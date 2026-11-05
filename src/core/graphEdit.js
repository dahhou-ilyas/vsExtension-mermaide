'use strict';

/**
 * Editing operations on a flowchart graph. Every operation is pure: it returns
 * a new graph and never mutates its input, which makes undo / redo trivial.
 *
 * Operations only ever produce *structured* shapes (sequence, if, loop, return),
 * so a graph edited with them can always be turned back into readable code.
 */

const { cloneGraph, indexGraph, nextNodeId, markReachability, isNormalEdge, isEmbeddedUnit } = require('./graph');

class GraphEditError extends Error {}

const INSERTABLE = Object.freeze({
    process: { label: 'Step', code: ['doSomething();'] },
    decision: { label: 'Condition', code: ['condition'] },
    loop: { label: 'Loop', code: ['condition'] },
    return: { label: 'Return', code: ['return result;'] },
    throw: { label: 'Throw', code: ["throw new Error('message');"] }
});

function findNode(graph, id) {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) throw new GraphEditError(`Unknown node ${id}.`);
    return node;
}

/**
 * Whether the flow of an embedded unit (inline callback, nested function) can
 * be edited: the builder recorded where its body lies in the statement that
 * holds it, so the code generator can put the edited body back there.
 */
function isSpliceable(unit) {
    return !!(unit && unit.host && unit.sig);
}

/**
 * Nodes of embedded flows are editable when their body can be spliced back
 * into the parent statement. Their signature (parameters, name) belongs to
 * the parent statement and is edited there.
 */
function assertEditable(graph, node, { header = false } = {}) {
    const unit = graph.units[node.unit];
    if (!isEmbeddedUnit(unit)) return;
    if (!isSpliceable(unit)) {
        throw new GraphEditError(unit.kind === 'nested'
            ? 'This node belongs to a nested function. Edit its definition in the parent flow instead.'
            : 'This node belongs to an inline callback. Edit the statement that contains the callback instead.');
    }
    if (header && node.kind === 'start') {
        throw new GraphEditError('The parameters of an inline callback are part of the statement that contains it. Edit that statement to change them.');
    }
}

/**
 * Removes units and renumbers `node.unit` accordingly.
 * @param {import('./graph').Graph} graph
 * @param {Set<number>} indices
 */
function removeUnits(graph, indices) {
    if (!indices.size) return graph;
    const removedNodes = new Set(graph.nodes.filter((n) => indices.has(n.unit)).map((n) => n.id));
    const mapping = new Map();
    let next = 0;
    graph.units.forEach((_, i) => { if (!indices.has(i)) mapping.set(i, next++); });
    graph.units = graph.units.filter((_, i) => !indices.has(i));
    graph.nodes = graph.nodes.filter((n) => !removedNodes.has(n.id));
    graph.nodes.forEach((n) => { n.unit = mapping.get(n.unit); });
    graph.edges = graph.edges.filter((e) => !removedNodes.has(e.from) && !removedNodes.has(e.to));
    return graph;
}

/**
 * Removes the callback flows that hang off `nodeIds` (and their own nested
 * callbacks): their code changed or disappeared with the statement.
 */
function dropCallbacksOf(graph, nodeIds) {
    const doomed = new Set();
    let frontier = new Set(nodeIds);
    while (frontier.size) {
        const nextFrontier = new Set();
        for (const edge of graph.edges) {
            if (edge.kind !== 'callback' || !frontier.has(edge.from)) continue;
            const start = graph.nodes.find((n) => n.id === edge.to);
            if (!start || doomed.has(start.unit)) continue;
            doomed.add(start.unit);
            graph.nodes.filter((n) => n.unit === start.unit).forEach((n) => nextFrontier.add(n.id));
        }
        frontier = nextFrontier;
    }
    return removeUnits(graph, doomed);
}

function addNode(graph, kind, unit, code, meta = {}) {
    const node = { id: nextNodeId(graph), kind, unit, code, meta };
    graph.nodes.push(node);
    return node;
}

/** Removes nodes that can no longer be reached from a start node (except end nodes). */
function prune(graph) {
    const { out } = indexGraph(graph);
    const keep = new Set();
    const stack = graph.units.flatMap((u) => [u.startId]);
    while (stack.length) {
        const id = stack.pop();
        if (keep.has(id)) continue;
        keep.add(id);
        for (const edge of out.get(id) || []) stack.push(edge.to);
    }
    graph.units.forEach((u) => keep.add(u.endId));
    graph.nodes = graph.nodes.filter((n) => keep.has(n.id));
    graph.edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));

    // Callback flows whose statement was removed are orphans.
    for (let changed = true; changed;) {
        const orphans = new Set();
        graph.units.forEach((unit, index) => {
            if (isEmbeddedUnit(unit) && !graph.edges.some((e) => e.kind === 'callback' && e.to === unit.startId)) orphans.add(index);
        });
        changed = orphans.size > 0;
        removeUnits(graph, orphans);
    }
    return markReachability(graph);
}

