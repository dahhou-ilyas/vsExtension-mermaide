'use strict';

/**
 * Flowchart layout engine (no Mermaid, no third-party layout library).
 *
 * A layered (Sugiyama) layout specialised for control-flow graphs:
 *
 *  1. Cycle removal     DFS from the start node; back edges are the loops.
 *  2. Layering          Longest path over the acyclic graph (top → bottom).
 *  3. Spine             Every node picks the child leading to the longest
 *                       continuation; those links get a heavy weight so the main
 *                       path is a straight vertical line (the "vertical alignment"
 *                       idea of Brandes & Köpf, used by dagre).
 *  4. Normalisation     Long forward edges get dummy nodes so they bend around nodes.
 *  5. Ordering          DFS order ("yes" left of "no"), then barycenter sweeps.
 *  6. Coordinates       Weighted medians of the neighbours, overlaps removed
 *                       exactly by isotonic regression (pool-adjacent-violators).
 *  7. Routing           Branches leave a condition from its side vertices, the
 *                       main path from the bottom. Loops run in a gutter on the
 *                       right and exceptional flow in a gutter on the left (VEIL,
 *                       2025), entering their target from the side when nothing is
 *                       in the way. Routes are orthogonal polylines; renderers
 *                       draw them with rounded corners or curves.
 *
 * Everything is computed in an abstract (u = across layers, v = along the flow)
 * space, then mapped to x / y, so the same code handles top-down and left-right.
 */

const { displayLines, isNormalEdge, isEmbeddedUnit, edgeLabel, labelOptions } = require('./graph');

const DEFAULTS = {
    direction: 'TD',
    shapes: 'classic',      // 'classic' (ISO 5807 symbols) or 'compact'
    nodeGap: 40,            // between nodes of a layer
    layerGap: 46,           // between layers
    gutterGap: 28,          // first gutter lane from the nodes
    laneGap: 12,            // between gutter lanes
    unitGap: 90,            // between flows (functions / callbacks)
    unitPadding: 28,
    unitTitle: 34,
    sweeps: 8,
    lineHeight: 18,
    fontSize: 13,
    maxRowWidth: 1900,
    spineWeight: 16
};

/** Rough text width when no measuring function is given (tests, Node). */
function approxMeasure(text, fontSize = DEFAULTS.fontSize) {
    return String(text).length * fontSize * 0.6;
}

/* ------------------------------------------------------------------------- */
/* Node sizes                                                                 */
/* ------------------------------------------------------------------------- */

const COMPACT_PADDING = {
    start: [18, 9], end: [16, 8], process: [16, 11], decision: [30, 11], loop: [24, 11],
    return: [18, 10], throw: [22, 10], try: [16, 8], catch: [16, 8], finally: [16, 8], junction: [10, 8]
};

/**
 * Size of a node so that its text fits inside its symbol.
 * Classic symbols (ISO 5807): terminator, process, decision diamond,
 * preparation hexagon (loops), predefined process (try / catch / definitions).
 */
function nodeBox(node, labels, measure, opts) {
    const lines = displayLines(node, labels);
    const w = Math.max(...lines.map((l) => measure(l, opts.fontSize)), 0);
    const h = lines.length * opts.lineHeight;
    const meta = node.meta || {};
    let width;
    let height;
    if (opts.shapes === 'classic') {
        switch (node.kind) {
            case 'decision': {
                // Text box w × h inside a diamond of aspect a: H ≥ h + w / a.
                const a = 2.1;
                height = Math.max(56, h + w / a + 18);
                width = Math.max(120, height * a);
                break;
            }
            case 'loop': {
                height = h + 20;
                width = w + height + 28;
                break;
            }
            case 'start':
            case 'end':
            case 'return':
                height = h + 16;
                width = Math.max(84, w + height + 18);
                break;
            case 'junction':
                if (meta.subtype === 'finallyEnd') {
                    height = h + 10;
                    width = w + height + 10;
                } else {
                    width = 34;
                    height = 34;
                }
                break;
            case 'try':
            case 'catch':
            case 'finally':
                height = h + 18;
                width = w + 52;
                break;
            default:
                height = h + 20;
                width = w + (meta.declaration ? 52 : 30);
        }
        width = Math.max(width, 64);
    } else {
        const [px, py] = COMPACT_PADDING[node.kind] || COMPACT_PADDING.process;
        width = w + px * 2;
        height = h + py * 2;
        if (node.kind === 'junction' && meta.subtype !== 'finallyEnd') {
            width = Math.max(30, w + 18);
            height = 30;
        }
        if (node.kind === 'start' || node.kind === 'end') width = Math.max(width, 74);
        width = Math.max(width, node.kind === 'decision' ? 110 : 52);
    }
    return { lines, width: Math.ceil(width), height: Math.ceil(height) };
}

