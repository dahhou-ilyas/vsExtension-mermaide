'use strict';

/**
 * Mermaid flowchart text → graph, so that any flowchart (hand-written, from a
 * README, from another tool...) can be turned into code.
 *
 * Node shapes give the node kind:
 *   ([Start]) / ([End])      start / end (also inferred from the graph)
 *   [statement]              statement(s) — `<br>` separates statements
 *   {condition}              if (or `switch (x)`)
 *   {{condition}}            while loop (or a `for (…)` header)
 *   (return x) / >throw x]   return / throw
 *   ((do))                   do…while entry
 * Edge labels yes/true/oui/vrai and no/false/non/faux name the branches.
 */

const babelParser = require('@babel/parser');
const { markReachability, isNormalEdge } = require('./graph');

class MermaidImportError extends Error {}

const OPENERS = [
    ['([', '])'],
    ['[[', ']]'],
    ['{{', '}}'],
    ['((', '))'],
    ['[(', ')]'],
    ['[/', '/]'],
    ['[\\', '\\]'],
    ['[/', '\\]'],
    ['[\\', '/]'],
    ['[', ']'],
    ['{', '}'],
    ['(', ')'],
    ['>', ']']
];

const YES = /^(yes|y|true|vrai|oui|si|sí|ja|ok|1)$/i;
const NO = /^(no|n|false|faux|non|nein|0|else|sinon)$/i;

