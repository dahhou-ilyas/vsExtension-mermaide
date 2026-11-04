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

const { markReachability } = require('./graph');

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
        .replace(/#quot;/g, '"')
        .replace(/#lt;/g, '<')
        .replace(/#gt;/g, '>')
        .replace(/#amp;/g, '&')
        .replace(/#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
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
    if (m) return { label: m[1] !== undefined ? cleanText(m[1]) : '', end: pos + m[0].length, invisible: /~~~/.test(m[0]) };
    m = /^\s*(?:--|==|-\.)\s*(.+?)\s*(?:-->|==>|\.->|---)\s*/.exec(rest);
    if (m) return { label: cleanText(m[1]), end: pos + m[0].length };
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

    const defs = new Map();
    const edges = [];
    const define = (n) => {
        const existing = defs.get(n.id);
        if (!existing) defs.set(n.id, { id: n.id, shape: n.shape, text: n.text });
        else if (n.shape && !existing.shape) Object.assign(existing, { shape: n.shape, text: n.text });
    };

    for (const raw of lines.slice(headerIndex + 1)) {
        if (/^(classDef|class|style|linkStyle|click|direction|end$|subgraph\b|accTitle|accDescr)/.test(raw)) continue;
        for (const statement of splitStatements(raw)) {
            const line = statement.trim();
            if (!line) continue;
            let pos = 0;
            let previous = null;
            let pendingLabel = null;
            let invisible = false;
            while (pos < line.length) {
                while (line[pos] === ' ') pos++;
                const read = readNode(line, pos);
                if (!read) break;
                define(read.node);
                if (previous && pendingLabel !== null && !invisible) {
                    edges.push({ from: previous, to: read.node.id, label: pendingLabel });
                }
                previous = read.node.id;
                pos = read.end;
                while (line[pos] === ' ') pos++;
                if (line[pos] === '&') break; // `A & B --> C` is not supported, keep the first node
                const arrow = readArrow(line, pos);
                if (!arrow) break;
                pendingLabel = arrow.label;
                invisible = !!arrow.invisible;
                pos = arrow.end;
            }
        }
    }

    if (defs.size === 0) throw new MermaidImportError('The flowchart has no nodes.');

    // Kinds.
    const incoming = new Map([...defs.keys()].map((id) => [id, 0]));
    const outgoing = new Map([...defs.keys()].map((id) => [id, 0]));
    edges.forEach((e) => {
        incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
        outgoing.set(e.from, (outgoing.get(e.from) || 0) + 1);
    });
    const kinds = new Map();
    for (const def of defs.values()) {
        let kind = kindFromShape(def.shape || '[]', def.text || def.id);
        if (kind === 'terminal') kind = incoming.get(def.id) === 0 ? 'start' : (outgoing.get(def.id) === 0 ? 'end' : 'process');
        kinds.set(def.id, kind);
    }
    let startDef = [...defs.values()].find((d) => kinds.get(d.id) === 'start')
        || [...defs.values()].find((d) => incoming.get(d.id) === 0);
    if (!startDef) startDef = defs.values().next().value;

    // Build the graph with fresh ids.
    const idMap = new Map();
    let counter = 0;
    const newId = () => `n${counter++}`;
    const graph = { version: 1, direction, units: [], nodes: [], edges: [] };
    const startId = newId();
    const endId = newId();
    idMap.set(startDef.id, startId);

    const startIsStatement = kinds.get(startDef.id) !== 'start';
    const signature = startIsStatement ? null : /^(async\s+)?(function\s+)?([A-Za-z_$][\w$.]*)\s*\(([^)]*)\)$/.exec((startDef.text || '').trim());
    const startMeta = signature
        ? { fnKind: 'function', name: signature[3], displayName: signature[3], params: signature[4].trim(), async: !!signature[1], generator: false }
        : { isMain: true };
    graph.units.push({ name: signature ? signature[3] : 'Imported flowchart', kind: signature ? 'function' : 'main', startId, endId });
    graph.nodes.push({ id: startId, kind: 'start', unit: 0, code: [], meta: startMeta });
    graph.nodes.push({ id: endId, kind: 'end', unit: 0, code: [], meta: {} });

    // If the start node is not a real "start" (e.g. a plain statement), keep it as a statement after Start.
    if (startIsStatement) idMap.delete(startDef.id);

    for (const def of defs.values()) {
        if (def === startDef && !startIsStatement) continue;
        const kind = kinds.get(def.id);
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
        const textValue = (def.text !== undefined ? def.text : def.id).trim();
        const node = { id, kind, unit: 0, code: [], meta: { importedId: def.id } };
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
            default:
                node.code = textValue.split(/<br\s*\/?>/i).map((s) => s.trim()).filter(Boolean);
                if (node.code.length === 0) node.code = [textValue];
        }
        graph.nodes.push(node);
    }

    if (startIsStatement) {
        // The first node was a plain statement: Start → that statement.
        graph.edges.push({ from: startId, to: idMap.get(startDef.id), label: '' });
    }

    for (const edge of edges) {
        const from = idMap.get(edge.from);
        const to = idMap.get(edge.to);
        if (!from || !to) continue;
        const e = { from, to, label: normalizeLabel(edge.label) };
        const caseMatch = /^case\s+([\s\S]+)$/.exec(edge.label || '');
        if (caseMatch) {
            e.label = 'case';
            e.code = caseMatch[1];
        }
        graph.edges.push(e);
    }

    finishGraph(graph);
    return markReachability(graph);
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
    const unit = graph.units[0];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const outOf = (id) => graph.edges.filter((e) => e.from === id);

    for (const node of graph.nodes) {
        const out = outOf(node.id);
        if (node.kind === 'decision' && node.meta.subtype === 'if') {
            const unlabeled = out.filter((e) => e.label !== 'yes' && e.label !== 'no');
            if (unlabeled.length) {
                const hasYes = out.some((e) => e.label === 'yes');
                unlabeled.forEach((e, i) => { e.label = !hasYes && i === 0 ? 'yes' : 'no'; });
            }
            if (out.length === 1) graph.edges.push({ from: node.id, to: unit.endId, label: out[0].label === 'yes' ? 'no' : 'yes' });
        }
        if ((node.kind === 'return' || node.kind === 'throw') && out.length === 0) {
            graph.edges.push({ from: node.id, to: unit.endId, label: node.kind === 'throw' ? 'throws' : '' });
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
    dfs(unit.startId);

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