/* ------------------------------------------------------------------------- */
/* Isotonic regression with spacing (exact 1-D overlap removal)               */
/* ------------------------------------------------------------------------- */

/**
 * Positions `desired` (sorted by order) as close as possible (least squares,
 * weighted) while keeping x[i+1] - x[i] >= gaps[i]. Pool-adjacent-violators.
 */
function placeWithGaps(desired, gaps, weights) {
    const n = desired.length;
    const offsets = new Array(n).fill(0);
    for (let i = 1; i < n; i++) offsets[i] = offsets[i - 1] + gaps[i - 1];
    const blocks = [];
    for (let i = 0; i < n; i++) {
        blocks.push({ value: desired[i] - offsets[i], weight: weights[i], start: i, end: i });
        while (blocks.length > 1 && blocks[blocks.length - 2].value > blocks[blocks.length - 1].value) {
            const b = blocks.pop();
            const a = blocks.pop();
            const weight = a.weight + b.weight;
            blocks.push({ value: (a.value * a.weight + b.value * b.weight) / weight, weight, start: a.start, end: b.end });
        }
    }
    const result = new Array(n);
    for (const block of blocks) {
        for (let i = block.start; i <= block.end; i++) result[i] = block.value + offsets[i];
    }
    return result;
}

function weightedMedian(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a.value - b.value);
    const total = sorted.reduce((s, v) => s + v.weight, 0);
    let acc = 0;
    for (let i = 0; i < sorted.length; i++) {
        acc += sorted[i].weight;
        if (acc >= total / 2) {
            if (acc === total / 2 && i + 1 < sorted.length) return (sorted[i].value + sorted[i + 1].value) / 2;
            return sorted[i].value;
        }
    }
    return sorted[sorted.length - 1].value;
}

/* ------------------------------------------------------------------------- */
/* One unit (function / callback)                                             */
/* ------------------------------------------------------------------------- */

const BRANCH_ORDER = { yes: 0, true: 0, next: 0, case: 1, default: 3, error: 4, no: 2, false: 2, done: 2, 'no match': 4 };

function branchRank(edge) {
    if (edge.label in BRANCH_ORDER) return BRANCH_ORDER[edge.label];
    return 1;
}

