'use strict';

/**
 * Small, dependency-free readers for the pieces of JavaScript the state
 * machine fallback has to take apart: declarations (`const { a, b: [c] } = x`),
 * loop headers (`for (const [k, v] of map)`) and binding patterns.
 *
 * They work on the text of a single statement, which always comes from a
 * parsed program or from the editor, so they only need to respect brackets,
 * strings, template literals and comments, not the whole grammar.
 */

/**
 * Calls `visit(index, char)` for every character of `text` that is outside
 * strings, template literals and comments, with the bracket depth at that point.
 * Returning `true` from `visit` stops the scan.
 */
function scanTopLevel(text, visit) {
    let depth = 0;
    let previous = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        // A regular expression literal (`/["']/g`): its content is not code.
        if (ch === '/' && text[i + 1] !== '/' && text[i + 1] !== '*' && (!previous || '(,=:[!&|?{};+-*%<>~^'.includes(previous)
            || /\b(return|typeof|case|in|of|new|delete|void|throw|yield|await)\s*$/.test(text.slice(Math.max(0, i - 8), i)))) {
            let inClass = false;
            i++;
            while (i < text.length && text[i] !== '\n') {
                if (text[i] === '\\') i++;
                else if (text[i] === '[') inClass = true;
                else if (text[i] === ']') inClass = false;
                else if (text[i] === '/' && !inClass) break;
                i++;
            }
            previous = 'a';
            continue;
        }
        if (!/\s/.test(ch)) previous = /[\w$]/.test(ch) ? 'a' : ch;
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            i++;
            while (i < text.length && text[i] !== quote) {
                if (text[i] === '\\') i++;
                else if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
                    // `${ … }` inside a template: skip to its closing brace.
                    let nested = 0;
                    i += 2;
                    while (i < text.length && !(text[i] === '}' && nested === 0)) {
                        if (text[i] === '{') nested++;
                        else if (text[i] === '}') nested--;
                        i++;
                    }
                }
                i++;
            }
            previous = 'a';
            continue;
        }
        if (ch === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 1;
            continue;
        }
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        if (visit(i, ch, depth) === true) return;
    }
}

/** Splits on `separator` at the top level; empty parts are kept. */
function splitTopLevel(text, separator) {
    const parts = [];
    let last = 0;
    scanTopLevel(text, (i, ch, depth) => {
        if (ch === separator && depth === 0) {
            parts.push(text.slice(last, i));
            last = i + 1;
        }
    });
    parts.push(text.slice(last));
    return parts;
}

/** Index of the top-level `=` of an assignment / initializer (not `==`, `=>`, `<=`…), or -1. */
function assignmentIndex(text) {
    let found = -1;
    scanTopLevel(text, (i, ch, depth) => {
        if (ch !== '=' || depth !== 0) return false;
        const prev = text[i - 1];
        const next = text[i + 1];
        if (next === '=' || next === '>' || '=!<>+-*/%&|^?'.includes(prev || '')) return false;
        found = i;
        return true;
    });
    return found;
}