/**
 * Changes the code of a node.
 * @param {import('./graph').Graph} graph
 * @param {string} id
 * @param {{ code?: string, header?: string, name?: string, params?: string }} changes
 */
function updateNode(graph, id, changes) {
    let next = cloneGraph(graph);
    const node = findNode(next, id);
    assertEditable(next, node, { header: true });
    node.meta = node.meta || {};
    switch (node.kind) {
        case 'start':
            if (node.meta.isMain || node.meta.blockName) throw new GraphEditError('This start node has no signature.');
            if (changes.name !== undefined) {
                const name = changes.name.trim();
                if (!/^[A-Za-z_$#[][\w$\]'".]*$/.test(name)) throw new GraphEditError(`"${name}" is not a valid function name.`);
                node.meta.name = name;
                node.meta.displayName = name;
                next.units[node.unit].name = name;
            }
            if (changes.params !== undefined) node.meta.params = changes.params.trim();
            break;
        case 'process':
            node.code = [String(changes.code ?? '').replace(/\s+$/, '')];
            node.meta.multiline = true;
            // The comments inside the node were part of the edited text (see editableText).
            if (node.comments) {
                const first = node.comments[0] || {};
                const kept = { ...(first.lead ? { lead: first.lead } : {}), ...(first.blank ? { blank: true } : {}) };
                if (Object.keys(kept).length) node.comments = { 0: kept };
                else delete node.comments;
            }
            break;
        case 'loop':
            if (node.meta.subtype === 'for' || node.meta.subtype === 'forin' || node.meta.subtype === 'forof') {
                const header = String(changes.header ?? changes.code ?? '').trim();
                const match = /^for\s*(await\s*)?\(([\s\S]*)\)$/.exec(header);
                if (!match) throw new GraphEditError('A for loop header must look like "for (…)".');
                node.meta.header = header;
                node.meta.subtype = /\s(of|in)\s/.test(match[2]) && !/;/.test(match[2])
                    ? (/\sof\s/.test(match[2]) ? 'forof' : 'forin')
                    : 'for';
            } else {
                node.code = [String(changes.code ?? '').trim() || 'true'];
            }
            break;
        case 'decision':
        case 'catch':
            node.code = [String(changes.code ?? '').trim()];
            if (node.kind === 'decision' && !node.code[0]) throw new GraphEditError('A condition cannot be empty.');
            break;
        case 'return':
        case 'throw': {
            let code = String(changes.code ?? '').trim();
            if (!new RegExp(`^${node.kind}\\b`).test(code)) code = `${node.kind} ${code}`.trim();
            node.code = [code];
            break;
        }
        default:
            throw new GraphEditError(`A ${node.kind} node cannot be edited.`);
    }
    node.async = node.code.some((c) => /\bawait\b/.test(c));
    delete node.start;
    delete node.end;
    // The code changed: callbacks drawn from the old code are stale, and so are its exception edges.
    next.edges = next.edges.filter((e) => !(e.from === id && e.kind === 'exception' && node.kind !== 'throw'));
    next = dropCallbacksOf(next, [id]);
    return next;
}

/**
 * Inserts a new construct on an edge.
 *
 * @param {import('./graph').Graph} graph
 * @param {number} edgeIndex  Index in graph.edges
 * @param {'process'|'decision'|'loop'|'return'|'throw'} kind
 * @returns {{ graph: import('./graph').Graph, nodeId: string }}
 */
function insertOnEdge(graph, edgeIndex, kind) {
    if (!INSERTABLE[kind]) throw new GraphEditError(`Cannot insert a ${kind}.`);
    const next = cloneGraph(graph);
    const edge = next.edges[edgeIndex];
    if (!edge) throw new GraphEditError('Unknown edge.');
    if (!isNormalEdge(edge)) throw new GraphEditError('Steps can only be inserted on the normal flow (not on exception, finally or callback links).');
    const from = findNode(next, edge.from);
    assertEditable(next, from);
    if (from.kind === 'return' || from.kind === 'throw') throw new GraphEditError('Nothing runs after a return or a throw.');
    const unit = from.unit;
    const target = edge.to;
    const template = INSERTABLE[kind];
    const node = addNode(next, kind, unit, [...template.code], kind === 'loop' ? { subtype: 'while' } : (kind === 'decision' ? { subtype: 'if' } : {}));
    edge.to = node.id;

    switch (kind) {
        case 'process':
            node.meta.multiline = true;
            next.edges.push({ from: node.id, to: target, label: '' });
            break;
        case 'decision':
            next.edges.push({ from: node.id, to: target, label: 'yes' });
            next.edges.push({ from: node.id, to: target, label: 'no' });
            break;
        case 'loop': {
            const body = addNode(next, 'process', unit, ['step();'], { multiline: true });
            next.edges.push({ from: node.id, to: body.id, label: 'yes' });
            next.edges.push({ from: body.id, to: node.id, label: '' });
            next.edges.push({ from: node.id, to: target, label: 'no' });
            break;
        }
        case 'return':
        case 'throw':
            next.edges.push({ from: node.id, to: next.units[unit].endId, label: kind === 'throw' ? 'throws' : '' });
            break;
        default:
            break;
    }
    return { graph: prune(next), nodeId: node.id };
}

/**
 * Deletes a node and reconnects its predecessors:
 *  - statement / return / throw: to the next node (or the end);
 *  - condition: to its "yes" branch (the "no" branch is removed);
 *  - loop: to the code after the loop (the body is removed).
 */
function deleteNode(graph, id) {
    let next = cloneGraph(graph);
    const node = findNode(next, id);
    assertEditable(next, node);
    next = dropCallbacksOf(next, [id]);
    const { out } = indexGraph(next);
    const outgoing = (out.get(id) || []).filter(isNormalEdge);
    const unit = next.units[node.unit];
    let replacement;

    switch (node.kind) {
        case 'start':
        case 'end':
            throw new GraphEditError('The start and end of a flowchart cannot be deleted.');
        case 'try':
        case 'catch':
        case 'finally':
            throw new GraphEditError('try / catch / finally blocks cannot be deleted from the chart. Edit the code instead.');
        case 'process':
        case 'junction':
            replacement = outgoing[0] ? outgoing[0].to : unit.endId;
            break;
        case 'return':
        case 'throw':
            replacement = unit.endId;
            break;
        case 'decision': {
            const yes = outgoing.find((e) => e.label === 'yes') || outgoing[0];
            replacement = yes ? yes.to : unit.endId;
            break;
        }
        case 'loop': {
            const exit = outgoing.find((e) => e.label === 'no' || e.label === 'done');
            replacement = exit ? exit.to : unit.endId;
            break;
        }
        default:
            throw new GraphEditError(`A ${node.kind} node cannot be deleted.`);
    }
    if (replacement === id) replacement = unit.endId;

    for (const edge of next.edges) {
        if (edge.to === id && edge.from !== id && isNormalEdge(edge)) edge.to = replacement;
    }
    next.edges = next.edges.filter((e) => e.from !== id && e.to !== id);
    next.nodes = next.nodes.filter((n) => n.id !== id);
    return prune(next);
}

/**
 * A blank flowchart: one function with a start and an end.
 * @param {{ name?: string, params?: string, async?: boolean }} [options]
 */
function newGraph(options = {}) {
    const name = options.name || 'myFunction';
    return {
        version: 1,
        direction: 'TD',
        units: [{ name, kind: 'function', startId: 'n0', endId: 'n1' }],
        nodes: [
            {
                id: 'n0',
                kind: 'start',
                unit: 0,
                code: [],
                meta: { fnKind: 'function', name, displayName: name, params: options.params || '', async: !!options.async, generator: false }
            },
            { id: 'n1', kind: 'end', unit: 0, code: [], meta: {} },
            { id: 'n2', kind: 'process', unit: 0, code: ['// your code'], meta: { multiline: true } }
        ],
        edges: [
            { from: 'n0', to: 'n2', label: '' },
            { from: 'n2', to: 'n1', label: '' }
        ]
    };
}

/** Which edges leave a node, with a readable description, for the editor UI. */
function outgoingEdges(graph, id) {
    return graph.edges
        .map((edge, index) => ({ edge, index }))
        .filter(({ edge }) => edge.from === id && isNormalEdge(edge));
}

/** Whether a node can be edited in the visual editor. */
function isEditable(graph, id) {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return false;
    const unit = graph.units[node.unit];
    return !isEmbeddedUnit(unit) || isSpliceable(unit);
}

/**
 * Code of a process node as shown in the editor: its statements with the
 * comments between them, so editing the text keeps (or changes) them. The
 * comments above the first statement stay attached to the node.
 * @returns {string}
 */
function editableText(node) {
    const notes = node.comments || {};
    const lines = [];
    (node.code || []).forEach((code, i) => {
        const note = notes[i] || {};
        if (i > 0) {
            if (note.blank) lines.push('');
            (note.lead || []).forEach((c) => lines.push(c));
        }
        lines.push(note.tail ? `${code} ${note.tail}` : String(code));
        (note.after || []).forEach((c) => lines.push(c));
    });
    return lines.join('\n');
}

module.exports = { updateNode, insertOnEdge, deleteNode, newGraph, outgoingEdges, prune, isEditable, isSpliceable, editableText, removeUnits, GraphEditError, INSERTABLE };