function layoutUnit(graph, unitIndex, ctx) {
    const { opts, labels, measure } = ctx;
    const unit = graph.units[unitIndex];
    const nodes = graph.nodes.filter((n) => n.unit === unitIndex);
    const ids = new Set(nodes.map((n) => n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.kind !== 'callback');

    // Sizes in abstract space: su across layers, sv along the flow.
    const horizontal = opts.direction === 'LR';
    const box = new Map();
    for (const node of nodes) {
        const b = nodeBox(node, labels, measure, opts);
        box.set(node.id, { ...b, su: horizontal ? b.height : b.width, sv: horizontal ? b.width : b.height });
    }

    // 1. Cycle removal: DFS from the start, normal edges first ("yes" before "no").
    const out = new Map(nodes.map((n) => [n.id, []]));
    edges.forEach((e) => out.get(e.from).push(e));
    out.forEach((list) => list.sort((a, b) => (isNormalEdge(a) === isNormalEdge(b) ? branchRank(a) - branchRank(b) : (isNormalEdge(a) ? -1 : 1))));
    const state = new Map();
    const back = new Set();
    const dfsOrder = [];
    const visit = (id) => {
        state.set(id, 1);
        dfsOrder.push(id);
        for (const e of out.get(id)) {
            const s = state.get(e.to);
            if (s === 1) back.add(e);
            else if (!s) visit(e.to);
        }
        state.set(id, 2);
    };
    if (ids.has(unit.startId)) visit(unit.startId);
    for (const n of nodes) if (!state.get(n.id)) visit(n.id);

    // 2. Layering: longest path on the acyclic graph (exceptional edges included, so a
    //    catch sits below the statements that throw into it).
    const forward = edges.filter((e) => !back.has(e));
    const inDeg = new Map(nodes.map((n) => [n.id, 0]));
    forward.forEach((e) => inDeg.set(e.to, inDeg.get(e.to) + 1));
    const rank = new Map(nodes.map((n) => [n.id, 0]));
    const queue = nodes.filter((n) => inDeg.get(n.id) === 0).map((n) => n.id);
    const fwdOut = new Map(nodes.map((n) => [n.id, []]));
    forward.forEach((e) => fwdOut.get(e.from).push(e));
    const topo = [];
    while (queue.length) {
        const id = queue.shift();
        topo.push(id);
        for (const e of fwdOut.get(id)) {
            rank.set(e.to, Math.max(rank.get(e.to), rank.get(id) + 1));
            inDeg.set(e.to, inDeg.get(e.to) - 1);
            if (inDeg.get(e.to) === 0) queue.push(e.to);
        }
    }
    if (ids.has(unit.endId)) {
        const maxRank = Math.max(...nodes.filter((n) => n.id !== unit.endId).map((n) => rank.get(n.id)), 0);
        rank.set(unit.endId, Math.max(rank.get(unit.endId), maxRank + 1));
    }
    for (const n of [...nodes].reverse()) {
        const succ = fwdOut.get(n.id).filter((e) => isNormalEdge(e));
        const preds = forward.filter((e) => e.to === n.id);
        if (!preds.length && succ.length) {
            rank.set(n.id, Math.max(rank.get(n.id), Math.min(...succ.map((e) => rank.get(e.to))) - 1));
        }
    }

    // 3. Spine: each node prefers the child with the longest continuation.
    const height = new Map(nodes.map((n) => [n.id, 0]));
    for (const id of [...topo].reverse()) {
        for (const e of fwdOut.get(id)) {
            if (isNormalEdge(e)) height.set(id, Math.max(height.get(id), height.get(e.to) + 1));
        }
    }
    const dfsIndex = new Map(dfsOrder.map((id, i) => [id, i]));
    const spineChild = new Map();
    for (const n of nodes) {
        const candidates = fwdOut.get(n.id).filter((e) => isNormalEdge(e) && rank.get(e.to) > rank.get(n.id));
        if (!candidates.length) continue;
        candidates.sort((a, b) => height.get(b.to) - height.get(a.to) || branchRank(a) - branchRank(b));
        spineChild.set(n.id, candidates[0]);
    }
    const spine = new Set();
    const claimed = new Set();
    for (const id of [...dfsOrder]) {
        const e = spineChild.get(id);
        if (e && !claimed.has(e.to)) {
            spine.add(e);
            claimed.add(e.to);
        }
    }

    // 4. Normalisation: dummy chains for long normal forward edges. Exceptional edges
    //    are routed in the left gutter and do not take part in the ordering.
    const layers = [];
    const put = (id, r) => {
        while (layers.length <= r) layers.push([]);
        layers[r].push(id);
    };
    nodes.forEach((n) => put(n.id, rank.get(n.id)));
    const vnodes = new Map(nodes.map((n) => [n.id, { id: n.id, dummy: false, su: box.get(n.id).su, sv: box.get(n.id).sv, rank: rank.get(n.id) }]));
    const chains = [];
    let dummyCount = 0;
    for (const e of forward) {
        if (!isNormalEdge(e)) continue;
        const r0 = rank.get(e.from);
        const r1 = rank.get(e.to);
        const chain = [e.from];
        for (let r = r0 + 1; r < r1; r++) {
            const id = `__d${dummyCount++}`;
            vnodes.set(id, { id, dummy: true, su: 2, sv: 0, rank: r, source: e.from });
            put(id, r);
            chain.push(id);
        }
        chain.push(e.to);
        chains.push({ edge: e, chain });
    }
    const up = new Map([...vnodes.keys()].map((id) => [id, []]));
    const down = new Map([...vnodes.keys()].map((id) => [id, []]));
    for (const e of forward) {
        if (isNormalEdge(e)) continue;
        down.get(e.from).push({ id: e.to, weight: 0.35 });
        up.get(e.to).push({ id: e.from, weight: 0.35 });
    }
    for (const { edge, chain } of chains) {
        const isSpine = spine.has(edge);
        for (let i = 0; i + 1 < chain.length; i++) {
            const dummy = vnodes.get(chain[i]).dummy || vnodes.get(chain[i + 1]).dummy;
            const weight = isSpine ? opts.spineWeight : (dummy ? 4 : 1);
            down.get(chain[i]).push({ id: chain[i + 1], weight });
            up.get(chain[i + 1]).push({ id: chain[i], weight });
        }
    }

    // 5. Ordering: DFS discovery order first, then barycenter sweeps.
    const order = new Map();
    layers.forEach((layer) => {
        const key = (id) => (vnodes.get(id).dummy ? (dfsIndex.get(vnodes.get(id).source) ?? 0) + 0.5 : dfsIndex.get(id) ?? 0);
        layer.sort((a, b) => key(a) - key(b));
        layer.forEach((id, i) => order.set(id, i));
    });
    const crossings = () => countCrossings(layers, down, order);
    let best = layers.map((l) => [...l]);
    let bestCrossings = crossings();
    for (let sweep = 0; sweep < opts.sweeps && bestCrossings > 0; sweep++) {
        const downward = sweep % 2 === 0;
        const range = downward ? [...layers.keys()].slice(1) : [...layers.keys()].reverse().slice(1);
        for (const r of range) {
            const layer = layers[r];
            const neighbours = downward ? up : down;
            const bary = new Map(layer.map((id) => {
                const ns = neighbours.get(id);
                if (!ns.length) return [id, order.get(id)];
                return [id, ns.reduce((s, n) => s + order.get(n.id) * n.weight, 0) / ns.reduce((s, n) => s + n.weight, 0)];
            }));
            layer.sort((a, b) => bary.get(a) - bary.get(b) || order.get(a) - order.get(b));
            layer.forEach((id, i) => order.set(id, i));
        }
        const c = crossings();
        if (c < bestCrossings) {
            bestCrossings = c;
            best = layers.map((l) => [...l]);
        }
    }
    best.forEach((layer, r) => {
        layers[r] = layer;
        layer.forEach((id, i) => order.set(id, i));
    });

    // 6. Coordinates across layers (u): medians + isotonic overlap removal.
    const pos = new Map();
    layers.forEach((layer) => {
        let u = 0;
        for (const id of layer) {
            const v = vnodes.get(id);
            pos.set(id, u + v.su / 2);
            u += v.su + opts.nodeGap;
        }
    });
    const gapBetween = (a, b) => {
        const va = vnodes.get(a);
        const vb = vnodes.get(b);
        const gap = va.dummy && vb.dummy ? 16 : (va.dummy || vb.dummy ? opts.nodeGap / 2 + 8 : opts.nodeGap);
        return va.su / 2 + vb.su / 2 + gap;
    };
    const relax = (layer, neighbours) => {
        if (!layer.length) return;
        const desired = layer.map((id) => {
            const m = weightedMedian(neighbours.get(id).map((n) => ({ value: pos.get(n.id), weight: n.weight })));
            return m === null ? pos.get(id) : m;
        });
        const weights = layer.map((id) => {
            const ns = neighbours.get(id);
            return (vnodes.get(id).dummy ? 2 : 1) + ns.reduce((s, n) => s + n.weight, 0);
        });
        const gaps = layer.slice(1).map((id, i) => gapBetween(layer[i], id));
        placeWithGaps(desired, gaps, weights).forEach((u, i) => pos.set(layer[i], u));
    };
    const both = new Map([...vnodes.keys()].map((id) => [id, [...up.get(id), ...down.get(id)]]));
    for (let i = 0; i < 8; i++) {
        for (let r = 1; r < layers.length; r++) relax(layers[r], up);
        for (let r = layers.length - 2; r >= 0; r--) relax(layers[r], down);
    }
    for (let r = 0; r < layers.length; r++) relax(layers[r], both);
    for (let r = 1; r < layers.length; r++) relax(layers[r], up);

    // Along the flow (v): each layer is as thick as its biggest node.
    const layerV = [];
    let v = 0;
    layers.forEach((layer, r) => {
        const thickness = Math.max(...layer.map((id) => vnodes.get(id).sv), 0);
        layerV[r] = { top: v, thickness };
        v += thickness + opts.layerGap;
    });
    const totalV = v - opts.layerGap;

    const minU = Math.min(...[...vnodes.values()].map((n) => pos.get(n.id) - n.su / 2));
    const maxU = Math.max(...[...vnodes.values()].map((n) => pos.get(n.id) + n.su / 2));
    const placed = new Map();
    for (const node of nodes) {
        const r = rank.get(node.id);
        const b = box.get(node.id);
        const cu = pos.get(node.id) - minU;
        const cv = layerV[r].top + layerV[r].thickness / 2;
        placed.set(node.id, { cu, cv, su: b.su, sv: b.sv, rank: r, lines: b.lines, width: b.width, height: b.height });
    }
    const realInLayer = (r) => layers[r].filter((id) => !vnodes.get(id).dummy);
    /** No real node beyond `id` on that side of its layer: an edge may leave / enter by the side. */
    const isOutermost = (id, side) => {
        const p = placed.get(id);
        return realInLayer(p.rank).every((other) => other === id
            || (side === 'right' ? placed.get(other).cu < p.cu : placed.get(other).cu > p.cu));
    };

    // 7. Routing.
    const routes = [];
    const channelMid = (r) => layerV[r].top + layerV[r].thickness + opts.layerGap / 2;
    const channelAbove = (r) => (r === 0 ? layerV[0].top - opts.layerGap / 2 : channelMid(r - 1));
    const branching = (id) => {
        const node = byId.get(id);
        return node.kind === 'decision' || node.kind === 'loop';
    };

    for (const { edge, chain } of chains) {
        const from = placed.get(edge.from);
        const to = placed.get(edge.to);
        const next = chain[1];
        const nextU = vnodes.get(next).dummy ? pos.get(next) - minU : to.cu;
        const points = [];
        let labelPos = null;
        let labelAlign = 'start';
        // The vertical part must clear the symbol, and nothing of the layer may sit on the way.
        const clear = Math.abs(nextU - from.cu) > from.su / 2 + 10 && realInLayer(from.rank).every((other) => {
            if (other === edge.from) return true;
            const o = placed.get(other);
            const [loU, hiU] = nextU < from.cu ? [nextU - 6, from.cu] : [from.cu, nextU + 6];
            return o.cu + o.su / 2 < loU || o.cu - o.su / 2 > hiU;
        });
        const sideExit = branching(edge.from) && !spine.has(edge) && clear;
        if (sideExit) {
            // Classic flowchart: secondary branches leave from a side vertex of the symbol.
            const dir = nextU < from.cu ? -1 : 1;
            const port = [from.cu + dir * from.su / 2, from.cv];
            points.push(port, [nextU, from.cv]);
            labelPos = [port[0] + dir * 8, port[1] - 7];
            labelAlign = dir < 0 ? 'end' : 'start';
        } else {
            points.push([from.cu, from.cv + from.sv / 2]);
            labelPos = [from.cu + 7, from.cv + from.sv / 2 + 13];
            if (Math.abs(nextU - from.cu) > 1) {
                const mid = channelMid(from.rank);
                points.push([from.cu, mid], [nextU, mid]);
                // A branch that turns carries its label on its horizontal part, so two
                // branches leaving from the bottom never stack their labels.
                if (!spine.has(edge)) {
                    const dir = nextU < from.cu ? -1 : 1;
                    labelPos = [from.cu + dir * 14, mid - 6];
                    labelAlign = dir < 0 ? 'end' : 'start';
                }
            }
        }
        // Within a pixel of the source: stay perfectly straight.
        let currentU = sideExit || Math.abs(nextU - from.cu) > 1 ? nextU : from.cu;
        for (let i = 1; i < chain.length; i++) {
            const id = chain[i];
            const vn = vnodes.get(id);
            const targetU = vn.dummy ? pos.get(id) - minU : to.cu;
            if (Math.abs(targetU - currentU) > 1) {
                const mid = channelMid(vnodes.get(chain[i - 1]).rank);
                points.push([currentU, mid], [targetU, mid]);
                currentU = targetU;
            }
            if (vn.dummy) {
                points.push([currentU, layerV[vn.rank].top], [currentU, layerV[vn.rank].top + layerV[vn.rank].thickness]);
            }
        }
        points.push([currentU, to.cv - to.sv / 2]);
        routes.push({ edge, points: simplify(points), kind: 'normal', back: false, labelPos, labelAlign });
    }

    const rightEdges = edges.filter((e) => back.has(e) && isNormalEdge(e));
    const adjacent = (e) => !back.has(e) && placed.get(e.to).rank === placed.get(e.from).rank + 1;
    const leftEdges = edges.filter((e) => !isNormalEdge(e) && !adjacent(e));
    for (const e of edges.filter((x) => !isNormalEdge(x) && adjacent(x))) {
        const a = placed.get(e.from);
        const b = placed.get(e.to);
        const exitU = a.cu - a.su / 4;
        const mid = channelMid(a.rank) + 5;
        const points = [[exitU, a.cv + a.sv / 2], [exitU, mid], [b.cu - b.su / 4, mid], [b.cu - b.su / 4, b.cv - b.sv / 2]];
        routes.push({ edge: e, points: simplify(points), kind: e.kind, back: false, labelPos: null });
    }

    // Gutters: edges sharing a target share a lane (a "bus"). An edge leaves / enters
    // by the side of a node when no other node of its layer is in the way, otherwise
    // through the channel between layers.
    const gutter = (list, side) => {
        const groups = new Map();
        for (const e of list) {
            if (!groups.has(e.to)) groups.set(e.to, []);
            groups.get(e.to).push(e);
        }
        const spans = [...groups.values()].map((group) => {
            const ranks = group.flatMap((e) => [placed.get(e.from).rank, placed.get(e.to).rank]);
            return { group, lo: Math.min(...ranks), hi: Math.max(...ranks) };
        }).sort((x, y) => (x.hi - x.lo) - (y.hi - y.lo) || x.lo - y.lo);
        const lanes = [];
        for (const sp of spans) {
            let lane = 0;
            while (lanes[lane] && lanes[lane].some((o) => !(sp.hi < o.lo || sp.lo > o.hi))) lane++;
            (lanes[lane] = lanes[lane] || []).push(sp);
            sp.lane = lane;
        }
        const result = [];
        const sign = side === 'right' ? 1 : -1;
        for (const sp of spans) {
            const extent = [...placed.values()].filter((p) => p.rank >= sp.lo && p.rank <= sp.hi);
            const laneU = side === 'right'
                ? Math.max(...extent.map((p) => p.cu + p.su / 2)) + opts.gutterGap + sp.lane * opts.laneGap
                : Math.min(...extent.map((p) => p.cu - p.su / 2)) - opts.gutterGap - sp.lane * opts.laneGap;
            sp.group.forEach((e, index) => {
                const a = placed.get(e.from);
                const b = placed.get(e.to);
                const points = [];
                let labelPos = null;
                let labelAlign = side === 'right' ? 'start' : 'end';
                if (isOutermost(e.from, side)) {
                    const port = [a.cu + sign * a.su / 2, a.cv];
                    points.push(port, [laneU, a.cv]);
                    labelPos = [port[0] + sign * 8, port[1] - 7];
                } else {
                    const exitU = a.cu + sign * a.su / 4;
                    const below = channelMid(a.rank) + sign * 4;
                    points.push([exitU, a.cv + a.sv / 2], [exitU, below], [laneU, below]);
                    labelPos = [exitU + 6, a.cv + a.sv / 2 + 13];
                    labelAlign = 'start';
                }
                if (isOutermost(e.to, side)) {
                    points.push([laneU, b.cv], [b.cu + sign * b.su / 2, b.cv]);
                } else {
                    const entryU = b.cu + sign * b.su / 4;
                    const above = channelAbove(b.rank) - sign * 4;
                    points.push([laneU, above], [entryU, above], [entryU, b.cv - b.sv / 2]);
                }
                result.push({
                    edge: e, points: simplify(points), kind: e.kind || 'normal', back: side === 'right', gutter: side,
                    labelPos: index === 0 || isNormalEdge(e) ? labelPos : null, labelAlign
                });
            });
        }
        return result;
    };
    routes.push(...gutter(rightEdges, 'right'), ...gutter(leftEdges, 'left'));

    // Bounds of everything (gutters and labels included).
    let lo = 0;
    let hi = maxU - minU;
    for (const route of routes) {
        for (const [u] of route.points) {
            lo = Math.min(lo, u - 12);
            hi = Math.max(hi, u + 12);
        }
    }
    const shift = -lo;
    const map = ([u, vv]) => (horizontal ? [vv, u + shift] : [u + shift, vv]);
    const nodesOut = {};
    for (const [id, p] of placed) {
        const [cx, cy] = map([p.cu, p.cv]);
        nodesOut[id] = { id, x: cx - p.width / 2, y: cy - p.height / 2, width: p.width, height: p.height, lines: p.lines, rank: p.rank };
    }
    const edgesOut = routes.map((route) => ({
        from: route.edge.from,
        to: route.edge.to,
        label: edgeLabel(route.edge),
        labelPos: route.labelPos ? map(route.labelPos) : null,
        labelAlign: horizontal ? 'start' : route.labelAlign,
        kind: route.kind,
        back: route.back,
        gutter: route.gutter,
        spine: spine.has(route.edge),
        edgeIndex: graph.edges.indexOf(route.edge),
        points: route.points.map(map)
    }));
    const width = horizontal ? totalV : hi - lo;
    const heightOut = horizontal ? hi - lo : totalV;
    return { unitIndex, name: unit.name, kind: unit.kind, nodes: nodesOut, edges: edgesOut, width, height: heightOut, crossings: bestCrossings };
}

/** Number of crossings between consecutive layers (O(E²) per layer, graphs are small). */
function countCrossings(layers, down, order) {
    let total = 0;
    for (let r = 0; r + 1 < layers.length; r++) {
        const segs = [];
        for (const id of layers[r]) for (const n of down.get(id)) segs.push([order.get(id), order.get(n.id)]);
        for (let i = 0; i < segs.length; i++) {
            for (let j = i + 1; j < segs.length; j++) {
                if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) total++;
            }
        }
    }
    return total;
}

