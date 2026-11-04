'use strict';

/**
 * The flowchart graph model ("IR") shared by every feature:
 *
 *   code ──(flowchartBuilder)──▶ Graph ──(toMermaid)──▶ diagram
 *                                 ▲  │
 *                    (graphEdit)  └──┴──(codegen)──▶ code
 *
 * Nodes keep the *raw* source of what they represent (never truncated), so a
 * graph can always be turned back into code. Display labels are derived.
 *
 * @typedef {'start'|'end'|'process'|'decision'|'loop'|'return'|'throw'|'try'|'catch'|'finally'|'junction'} NodeKind
 *
 * @typedef {Object} GraphNode
 * @property {string} id
 * @property {NodeKind} kind
 * @property {number} unit           Index of the unit (function) the node belongs to
 * @property {string[]} code         Raw code: statements (process), condition (decision/loop), statement (return/throw), catch parameter
 * @property {Object} meta           Kind specific data (subtype, loop header, function signature, ...)
 * @property {boolean} [unreachable]
 * @property {boolean} [async]
 * @property {number} [start]        Source offsets (when generated from code)
 * @property {number} [end]
 *
 * @typedef {Object} GraphEdge
 * @property {string} from
 * @property {string} to
 * @property {string} label          Branch label: yes/no, next/done, case/default/no match, error, ...
 * @property {string} [code]         Raw `case` test
 * @property {'exception'|'abrupt'|'callback'} [kind]  Non-normal edges: may-throw → handler, return/throw through finally, statement → inline callback
 *
 * @typedef {Object} GraphUnit
 * @property {string} name
 * @property {'function'|'main'|'block'|'callback'|'nested'} kind  callback / nested: drawn from code embedded in another unit
 * @property {string} startId
 * @property {string} endId
 *
 * @typedef {Object} Graph
 * @property {number} version
 * @property {'TD'|'LR'} direction
 * @property {GraphUnit[]} units
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 */

const GRAPH_VERSION = 1;

const SHAPES = {
    start: ['([', '])'],
    end: ['([', '])'],
    process: ['[', ']'],
    decision: ['{', '}'],
    loop: ['{{', '}}'],
    return: ['(', ')'],
    throw: ['>', ']'],
    try: ['[[', ']]'],
    catch: ['[[', ']]'],
    finally: ['[[', ']]'],
    junction: ['((', '))']
};

const CLASS_BY_KIND = {
    start: 'cfStart',
    end: 'cfEnd',
    decision: 'cfDecision',
    loop: 'cfLoop',
    return: 'cfReturn',
    throw: 'cfThrow',
    try: 'cfTry',
    catch: 'cfTry',
    finally: 'cfTry',
    junction: 'cfJunction'
};

const CLASS_DEFS = [
    'classDef cfStart fill:#2e7d32,stroke:#1b5e20,color:#ffffff,stroke-width:2px',
    'classDef cfEnd fill:#455a64,stroke:#263238,color:#ffffff,stroke-width:2px',
    'classDef cfDecision fill:#ffca28,stroke:#f57f17,color:#1a1a1a',
    'classDef cfLoop fill:#7e57c2,stroke:#4527a0,color:#ffffff',
    'classDef cfReturn fill:#1e88e5,stroke:#0d47a1,color:#ffffff',
    'classDef cfThrow fill:#e53935,stroke:#b71c1c,color:#ffffff',
    'classDef cfTry fill:#fb8c00,stroke:#e65100,color:#ffffff',
    'classDef cfJunction fill:#90a4ae,stroke:#546e7a,color:#1a1a1a',
    'classDef cfAsync stroke:#00acc1,stroke-width:3px',
    'classDef cfUnreachable fill:#bdbdbd,stroke:#757575,color:#424242,stroke-dasharray:5 4',
    'classDef cfSelected stroke:#1e88e5,stroke-width:4px'
];

/* ------------------------------------------------------------------------- */
/* Text helpers                                                               */
/* ------------------------------------------------------------------------- */