/** Index of the bracket that closes the one at `start`. */
function closingIndex(text, start) {
    let found = -1;
    scanTopLevel(text.slice(start), (i, ch, depth) => {
        if (depth === 0 && ')]}'.includes(ch)) {
            found = start + i;
            return true;
        }
        return false;
    });
    return found;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Names bound by a binding pattern: `a`, `{ a, b: [c, ...d], e = 1 }`, `[x, , y]`.
 * @param {string} pattern
 * @returns {string[]}
 */
function patternNames(pattern) {
    const text = stripDefault(String(pattern).trim());
    if (!text) return [];
    if (IDENTIFIER.test(text)) return [text];
    const open = text[0];
    if (open !== '{' && open !== '[') return [];
    const close = closingIndex(text, 0);
    const inner = text.slice(1, close < 0 ? text.length : close);
    const names = [];
    for (const raw of splitTopLevel(inner, ',')) {
        const part = raw.trim();
        if (!part) continue;
        if (part.startsWith('...')) {
            names.push(...patternNames(part.slice(3)));
            continue;
        }
        if (open === '[') {
            names.push(...patternNames(part));
            continue;
        }
        // Object pattern: `key: target`, `[computed]: target`, `name = default` or `name`.
        const eq = assignmentIndex(part);
        let colon = -1;
        scanTopLevel(part, (i, ch, depth) => {
            if (ch === ':' && depth === 0 && (eq < 0 || i < eq)) {
                colon = i;
                return true;
            }
            return false;
        });
        names.push(...patternNames(colon >= 0 ? part.slice(colon + 1) : part));
    }
    return names;
}

/** `x = 1` → `x`; a pattern followed by a type annotation keeps only the pattern. */
function stripDefault(text) {
    let target = text.trim();
    const eq = assignmentIndex(target);
    if (eq >= 0) target = target.slice(0, eq).trim();
    if (target[0] === '{' || target[0] === '[') {
        const close = closingIndex(target, 0);
        if (close > 0) return target.slice(0, close + 1);
    }
    // `name!: Type` / `name: Type` (TypeScript)
    const typed = /^([A-Za-z_$][\w$]*)\s*!?\s*:/.exec(target);
    return typed ? typed[1] : target;
}

/**
 * `const a = 1, { b } = c;` → { kind: 'const', declarators: [{ target: 'a', names: ['a'], init: '1' }, …] }
 * @returns {{ kind: string, declarators: Array<{ target: string, names: string[], init: string | null }> } | null}
 */
function parseDeclaration(code) {
    const match = /^\s*(const|let|var)\s+([\s\S]*?);?\s*$/.exec(String(code));
    if (!match) return null;
    const declarators = [];
    for (const raw of splitTopLevel(match[2], ',')) {
        if (!raw.trim()) continue;
        const eq = assignmentIndex(raw);
        const left = eq >= 0 ? raw.slice(0, eq) : raw;
        const target = stripDefault(left);
        declarators.push({ target, names: patternNames(target), init: eq >= 0 ? raw.slice(eq + 1).trim() : null });
    }
    return { kind: match[1], declarators };
}

/**
 * Reads a loop header.
 * @returns {{ kind: 'for', init: string, test: string, update: string }
 *   | { kind: 'of' | 'in', await: boolean, declaration: string | null, target: string, names: string[], right: string } | null}
 */
function parseForHeader(header) {
    const match = /^\s*for\s*(await\s*)?\(([\s\S]*)\)\s*$/.exec(String(header));
    if (!match) return null;
    const inner = match[2];
    const parts = splitTopLevel(inner, ';');
    if (parts.length === 3) {
        return { kind: 'for', init: parts[0].trim(), test: parts[1].trim(), update: parts[2].trim() };
    }
    let keyword = null;
    scanTopLevel(inner, (i, ch, depth) => {
        if (depth !== 0) return false;
        const rest = inner.slice(i);
        const m = /^(of|in)\b/.exec(rest);
        if (m && /[\s)\]}]/.test(inner[i - 1] || ' ')) {
            keyword = { index: i, word: m[1] };
            return true;
        }
        return false;
    });
    if (!keyword) return null;
    const left = inner.slice(0, keyword.index).trim();
    const right = inner.slice(keyword.index + keyword.word.length).trim();
    const decl = /^(const|let|var)\s+([\s\S]*)$/.exec(left);
    const target = decl ? stripDefault(decl[2]) : left;
    return {
        kind: keyword.word,
        await: !!match[1],
        declaration: decl ? decl[1] : null,
        target,
        names: decl ? patternNames(target) : [],
        right
    };
}

/** Every identifier-like word of a text (an over-approximation, to choose fresh names). */
function identifiers(text) {
    return new Set(String(text).match(/[A-Za-z_$][\w$]*/g) || []);
}

