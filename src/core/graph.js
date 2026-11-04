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
 *
 * @typedef {Object} GraphUnit
 * @property {string} name
 * @property {'function'|'main'|'block'} kind
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
        .replace(/"/g, "'")
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

/** Human readable signature of a function start node. */
function signatureOf(meta) {
    if (!meta || meta.isMain) return 'Start';
    if (meta.blockName) return meta.blockName;
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
 * @param {number} max
 * @returns {string[]}
 */
function displayLines(node, max = 60) {
    const first = collapse(node.code && node.code[0]);
    const meta = node.meta || {};
    switch (node.kind) {
        case 'start':
            return [truncate(signatureOf(meta), Math.max(max, 40))];
        case 'end':
            return ['End'];
        case 'process': {
            const code = node.code && node.code.length ? node.code : ['…'];
            const lines = meta.multiline
                ? code.flatMap((c) => String(c).split('\n')).map((l) => l.trim()).filter(Boolean)
                : code;
            const shown = lines.slice(0, 8).map((c) => truncate(collapse(c).replace(/;$/, '') || '…', max));
            if (lines.length > 8) shown.push(`… +${lines.length - 8} lines`);
            return shown.length ? shown : ['…'];
        }
        case 'decision':
            return [truncate(meta.subtype === 'switch' ? `switch (${first})` : `if (${first})`, max)];
        case 'loop':
            if (meta.subtype === 'for' || meta.subtype === 'forin' || meta.subtype === 'forof') {
                return [truncate(collapse(meta.header), max)];
            }
            return [truncate(`while (${first})`, max)];
        case 'return':
        case 'throw':
            return [truncate(first.replace(/;$/, '') || node.kind, max)];
        case 'try':
            return ['try'];
        case 'catch':
            return [truncate(first ? `catch (${first})` : 'catch', max)];
        case 'finally':
            return ['finally'];
        case 'junction':
            return [meta.subtype === 'do' ? 'do' : (first || '•')];
        default:
            return [truncate(first || node.kind, max)];
    }
}

/** @param {GraphEdge} edge */
function edgeLabel(edge) {
    if (edge.code !== undefined && edge.code !== null) return truncate(`case ${collapse(edge.code)}`, 30);
    return edge.label || '';
}

/* ------------------------------------------------------------------------- */
/* Mermaid                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * @param {Graph} graph
 * @param {{ maxLabelLength?: number, direction?: 'TD'|'LR', selectedId?: string }} [options]
 */
function toMermaid(graph, options = {}) {
    const max = options.maxLabelLength || 60;
    const direction = (options.direction || graph.direction) === 'LR' ? 'LR' : 'TD';
    const lines = [`flowchart ${direction}`];
    const grouped = graph.units.length > 1;
    const unreachableIds = new Set(graph.nodes.filter((n) => n.unreachable).map((n) => n.id));

    const nodeLine = (node) => {
        const [open, close] = SHAPES[node.kind] || SHAPES.process;
        const label = displayLines(node, max).map(escapeLabel).join('<br/>');
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

    if (grouped) {
        // Invisible links stack the subgraphs vertically instead of side by side.
        for (let i = 1; i < graph.units.length; i++) lines.push(`    sg${i - 1} ~~~ sg${i}`);
    }

    for (const edge of graph.edges) {
        const arrow = unreachableIds.has(edge.from) ? '-.->' : '-->';
        const text = edgeLabel(edge);
        const label = text ? `|"${escapeEdgeLabel(text)}"|` : '';
        lines.push(`    ${edge.from} ${arrow}${label} ${edge.to}`);
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
            if (CLASS_BY_KIND[node.kind]) addClass(CLASS_BY_KIND[node.kind], node.id);
            if (node.async) addClass('cfAsync', node.id);
        }
        if (options.selectedId === node.id) addClass('cfSelected', node.id);
    }

    lines.push('');
    CLASS_DEFS.forEach((def) => lines.push(`    ${def}`));
    for (const [cls, ids] of byClass) lines.push(`    class ${ids.join(',')} ${cls}`);
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
    edgeLabel,
    toMermaid,
    cloneGraph,
    indexGraph,
    markReachability,
    nextNodeId
};