function collapse(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

/**
 * Escapes a label so it can be used inside a quoted Mermaid string rendered as SVG text.
 *
 * Only `#lt;`, `#gt;` and `#amp;` are reliably decoded by Mermaid in SVG-text mode,
 * so double quotes (which would close the string) are rendered as single quotes,
 * `#word;` sequences are broken with a zero-width space so they are not read as
 * entities, and a leading backtick is guarded so it is not parsed as a Markdown string.
 */
function escapeLabel(text) {
    let label = String(text)
        .replace(/&/g, '#amp;')
        .replace(/</g, '#lt;')
        .replace(/>/g, '#gt;')
        // U+02BA looks like a double quote; the importer turns it back into ".
        .replace(/"/g, '\u02BA')
        .replace(/#(?!(?:amp|lt|gt);)(?=\w+;)/g, '#\u200B');
    if (label.startsWith('`')) label = `\u200B${label}`;
    return label;
}

function escapeEdgeLabel(text) {
    return escapeLabel(text).replace(/\|/g, '∣');
}

/* ------------------------------------------------------------------------- */
/* Labels                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * @typedef {Object} LabelOptions
 * @property {'wrap' | 'truncate'} [labelMode]  wrap (default): word-wrap and elide nested brackets; truncate: cut after maxLabelLength
 * @property {number} [lineWidth]               Characters per line in wrap mode
 * @property {number} [maxLines]                Lines per statement in wrap mode
 * @property {number} [maxLabelLength]          Characters per label in truncate mode
 */

const DEFAULT_LABELS = { labelMode: 'wrap', lineWidth: 40, maxLines: 4, maxLabelLength: 60 };

function labelOptions(options = {}) {
    const merged = { ...DEFAULT_LABELS };
    for (const key of Object.keys(DEFAULT_LABELS)) {
        if (options[key] !== undefined && options[key] !== null) merged[key] = options[key];
    }
    merged.lineWidth = Math.max(10, merged.lineWidth);
    merged.maxLines = Math.max(1, merged.maxLines);
    return merged;
}

/** Positions of the bracket pairs of `text`, ignoring brackets inside strings. */
function bracketPairs(text) {
    const pairs = [];
    const stack = [];
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
        } else if (ch === '(' || ch === '[' || ch === '{') {
            stack.push({ open: i, ch });
        } else if (ch === ')' || ch === ']' || ch === '}') {
            const top = stack.pop();
            if (top) pairs.push({ open: top.open, close: i, depth: stack.length });
        }
    }
    return pairs;
}

/**
 * Shortens code by folding the content of nested brackets, innermost first
 * (like an editor folding a region), so the overall structure stays readable:
 *   fetch(url, { headers: { Accept: 'json', Auth: token }, retry: 3 })
 *   → fetch(url, { headers: {…}, retry: 3 })
 */
function elide(text, limit) {
    let result = text;
    for (let guard = 0; guard < 50 && result.length > limit; guard++) {
        const candidates = bracketPairs(result).filter((p) => {
            const inner = result.slice(p.open + 1, p.close).trim();
            return inner.length > 3 && inner !== '…';
        });
        if (!candidates.length) break;
        candidates.sort((a, b) => b.depth - a.depth || (b.close - b.open) - (a.close - a.open));
        const pick = candidates[0];
        result = `${result.slice(0, pick.open + 1)}…${result.slice(pick.close)}`;
    }
    return result;
}

/**
 * Folds the bodies of inline functions (`=> {…}`, `function () {…}`): used for
 * statements whose callbacks are drawn as their own flows.
 */
function foldRanges(text, ranges) {
    let result = String(text);
    for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
        if (start >= 0 && end <= result.length && start < end) result = `${result.slice(0, start)}{…}${result.slice(end)}`;
    }
    return result;
}

/** Removes line and block comments outside of strings (labels show code, not comments). */
function stripComments(text) {
    let out = '';
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            out += ch;
            if (ch === '\\') out += text[++i] || '';
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            out += ch;
        } else if (ch === '/' && text[i + 1] === '/' && (i === 0 || /\s/.test(text[i - 1]))) {
            // Only comments that start a line or follow whitespace: `//` also appears in regex literals.
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
        } else if (ch === '/' && text[i + 1] === '*' && (i === 0 || /[\s;{}(,]/.test(text[i - 1]))) {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 1;
            out += ' ';
        } else {
            out += ch;
        }
    }
    return out;
}

function foldFunctionBodies(text) {
    const pairs = bracketPairs(text).filter((p) => text[p.open] === '{' && text.slice(p.open + 1, p.close).trim() !== '…');
    const bodies = pairs.filter((p) => /(=>|\))\s*$/.test(text.slice(0, p.open)));
    // Outermost bodies only.
    const outer = bodies.filter((p) => !bodies.some((q) => q !== p && q.open < p.open && q.close > p.close));
    let result = text;
    for (const p of outer.sort((a, b) => b.open - a.open)) {
        result = `${result.slice(0, p.open + 1)}…${result.slice(p.close)}`;
    }
    return result;
}