/**
 * Renames identifiers in a piece of code, leaving strings, comments, regular
 * expressions, property names (`a.x`, `{ x: 1 }`) alone. Shorthand
 * properties are expanded (`{ x }` → `{ x: x2 }`) so object literals and
 * destructuring patterns keep their keys.
 * @param {string} code
 * @param {Map<string, string>} mapping
 */
function renameIdentifiers(code, mapping) {
    const text = String(code);
    if (!mapping.size) return text;
    let out = '';
    let i = 0;
    /** Bracket stack; a template literal pushes '`', a `${` pushes '${'. */
    const stack = [];
    let prev = '';
    let prevWord = '';
    const top = () => stack[stack.length - 1];
    const nextSignificant = (from) => {
        let j = from;
        while (j < text.length && /\s/.test(text[j])) j++;
        return text[j] || '';
    };
    while (i < text.length) {
        const ch = text[i];
        if (top() === '`') {
            // Inside a template literal: copy until `${` or the closing backtick.
            if (ch === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
            if (ch === '`') { stack.pop(); out += ch; i++; prev = 'a'; continue; }
            if (ch === '$' && text[i + 1] === '{') { stack.push('${'); out += '${'; i += 2; prev = '{'; prevWord = ''; continue; }
            out += ch;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            let j = i + 1;
            while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j + 1;
            prev = 'a';
            continue;
        }
        if (ch === '`') { stack.push('`'); out += ch; i++; continue; }
        if (ch === '/' && text[i + 1] === '/') {
            const end = text.indexOf('\n', i);
            const stop = end < 0 ? text.length : end;
            out += text.slice(i, stop);
            i = stop;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end < 0 ? text.length : end + 2;
            out += text.slice(i, stop);
            i = stop;
            continue;
        }
        if (ch === '/' && (!prev || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /^(return|typeof|case|in|of|new|delete|void|throw|yield|await)$/.test(prevWord))) {
            let j = i + 1;
            let inClass = false;
            while (j < text.length && text[j] !== '\n') {
                if (text[j] === '\\') j++;
                else if (text[j] === '[') inClass = true;
                else if (text[j] === ']') inClass = false;
                else if (text[j] === '/' && !inClass) break;
                j++;
            }
            j++;
            while (j < text.length && /[a-z]/i.test(text[j])) j++;
            out += text.slice(i, j);
            i = j;
            prev = 'a';
            prevWord = '';
            continue;
        }
        if (/[A-Za-z_$]/.test(ch)) {
            let j = i;
            while (j < text.length && /[\w$]/.test(text[j])) j++;
            const word = text.slice(i, j);
            const before = out.replace(/\s+$/, '');
            const member = /\.$/.test(before) && !/\.\.\.$/.test(before);
            const inObject = top() === '{';
            const after = nextSignificant(j);
            const key = inObject && (prev === '{' || prev === ',') && after === ':';
            const shorthand = inObject && (prev === '{' || prev === ',') && (after === ',' || after === '}' || after === '=');
            if (mapping.has(word) && !member && !key && !/^\d/.test(word)) {
                out += shorthand ? `${word}: ${mapping.get(word)}` : mapping.get(word);
            } else {
                out += word;
            }
            prev = 'a';
            prevWord = word;
            i = j;
            continue;
        }
        if ('([{'.includes(ch)) stack.push(ch);
        else if (')]'.includes(ch)) stack.pop();
        else if (ch === '}') {
            if (top() === '${') { stack.pop(); out += ch; i++; prev = 'a'; continue; }
            stack.pop();
        }
        if (!/\s/.test(ch)) {
            prev = ch;
            prevWord = '';
        }
        out += ch;
        i++;
    }
    return out;
}

module.exports = { renameIdentifiers, scanTopLevel, splitTopLevel, assignmentIndex, patternNames, parseDeclaration, parseForHeader, identifiers };
