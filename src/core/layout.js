'use strict';

/**
 * Flowchart layout engine (no Mermaid, no third-party layout library).
 *
 * A layered (Sugiyama) layout specialised for control-flow graphs:
 *
 *  1. Cycle removal     DFS from the start node; back edges are the loops.
 *  2. Layering          Longest path over the acyclic graph (top → bottom).
 *  3. Normalisation     Long forward edges get dummy nodes so they bend around nodes.
 *  4. Ordering          DFS order ("yes" left of "no"), then barycenter sweeps.
 *  5. Coordinates       Per layer, nodes go to the weighted median of their
 *                       neighbours, overlaps are removed optimally with an
 *                       isotonic regression (pool-adjacent-violators), several sweeps.
 *  6. Routing           PCB-like orthogonal traces with chamfered bends. As advised
 *                       for CFGs (VEIL, 2025), loops run in a gutter on one side
 *                       (right) and exceptional flow in a gutter on the other (left).
 *
 * Everything is computed in an abstract (u = across layers, v = along the flow)
 * space, then mapped to x / y, so the same code handles top-down and left-right.
 */

const { displayLines, isNormalEdge, isEmbeddedUnit, edgeLabel, labelOptions } = require('./graph');

const DEFAULTS = {
    direction: 'TD',
    nodeGap: 34,            // between nodes of a layer
    layerGap: 56,           // between layers
    gutterGap: 26,          // first gutter lane from the nodes
    laneGap: 12,            // between gutter lanes
    unitGap: 90,            // between flows (functions / callbacks)
    unitPadding: 28,
    unitTitle: 30,
    sweeps: 8,
    lineHeight: 17,
    fontSize: 12.5,
    titleFontSize: 12,
    maxRowWidth: 1900
};

/** Rough text width when no measuring function is given (tests, Node). */
function approxMeasure(text, fontSize = DEFAULTS.fontSize) {
    return String(text).length * fontSize * 0.6;
}

/* ------------------------------------------------------------------------- */
/* Node sizes                                                                 */
/* ------------------------------------------------------------------------- */

const PADDING = {
    start: [18, 9], end: [16, 8], process: [16, 11], decision: [30, 11], loop: [24, 11],
    return: [18, 10], throw: [22, 10], try: [16, 8], catch: [16, 8], finally: [16, 8], junction: [10, 8]
};