/** Splits a long token at natural code boundaries (".", ",", "(", operators). */
function splitToken(token, width) {
    const parts = [];
    let rest = token;
    while (rest.length > width) {
        let cut = -1;
        for (let i = Math.min(width, rest.length - 1); i > width / 3; i--) {
            if ('.,(['.includes(rest[i]) || '=+-*/&|?:'.includes(rest[i - 1])) {
                cut = rest[i] === '.' || rest[i] === '(' || rest[i] === '[' ? i : i;
                break;
            }
        }
        if (cut <= 0) cut = width;
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest) parts.push(rest);
    return parts;
}

/** Word-wraps code into lines of at most `width` characters. */
function wrap(text, width) {
    const lines = [];
    let current = '';
    for (const word of text.split(' ')) {
        const pieces = word.length > width ? splitToken(word, width) : [word];
        for (const piece of pieces) {
            if (!current) current = piece;
            else if (current.length + 1 + piece.length <= width) current += ` ${piece}`;
            else {
                lines.push(current);
                current = piece;
            }
        }
    }
    if (current) lines.push(current);
    return lines;
}

/**
 * Formats one piece of code for display.
 * @param {string} text
 * @param {LabelOptions} options
 * @param {number} [maxLines]
 * @returns {string[]}
 */
function formatText(text, options, maxLines = options.maxLines) {
    const flat = collapse(stripComments(String(text)));
    if (!flat) return [];
    if (options.labelMode === 'truncate') return [truncate(flat, options.maxLabelLength)];
    const budget = options.lineWidth * maxLines;
    const lines = wrap(flat.length > budget ? elide(flat, budget) : flat, options.lineWidth);
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = truncate(`${kept[maxLines - 1]} …`, options.lineWidth + 2);
    return kept;
}

/** Human readable signature of a function start node. */
function signatureOf(meta) {
    if (!meta || meta.isMain) return 'Start';
    if (meta.blockName) return meta.blockName;
    if (meta.fnKind === 'callback') {
        const params = collapse(meta.params);
        const fn = meta.isArrow ? `${meta.async ? 'async ' : ''}(${params}) => …` : `${meta.async ? 'async ' : ''}function (${params}) …`;
        if (meta.callee === 'IIFE') return `↳ (${fn})()`;
        if (meta.jsxAttribute) return `↳ ${meta.callee}={${fn}}`;
        return `↳ ${meta.callee}(${fn})`;
    }
    const prefixes = [];
    if (meta.static) prefixes.push('static');
    if (meta.async) prefixes.push('async');
    if (meta.accessor) prefixes.push(meta.accessor);
    const prefix = prefixes.length ? `${prefixes.join(' ')} ` : '';
    return `${prefix}${meta.generator ? '*' : ''}${meta.displayName || meta.name || 'anonymous'}(${collapse(meta.params)})`;
}

/**
 * Display lines of a node (before escaping).
 * @param {GraphNode} node
 * @param {LabelOptions | number} [options]  label options, or a max length (truncate mode)
 * @returns {string[]}
 */
