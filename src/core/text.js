'use strict';

/**
 * Text helpers that understand just enough JavaScript to re-indent code
 * safely: a line that starts inside a template literal is part of a string,
 * so adding or removing indentation there would change the program.
 */

/** Marks a generated line that must be printed exactly as it is (no indentation added). */
const KEEP = '\u0000';

const REGEX_AFTER_WORD = new Set([
    'return', 'typeof', 'instanceof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await'
]);

/**
 * Indices of the lines of `code` that begin inside a template literal.
 * @param {string} code
 * @returns {Set<number>}
 */
function templateLines(code) {
    const result = new Set();
    const text = String(code);
    if (!text.includes('`')) return result;
    /** Stack of contexts: 'code' (with its brace depth) or 'template'. */
    const stack = [{ type: 'code', depth: 0 }];
    let line = 0;
    let lastSignificant = '';
    let lastWord = '';
    let i = 0;
    const top = () => stack[stack.length - 1];
    while (i < text.length) {
        const ch = text[i];
        const context = top();
        if (ch === '\n') {
            line++;
            if (context.type === 'template') result.add(line);
            i++;
            continue;
        }
        if (context.type === 'template') {
            if (ch === '\\') {
                if (text[i + 1] === '\n') {
                    line++;
                    result.add(line);
                }
                i += 2;
            } else if (ch === '`') {
                stack.pop();
                lastSignificant = '`';
                i++;
            } else if (ch === '$' && text[i + 1] === '{') {
                stack.push({ type: 'code', depth: 0 });
                lastSignificant = '{';
                i += 2;
            } else {
                i++;
            }
            continue;
        }
        // Code.
        if (ch === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end < 0 ? text.length : end + 2;
            for (let k = i; k < stop; k++) if (text[k] === '\n') line++;
            i = stop;
            continue;
        }
        if (ch === '"' || ch === "'") {
            i++;
            while (i < text.length && text[i] !== ch && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
            i++;
            lastSignificant = ch;
            continue;
        }
        if (ch === '`') {
            stack.push({ type: 'template' });
            i++;
            continue;
        }
        if (ch === '/') {
            const regex = !lastSignificant || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant) || REGEX_AFTER_WORD.has(lastWord);
            if (regex) {
                i++;
                let inClass = false;
                while (i < text.length && text[i] !== '\n') {
                    if (text[i] === '\\') i++;
                    else if (text[i] === '[') inClass = true;
                    else if (text[i] === ']') inClass = false;
                    else if (text[i] === '/' && !inClass) break;
                    i++;
                }
                i++;
                while (i < text.length && /[a-z]/i.test(text[i])) i++;
                lastSignificant = '/';
                lastWord = '';
                continue;
            }
        }
        if (ch === '{') context.depth++;
        if (ch === '}') {
            if (context.depth === 0 && stack.length > 1) {
                stack.pop();
                lastSignificant = '`';
                lastWord = '';
                i++;
                continue;
            }
            context.depth--;
        }
        if (/[A-Za-z_$0-9]/.test(ch)) {
            let j = i;
            while (j < text.length && /[\w$]/.test(text[j])) j++;
            lastWord = text.slice(i, j);
            lastSignificant = 'a';
            i = j;
            continue;
        }
        if (!/\s/.test(ch)) {
            lastSignificant = ch;
            lastWord = '';
        }
        i++;
    }
    return result;
}

/**
 * Indents every line but the first (and the lines inside template literals)
 * with `indent`: the code is inserted at a position that already has it.
 * @param {string} code
 * @param {string} indent
 * @param {string} [eol]
 */
function indentCode(code, indent, eol = '\n') {
    const text = String(code).replace(/\n$/, '');
    const keep = templateLines(text);
    return text.split('\n').map((l, i) => (i === 0 || !l || keep.has(i) ? l : indent + l)).join(eol);
}

module.exports = { KEEP, templateLines, indentCode };