function decode(text) {
    return String(text)
        .replace(/\u200B/g, '')
        .replace(/\u02BA/g, '"')
        .replace(/#quot;/g, '"')
        .replace(/#lt;/g, '<')
        .replace(/#gt;/g, '>')
        .replace(/#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        // Last: code may itself contain entities such as "&quot;" (escaped as #amp;quot;).
        .replace(/#amp;/g, '&');
}

function cleanText(raw) {
    let text = raw.trim();
    if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) text = text.slice(1, -1);
    if (text.startsWith('`') && text.endsWith('`') && text.length >= 2) text = text.slice(1, -1);
    return decode(text);
}

/** Reads `id[shape text]` at `pos`. */
function readNode(line, pos) {
    const idMatch = /^[A-Za-z0-9_$][\w$-]*/.exec(line.slice(pos));
    if (!idMatch) return null;
    let i = pos + idMatch[0].length;
    const node = { id: idMatch[0] };
    for (const [open, close] of OPENERS) {
        if (!line.startsWith(open, i)) continue;
        let j = i + open.length;
        let text = '';
        if (line[j] === '"') {
            const end = line.indexOf('"', j + 1);
            if (end < 0) break;
            text = line.slice(j, end + 1);
            j = end + 1;
            while (line[j] === ' ') j++;
            if (!line.startsWith(close, j)) continue;
        } else {
            const end = line.indexOf(close, j);
            if (end < 0) continue;
            text = line.slice(j, end);
            j = end;
        }
        node.shape = open + close;
        node.text = cleanText(text);
        i = j + close.length;
        break;
    }
    if (node.id === 'end' && !node.shape) return null;
    return { node, end: i };
}

/** Reads an arrow (and its label) at `pos`. */
function readArrow(line, pos) {
    const rest = line.slice(pos);
    let m = /^\s*(?:<)?(?:-->|---|==>|===|-\.->|-\.-|--o|--x|~~~)\s*(?:\|([^|]*)\|)?\s*/.exec(rest);
    if (m) return { label: m[1] !== undefined ? cleanText(m[1]) : '', end: pos + m[0].length, invisible: /~~~/.test(m[0]), dotted: /-\./.test(m[0]) };
    m = /^\s*(?:--|==|-\.)\s*(.+?)\s*(?:-->|==>|\.->|---)\s*/.exec(rest);
    if (m) return { label: cleanText(m[1]), end: pos + m[0].length, dotted: /-\./.test(m[0]) };
    return null;
}

function kindFromShape(shape, text) {
    const t = text.trim();
    switch (shape) {
        case '([])':
            if (/^(start|begin|début|debut|inicio)\b/i.test(t)) return 'start';
            if (/^(end|fin|stop|exit)\b/i.test(t)) return 'end';
            if (/^return\b/.test(t)) return 'return';
            return 'terminal';
        case '{}':
            return 'decision';
        case '{{}}':
            return 'loop';
        case '(())':
            return /^do$/i.test(t) ? 'junction' : 'process';
        case '>]':
            return /^throw\b/.test(t) ? 'throw' : 'process';
        case '[[]]':
            if (/^try$/i.test(t)) return 'try';
            if (/^catch\b/i.test(t)) return 'catch';
            if (/^finally$/i.test(t)) return 'finally';
            return 'process';
        default:
            if (/^return\b/.test(t)) return 'return';
            if (/^throw\b/.test(t)) return 'throw';
            return 'process';
    }
}

const EXCEPTION_LABELS = new Set(['error', 'caught', 'throws']);
const ABRUPT_LABELS = new Set(['return', 'then return', 'rethrow']);

/** Kind of an edge drawn as a dotted arrow (exception, finally continuation, callback). */
function edgeKind(edge) {
    const label = String(edge.label || '').trim().toLowerCase();
    if (label === 'callback' || label === 'defines') return 'callback';
    if (!edge.dotted) return undefined;
    if (EXCEPTION_LABELS.has(label)) return 'exception';
    if (ABRUPT_LABELS.has(label)) return 'abrupt';
    return undefined;
}

/** Function header of a start node: `name(params)`, `async name(params)`, `↳ items.forEach((x) => …)`. */
function parseStart(text) {
    const t = String(text || '').trim();
    let m = /^↳\s*\((async\s+)?(?:\(([^)]*)\)\s*=>|function\s*\(([^)]*)\))\s*…\)\(\)$/.exec(t);
    if (m) return { fnKind: 'callback', callee: 'IIFE', params: (m[2] ?? m[3] ?? '').trim(), async: !!m[1], isArrow: m[2] !== undefined };
    m = /^↳\s*([\w$.]+)=\{(async\s+)?\(([^)]*)\)\s*=>\s*…\}$/.exec(t);
    if (m) return { fnKind: 'callback', callee: m[1], jsxAttribute: true, params: m[3].trim(), async: !!m[2], isArrow: true };
    m = /^↳\s*(.+?)\((async\s+)?(?:\(([^)]*)\)\s*=>|function\s*\(([^)]*)\))\s*…\)$/.exec(t);
    if (m) return { fnKind: 'callback', callee: m[1], params: (m[3] ?? m[4] ?? '').trim(), async: !!m[2], isArrow: m[3] !== undefined };
    m = /^((?:static|async|get|set)\s+)*(function\s+)?(\*)?([A-Za-z_$#][\w$.#]*)\s*\(([\s\S]*)\)$/.exec(t);
    if (m) {
        const prefixes = m[1] || '';
        return {
            fnKind: 'function',
            name: m[4].split('.').pop(),
            displayName: m[4],
            params: m[5].trim(),
            async: /async/.test(prefixes),
            static: /static/.test(prefixes),
            generator: !!m[3]
        };
    }
    return null;
}

/** Splits code on `;` that are outside of strings and brackets. */
function splitTopLevelStatements(text) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        current += ch;
        if (quote) {
            if (ch === '\\') current += text[++i] || '';
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
        else if (ch === ';' && depth === 0) {
            parts.push(current.trim());
            current = '';
        }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

/** Whether `code` parses as JavaScript statements (`{…}` placeholders allowed). */
function parses(code) {
    try {
        babelParser.parse(code.replace(/\{…\}/g, '{}'), {
            sourceType: 'module',
            allowReturnOutsideFunction: true,
            allowAwaitOutsideFunction: true,
            allowSuperOutsideMethod: true,
            allowUndeclaredExports: true,
            plugins: ['jsx', 'typescript']
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Lines of a label are either one statement wrapped on several lines (what the
 * extension produces) or one statement per line (hand-written diagrams).
 */
function labelLines(raw) {
    const lines = String(raw).split(/<br\s*\/?>/i).map((l) => l.trim()).filter(Boolean);
    const joined = lines.join(' ');
    if (lines.length <= 1 || parses(joined) || !parses(lines.join('\n'))) return { text: joined, lines: null };
    return { text: joined, lines };
}

function nodeFromDef(def, kind, id, unit) {
    const raw = (def.text !== undefined ? def.text : def.id);
    const { text: textValue, lines: separateLines } = labelLines(raw);
    const node = { id, kind, unit, code: [], meta: { importedId: def.id } };
    switch (kind) {
        case 'decision': {
            const sw = /^switch\s*\(([\s\S]*)\)$/.exec(textValue);
            const iff = /^if\s*\(([\s\S]*)\)$/.exec(textValue);
            node.meta.subtype = sw ? 'switch' : 'if';
            node.code = [sw ? sw[1] : (iff ? iff[1] : textValue.replace(/\?$/, '').trim())];
            break;
        }
        case 'loop': {
            const forHeader = /^for\s*(await\s*)?\(([\s\S]*)\)$/.exec(textValue);
            const whileHeader = /^while\s*\(([\s\S]*)\)$/.exec(textValue);
            if (forHeader) {
                node.meta.header = textValue;
                node.meta.subtype = /;/.test(forHeader[2]) ? 'for' : (/\sof\s/.test(forHeader[2]) ? 'forof' : 'forin');
                node.code = [''];
            } else {
                node.meta.subtype = 'while';
                node.code = [whileHeader ? whileHeader[1] : textValue.replace(/\?$/, '').trim()];
            }
            break;
        }
        case 'junction':
            node.meta.subtype = 'do';
            break;
        case 'catch': {
            const m = /^catch\s*\(([\s\S]*)\)$/.exec(textValue);
            node.code = m ? [m[1]] : [];
            break;
        }
        case 'try':
        case 'finally':
            break;
        default: {
            const statements = separateLines || splitTopLevelStatements(textValue);
            node.code = statements.length ? statements : [textValue];
        }
    }
    return node;
}

/**
 * @param {string} text  Mermaid flowchart definition (or a Markdown file containing one)
 * @returns {import('./graph').Graph}
 */
function importMermaid(text) {
    let source = String(text);
    const fenced = /```mermaid\s*\n([\s\S]*?)```/.exec(source);
    if (fenced) source = fenced[1];

    const lines = source.split(/\r?\n/).map((l) => l.replace(/%%.*$/, '').trim()).filter(Boolean);
    const headerIndex = lines.findIndex((l) => /^(flowchart|graph)\b/.test(l));
    if (headerIndex < 0) throw new MermaidImportError('No "flowchart" or "graph" definition found.');
    const direction = /\b(LR|RL)\b/.test(lines[headerIndex]) ? 'LR' : 'TD';

    // Subgraphs become units (functions / callbacks); their ids are not nodes.
    const groups = [{ id: '', title: '' }];
    const subgraphIds = new Set();
    for (const raw of lines) {
        const m = /^subgraph\s+([\w$-]+)/.exec(raw);
        if (m) subgraphIds.add(m[1]);
    }

    const defs = new Map();
    const edges = [];
    const groupStack = [];
    const define = (n) => {
        if (subgraphIds.has(n.id)) return false;
        const group = groupStack.length ? groupStack[groupStack.length - 1] : '';
        const existing = defs.get(n.id);
        if (!existing) defs.set(n.id, { id: n.id, shape: n.shape, text: n.text, group, shaped: !!n.shape });
        else if (n.shape && !existing.shaped) Object.assign(existing, { shape: n.shape, text: n.text, group, shaped: true });
        return true;
    };

    for (const raw of lines.slice(headerIndex + 1)) {
        const sub = /^subgraph\s+(?:([\w$-]+)\s*)?(?:\["?(.*?)"?\]|(.*))?$/.exec(raw);
        if (sub) {
            const id = sub[1] || `group${groups.length}`;
            const title = cleanText(sub[2] !== undefined ? sub[2] : (sub[3] || id));
            groups.push({ id, title });
            groupStack.push(id);
            continue;
        }
        if (raw === 'end') {
            groupStack.pop();
            continue;
        }
        if (/^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(raw)) continue;
        for (const statement of splitStatements(raw)) {
            const line = statement.trim();
            if (!line) continue;
            let pos = 0;
            let previous = null;
            let pending = null;
            while (pos < line.length) {
                while (line[pos] === ' ') pos++;
                const read = readNode(line, pos);
                if (!read) break;
                const isNode = define(read.node);
                if (previous && pending && !pending.invisible && isNode) {
                    edges.push({ from: previous, to: read.node.id, label: pending.label, dotted: pending.dotted });
                }
                previous = isNode ? read.node.id : null;
                pos = read.end;
                while (line[pos] === ' ') pos++;
                if (line[pos] === '&') break; // `A & B --> C` is not supported, keep the first node
                const arrow = readArrow(line, pos);
                if (!arrow) break;
                pending = arrow;
                pos = arrow.end;
            }
        }
    }

    if (defs.size === 0) throw new MermaidImportError('The flowchart has no nodes.');
    edges.forEach((e) => { e.kind = edgeKind(e); });

    // Kinds (only the normal flow tells where a function starts and ends).
    const incoming = new Map([...defs.keys()].map((id) => [id, 0]));
    const outgoing = new Map([...defs.keys()].map((id) => [id, 0]));
    const callbackTargets = new Map();
    edges.forEach((e) => {
        if (e.kind === 'callback') callbackTargets.set(e.to, String(e.label).trim().toLowerCase() === 'defines' ? 'nested' : 'callback');
        if (e.kind) return;
        incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
        outgoing.set(e.from, (outgoing.get(e.from) || 0) + 1);
    });
    const kinds = new Map();
    for (const def of defs.values()) {
        let kind = kindFromShape(def.shape || '[]', def.text || def.id);
        if (kind === 'terminal') kind = incoming.get(def.id) === 0 ? 'start' : (outgoing.get(def.id) === 0 ? 'end' : 'process');
        kinds.set(def.id, kind);
    }

    const graph = { version: 1, direction, units: [], nodes: [], edges: [] };
    const idMap = new Map();
    let counter = 0;
    const newId = () => `n${counter++}`;

    for (const group of groups) {
        const members = [...defs.values()].filter((d) => d.group === group.id);
        if (!members.length) continue;
        const unitIndex = graph.units.length;
        const startDef = members.find((d) => kinds.get(d.id) === 'start')
            || members.find((d) => incoming.get(d.id) === 0)
            || members[0];
        const startIsStatement = kinds.get(startDef.id) !== 'start';
        const parsed = startIsStatement ? null : parseStart(startDef.text);
        const isCallback = callbackTargets.has(startDef.id) || (parsed && parsed.fnKind === 'callback');

        const startId = newId();
        const endId = newId();
        let meta;
        let name;
        if (parsed && parsed.fnKind === 'callback') {
            meta = parsed;
            name = group.title || `${parsed.callee} callback`;
        } else if (parsed) {
            meta = parsed;
            name = group.title || parsed.displayName;
        } else {
            meta = { isMain: true };
            name = group.title || 'Imported flowchart';
        }
        const embeddedKind = callbackTargets.get(startDef.id) || (parsed && parsed.fnKind === 'callback' ? 'callback' : null);
        graph.units.push({ name, kind: isCallback ? embeddedKind || 'callback' : (parsed ? 'function' : 'main'), startId, endId });
        graph.nodes.push({ id: startId, kind: 'start', unit: unitIndex, code: [], meta });
        graph.nodes.push({ id: endId, kind: 'end', unit: unitIndex, code: [], meta: {} });

        for (const def of members) {
            const kind = kinds.get(def.id);
            if (def === startDef && !startIsStatement) {
                idMap.set(def.id, startId);
                continue;
            }
            if (kind === 'end') {
                idMap.set(def.id, endId);
                continue;
            }
            if (kind === 'start') {
                idMap.set(def.id, startId);
                continue;
            }
            const id = newId();
            idMap.set(def.id, id);
            graph.nodes.push(nodeFromDef(def, kind, id, unitIndex));
        }
        if (startIsStatement) graph.edges.push({ from: startId, to: idMap.get(startDef.id), label: '' });
    }

    for (const edge of edges) {
        const from = idMap.get(edge.from);
        const to = idMap.get(edge.to);
        if (!from || !to) continue;
        const e = { from, to, label: edge.kind ? String(edge.label).trim() : normalizeLabel(edge.label) };
        if (edge.kind) e.kind = edge.kind;
        const caseMatch = !edge.kind && /^case\s+([\s\S]+)$/.exec(edge.label || '');
        if (caseMatch) {
            e.label = 'case';
            e.code = caseMatch[1];
        }
        graph.edges.push(e);
    }

    // try nodes: remember their catch / finally so code generation can rebuild the block.
    for (const node of graph.nodes) {
        if (node.kind !== 'try') continue;
        const reach = new Set();
        const stack = [node.id];
        while (stack.length) {
            const id = stack.pop();
            if (reach.has(id)) continue;
            reach.add(id);
            graph.edges.filter((e) => e.from === id).forEach((e) => stack.push(e.to));
        }
        const catchNode = graph.nodes.find((n) => n.kind === 'catch' && n.unit === node.unit && reach.has(n.id) && !n.meta.claimed);
        if (catchNode) {
            node.meta.catchId = catchNode.id;
            catchNode.meta.claimed = true;
        }
        const finallyNode = graph.nodes.find((n) => n.kind === 'finally' && n.unit === node.unit && reach.has(n.id) && !n.meta.claimed);
        if (finallyNode) {
            node.meta.finallyId = finallyNode.id;
            finallyNode.meta.claimed = true;
        }
    }
    graph.nodes.forEach((n) => { delete n.meta.claimed; });

    finishGraph(graph);
    restoreFoldedBodies(graph);
    return markReachability(graph);
}

/**
 * Statements whose callbacks / nested functions are drawn as their own flows show
 * their bodies folded (`=> {…}`). The bodies are rebuilt from those flows, so an
 * exported diagram can still be turned back into complete code.
 */
function restoreFoldedBodies(graph) {
    // Required lazily: codegen does not depend on the importer.
    const { generateBody } = require('./codegen');
    const unitOfStart = new Map(graph.units.map((u, i) => [u.startId, i]));
    // Function declarations (they may sit after a return: hoisted, without incoming edge).
    for (const node of graph.nodes) {
        const m = node.kind === 'process' && node.code.length === 1 && /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(node.code[0]);
        if (m) node.meta.declaration = m[1];
    }
    const restored = new Set();
    const restore = (node) => {
        if (restored.has(node.id)) return;
        restored.add(node.id);
        const links = graph.edges.filter((e) => e.from === node.id && e.kind === 'callback' && unitOfStart.has(e.to));
        if (!links.length || !(node.code || []).some((c) => c.includes('{…}'))) return;
        links.sort((a, b) => unitOfStart.get(a.to) - unitOfStart.get(b.to));
        for (const link of links) {
            const unitIndex = unitOfStart.get(link.to);
            // Inner callbacks first, so their own folded bodies are complete.
            graph.nodes.filter((n) => n.unit === unitIndex).forEach(restore);
            const body = generateBody(graph, unitIndex).split('\n').map((l) => (l ? `    ${l}` : l)).join('\n');
            const at = node.code.findIndex((c) => c.includes('{…}'));
            if (at < 0) break;
            node.code[at] = node.code[at].replace('{…}', `{\n${body}\n}`);
            node.meta.multiline = node.meta.multiline || false;
        }
    };
    graph.nodes.forEach(restore);
}

/** Splits a line on `;` outside of quotes, brackets and `|labels|`. */
function splitStatements(line) {
    const parts = [];
    let current = '';
    let depth = 0;
    let quote = false;
    let pipe = false;
    for (const ch of line) {
        if (ch === '"') quote = !quote;
        else if (!quote && ch === '|') pipe = !pipe;
        else if (!quote && !pipe && '[({'.includes(ch)) depth++;
        else if (!quote && !pipe && '])}'.includes(ch)) depth = Math.max(0, depth - 1);
        if (ch === ';' && !quote && !pipe && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return parts;
}

function normalizeLabel(label) {
    const text = String(label || '').trim();
    if (YES.test(text)) return 'yes';
    if (NO.test(text)) return 'no';
    if (/^(next|each)$/i.test(text)) return 'next';
    if (/^(done|end of list)$/i.test(text)) return 'done';
    if (/^default$/i.test(text)) return 'default';
    return text;
}

/** Fixes what hand-written diagrams usually leave implicit. */
function finishGraph(graph) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // Structure is inferred from the normal control flow only.
    const outOf = (id) => graph.edges.filter((e) => e.from === id && isNormalEdge(e));

    for (const node of graph.nodes) {
        const unit = graph.units[node.unit];
        const out = outOf(node.id);
        if (node.kind === 'decision' && node.meta.subtype === 'if') {
            const unlabeled = out.filter((e) => e.label !== 'yes' && e.label !== 'no');
            if (unlabeled.length) {
                const hasYes = out.some((e) => e.label === 'yes');
                unlabeled.forEach((e, i) => { e.label = !hasYes && i === 0 ? 'yes' : 'no'; });
            }
            if (out.length === 1) graph.edges.push({ from: node.id, to: unit.endId, label: out[0].label === 'yes' ? 'no' : 'yes' });
        }
        const anyOut = graph.edges.some((e) => e.from === node.id);
        if ((node.kind === 'return' || node.kind === 'throw') && !anyOut) {
            graph.edges.push(node.kind === 'throw'
                ? { from: node.id, to: unit.endId, label: 'throws', kind: 'exception' }
                : { from: node.id, to: unit.endId, label: '' });
        }
        if (['process', 'junction', 'try', 'catch', 'finally'].includes(node.kind) && out.length === 0) {
            graph.edges.push({ from: node.id, to: unit.endId, label: '' });
        }
    }

    // A condition whose branch loops back to it is a while loop.
    const order = new Map();
    const onStack = new Set();
    const backTargets = new Map();
    let index = 0;
    const dfs = (id) => {
        order.set(id, index++);
        onStack.add(id);
        for (const e of outOf(id)) {
            if (onStack.has(e.to)) {
                if (!backTargets.has(e.to)) backTargets.set(e.to, new Set());
                backTargets.get(e.to).add(e.from);
            } else if (!order.has(e.to)) {
                dfs(e.to);
            }
        }
        onStack.delete(id);
    };
    graph.units.forEach((unit) => { if (!order.has(unit.startId)) dfs(unit.startId); });

    for (const [target] of backTargets) {
        const node = byId.get(target);
        if (!node || node.kind !== 'decision' || node.meta.subtype !== 'if') continue;
        const out = outOf(target);
        const reaches = (from) => {
            const seen = new Set();
            const stack = [from];
            while (stack.length) {
                const id = stack.pop();
                if (id === target) return true;
                if (seen.has(id)) continue;
                seen.add(id);
                outOf(id).forEach((e) => stack.push(e.to));
            }
            return false;
        };
        const yes = out.find((e) => e.label === 'yes');
        const no = out.find((e) => e.label === 'no');
        if (!yes || !no) continue;
        const yesLoops = reaches(yes.to);
        const noLoops = reaches(no.to);
        if (yesLoops === noLoops) continue;
        node.kind = 'loop';
        node.meta.subtype = 'while';
        if (noLoops) {
            node.code = [`!(${node.code[0]})`];
            yes.label = 'no';
            no.label = 'yes';
        }
    }
}

module.exports = { importMermaid, MermaidImportError };