function displayLines(node, options = {}) {
    const opts = typeof options === 'number'
        ? labelOptions({ labelMode: 'truncate', maxLabelLength: options })
        : labelOptions(options);
    const first = node.code && node.code[0] !== undefined ? String(node.code[0]) : '';
    const meta = node.meta || {};
    const one = (text) => {
        const lines = formatText(text, opts);
        return lines.length ? lines : [node.kind];
    };
    switch (node.kind) {
        case 'start':
            return one(signatureOf(meta));
        case 'end':
            return ['End'];
        case 'process': {
            const code = node.code && node.code.length ? node.code : ['…'];
            const statements = meta.multiline
                ? code.flatMap((c) => String(c).split('\n')).map((l) => l.trim()).filter(Boolean)
                : code;
            const perStatement = statements.length > 1 ? Math.min(2, opts.maxLines) : opts.maxLines;
            const shown = [];
            for (const statement of statements.slice(0, 8)) {
                let text = String(statement);
                if (meta.folds && statements.length === 1) text = foldRanges(text, meta.folds);
                // Several statements keep their ";" so they can be told apart from wrapped lines.
                text = statements.length > 1 ? `${text.replace(/;\s*$/, '')};` : text.replace(/;\s*$/, '');
                shown.push(...formatText(text, opts, perStatement));
            }
            if (statements.length > 8) shown.push(`… +${statements.length - 8} more`);
            return shown.length ? shown : ['…'];
        }
        case 'decision': {
            // A diamond grows with the width of its text: wrap conditions narrower and taller.
            const narrow = { ...opts, lineWidth: Math.max(16, Math.round(opts.lineWidth * 0.7)) };
            const lines = formatText(meta.subtype === 'switch' ? `switch (${first})` : `if (${first})`, narrow, opts.maxLines + 2);
            return lines.length ? lines : ['if'];
        }
        case 'loop':
            if (meta.subtype === 'for' || meta.subtype === 'forin' || meta.subtype === 'forof') return one(meta.header);
            return one(`while (${first})`);
        case 'return':
        case 'throw':
            // Comments are removed by formatText before lines are collapsed.
            return one(String(first).trim().replace(/;\s*$/, '') || node.kind);
        case 'try':
            return ['try'];
        case 'catch':
            return one(first ? `catch (${first})` : 'catch');
        case 'finally':
            return ['finally'];
        case 'junction':
            if (meta.subtype === 'do') return ['do'];
            if (meta.subtype === 'finallyEnd') return ['end finally'];
            return [collapse(first) || '•'];
        default:
            return one(first || node.kind);
    }
}

/**
 * Full, untruncated text of a node (for tooltips and inspectors).
 * @param {GraphNode} node
 */
function fullText(node) {
    const meta = node.meta || {};
    const first = node.code && node.code[0] !== undefined ? String(node.code[0]) : '';
    switch (node.kind) {
        case 'start': return signatureOf(meta).replace(/…/g, '…');
        case 'end': return 'End';
        case 'process': return (node.code || []).join('\n');
        case 'decision': return meta.subtype === 'switch' ? `switch (${first})` : `if (${first})`;
        case 'loop': return meta.header && meta.subtype !== 'while' && meta.subtype !== 'dowhile' ? meta.header : `while (${first})`;
        case 'catch': return first ? `catch (${first})` : 'catch';
        case 'junction': return meta.subtype === 'do' ? 'do' : (meta.subtype === 'finallyEnd' ? 'end of the finally block' : first);
        default: return first || node.kind;
    }
}

/** @param {GraphEdge} edge */
function edgeLabel(edge) {
    if (edge.code !== undefined && edge.code !== null) return truncate(`case ${collapse(edge.code)}`, 40);
    return edge.label || '';
}

/**
 * Units whose code is embedded in another unit's statement: inline callbacks and
 * nested function declarations. They are drawn, but read-only and not emitted by codegen.
 */
function isEmbeddedUnit(unit) {
    return !!unit && (unit.kind === 'callback' || unit.kind === 'nested');
}

/** Edge kinds that do not belong to the normal control flow. */
const SPECIAL_EDGES = new Set(['exception', 'abrupt', 'callback']);

function isNormalEdge(edge) {
    return !edge.kind || !SPECIAL_EDGES.has(edge.kind);
}

const LINK_STYLES = {
    exception: 'stroke:#e53935,stroke-width:1.5px,stroke-dasharray:4 3',
    abrupt: 'stroke:#8e24aa,stroke-width:1.5px,stroke-dasharray:4 3',
    callback: 'stroke:#00897b,stroke-width:1.5px,stroke-dasharray:2 3'
};

/* ------------------------------------------------------------------------- */
/* Mermaid                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * @param {Graph} graph
 * @param {LabelOptions & { direction?: 'TD'|'LR', selectedId?: string }} [options]
 */