function nodeBox(node, labels, measure, opts) {
    const lines = displayLines(node, labels);
    const textWidth = Math.max(...lines.map((l) => measure(l, opts.fontSize)), 0);
    const [px, py] = PADDING[node.kind] || PADDING.process;
    let width = textWidth + px * 2;
    let height = lines.length * opts.lineHeight + py * 2;
    if (node.kind === 'junction' && !(node.meta && node.meta.subtype === 'finallyEnd')) {
        const size = Math.max(30, textWidth + 18);
        width = size;
        height = 30;
    }
    if (node.kind === 'start' || node.kind === 'end') width = Math.max(width, 74);
    width = Math.max(width, node.kind === 'decision' ? 110 : 52);
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
            // Average the two middle values when the median falls between them.
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
    while (queue.length) {
        const id = queue.shift();
        for (const e of fwdOut.get(id)) {
            rank.set(e.to, Math.max(rank.get(e.to), rank.get(id) + 1));
            inDeg.set(e.to, inDeg.get(e.to) - 1);
            if (inDeg.get(e.to) === 0) queue.push(e.to);
        }
    }
    // The end node closes the flow.
    if (ids.has(unit.endId)) {
        const maxRank = Math.max(...nodes.filter((n) => n.id !== unit.endId).map((n) => rank.get(n.id)), 0);
        rank.set(unit.endId, Math.max(rank.get(unit.endId), maxRank + 1));
    }
    // Pull nodes with a single successor down next to it (shorter edges, e.g. hoisted code).
    for (const n of [...nodes].reverse()) {
        const succ = fwdOut.get(n.id).filter((e) => isNormalEdge(e));
        const preds = forward.filter((e) => e.to === n.id);
        if (!preds.length && succ.length) {
            rank.set(n.id, Math.max(rank.get(n.id), Math.min(...succ.map((e) => rank.get(e.to))) - 1));
        }
    }

    // 3. Normalisation: dummy chains for long normal forward edges. Exceptional edges
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
            vnodes.set(id, { id, dummy: true, su: 2, sv: 0, rank: r });
            put(id, r);
            chain.push(id);
        }
        chain.push(e.to);
        chains.push({ edge: e, chain });
    }
    const up = new Map([...vnodes.keys()].map((id) => [id, []]));
    const down = new Map([...vnodes.keys()].map((id) => [id, []]));
    // Exceptional edges weakly attract their handler, so a catch sits under its try block.
    for (const e of forward) {
        if (isNormalEdge(e)) continue;
        down.get(e.from).push({ id: e.to, weight: 0.35 });
        up.get(e.to).push({ id: e.from, weight: 0.35 });
    }
    for (const { chain } of chains) {
        for (let i = 0; i + 1 < chain.length; i++) {
            const weight = vnodes.get(chain[i]).dummy || vnodes.get(chain[i + 1]).dummy ? 4 : 1;
            down.get(chain[i]).push({ id: chain[i + 1], weight });
            up.get(chain[i + 1]).push({ id: chain[i], weight });
        }
    }

    // 4. Ordering: DFS discovery order first, then barycenter sweeps.
    const dfsIndex = new Map(dfsOrder.map((id, i) => [id, i]));
    const order = new Map();
    layers.forEach((layer) => {
        layer.sort((a, b) => {
            const ka = vnodes.get(a).dummy ? (dfsIndex.get(chainSource(a, chains)) ?? 0) + 0.5 : dfsIndex.get(a) ?? 0;
            const kb = vnodes.get(b).dummy ? (dfsIndex.get(chainSource(b, chains)) ?? 0) + 0.5 : dfsIndex.get(b) ?? 0;
            return ka - kb;
        });
        layer.forEach((id, i) => order.set(id, i));
    });
    // Initial DFS order already puts "yes" left of "no"; sweeps reduce crossings.
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

    // 5. Coordinates across layers (u): medians + isotonic overlap removal.
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
        const gap = va.dummy && vb.dummy ? 14 : (va.dummy || vb.dummy ? opts.nodeGap / 2 + 6 : opts.nodeGap);
        return va.su / 2 + vb.su / 2 + gap;
    };
    const relax = (layer, neighbours) => {
        if (!layer.length) return;
        const desired = layer.map((id) => {
            const m = weightedMedian(neighbours.get(id).map((n) => ({ value: pos.get(n.id), weight: n.weight })));
            return m === null ? pos.get(id) : m;
        });
        const weights = layer.map((id) => (vnodes.get(id).dummy ? 2 : 1 + neighbours.get(id).length));
        const gaps = layer.slice(1).map((id, i) => gapBetween(layer[i], id));
        placeWithGaps(desired, gaps, weights).forEach((u, i) => pos.set(layer[i], u));
    };
    const both = new Map([...vnodes.keys()].map((id) => [id, [...up.get(id), ...down.get(id)]]));
    for (let i = 0; i < 6; i++) {
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

    // 6. Routing.
    const routes = [];
    const channelUse = new Map();
    const channelOffset = (r, key) => {
        if (!channelUse.has(r)) channelUse.set(r, []);
        const used = channelUse.get(r);
        let index = used.indexOf(key);
        if (index < 0) {
            used.push(key);
            index = used.length - 1;
        }
        return index;
    };
    const channelMid = (r) => layerV[r].top + layerV[r].thickness + opts.layerGap / 2;

    for (const { edge, chain } of chains) {
        const from = placed.get(edge.from);
        const to = placed.get(edge.to);
        const node = byId.get(edge.from);
        const points = [];
        // Exit port: decisions send "yes" from the left half and "no" from the right half.
        let exitU = from.cu;
        if (node.kind === 'decision' || node.kind === 'loop') {
            const branches = edges.filter((e) => e.from === edge.from && isNormalEdge(e) && !back.has(e)).sort((a, b) => branchRank(a) - branchRank(b));
            if (branches.length > 1) {
                const i = branches.indexOf(edge);
                exitU = from.cu - from.su / 4 + (from.su / 2) * (i / (branches.length - 1));
            }
        }
        points.push([exitU, from.cv + from.sv / 2]);
        let currentU = exitU;
        for (let i = 1; i < chain.length; i++) {
            const id = chain[i];
            const r = vnodes.get(chain[i - 1]).rank;
            const targetU = vnodes.get(id).dummy ? pos.get(id) - minU : to.cu;
            if (Math.abs(targetU - currentU) > 1) {
                const lane = channelOffset(r, `${edge.from}->${edge.to}`);
                const mid = channelMid(r) + (lane % 3 - 1) * 6;
                points.push([currentU, mid], [targetU, mid]);
                currentU = targetU;
            }
            // Within a pixel: stay perfectly straight.
            if (vnodes.get(id).dummy) {
                const vr = vnodes.get(id).rank;
                points.push([currentU, layerV[vr].top], [currentU, layerV[vr].top + layerV[vr].thickness]);
            }
        }
        points.push([currentU, to.cv - to.sv / 2]);
        routes.push({ edge, points: simplify(points), kind: edge.kind || 'normal', back: false });
    }

    const rightEdges = edges.filter((e) => back.has(e) && isNormalEdge(e));
    const adjacent = (e) => !back.has(e) && placed.get(e.to).rank === placed.get(e.from).rank + 1;
    const leftEdges = edges.filter((e) => !isNormalEdge(e) && !adjacent(e));
    // Exceptional edges between consecutive layers go straight through the channel.
    for (const e of edges.filter((x) => !isNormalEdge(x) && adjacent(x))) {
        const a = placed.get(e.from);
        const b = placed.get(e.to);
        const exitU = a.cu - a.su / 4;
        const mid = channelMid(a.rank) + 5;
        const points = [[exitU, a.cv + a.sv / 2], [exitU, mid], [b.cu - b.su / 4, mid], [b.cu - b.su / 4, b.cv - b.sv / 2]];
        routes.push({ edge: e, points: simplify(points), kind: e.kind, back: false });
    }
    // Gutters: loops on the right, exceptional flow on the left (VEIL). Edges reach
    // their gutter through the channels between layers, so they never cross a node,
    // and edges sharing a target share a lane (a "bus", like a PCB trace).
    const channelAbove = (r) => (r === 0 ? layerV[0].top - opts.layerGap / 2 : channelMid(r - 1));
    const gutter = (list, side) => {
        const groups = new Map();
        for (const e of list) {
            const key = e.to;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(e);
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
        for (const sp of spans) {
            const extent = [...placed.values()].filter((p) => p.rank >= sp.lo && p.rank <= sp.hi);
            const laneU = side === 'right'
                ? Math.max(...extent.map((p) => p.cu + p.su / 2)) + opts.gutterGap + sp.lane * opts.laneGap
                : Math.min(...extent.map((p) => p.cu - p.su / 2)) - opts.gutterGap - sp.lane * opts.laneGap;
            const sign = side === 'right' ? 1 : -1;
            sp.group.forEach((e, index) => {
                const a = placed.get(e.from);
                const b = placed.get(e.to);
                const exitU = a.cu + sign * a.su / 4;
                const entryU = b.cu + sign * b.su / 4;
                const below = channelMid(a.rank) + sign * 4;
                const above = channelAbove(b.rank) - sign * 4;
                const points = [[exitU, a.cv + a.sv / 2], [exitU, below], [laneU, below], [laneU, above], [entryU, above], [entryU, b.cv - b.sv / 2]];
                // A bus shows its label once, where it enters its target.
                result.push({ edge: e, points: simplify(points), kind: e.kind || 'normal', back: side === 'right', gutter: side, showLabel: index === 0, labelAt: 'lane' });
            });
        }
        return result;
    };
    routes.push(...gutter(rightEdges, 'right'), ...gutter(leftEdges, 'left'));

    // Bounds of everything (gutters included).
    let lo = 0;
    let hi = maxU - minU;
    for (const route of routes) {
        for (const [u] of route.points) {
            lo = Math.min(lo, u - 10);
            hi = Math.max(hi, u + 10);
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
        label: route.showLabel === false ? '' : edgeLabel(route.edge),
        labelAt: route.labelAt || 'start',
        kind: route.kind,
        back: route.back,
        gutter: route.gutter,
        edgeIndex: graph.edges.indexOf(route.edge),
        points: route.points.map(map)
    }));
    const width = horizontal ? totalV : hi - lo;
    const height = horizontal ? hi - lo : totalV;
    return { unitIndex, name: unit.name, kind: unit.kind, nodes: nodesOut, edges: edgesOut, width, height, crossings: bestCrossings };
}