/** Removes collinear / duplicate points. */
function simplify(points) {
    const out = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (last && Math.abs(last[0] - p[0]) < 0.5 && Math.abs(last[1] - p[1]) < 0.5) continue;
        if (out.length >= 2) {
            const a = out[out.length - 2];
            const b = out[out.length - 1];
            const collinear = (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(b[0] - p[0]) < 0.5) || (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(b[1] - p[1]) < 0.5);
            if (collinear) {
                out[out.length - 1] = p;
                continue;
            }
        }
        out.push(p);
    }
    return out;
}

/* ------------------------------------------------------------------------- */
/* Whole graph                                                                */
/* ------------------------------------------------------------------------- */

/**
 * @param {import('./graph').Graph} graph
 * @param {Object} [options]
 * @param {(text: string, fontSize: number) => number} [options.measure]  Text width measuring function
 * @param {import('./graph').LabelOptions} [options.labels]
 * @param {'classic' | 'compact'} [options.shapes]
 * @returns {{ width: number, height: number, units: any[], nodes: Record<string, any>, edges: any[] }}
 */
function layoutGraph(graph, options = {}) {
    const opts = { ...DEFAULTS, ...stripUndefined(options), direction: (options.direction || graph.direction) === 'LR' ? 'LR' : 'TD' };
    const ctx = { opts, labels: labelOptions(options.labels || {}), measure: options.measure || approxMeasure };
    const units = graph.units.map((_, i) => layoutUnit(graph, i, ctx));
    const grouped = units.length > 1;

    // Place units as a tree: each embedded flow (callback / nested function) is
    // stacked in a column to the right of the flow it belongs to, so links run
    // left → right without crossing other flows. Top-level flows (with their
    // columns) form rows that wrap.
    const pad = grouped ? opts.unitPadding : 0;
    const title = grouped ? opts.unitTitle : 0;
    const boxes = units.map((u) => ({ w: u.width + pad * 2, h: u.height + pad * 2 + title }));
    const parentOf = new Map();
    const nodeUnit = new Map(graph.nodes.map((n) => [n.id, n.unit]));
    for (const e of graph.edges) {
        if (e.kind !== 'callback') continue;
        const from = nodeUnit.get(e.from);
        const to = nodeUnit.get(e.to);
        if (from !== undefined && to !== undefined && from !== to && !parentOf.has(to)) parentOf.set(to, from);
    }
    const children = new Map(units.map((_, i) => [i, []]));
    parentOf.forEach((parent, child) => children.get(parent).push(child));
    const roots = units.map((_, i) => i).filter((i) => !parentOf.has(i));
    const origin = [];
    const placeTree = (i, x0, y0) => {
        origin[i] = [x0, y0];
        let cy = y0;
        let width = boxes[i].w;
        for (const c of children.get(i)) {
            const sub = placeTree(c, x0 + boxes[i].w + opts.unitGap, cy);
            cy += sub.h + opts.unitGap / 2;
            width = Math.max(width, boxes[i].w + opts.unitGap + sub.w);
        }
        return { w: width, h: Math.max(boxes[i].h, cy - y0 - (children.get(i).length ? opts.unitGap / 2 : 0)) };
    };
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    for (const root of roots) {
        const probe = placeTree(root, 0, 0);
        if (x > 0 && x + probe.w > opts.maxRowWidth) {
            x = 0;
            y += rowHeight + opts.unitGap;
            rowHeight = 0;
        }
        const block = placeTree(root, x, y);
        x += block.w + opts.unitGap;
        rowHeight = Math.max(rowHeight, block.h);
    }

    const nodes = {};
    const edges = [];
    const unitsOut = units.map((u, i) => {
        const [ox, oy] = origin[i];
        const dx = ox + pad;
        const dy = oy + pad + title;
        for (const [id, n] of Object.entries(u.nodes)) nodes[id] = { ...n, x: n.x + dx, y: n.y + dy, unit: i };
        for (const e of u.edges) {
            edges.push({
                ...e,
                points: e.points.map(([px, py]) => [px + dx, py + dy]),
                labelPos: e.labelPos ? [e.labelPos[0] + dx, e.labelPos[1] + dy] : null
            });
        }
        return {
            index: i,
            name: u.name,
            kind: u.kind,
            embedded: isEmbeddedUnit(graph.units[i]),
            x: ox,
            y: oy,
            width: boxes[i].w,
            height: boxes[i].h,
            grouped,
            crossings: u.crossings
        };
    });

    // Links between flows (statement → callback / nested function).
    for (const e of graph.edges) {
        if (e.kind !== 'callback' || !nodes[e.from] || !nodes[e.to]) continue;
        const a = nodes[e.from];
        const b = nodes[e.to];
        const start = [a.x + a.width, a.y + a.height / 2];
        const end = [b.x, b.y + b.height / 2];
        edges.push({ from: e.from, to: e.to, label: e.label, labelPos: null, kind: 'callback', edgeIndex: graph.edges.indexOf(e), points: [start, end], curve: true });
    }

    const width = Math.max(...unitsOut.map((u) => u.x + u.width), 0);
    const height = Math.max(...unitsOut.map((u) => u.y + u.height), 0);
    return { width, height, units: unitsOut, nodes, edges, direction: opts.direction };
}

function stripUndefined(object) {
    return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

module.exports = { layoutGraph, placeWithGaps, countCrossings, approxMeasure, DEFAULTS };