function toMermaid(graph, options = {}) {
    const opts = labelOptions(options);
    const direction = (options.direction || graph.direction) === 'LR' ? 'LR' : 'TD';
    const lines = [`flowchart ${direction}`];
    const grouped = graph.units.length > 1;
    const unreachableIds = new Set(graph.nodes.filter((n) => n.unreachable).map((n) => n.id));

    const nodeLine = (node) => {
        const finallyEnd = node.kind === 'junction' && node.meta && node.meta.subtype === 'finallyEnd';
        const [open, close] = finallyEnd ? SHAPES.start : (SHAPES[node.kind] || SHAPES.process);
        const label = displayLines(node, opts).map(escapeLabel).join('<br/>');
        return `${node.id}${open}"${label}"${close}`;
    };

    graph.units.forEach((unit, index) => {
        const unitNodes = graph.nodes.filter((n) => n.unit === index);
        if (grouped) {
            lines.push(`    subgraph sg${index}["${escapeLabel(unit.name)}"]`);
            unitNodes.forEach((n) => lines.push(`        ${nodeLine(n)}`));
            lines.push('    end');
        } else {
            unitNodes.forEach((n) => lines.push(`    ${nodeLine(n)}`));
        }
    });

    // Mermaid numbers links in declaration order (invisible ones included) for linkStyle.
    let linkIndex = 0;
    const styled = { exception: [], abrupt: [], callback: [] };

    if (grouped) {
        // Invisible links stack the subgraphs vertically instead of side by side.
        for (let i = 1; i < graph.units.length; i++) {
            lines.push(`    sg${i - 1} ~~~ sg${i}`);
            linkIndex++;
        }
    }

    for (const edge of graph.edges) {
        const special = edge.kind && SPECIAL_EDGES.has(edge.kind);
        const arrow = special || unreachableIds.has(edge.from) ? '-.->' : '-->';
        const text = edgeLabel(edge);
        const label = text ? `|"${escapeEdgeLabel(text)}"|` : '';
        lines.push(`    ${edge.from} ${arrow}${label} ${edge.to}`);
        if (special) styled[edge.kind].push(linkIndex);
        linkIndex++;
    }

    const byClass = new Map();
    const addClass = (cls, id) => {
        if (!byClass.has(cls)) byClass.set(cls, []);
        byClass.get(cls).push(id);
    };
    for (const node of graph.nodes) {
        if (node.unreachable) {
            addClass('cfUnreachable', node.id);
        } else {
            const cls = node.kind === 'junction' && node.meta && node.meta.subtype === 'finallyEnd' ? 'cfTry' : CLASS_BY_KIND[node.kind];
            if (cls) addClass(cls, node.id);
            if (node.async) addClass('cfAsync', node.id);
        }
        if (options.selectedId === node.id) addClass('cfSelected', node.id);
    }

    lines.push('');
    CLASS_DEFS.forEach((def) => lines.push(`    ${def}`));
    for (const [cls, ids] of byClass) lines.push(`    class ${ids.join(',')} ${cls}`);
    for (const [kind, indices] of Object.entries(styled)) {
        if (indices.length) lines.push(`    linkStyle ${indices.join(',')} ${LINK_STYLES[kind]}`);
    }
    return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------------- */
/* Graph utilities                                                            */
/* ------------------------------------------------------------------------- */

function cloneGraph(graph) {
    return JSON.parse(JSON.stringify(graph));
}

function indexGraph(graph) {
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const out = new Map(graph.nodes.map((n) => [n.id, []]));
    const inc = new Map(graph.nodes.map((n) => [n.id, []]));
    for (const edge of graph.edges) {
        if (out.has(edge.from)) out.get(edge.from).push(edge);
        if (inc.has(edge.to)) inc.get(edge.to).push(edge);
    }
    return { nodes, out, inc };
}

/** Recomputes the `unreachable` flag of every node from the start nodes. */
function markReachability(graph) {
    const { out } = indexGraph(graph);
    const seen = new Set();
    const stack = graph.units.map((u) => u.startId);
    while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        for (const edge of out.get(id) || []) stack.push(edge.to);
    }
    for (const node of graph.nodes) {
        node.unreachable = !seen.has(node.id) && node.kind !== 'end';
    }
    return graph;
}

function nextNodeId(graph) {
    let max = -1;
    for (const node of graph.nodes) {
        const match = /^n(\d+)$/.exec(node.id);
        if (match) max = Math.max(max, Number(match[1]));
    }
    return `n${max + 1}`;
}

module.exports = {
    GRAPH_VERSION,
    collapse,
    truncate,
    escapeLabel,
    escapeEdgeLabel,
    signatureOf,
    displayLines,
    fullText,
    formatText,
    elide,
    foldFunctionBodies,
    foldRanges,
    stripComments,
    wrap,
    labelOptions,
    DEFAULT_LABELS,
    isNormalEdge,
    isEmbeddedUnit,
    edgeLabel,
    toMermaid,
    cloneGraph,
    indexGraph,
    markReachability,
    nextNodeId
};