function chainSource(dummyId, chains) {
    const chain = chains.find((c) => c.chain.includes(dummyId));
    return chain ? chain.chain[0] : undefined;
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
 * @returns {{ width: number, height: number, units: any[], nodes: Record<string, any>, edges: any[] }}
 */
function layoutGraph(graph, options = {}) {
    const opts = { ...DEFAULTS, ...options, direction: (options.direction || graph.direction) === 'LR' ? 'LR' : 'TD' };
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
    for (const e of graph.edges) {
        if (e.kind !== 'callback') continue;
        const from = graph.nodes.find((n) => n.id === e.from);
        const to = graph.nodes.find((n) => n.id === e.to);
        if (from && to && from.unit !== to.unit && !parentOf.has(to.unit)) parentOf.set(to.unit, from.unit);
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
        for (const e of u.edges) edges.push({ ...e, points: e.points.map(([px, py]) => [px + dx, py + dy]) });
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
        edges.push({ from: e.from, to: e.to, label: e.label, labelAt: 'curve', kind: 'callback', edgeIndex: graph.edges.indexOf(e), points: [start, end], curve: true });
    }

    const width = Math.max(...unitsOut.map((u) => u.x + u.width), 0);
    const height = Math.max(...unitsOut.map((u) => u.y + u.height), 0);
    return { width, height, units: unitsOut, nodes, edges, direction: opts.direction };
}

module.exports = { layoutGraph, placeWithGaps, countCrossings, approxMeasure, DEFAULTS };
