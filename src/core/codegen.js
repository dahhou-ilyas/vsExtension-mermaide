'use strict';

/**
 * Graph → code.
 *
 * Strategy (same family as the Relooper / Stackifier algorithms used by
 * compilers that target structured languages):
 *
 *  1. Structured reconstruction: walk the graph from the start node and rebuild
 *     `if / else`, loops, `switch`, `try / catch / finally`, `break` / `continue`
 *     (labeled when needed) using immediate post-dominators as merge points.
 *  2. If the graph is not structured (e.g. a hand-drawn diagram that jumps into
 *     the middle of a loop), fall back to a state machine
 *     (`while (true) { switch (state) { ... } }`). By the Böhm–Jacopini theorem
 *     this is always possible and preserves the behaviour exactly.
 *
 * Fidelity (same idea as Recast's reprinting, adapted to a flow graph): the
 * builder keeps the original code, and every compound statement remembers a
 * signature of the code it produced. A statement whose signature is unchanged
 * is printed back exactly as it was written (formatting and comments inside
 * included); only the parts of the flow that were edited are regenerated.
 * Comments between statements travel with their statement (see `notes`).
 */

const { indexGraph, isNormalEdge, isEmbeddedUnit } = require('./graph');
const { KEEP, templateLines } = require('./text');
const { scanTopLevel, splitTopLevel, patternNames, parseDeclaration, parseForHeader, identifiers } = require('./lowering');

class UnstructuredError extends Error {}

const EXIT = '__exit__';
const TERMINAL_KINDS = new Set(['end', 'return', 'throw']);

/* ------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* ------------------------------------------------------------------------- */

/** 53-bit string hash (cyrb53): signatures must be computable in the webview too. */
function hash(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Whitespace before `offset` on its line, when nothing else precedes it. */
function indentAt(source, offset) {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    const prefix = source.slice(lineStart, offset);
    return /^[ \t]*$/.test(prefix) ? prefix : undefined;
}

const SIGNATURE_META = new Set(['sig', 'span', 'ids', 'folds', 'exits', 'endId', 'exitId']);

/**
 * Signature of an embedded flow (inline callback, nested function): its nodes,
 * edges and the embedded flows it holds itself. A flow whose signature differs
 * from the one recorded when the diagram was built has been edited.
 */
function unitSignature(graph, index, cache = new Map()) {
    if (cache.has(index)) return cache.get(index);
    cache.set(index, '');
    const nodes = graph.nodes.filter((n) => n.unit === index);
    const ids = new Set(nodes.map((n) => n.id));
    const parts = nodes.map((n) => {
        const meta = Object.fromEntries(Object.entries(n.meta || {}).filter(([k]) => !SIGNATURE_META.has(k)));
        return JSON.stringify([n.id, n.kind, n.code, meta, n.comments || null]);
    });
    for (const e of graph.edges) {
        if (ids.has(e.from)) parts.push(JSON.stringify([e.from, e.to, e.label, e.kind || '', e.code === undefined ? null : e.code]));
    }
    for (const child of hostedUnits(graph, ids)) parts.push(`u${unitSignature(graph, child, cache)}`);
    const result = hash(parts.join('\n'));
    cache.set(index, result);
    return result;
}

/** Indices of the embedded flows held by the nodes `ids`. */
function hostedUnits(graph, ids) {
    const starts = new Set(graph.edges.filter((e) => e.kind === 'callback' && ids.has(e.from)).map((e) => e.to));
    return graph.units.map((u, i) => (starts.has(u.startId) ? i : -1)).filter((i) => i >= 0);
}

function withSemicolon(code) {
    const text = String(code).trimEnd();
    if (!text) return text;
    const lastLine = text.split('\n').pop().trim();
    if (lastLine.startsWith('//') || lastLine.endsWith('*/')) return text;
    return /[;}{]$/.test(text) ? text : `${text};`;
}

function negate(condition) {
    const text = condition.trim();
    // !x → x, !obj.prop → obj.prop, !f(a) → f(a)
    if (/^![\w$.]+(\([^()]*\))?$/.test(text)) return text.slice(1);
    if (/^!\s*\(.*\)$/s.test(text) && balanced(text.replace(/^!\s*/, ''))) return text.replace(/^!\s*\((.*)\)$/s, '$1');
    if (/^[\w$.]+$/.test(text)) return `!${text}`;
    return `!(${text})`;
}

/** true when the outer parentheses of `(…)` wrap the whole text. */
function balanced(text) {
    if (!text.startsWith('(') || !text.endsWith(')')) return false;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        if (depth === 0 && i < text.length - 1) return false;
    }
    return true;
}

function isTerminator(stmt) {
    return !!stmt && (stmt.t === 'return' || stmt.t === 'throw' || stmt.t === 'break' || stmt.t === 'continue');
}

function endsWithJump(body) {
    const last = body[body.length - 1];
    if (isTerminator(last)) return true;
    if (last && last.t === 'if' && last.else.length) return endsWithJump(last.then) && endsWithJump(last.else);
    return false;
}

/* ------------------------------------------------------------------------- */
/* Analysis                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Normal-flow successors: `return`, `throw` and `end` stop the flow, `try`
 * flows into its block (the `error` edge is handled by the try construct).
 */
function buildFlow(graph, unitIndex) {
    const { nodes, out, inc } = indexGraph(graph);
    const unit = graph.units[unitIndex];
    const succ = new Map();
    for (const node of graph.nodes) {
        if (node.unit !== unitIndex) continue;
        if (TERMINAL_KINDS.has(node.kind)) {
            succ.set(node.id, []);
            continue;
        }
        // Only the normal control flow: exception, abrupt and callback edges are implied by the code.
        const targets = (out.get(node.id) || [])
            .filter((e) => isNormalEdge(e) && nodes.has(e.to) && nodes.get(e.to).unit === unitIndex)
            .map((e) => e.to);
        // A try block may jump to its catch at any point: keep that branch for the analysis.
        if (node.kind === 'try') {
            const catchId = (node.meta && node.meta.catchId)
                || ((out.get(node.id) || []).find((e) => e.label === 'error') || {}).to;
            if (catchId && nodes.has(catchId) && !targets.includes(catchId)) targets.push(catchId);
        }
        succ.set(node.id, targets);
    }

    // Reachable nodes from the start.
    const reachable = new Set();
    const stack = [unit.startId];
    while (stack.length) {
        const id = stack.pop();
        if (reachable.has(id) || !succ.has(id)) continue;
        reachable.add(id);
        succ.get(id).forEach((s) => stack.push(s));
    }

    // Post-dominators (iterative data-flow on the reversed graph).
    const ids = [...reachable];
    const exitSuccs = new Map(ids.map((id) => [id, succ.get(id).filter((s) => reachable.has(s))]));
    for (const id of ids) if (exitSuccs.get(id).length === 0) exitSuccs.get(id).push(EXIT);

    // Nodes that can never reach the exit (infinite loops) get a virtual exit edge.
    const reachesExit = new Set([EXIT]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const id of ids) {
            if (!reachesExit.has(id) && exitSuccs.get(id).some((s) => reachesExit.has(s))) {
                reachesExit.add(id);
                changed = true;
            }
        }
    }
    for (const id of ids) {
        if (!reachesExit.has(id) && nodes.get(id).kind === 'loop') exitSuccs.get(id).push(EXIT);
    }

    const all = new Set([...ids, EXIT]);
    const pdom = new Map(ids.map((id) => [id, new Set(all)]));
    pdom.set(EXIT, new Set([EXIT]));
    changed = true;
    while (changed) {
        changed = false;
        for (const id of ids) {
            const succs = exitSuccs.get(id);
            let next = null;
            for (const s of succs) {
                const set = pdom.get(s) || new Set(all);
                next = next === null ? new Set(set) : new Set([...next].filter((x) => set.has(x)));
            }
            next = next || new Set();
            next.add(id);
            const current = pdom.get(id);
            if (next.size !== current.size || [...next].some((x) => !current.has(x))) {
                pdom.set(id, next);
                changed = true;
            }
        }
    }

    const ipdCache = new Map();
    const ipd = (id) => {
        if (ipdCache.has(id)) return ipdCache.get(id);
        const candidates = [...(pdom.get(id) || [])].filter((x) => x !== id);
        let best = null;
        let bestSize = -1;
        for (const c of candidates) {
            const size = c === EXIT ? 1 : (pdom.get(c) ? pdom.get(c).size : 0);
            if (size > bestSize) {
                best = c;
                bestSize = size;
            }
        }
        const result = best === EXIT ? null : best;
        ipdCache.set(id, result);
        return result;
    };

    // Reverse post-order, used to pick the earliest convergence point.
    const rpo = new Map();
    const visited = new Set();
    const order = [];
    const dfs = (id) => {
        visited.add(id);
        for (const s of succ.get(id) || []) if (!visited.has(s) && reachable.has(s)) dfs(s);
        order.push(id);
    };
    if (reachable.has(unit.startId)) dfs(unit.startId);
    order.reverse().forEach((id, i) => rpo.set(id, i));

    return { nodes, out, inc, succ, reachable, ipd, rpo, unit };
}

/** Nodes of the natural loop: reachable from `entry` without crossing `header`, and able to reach `header`. */
function loopBody(flow, entry, header) {
    const forward = new Set();
    const stack = [entry];
    while (stack.length) {
        const id = stack.pop();
        if (id === header || forward.has(id) || !flow.succ.has(id)) continue;
        forward.add(id);
        flow.succ.get(id).forEach((s) => stack.push(s));
    }
    const body = new Set();
    const back = [header];
    const visited = new Set();
    while (back.length) {
        const id = back.pop();
        if (visited.has(id)) continue;
        visited.add(id);
        for (const edge of flow.inc.get(id) || []) {
            if (forward.has(edge.from) && !body.has(edge.from)) {
                body.add(edge.from);
                back.push(edge.from);
            }
        }
    }
    return body;
}

/* ------------------------------------------------------------------------- */
/* Structured reconstruction                                                  */
/* ------------------------------------------------------------------------- */

class StructuredEmitter {
    constructor(graph, unitIndex) {
        this.graph = graph;
        this.flow = buildFlow(graph, unitIndex);
        this.labelCounter = 0;
        this.warnings = [];
        this.indentUnit = '    ';
        this.unitSigs = new Map();
        this.embeddedSigs = new Map();
        /** Node id ranges printed verbatim (their hoisted declarations are already in the text). */
        this.covered = [];
    }

    node(id) {
        return this.flow.nodes.get(id);
    }

    /** Links an emitted statement to the node (and code line) it comes from. */
    tag(item, node, line = 0) {
        item.from = node.id;
        item.line = line;
        const notes = node.comments && node.comments[line];
        if (notes) item.notes = notes;
        const source = this.graph.source;
        const raw = node.code && node.code[line];
        if (typeof source === 'string' && node.start !== undefined && typeof raw === 'string' && raw) {
            const at = source.indexOf(raw, node.start);
            if (at >= 0 && at <= node.end) item.indent = indentAt(source, at);
        }
        return item;
    }

    /** Signature of the embedded flows held by a node. */
    embeddedSignature(id) {
        if (!this.embeddedSigs.has(id)) {
            const units = hostedUnits(this.graph, new Set([id]));
            this.embeddedSigs.set(id, units.map((u) => unitSignature(this.graph, u, this.unitSigs)).join(','));
        }
        return this.embeddedSigs.get(id);
    }

    /**
     * Text of a node field with the edited embedded flows spliced back in:
     * the body of a callback whose flow changed is regenerated from that flow.
     */
    hosted(node, field, line, text) {
        if (typeof text !== 'string') return text;
        const edits = [];
        this.graph.units.forEach((unit, index) => {
            const host = unit.host;
            if (!host || host.nodeId !== node.id || host.field !== field || host.line !== line || !unit.sig) return;
            if (unitSignature(this.graph, index, this.unitSigs) === unit.sig) return;
            edits.push({ unit, index, range: host.range });
        });
        if (!edits.length) return text;
        edits.sort((a, b) => b.range[0] - a.range[0]);
        let result = text;
        const base = (this.graph.source && node.start !== undefined && indentAt(this.graph.source, node.start)) || '';
        for (const edit of edits) {
            const [start, end] = edit.range;
            if (start < 0 || end > result.length || start > end) continue;
            const lineStart = result.lastIndexOf('\n', start - 1) + 1;
            const pad = lineStart === 0 ? base : result.slice(lineStart).match(/^[ \t]*/)[0];
            // `(x) => expression` stays concise while its flow is a single return.
            const concise = edit.unit.host.expression ? singleReturn(this.graph, edit.index) : null;
            if (concise !== null) {
                result = `${result.slice(0, start)}${/^\s*\{/.test(concise) ? `(${concise})` : concise}${result.slice(end)}`;
                continue;
            }
            const lines = bodyLines(this.graph, edit.index, this.indentUnit).map((l) => indentLine(l, pad + this.indentUnit));
            result = `${result.slice(0, start)}{\n${lines.join('\n')}${lines.length ? '\n' : ''}${pad}}${result.slice(end)}`;
        }
        return result;
    }

    outEdges(id) {
        const unit = this.node(id) && this.node(id).unit;
        return (this.flow.out.get(id) || []).filter((e) => isNormalEdge(e) && this.flow.nodes.has(e.to) && this.flow.nodes.get(e.to).unit === unit);
    }

    edgeTo(id, labels) {
        const edge = this.outEdges(id).find((e) => labels.includes(e.label));
        return edge ? edge.to : undefined;
    }

    singleSuccessor(id) {
        const succs = this.flow.succ.get(id) || [];
        const unique = [...new Set(succs)];
        if (unique.length > 1) throw new UnstructuredError(`Node ${id} has several successors.`);
        return unique[0];
    }

    /**
     * Merge point of a branching node: its immediate post-dominator when it lies
     * in the current loop, otherwise the earliest node where at least two
     * branches converge (branches that return / throw never converge).
     */
    mergePoint(id, ctx) {
        const loop = [...ctx.jumps].reverse().find((j) => j.type === 'loop');
        // Inside a loop, a merge point must be in the loop body, or a path that only returns / throws.
        const inScope = (m) => !loop || loop.body.has(m) || m === loop.continueTarget || this.endsInTerminal(m);
        const merge = this.flow.ipd(id);
        const valid = merge && inScope(merge) && this.reachableWithin(id, merge, ctx);
        // The post-dominator is the loop header when some branches `continue`: the branches
        // usually meet earlier, and only the others jump back (no code is duplicated).
        if (valid && !(loop && merge === loop.continueTarget)) return merge;
        const earlier = this.convergence(id, ctx, inScope);
        return earlier || (valid ? merge : null);
    }

    /** Earliest node where at least two branches of `id` meet, without crossing an enclosing stop. */
    convergence(id, ctx, inScope) {
        const blockers = new Set([...ctx.stops, id]);
        const jumpTargets = new Set();
        for (const j of ctx.jumps) {
            if (j.continueTarget) jumpTargets.add(j.continueTarget);
            if (j.exit) jumpTargets.add(j.exit);
        }
        jumpTargets.forEach((t) => blockers.add(t));
        const branches = [...new Set(this.flow.succ.get(id) || [])];
        const counts = new Map();
        for (const branch of branches) {
            const seen = new Set();
            const stack = [branch];
            while (stack.length) {
                const n = stack.pop();
                if (seen.has(n) || n === id || !this.flow.succ.has(n)) continue;
                seen.add(n);
                // An enclosing stop can be where branches meet, but the walk does not go past it.
                if (blockers.has(n)) continue;
                (this.flow.succ.get(n) || []).forEach((s) => stack.push(s));
            }
            seen.forEach((n) => counts.set(n, (counts.get(n) || 0) + 1));
        }
        // Branches that meet at the header or the exit of an enclosing loop are written with continue / break.
        const candidates = [...counts].filter(([n, c]) => c >= 2 && inScope(n) && !jumpTargets.has(n)).map(([n]) => n);
        if (!candidates.length) return null;
        candidates.sort((a, b) => (this.flow.rpo.get(a) ?? 0) - (this.flow.rpo.get(b) ?? 0));
        // The first meeting point is the candidate from which every other one is reached.
        const reaches = (from) => {
            const seen = new Set();
            const stack = [from];
            while (stack.length) {
                const n = stack.pop();
                if (seen.has(n)) continue;
                seen.add(n);
                if (n !== from && blockers.has(n)) continue;
                (this.flow.succ.get(n) || []).forEach((s) => stack.push(s));
            }
            return seen;
        };
        const first = candidates.find((c) => {
            const seen = reaches(c);
            return candidates.every((other) => seen.has(other));
        });
        return first || candidates[0];
    }

    /**
     * Whether no branch of `id` crosses an enclosing stop (the next case of a
     * switch, the header of a loop, ...) before reaching `merge`. Otherwise the
     * post-dominator lies outside the current block and cannot be the merge point.
     */
    reachableWithin(id, merge, ctx) {
        const stops = new Set(ctx.stops);
        stops.delete(merge);
        for (const branch of new Set(this.flow.succ.get(id) || [])) {
            const seen = new Set();
            const stack = [branch];
            while (stack.length) {
                const n = stack.pop();
                if (n === merge || seen.has(n) || n === id) continue;
                seen.add(n);
                if (stops.has(n)) return false;
                (this.flow.succ.get(n) || []).forEach((s) => stack.push(s));
            }
        }
        return true;
    }

    /** Whether every path from `id` ends with return / throw (it never rejoins the rest of the code). */
    endsInTerminal(id) {
        const seen = new Set();
        const stack = [id];
        while (stack.length) {
            const n = stack.pop();
            if (seen.has(n)) continue;
            seen.add(n);
            const node = this.node(n);
            if (!node || node.kind === 'end') return false;
            if (node.kind === 'return' || node.kind === 'throw') continue;
            const succs = this.flow.succ.get(n) || [];
            if (succs.length === 0 || seen.size > 500) return false;
            succs.forEach((s) => stack.push(s));
        }
        return true;
    }

    /**
     * The node a loop body leaves to with `break`. When several nodes are
     * reached from the body (e.g. `break` and `return`), the exit recorded by
     * the builder (`meta.exitId`) decides; otherwise a single non-terminal target.
     */
    loopExitFromBody(body, header, hintNode) {
        const exits = new Set();
        for (const n of body) {
            for (const s of this.flow.succ.get(n) || []) {
                if (s !== header && !body.has(s)) exits.add(s);
            }
        }
        const hint = hintNode && hintNode.meta && hintNode.meta.exitId;
        if (exits.size <= 1) {
            const only = exits.size ? [...exits][0] : null;
            // `for (;;) { … return; }`: the return stays in the loop, it is not reached by a break.
            if (only && hint !== only && hintNode && hintNode.meta && hintNode.meta.exitId === undefined && this.endsInTerminal(only)) return null;
            return only;
        }
        if (hint && exits.has(hint)) return hint;
        const nonTerminal = [...exits].filter((e) => !this.endsInTerminal(e));
        if (nonTerminal.length === 1) return nonTerminal[0];
        // Only returns / throws leave the loop: there is no break target, they stay in the body.
        if (nonTerminal.length === 0) return null;
        throw new UnstructuredError('Loop with several exits.');
    }

    /**
     * Emits statements from `entry` until a node of `stops` is reached.
     * @returns {{ body: any[], stoppedAt: string | null }}
     */
    region(entry, stops, ctx) {
        ctx = { ...ctx, stops };
        const body = [];
        // Statements remember the block scope of the node they come from (see applyScopes).
        const rawPush = body.push.bind(body);
        let currentScope = [];
        body.push = (...items) => {
            items.forEach((item) => { if (!item.scope) item.scope = currentScope; });
            return rawPush(...items);
        };
        let cur = entry;
        const seen = new Set();

        while (cur) {
            if (stops.has(cur)) return { body, stoppedAt: cur };

            const jump = this.jumpTo(cur, ctx);
            if (jump) {
                body.push(jump);
                return { body, stoppedAt: null };
            }

            if (seen.has(cur) || ctx.visiting.has(cur)) throw new UnstructuredError(`Unexpected cycle through ${cur}.`);
            seen.add(cur);

            const node = this.node(cur);
            if (!node) throw new UnstructuredError(`Unknown node ${cur}.`);
            currentScope = node.scope || [];

            switch (node.kind) {
                case 'start':
                    cur = this.singleSuccessor(cur);
                    break;
                case 'end':
                    return { body, stoppedAt: null };
                case 'process':
                    (node.code || []).forEach((line, i) => {
                        if (!String(line).trim()) return;
                        const text = withSemicolon(this.hosted(node, 'code', i, line));
                        body.push(this.tag(node.meta && node.meta.multiline ? { t: 'raw', text } : { t: 'code', text }, node, i));
                    });
                    if (ctx.stopAfter && ctx.stopAfter.has(cur)) {
                        return { body, stoppedAt: this.singleSuccessor(cur) || null, stoppedAfter: true };
                    }
                    cur = this.singleSuccessor(cur);
                    break;
                case 'return':
                    body.push(this.tag({ t: 'return', text: withSemicolon(this.hosted(node, 'code', 0, node.code[0]) || 'return') }, node));
                    return { body, stoppedAt: null };
                case 'throw':
                    body.push(this.tag({ t: 'throw', text: withSemicolon(this.hosted(node, 'code', 0, node.code[0]) || 'throw new Error()') }, node));
                    return { body, stoppedAt: null };
                case 'decision':
                    cur = node.meta && node.meta.subtype === 'switch'
                        ? this.emitSwitch(cur, body, ctx)
                        : this.emitIf(cur, body, ctx);
                    break;
                case 'loop':
                    if (node.meta && node.meta.subtype === 'dowhile') throw new UnstructuredError('do…while test reached without its do.');
                    cur = this.emitLoop(cur, body, ctx);
                    break;
                case 'junction':
                    if (node.meta && node.meta.subtype === 'do') {
                        cur = this.emitDoWhile(cur, body, ctx);
                    } else {
                        cur = this.singleSuccessor(cur);
                    }
                    break;
                case 'try':
                    cur = this.emitTry(cur, body, ctx);
                    break;
                default:
                    throw new UnstructuredError(`A ${node.kind} node cannot be reached directly.`);
            }
            if (cur === undefined) return { body, stoppedAt: null };
        }
        return { body, stoppedAt: null };
    }

    /** break / continue when `id` is the target of an enclosing construct. */
    jumpTo(id, ctx, dryRun = false) {
        for (let i = ctx.jumps.length - 1; i >= 0; i--) {
            const j = ctx.jumps[i];
            const innermostBreakable = ctx.jumps.slice(i + 1).every((x) => x.type === 'if');
            const innermostLoop = !ctx.jumps.slice(i + 1).some((x) => x.type === 'loop');
            if (j.type === 'loop' && id === j.continueTarget) {
                const needsLabel = !innermostLoop;
                if (needsLabel && !dryRun) j.usedLabel = true;
                return { t: 'continue', label: needsLabel ? j.label : undefined };
            }
            if ((j.type === 'loop' || j.type === 'switch') && id === j.exit) {
                const needsLabel = !innermostBreakable;
                if (needsLabel && !dryRun) j.usedLabel = true;
                return { t: 'break', label: needsLabel ? j.label : undefined };
            }
        }
        return null;
    }

    /** The label written in the source (`outer: for …`), or a generated one. */
    labelFor(node, prefix) {
        const labels = node && node.meta && node.meta.labels;
        if (Array.isArray(labels) && labels.length && /^[A-Za-z_$][\w$]*$/.test(labels[0])) return labels[0];
        return `${prefix}${++this.labelCounter}`;
    }

    withVisiting(ctx, id) {
        return { ...ctx, visiting: new Set([...ctx.visiting, id]) };
    }

    emitIf(id, body, ctx) {
        const node = this.node(id);
        const yes = this.edgeTo(id, ['yes', 'true']);
        const no = this.edgeTo(id, ['no', 'false']);
        if (!yes || !no) throw new UnstructuredError(`Condition ${id} needs a "yes" and a "no" branch.`);

        const inner = this.withVisiting(ctx, id);
        // A guard (`if (c) { …; continue; }`) keeps its shape: the code after it is not moved into an else.
        if (node.meta && node.meta.guard) {
            const guarded = this.tryRegion(yes, new Set(ctx.stops), inner);
            const jump = guarded && guarded.stoppedAt !== null ? this.jumpTo(guarded.stoppedAt, { ...ctx, stops: new Set() }) : null;
            if (jump) {
                guarded.body.push(jump);
                guarded.stoppedAt = null;
            }
            if (guarded && guarded.stoppedAt === null && endsWithJump(guarded.body)) {
                body.push(this.ifItem(node, guarded.body, []));
                return no;
            }
        }

        const merge = this.mergePoint(id, ctx);
        const stops = new Set(ctx.stops);
        if (merge) stops.add(merge);

        const thenRegion = this.region(yes, stops, inner);
        const elseRegion = this.region(no, stops, inner);
        const next = this.resolveEnds([thenRegion, elseRegion], merge, ctx);

        body.push(this.ifItem(node, thenRegion.body, elseRegion.body));
        return next;
    }

    /** Region that may not be structurable: null instead of an error (the caller has another way). */
    tryRegion(entry, stops, ctx) {
        const saved = this.labelCounter;
        try {
            return this.region(entry, stops, ctx);
        } catch (error) {
            if (!(error instanceof UnstructuredError)) throw error;
            this.labelCounter = saved;
            return null;
        }
    }

    ifItem(node, thenBody, elseBody) {
        const item = this.tag({ t: 'if', cond: this.hosted(node, 'code', 0, node.code[0]) || 'true', then: thenBody, else: elseBody }, node);
        const source = this.graph.source;
        const head = node.meta && node.meta.head;
        if (head && typeof source === 'string' && node.start !== undefined && item.cond === source.slice(node.start, node.end)) {
            item.headText = source.slice(head[0], head[1]).trimEnd();
            item.headIndent = indentAt(source, head[0]);
        }
        return item;
    }

    /**
     * Decides where the flow continues after a construct whose branches are `regions`.
     * Branches end at the merge point, by jumping away (return / break / ...), or by
     * falling out to an enclosing stop.
     * @returns {string | undefined}
     */
    resolveEnds(regions, merge, ctx) {
        if (merge) {
            for (const region of regions) {
                if (region.stoppedAt === null || region.stoppedAt === merge) continue;
                const jump = ctx.stops.has(region.stoppedAt) ? this.jumpTo(region.stoppedAt, { ...ctx, stops: new Set() }) : null;
                if (!jump) throw new UnstructuredError('A branch leaves its block.');
                region.body.push(jump);
            }
            return merge;
        }
        const ends = [...new Set(regions.map((r) => r.stoppedAt).filter((x) => x !== null))];
        if (ends.length === 0) return undefined;
        const noStops = { ...ctx, stops: new Set() };
        // Ends that are loop headers / exits can be written as continue / break; at most
        // one other end may remain, and the construct falls through to it.
        const plain = ends.filter((e) => !this.jumpTo(e, noStops, true));
        if (plain.length > 1 || (plain.length === 1 && !ctx.stops.has(plain[0]))) {
            throw new UnstructuredError('A branch leaves its block.');
        }
        const fallThrough = plain.length === 1 ? plain[0] : (ends.length === 1 && ctx.stops.has(ends[0]) ? ends[0] : null);
        for (const region of regions) {
            if (region.stoppedAt === null || region.stoppedAt === fallThrough) continue;
            region.body.push(this.jumpTo(region.stoppedAt, noStops));
        }
        return fallThrough || undefined;
    }

    loopEntryExit(id) {
        const node = this.node(id);
        const iteration = node.meta && (node.meta.subtype === 'forof' || node.meta.subtype === 'forin');
        const entry = this.edgeTo(id, iteration ? ['next', 'yes'] : ['yes', 'next', 'true']);
        let exit = this.edgeTo(id, iteration ? ['done', 'no'] : ['no', 'done', 'false']);
        if (!entry) throw new UnstructuredError(`Loop ${id} has no body edge.`);
        const body = loopBody(this.flow, entry, id);
        if (!exit) exit = this.loopExitFromBody(body, id, node);
        return { entry, exit, body };
    }

    emitLoop(id, body, ctx) {
        const node = this.node(id);
        const { entry, exit, body: loopNodes } = this.loopEntryExit(id);
        const jump = {
            type: 'loop',
            continueTarget: id,
            exit,
            body: loopNodes,
            label: this.labelFor(node, 'loop'),
            usedLabel: false
        };
        const inner = { ...this.withVisiting(ctx, id), jumps: [...ctx.jumps, jump], stops: new Set([id]) };
        const region = this.region(entry, inner.stops, inner);
        if (region.stoppedAt !== null && region.stoppedAt !== id) throw new UnstructuredError('Loop body leaves the loop.');

        const meta = node.meta || {};
        let head;
        if (meta.subtype === 'for' || meta.subtype === 'forin' || meta.subtype === 'forof') {
            head = this.hosted(node, 'header', 0, meta.header);
        } else {
            head = `while (${(this.hosted(node, 'code', 0, node.code[0]) || 'true').trim() || 'true'})`;
            // The header as written (several lines, comments) while the condition is unchanged.
            const squash = (t) => String(t).replace(/\s+/g, '');
            if (meta.header && squash(meta.header) === squash(head)) head = meta.header;
        }
        const item = this.tag({ t: 'loop', head, body: region.body, label: jump.usedLabel ? jump.label : undefined }, node);
        if (typeof this.graph.source === 'string' && node.start !== undefined) item.headIndent = indentAt(this.graph.source, node.start);
        body.push(item);
        return exit || undefined;
    }

    emitDoWhile(id, body, ctx) {
        const test = (this.flow.inc.get(id) || [])
            .map((e) => e.from)
            .find((from) => {
                const n = this.node(from);
                return n && n.kind === 'loop' && n.meta && n.meta.subtype === 'dowhile';
            });
        if (!test) throw new UnstructuredError('do…while without its test.');
        const entry = this.singleSuccessor(id);
        const doBody = new Set([...loopBody(this.flow, entry, test), test]);
        const exit = this.edgeTo(test, ['no', 'false']) || this.loopExitFromBody(doBody, id, this.node(id));
        const jump = {
            type: 'loop',
            continueTarget: test,
            exit,
            body: doBody,
            label: this.labelFor(this.node(id), 'loop'),
            usedLabel: false
        };
        const inner = { ...this.withVisiting(ctx, id), jumps: [...ctx.jumps, jump], stops: new Set([test]) };
        const region = entry === test ? { body: [], stoppedAt: test } : this.region(entry, inner.stops, inner);
        if (region.stoppedAt !== null && region.stoppedAt !== test) throw new UnstructuredError('do…while body leaves the loop.');
        const testNode = this.node(test);
        body.push(this.tag({ t: 'do', cond: this.hosted(testNode, 'code', 0, testNode.code[0]) || 'true', body: region.body, label: jump.usedLabel ? jump.label : undefined }, this.node(id)));
        return exit || undefined;
    }

    emitSwitch(id, body, ctx) {
        const node = this.node(id);
        const hint = node.meta && node.meta.exitId && this.flow.reachable.has(node.meta.exitId) ? node.meta.exitId : null;
        let merge = this.mergePoint(id, ctx) || hint;
        const edges = this.outEdges(id);

        // Group case labels by target, keeping the source order.
        const groups = [];
        for (const edge of edges) {
            let test;
            if (edge.code !== undefined && edge.code !== null) test = edge.code;
            else if (edge.label === 'default' || edge.label === 'no match') test = null;
            else if (/^case /.test(edge.label)) test = edge.label.slice(5);
            else throw new UnstructuredError(`Unknown switch branch "${edge.label}".`);
            if (edge.label === 'no match' && edge.to === merge) continue;
            let group = groups.find((g) => g.target === edge.to);
            if (!group) {
                group = { target: edge.to, tests: [] };
                groups.push(group);
            }
            group.tests.push(test);
        }

        // Cases are emitted in source order when the builder recorded it.
        const order = node.meta && Array.isArray(node.meta.caseOrder) ? node.meta.caseOrder : null;
        if (order) {
            const rank = (test) => {
                const i = order.indexOf(test);
                return i < 0 ? order.length : i;
            };
            groups.forEach((g) => g.tests.sort((a, b) => rank(a) - rank(b)));
            groups.sort((a, b) => rank(a.tests[0]) - rank(b.tests[0]));
        }

        const jump = { type: 'switch', exit: merge, label: this.labelFor(node, 'switch'), usedLabel: false };
        const targets = new Set(groups.map((g) => g.target));
        const inner = { ...this.withVisiting(ctx, id), jumps: [...ctx.jumps, jump] };
        const cases = [];
        groups.forEach((group, index) => {
            if (group.target === merge) {
                cases.push({ tests: group.tests, body: [{ t: 'break' }] });
                return;
            }
            const stops = new Set([...ctx.stops, ...targets]);
            stops.delete(group.target);
            if (merge) stops.add(merge);
            const region = this.region(group.target, stops, { ...inner, stops });
            const next = groups[index + 1];
            if (region.stoppedAt === null) {
                // ended with return / throw / break / continue
            } else if (region.stoppedAt === merge) {
                region.body.push({ t: 'break' });
            } else if (next && region.stoppedAt === next.target) {
                // fall-through into the next case
            } else if (ctx.stops.has(region.stoppedAt) && this.jumpTo(region.stoppedAt, { ...ctx, stops: new Set() }, true)) {
                region.body.push(this.jumpTo(region.stoppedAt, { ...ctx, stops: new Set() }));
            } else if (!merge && ctx.stops.has(region.stoppedAt)) {
                // The cases meet again only after an enclosing construct: that is where the switch ends.
                merge = region.stoppedAt;
                jump.exit = merge;
                region.body.push({ t: 'break' });
            } else {
                throw new UnstructuredError(`switch case ends at ${region.stoppedAt}, outside the switch.`);
            }
            cases.push({ tests: group.tests, body: region.body });
        });

        body.push(this.tag({ t: 'switch', disc: this.hosted(node, 'code', 0, node.code[0]) || 'undefined', cases, label: jump.usedLabel ? jump.label : undefined }, node));
        return merge || undefined;
    }

    emitTry(id, body, ctx) {
        const node = this.node(id);
        const meta = node.meta || {};
        const edges = this.outEdges(id);
        const catchId = meta.catchId
            || ((this.flow.out.get(id) || []).find((e) => e.label === 'error') || {}).to;
        const blockEdge = edges.find((e) => e.to !== catchId);
        const catchNode = catchId ? this.node(catchId) : null;
        const finallyId = meta.finallyId && this.flow.nodes.has(meta.finallyId) ? meta.finallyId : null;
        const merge = finallyId || this.mergePoint(id, ctx);

        const stops = new Set(ctx.stops);
        if (merge) stops.add(merge);
        const inner = this.withVisiting(ctx, id);

        const block = blockEdge ? this.region(blockEdge.to, stops, inner) : { body: [], stoppedAt: merge };
        const regions = [block];
        let handler = null;
        if (catchNode) {
            const catchEntry = this.singleSuccessor(catchNode.id);
            const region = catchEntry ? this.region(catchEntry, stops, inner) : { body: [], stoppedAt: merge };
            regions.push(region);
            handler = { param: catchNode.code[0] || '', body: region.body };
        }
        const next = this.resolveEnds(regions, merge, ctx);

        if (!finallyId) {
            body.push(this.tag({ t: 'try', block: block.body, handler, finalizer: null }, node));
            return next;
        }

        // finally: from its first statement to its explicit end node.
        const finallyNode = this.node(finallyId);
        const endId = finallyNode.meta && finallyNode.meta.endId;
        if (endId && this.flow.nodes.has(endId)) {
            const first = this.singleSuccessor(finallyId);
            const region = first === endId || !first
                ? { body: [], stoppedAt: endId }
                : this.region(first, new Set([...ctx.stops, endId]), this.withVisiting(inner, finallyId));
            const after = region.stoppedAt === endId ? this.singleSuccessor(endId) : undefined;
            if (region.stoppedAt !== null && region.stoppedAt !== endId) region.body.push(this.jumpTo(region.stoppedAt, { ...ctx, stops: new Set() }) || (() => { throw new UnstructuredError('finally leaves its block.'); })());
            body.push(this.tag({ t: 'try', block: block.body, handler, finalizer: region.body }, node));
            return after;
        }
        if (!finallyNode.meta || finallyNode.meta.exits === undefined) {
            // A finally with no recorded end never completes normally (it returns / throws).
            const region = this.region(this.singleSuccessor(finallyId), new Set(ctx.stops), this.withVisiting(inner, finallyId));
            body.push(this.tag({ t: 'try', block: block.body, handler, finalizer: region.body }, node));
            return undefined;
        }
        const exits = finallyNode.meta.exits;
        let finalizer = [];
        let after;
        if (exits.length === 1 && exits[0].id === finallyId) {
            after = this.singleSuccessor(finallyId);
        } else if (exits.length > 0 && exits.every((e) => this.node(e.id) && this.node(e.id).kind === 'process' && !e.label)) {
            const region = this.region(this.singleSuccessor(finallyId), new Set(ctx.stops), {
                ...this.withVisiting(inner, finallyId),
                stopAfter: new Set(exits.map((e) => e.id))
            });
            finalizer = region.body;
            after = region.stoppedAfter ? region.stoppedAt || undefined : undefined;
        } else if (exits.length === 0) {
            const region = this.region(this.singleSuccessor(finallyId), new Set(ctx.stops), this.withVisiting(inner, finallyId));
            finalizer = region.body;
            after = undefined;
        } else {
            throw new UnstructuredError('The end of the finally block cannot be determined.');
        }
        body.push(this.tag({ t: 'try', block: block.body, handler, finalizer }, node));
        return after;
    }

    /**
     * @param {{ verbatim?: boolean }} [options] verbatim: print unchanged statements as written
     */
    emitUnit(options = {}) {
        const { unit } = this.flow;
        const ctx = { jumps: [], stops: new Set(), visiting: new Set() };
        const region = this.region(unit.startId, new Set(), ctx);
        const index = this.graph.units.indexOf(unit);
        let body = applyScopes(cleanup(region.body), 0);
        if (options.verbatim) body = this.applyVerbatim(body);
        const inCovered = (n) => {
            const k = nodeIndex(n.id);
            return this.covered.some(([lo, hi]) => k >= lo && k < hi);
        };
        const notReached = this.graph.nodes.filter((n) => n.unit === index && !this.flow.reachable.has(n.id) && n.kind !== 'end' && !inCovered(n));
        // Function declarations placed after a return are hoisted: they still belong to the code.
        const hoisted = notReached.filter((n) => n.meta && n.meta.declaration);
        const unreachable = notReached.filter((n) => !(n.meta && n.meta.declaration));
        if (unreachable.length) {
            this.warnings.push(`${unreachable.length} unreachable node(s) in "${unit.name}" were not converted.`);
        }
        hoisted.forEach((n) => (n.code || []).forEach((c, i) => body.push(this.tag({ t: 'code', text: withSemicolon(c), scope: [] }, n, i))));
        return body;
    }

    /** Replaces the compound statements whose signature is unchanged by their original text. */
    applyVerbatim(body) {
        const source = this.graph.source;
        if (typeof source !== 'string') return body;
        const visit = (list) => list.map((stmt) => {
            const node = stmt.from && this.node(stmt.from);
            const meta = node && node.meta;
            if (meta && meta.sig && meta.span && COMPOUND.has(stmt.t) && stmt.line === 0) {
                const sig = this.signature(stmt);
                if (sig && sig.hash === meta.sig) {
                    if (meta.ids) this.covered.push(meta.ids);
                    return {
                        t: 'verbatim',
                        text: source.slice(meta.span[0], meta.span[1]),
                        indent: indentAt(source, meta.span[0]),
                        notes: stmt.notes,
                        scope: stmt.scope,
                        from: stmt.from,
                        line: 0
                    };
                }
            }
            forEachChildList(stmt, visit);
            return stmt;
        });
        return visit(body);
    }

    /**
     * Signature of an emitted statement: its kind, texts, source nodes, comments,
     * embedded flows and children, with generated label names normalised.
     * @returns {{ hash: string, froms: Set<string>, free: Set<string> } | null}
     */
    signature(stmt) {
        const froms = new Set();
        const free = new Set();
        const walk = (s, labels) => {
            const parts = [s.t];
            if (s.from) {
                froms.add(s.from);
                parts.push(s.from, s.line || 0, this.embeddedSignature(s.from));
            }
            if (s.notes) parts.push(JSON.stringify(s.notes));
            let inner = labels;
            if (s.label && (s.t === 'loop' || s.t === 'do' || s.t === 'switch')) {
                inner = new Map(labels);
                inner.set(s.label, `L${labels.size}`);
                parts.push(`label:${inner.get(s.label)}`);
            } else if (s.label) {
                if (labels.has(s.label)) parts.push(`to:${labels.get(s.label)}`);
                else free.add(s.label);
            }
            for (const key of ['text', 'cond', 'head', 'disc']) if (s[key] !== undefined) parts.push(`${key}=${s[key]}`);
            const list = (items) => `[${items.map((c) => walk(c, inner)).join(',')}]`;
            if (s.t === 'if') parts.push(list(s.then), list(s.else));
            if (s.t === 'loop' || s.t === 'do' || s.t === 'block') parts.push(list(s.body));
            if (s.t === 'switch') s.cases.forEach((c) => parts.push(JSON.stringify(c.tests), list(c.body)));
            if (s.t === 'try') {
                parts.push(list(s.block));
                parts.push(s.handler ? `catch(${s.handler.param})${list(s.handler.body)}` : 'nocatch');
                parts.push(s.finalizer ? list(s.finalizer) : 'nofinally');
            }
            return hash(parts.join('\u0001'));
        };
        const result = walk(stmt, new Map());
        return { hash: result, froms, free };
    }
}

const COMPOUND = new Set(['if', 'loop', 'do', 'switch', 'try']);

function nodeIndex(id) {
    const match = /^n(\d+)$/.exec(String(id));
    return match ? Number(match[1]) : -1;
}

/** Calls `fn(list)` for each child statement list of `stmt` and stores its result. */
function forEachChildList(stmt, fn) {
    if (stmt.t === 'if') {
        stmt.then = fn(stmt.then);
        stmt.else = fn(stmt.else);
    } else if (stmt.t === 'loop' || stmt.t === 'do' || stmt.t === 'block') {
        stmt.body = fn(stmt.body);
    } else if (stmt.t === 'switch') {
        stmt.cases.forEach((c) => { c.body = fn(c.body); });
    } else if (stmt.t === 'try') {
        stmt.block = fn(stmt.block);
        if (stmt.handler) stmt.handler.body = fn(stmt.handler.body);
        if (stmt.finalizer) stmt.finalizer = fn(stmt.finalizer);
    }
}

/**
 * Re-creates the `{ … }` blocks that only limited the scope of declarations:
 * consecutive statements sharing a deeper scope are wrapped in a block.
 */
function applyScopes(body, level) {
    const result = [];
    let i = 0;
    while (i < body.length) {
        const stmt = body[i];
        recurseScopes(stmt);
        const scope = stmt.scope || [];
        if (scope.length > level) {
            const id = scope[level];
            const group = [];
            while (i < body.length && (body[i].scope || []).length > level && body[i].scope[level] === id) {
                group.push(body[i]);
                i++;
            }
            result.push({ t: 'block', body: applyScopes(group, level + 1), scope: scope.slice(0, level) });
        } else {
            result.push(stmt);
            i++;
        }
    }
    return result;
}

function recurseScopes(stmt) {
    const base = (stmt.scope || []).length;
    if (stmt.t === 'if') {
        stmt.then = applyScopes(stmt.then, base);
        stmt.else = applyScopes(stmt.else, base);
    } else if (stmt.t === 'loop' || stmt.t === 'do') {
        stmt.body = applyScopes(stmt.body, base);
    } else if (stmt.t === 'switch') {
        stmt.cases.forEach((c) => { c.body = applyScopes(c.body, base); });
    } else if (stmt.t === 'try') {
        stmt.block = applyScopes(stmt.block, base);
        if (stmt.handler) stmt.handler.body = applyScopes(stmt.handler.body, base);
        if (stmt.finalizer) stmt.finalizer = applyScopes(stmt.finalizer, base);
    }
}

/* ------------------------------------------------------------------------- */
/* Cleanups                                                                    */
/* ------------------------------------------------------------------------- */

function cleanup(body, inLoopTail = false) {
    const result = [];
    for (let i = 0; i < body.length; i++) {
        const stmt = body[i];
        const isLast = i === body.length - 1;
        if (stmt.t === 'if') {
            stmt.then = cleanup(stmt.then, inLoopTail && isLast);
            stmt.else = cleanup(stmt.else, inLoopTail && isLast);
            if (stmt.then.length === 0 && stmt.else.length > 0) {
                stmt.cond = negate(stmt.cond);
                delete stmt.headText;
                stmt.then = stmt.else;
                stmt.else = [];
            }
            // if (c) { …; return; } else { rest }  →  if (c) { …; return; } rest
            if (stmt.else.length > 0 && endsWithJump(stmt.then) && !(stmt.else.length === 1 && stmt.else[0].t === 'if')) {
                const rest = stmt.else;
                stmt.else = [];
                result.push(stmt);
                result.push(...cleanup(rest, inLoopTail && isLast));
                continue;
            }
        } else if (stmt.t === 'loop' || stmt.t === 'do') {
            stmt.body = cleanup(stmt.body, true);
        } else if (stmt.t === 'switch') {
            stmt.cases.forEach((c) => { c.body = cleanup(c.body, false); });
        } else if (stmt.t === 'try') {
            stmt.block = cleanup(stmt.block, false);
            if (stmt.handler) stmt.handler.body = cleanup(stmt.handler.body, false);
            if (stmt.finalizer) stmt.finalizer = cleanup(stmt.finalizer, false);
        } else if (stmt.t === 'continue' && !stmt.label && inLoopTail && isLast) {
            continue; // redundant: the loop continues anyway
        }
        result.push(stmt);
    }
    // A trailing `continue` may have become last after hoisting.
    if (inLoopTail && result.length && result[result.length - 1].t === 'continue' && !result[result.length - 1].label) result.pop();
    return result;
}

/* ------------------------------------------------------------------------- */
/* Printing                                                                    */
/* ------------------------------------------------------------------------- */

/** `let`, `const`, `class` or `function` declared directly in a list of statements. */
function declaresLexically(stmt) {
    return (stmt.t === 'code' || stmt.t === 'raw') && /^\s*(?:export\s+)?(?:const|let|class|function|async\s+function|using)\b/.test(stmt.text)
        && !/^\s*(?:const|let)\s*=/.test(stmt.text);
}

/** Lines that must not be re-indented: inside a template literal, or already final. */
function frozenLines(lines) {
    const keep = templateLines(lines.join('\n'));
    lines.forEach((l, i) => { if (l.startsWith(KEEP)) keep.add(i); });
    return keep;
}

function freeze(line) {
    return line.startsWith(KEEP) ? line : KEEP + line;
}

function reindent(text, pad, original) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    if (lines.length === 1) return [pad + lines[0].trim()];
    const keep = frozenLines(lines);
    // The statement comes from the source and we know where it started: shift it exactly.
    if (typeof original === 'string' && lines.slice(1).every((l, i) => keep.has(i + 1) || !l.trim() || l.startsWith(original))) {
        return [pad + lines[0].trim(), ...lines.slice(1).map((l, i) => {
            if (keep.has(i + 1)) return freeze(l);
            return (l.trim() ? pad + l.slice(original.length) : '').replace(/\s+$/, '');
        })];
    }
    // Keep the relative indentation of multi-line statements. The first line lost its
    // indentation when it was extracted; when the statement ends with a closing line
    // (`});`, `]`, `}`), that line has the original indentation of the statement.
    const rest = lines.slice(1).filter((l, i) => l.trim() && !keep.has(i + 1));
    const indentOf = (l) => l.match(/^\s*/)[0].length;
    const common = rest.length ? Math.min(...rest.map(indentOf)) : 0;
    const last = rest[rest.length - 1] || '';
    const closes = /^\s*[}\])]/.test(last) && indentOf(last) === common;
    const extra = closes ? '' : '    ';
    return [pad + lines[0].trim(), ...lines.slice(1).map((l, i) => {
        if (keep.has(i + 1)) return freeze(l);
        return (l.trim() ? pad + extra + l.slice(common) : '').replace(/\s+$/, '');
    })];
}

/** Lines of a comment, aligned on `pad` (the inner lines of `/** … *\/` keep their star column). */
function commentLines(comment, pad) {
    const lines = String(comment).replace(/\r\n/g, '\n').split('\n');
    return lines.map((l, i) => {
        const trimmed = l.trim();
        if (i === 0) return pad + trimmed;
        return trimmed.startsWith('*') ? `${pad} ${trimmed}` : pad + trimmed;
    });
}

function print(body, indent, unit) {
    const pad = unit.repeat(indent);
    const lines = [];
    body.forEach((stmt, index) => {
        const notes = stmt.notes;
        if (notes) {
            if (notes.blank && index > 0) lines.push('');
            (notes.lead || []).forEach((c) => lines.push(...commentLines(c, pad)));
        }
        const before = lines.length;
        printStatement(stmt, lines, pad, indent, unit);
        if (notes) {
            if (notes.tail && lines.length > before) lines[lines.length - 1] += ` ${notes.tail}`;
            (notes.after || []).forEach((c) => lines.push(...commentLines(c, pad)));
        }
    });
    return lines;
}

function printStatement(stmt, lines, pad, indent, unit) {
    {
        switch (stmt.t) {
            case 'code':
            case 'return':
            case 'throw':
            case 'verbatim':
                lines.push(...reindent(stmt.text, pad, stmt.indent));
                break;
            case 'break':
            case 'continue':
                lines.push(`${pad}${stmt.t}${stmt.label ? ` ${stmt.label}` : ''};`);
                break;
            case 'raw': {
                // User-written block: keep its relative indentation.
                const rawLines = String(stmt.text).replace(/\r\n/g, '\n').split('\n');
                const keep = frozenLines(rawLines);
                const filled = rawLines.filter((l, i) => l.trim() && !keep.has(i));
                const common = filled.length ? Math.min(...filled.map((l) => l.match(/^\s*/)[0].length)) : 0;
                rawLines.forEach((l, i) => {
                    if (keep.has(i)) lines.push(freeze(l));
                    else lines.push(l.trim() ? `${pad}${l.slice(common).trimEnd()}` : '');
                });
                break;
            }
            case 'if': {
                const opening = (s, prefix) => {
                    if (!s.headText) return [`${pad}${prefix}if (${s.cond.trim()}) {`];
                    const head = reindent(`${s.headText} {`, pad, s.headIndent);
                    head[0] = pad + prefix + head[0].trimStart();
                    return head;
                };
                lines.push(...opening(stmt, ''));
                lines.push(...print(stmt.then, indent + 1, unit));
                let elseBody = stmt.else;
                while (elseBody.length === 1 && elseBody[0].t === 'if' && !elseBody[0].notes) {
                    const nested = elseBody[0];
                    lines.push(...opening(nested, '} else '));
                    lines.push(...print(nested.then, indent + 1, unit));
                    elseBody = nested.else;
                }
                if (elseBody.length) {
                    lines.push(`${pad}} else {`);
                    lines.push(...print(elseBody, indent + 1, unit));
                }
                lines.push(`${pad}}`);
                break;
            }
            case 'block':
                lines.push(`${pad}{`);
                lines.push(...print(stmt.body, indent + 1, unit));
                lines.push(`${pad}}`);
                break;
            case 'loop': {
                const head = reindent(`${stmt.head.trim()} {`, pad, stmt.headIndent);
                head[0] = `${pad}${stmt.label ? `${stmt.label}: ` : ''}${head[0].trimStart()}`;
                lines.push(...head);
                lines.push(...print(stmt.body, indent + 1, unit));
                lines.push(`${pad}}`);
                break;
            }
            case 'do':
                lines.push(`${pad}${stmt.label ? `${stmt.label}: ` : ''}do {`);
                lines.push(...print(stmt.body, indent + 1, unit));
                lines.push(`${pad}} while (${stmt.cond.trim()});`);
                break;
            case 'switch':
                lines.push(`${pad}${stmt.label ? `${stmt.label}: ` : ''}switch (${stmt.disc.trim()}) {`);
                for (const c of stmt.cases) {
                    for (const test of c.tests) lines.push(test === null ? `${pad}${unit}default:` : `${pad}${unit}case ${test.trim()}:`);
                    // All cases share one scope: declarations get their own block, as in the original code.
                    if (c.body.some(declaresLexically)) {
                        lines[lines.length - 1] += ' {';
                        lines.push(...print(c.body, indent + 2, unit));
                        lines.push(`${pad}${unit}}`);
                    } else {
                        lines.push(...print(c.body, indent + 2, unit));
                    }
                }
                lines.push(`${pad}}`);
                break;
            case 'try':
                lines.push(`${pad}try {`);
                lines.push(...print(stmt.block, indent + 1, unit));
                if (stmt.handler) {
                    lines.push(`${pad}} catch${stmt.handler.param ? ` (${stmt.handler.param.trim()})` : ''} {`);
                    lines.push(...print(stmt.handler.body, indent + 1, unit));
                }
                if (stmt.finalizer) {
                    lines.push(`${pad}} finally {`);
                    lines.push(...print(stmt.finalizer, indent + 1, unit));
                }
                lines.push(`${pad}}`);
                break;
            default:
                break;
        }
    }
}

/* ------------------------------------------------------------------------- */
/* State machine fallback                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Böhm–Jacopini fallback: any flow graph as `for (;;) { switch (state) … }`.
 *
 * Every node becomes a `case`; jumps assign the next state. What cannot be a
 * plain case is lowered first:
 *  - declarations are hoisted (`let a, b;` at the top) and become assignments,
 *    destructuring included (`({ a, b } = obj);`), `let x;` resets x;
 *  - `for (init; test; update)` gets an init and an update state, `for…of`
 *    drives the iterator by hand (closed with `return()` when left early) and
 *    `for…in` iterates over a snapshot of the keys, skipping deleted ones;
 *  - try / catch / finally use a table of protected states, like the
 *    exception tables of compiled code: the whole dispatcher runs in a `try`,
 *    and its `catch` sends the error to the handler of the state that threw;
 *    a `finally` remembers what it interrupted (error, return value or
 *    target state) and resumes it at its end.
 * @returns {{ lines: string[], warnings: string[] }}
 */
function stateMachine(graph, unitIndex, indentUnit) {
    const flow = buildFlow(graph, unitIndex);
    const unit = graph.units[unitIndex];
    const nodes = flow.nodes;
    const startNode = nodes.get(unit.startId);
    const startMeta = (startNode && startNode.meta) || {};
    const ids = [...flow.reachable].filter((id) => !['start', 'end'].includes(nodes.get(id).kind));
    const warnings = [];
    const pad = (n) => indentUnit.repeat(n);
    const kindOf = (id) => (nodes.get(id) ? nodes.get(id).kind : 'end');

    // Fresh names that cannot clash with the code of the function.
    const used = new Set();
    for (const n of graph.nodes) {
        if (n.unit !== unitIndex) continue;
        for (const c of n.code || []) identifiers(c).forEach((w) => used.add(w));
        if (n.meta && n.meta.header) identifiers(n.meta.header).forEach((w) => used.add(w));
    }
    identifiers(startMeta.params || '').forEach((w) => used.add(w));
    const fresh = (base) => {
        let name = base;
        for (let i = 2; used.has(name); i++) name = `${base}${i}`;
        used.add(name);
        return name;
    };
    const S = fresh('$state');
    const FLOW = fresh('$flow');
    const ERROR = fresh('$error');

    const params = new Set(splitTopLevel(startMeta.params || '', ',').flatMap((p) => patternNames(p.replace(/^\s*\.\.\./, ''))));
    const hoisted = new Set();
    const declaredBy = new Map();
    const hoist = (names, id) => names.forEach((name) => {
        if (!params.has(name)) hoisted.add(name);
        if (!declaredBy.has(name)) declaredBy.set(name, new Set());
        declaredBy.get(name).add(id);
    });
    const assign = (target, value) => (/^[A-Za-z_$][\w$]*$/.test(target) ? `${target} = ${value}` : `(${target} = ${value})`);

    /** A statement of the function as a statement of a `case`. */
    const lower = (code, id) => {
        const text = String(code).trim();
        if (/^export\b/.test(text)) throw new Error('Exported declarations cannot be moved into a state machine. Restructure the diagram.');
        if (/^using\b|^await\s+using\b/.test(text)) throw new Error('`using` declarations cannot be moved into a state machine. Restructure the diagram.');
        const declaration = parseDeclaration(text);
        if (declaration) {
            const parts = [];
            for (const d of declaration.declarators) {
                hoist(d.names, id);
                if (d.init !== null) parts.push(assign(d.target, d.init));
                else if (declaration.kind !== 'var') d.names.forEach((name) => parts.push(`${name} = undefined`));
            }
            return parts.length ? `${parts.join(', ')};` : '';
        }
        const cls = /^class\s+([A-Za-z_$][\w$]*)/.exec(text);
        if (cls) {
            hoist([cls[1]], id);
            return `${cls[1]} = ${text.replace(/;$/, '')};`;
        }
        return text;
    };

    /* ---- loops that need more than one state ---- */
    // Dominators, to find the real back edges of a loop: `continue outer` reaches an inner
    // loop header from outside, but that is not an iteration of the inner loop.
    const preds = new Map(ids.map((id) => [id, []]));
    for (const id of [unit.startId, ...ids]) for (const t of flow.succ.get(id) || []) if (preds.has(t)) preds.get(t).push(id);
    const dom = new Map(ids.map((id) => [id, null]));
    const all = new Set([unit.startId, ...ids]);
    for (const id of ids) dom.set(id, new Set(all));
    for (let changed = true; changed;) {
        changed = false;
        for (const id of ids) {
            let set = null;
            for (const p of preds.get(id)) {
                const ps = p === unit.startId ? new Set([unit.startId]) : dom.get(p);
                set = set === null ? new Set(ps) : new Set([...set].filter((x) => ps.has(x)));
            }
            set = set || new Set();
            set.add(id);
            if (set.size !== dom.get(id).size) {
                dom.set(id, set);
                changed = true;
            }
        }
    }
    const naturalLoop = (header) => {
        const body = new Set();
        const stack = preds.get(header).filter((p) => dom.get(p) && dom.get(p).has(header));
        while (stack.length) {
            const n = stack.pop();
            if (n === header || body.has(n)) continue;
            body.add(n);
            preds.get(n).forEach((p) => stack.push(p));
        }
        return body;
    };
    const loops = new Map();
    for (const id of ids) {
        const node = nodes.get(id);
        const subtype = node.meta && node.meta.subtype;
        if (node.kind !== 'loop' || !['for', 'forin', 'forof'].includes(subtype)) continue;
        const header = parseForHeader(node.meta.header || '');
        if (!header) throw new Error(`Cannot read the loop header "${node.meta.header}". Restructure the diagram.`);
        const entryEdge = (flow.out.get(id) || []).find((e) => isNormalEdge(e) && ['yes', 'next', 'true'].includes(e.label));
        const exitEdge = (flow.out.get(id) || []).find((e) => isNormalEdge(e) && ['no', 'done', 'false'].includes(e.label));
        const body = entryEdge ? naturalLoop(id) : new Set();
        const loop = { id, header, body, entry: entryEdge && entryEdge.to, exit: exitEdge && exitEdge.to };
        if (header.kind === 'of') {
            loop.iterator = fresh('$iterator');
            loop.step = fresh('$step');
        } else if (header.kind === 'in') {
            loop.keys = fresh('$keys');
            loop.object = fresh('$object');
            loop.index = fresh('$index');
        }
        if (header.kind !== 'for') hoist(header.names, id);
        loops.set(id, loop);
    }

    /* ---- protected regions (try / catch / finally) ---- */
    const inSpan = (id, span) => {
        const n = nodes.get(id);
        return !!(n && span && n.start !== undefined && n.start >= span[0] && n.start < span[1]);
    };
    const regions = [];
    const pending = new Map();
    for (const id of ids) {
        const node = nodes.get(id);
        if (node.kind !== 'try') continue;
        const meta = node.meta || {};
        const finallyId = meta.finallyId && flow.reachable.has(meta.finallyId) ? meta.finallyId : null;
        if (finallyId) pending.set(finallyId, fresh('$finally'));
        if (meta.block) regions.push({ tryId: id, span: meta.block, stmt: meta.stmt, handler: meta.catchId || finallyId, finallyId });
        if (meta.handlerBody && finallyId) regions.push({ tryId: id, span: meta.handlerBody, stmt: meta.stmt, handler: finallyId, finallyId });
    }
    const size = (span) => span[1] - span[0];
    const innermost = (list) => list.sort((a, b) => size(a.span) - size(b.span))[0];
    /** The catch / finally that receives an error thrown in state `id`. */
    const handlerOf = (id) => {
        const exception = (flow.out.get(id) || []).find((e) => e.kind === 'exception' && ['catch', 'finally'].includes(kindOf(e.to)));
        if (exception) return exception.to;
        const region = innermost(regions.filter((r) => inSpan(id, r.span)));
        return region ? region.handler : null;
    };

    /* ---- jumps ---- */
    const closeIterators = (from, target) => [...loops.values()]
        .filter((l) => l.header.kind === 'of' && l.body.has(from) && !l.body.has(target) && target !== l.id)
        .map((l) => `if (${l.iterator} && ${l.iterator}.return) ${l.iterator}.return();`);
    const go = (target, from) => {
        const prefix = closeIterators(from, target);
        if (!target || kindOf(target) === 'end') return [...prefix, `break ${FLOW};`].join(' ');
        let state = target;
        const loop = loops.get(target);
        if (loop) state = loop.body.has(from) ? (loop.header.kind === 'for' ? `${target}:next` : target) : `${target}:init`;
        // Leaving a try that has a finally: the finally runs first, then resumes the jump.
        const crossing = innermost(regions.filter((r) => r.finallyId && inSpan(from, r.span) && r.stmt && nodes.get(target).start !== undefined && !inSpan(target, r.stmt)));
        if (crossing) return [...prefix, `${pending.get(crossing.finallyId)} = { state: '${state}' }; ${S} = '${crossing.finallyId}'; continue ${FLOW};`].join(' ');
        return [...prefix, `${S} = '${state}'; continue ${FLOW};`].join(' ');
    };
    const normal = (id) => (flow.out.get(id) || []).filter((e) => isNormalEdge(e) && nodes.has(e.to));
    const to = (id, labels) => (normal(id).find((e) => labels.includes(e.label)) || {}).to;
    const next = (id) => (normal(id)[0] || {}).to;

    /* ---- cases ---- */
    const cases = [];
    const addCase = (state, body) => cases.push({ state, body });
    for (const id of ids) {
        const node = nodes.get(id);
        const body = [];
        const emit = (code) => {
            if (!String(code).trim()) return;
            body.push(...reindent(withSemicolon(code), ''));
        };
        switch (node.kind) {
            case 'process':
                if (node.meta && node.meta.declaration) {
                    body.push(go(next(id), id));
                    break;
                }
                (node.code || []).flatMap((c) => (node.meta && node.meta.multiline ? splitStatements(String(c)) : [c])).forEach((c) => {
                    if (/^\s*(\/\/|\/\*)/.test(c) && !/\n/.test(String(c).trim())) body.push(String(c).trim());
                    else emit(lower(c, id));
                });
                body.push(go(next(id), id));
                break;
            case 'junction':
            case 'try':
            case 'catch':
            case 'finally':
                if (node.kind === 'junction' && node.meta && node.meta.subtype === 'finallyEnd' && pending.has(node.meta.finallyId)) {
                    const variable = pending.get(node.meta.finallyId);
                    const outer = (flow.out.get(id) || []).find((e) => e.kind === 'abrupt' && e.label === 'then return' && kindOf(e.to) === 'finally');
                    const resume = outer && pending.has(outer.to)
                        ? `${pending.get(outer.to)} = p; ${S} = '${outer.to}'; continue ${FLOW};`
                        : 'return p.value;';
                    body.push(`if (${variable} !== undefined) {`);
                    body.push(`${indentUnit}const p = ${variable};`);
                    body.push(`${indentUnit}${variable} = undefined;`);
                    body.push(`${indentUnit}if ('error' in p) throw p.error;`);
                    body.push(`${indentUnit}if ('value' in p) { ${resume} }`);
                    body.push(`${indentUnit}${S} = p.state;`);
                    body.push(`${indentUnit}continue ${FLOW};`);
                    body.push('}');
                }
                body.push(go(node.kind === 'try'
                    ? (normal(id).find((e) => e.to !== (node.meta && node.meta.catchId)) || {}).to
                    : next(id), id));
                break;
            case 'return': {
                const text = String(node.code[0] || 'return').trim().replace(/;$/, '');
                const value = text.replace(/^return\b/, '').trim();
                const viaFinally = (flow.out.get(id) || []).find((e) => e.kind === 'abrupt' && kindOf(e.to) === 'finally' && pending.has(e.to));
                const closing = closeIterators(id, null);
                if (viaFinally) {
                    body.push(...closing);
                    body.push(`${pending.get(viaFinally.to)} = { value: ${value || 'undefined'} };`);
                    body.push(`${S} = '${viaFinally.to}';`);
                    body.push(`continue ${FLOW};`);
                } else if (closing.length) {
                    // The value is computed before the iterators are closed.
                    const result = fresh('$result');
                    body.push(`const ${result} = ${value || 'undefined'};`, ...closing, `return ${result};`);
                } else {
                    emit(text);
                }
                break;
            }
            case 'throw':
                emit(node.code[0] || 'throw new Error()');
                break;
            case 'decision':
                if (node.meta && node.meta.subtype === 'switch') {
                    body.push(`switch (${node.code[0]}) {`);
                    for (const edge of normal(id)) {
                        if (edge.code !== undefined && edge.code !== null) body.push(`${indentUnit}case ${edge.code}: ${go(edge.to, id)}`);
                    }
                    const fallback = normal(id).find((e) => e.label === 'default' || e.label === 'no match');
                    body.push(`${indentUnit}default: ${go(fallback && fallback.to, id)}`);
                    body.push('}');
                    break;
                }
                body.push(`if (${node.code[0]}) { ${go(to(id, ['yes', 'true']), id)} }`);
                body.push(go(to(id, ['no', 'false']), id));
                break;
            case 'loop': {
                const loop = loops.get(id);
                const enter = to(id, ['yes', 'next', 'true']);
                const leave = to(id, ['no', 'done', 'false']);
                if (!loop) {
                    body.push(`if (${node.code[0] || 'true'}) { ${go(enter, id)} }`);
                    body.push(go(leave, id));
                    break;
                }
                const { header } = loop;
                if (header.kind === 'for') {
                    addCase(`${id}:init`, [...(header.init ? reindent(withSemicolon(lower(header.init, id) || ''), '') : []).filter((l) => l.trim() && l.trim() !== ';'), `${S} = '${id}'; continue ${FLOW};`]);
                    body.push(`if (${header.test || 'true'}) { ${go(enter, id)} }`);
                    body.push(go(leave, id));
                    if (header.update) addCase(`${id}:next`, [...reindent(withSemicolon(header.update), ''), `${S} = '${id}'; continue ${FLOW};`]);
                    else addCase(`${id}:next`, [`${S} = '${id}'; continue ${FLOW};`]);
                } else if (header.kind === 'of') {
                    const iterator = header.await
                        ? `(${header.right})[Symbol.asyncIterator] ? (${header.right})[Symbol.asyncIterator]() : (${header.right})[Symbol.iterator]()`
                        : `(${header.right})[Symbol.iterator]()`;
                    addCase(`${id}:init`, [`${loop.iterator} = ${iterator};`, `${S} = '${id}'; continue ${FLOW};`]);
                    body.push(`${loop.step} = ${header.await ? 'await ' : ''}${loop.iterator}.next();`);
                    body.push(`if (${loop.step}.done) { ${loop.iterator} = undefined; ${go(leave, id)} }`);
                    body.push(`${withSemicolon(assign(header.target, `${loop.step}.value`))}`);
                    body.push(go(enter, id));
                } else {
                    addCase(`${id}:init`, [
                        `${loop.object} = ${header.right};`,
                        `${loop.keys} = [];`,
                        `for (const key in ${loop.object}) ${loop.keys}.push(key);`,
                        `${loop.index} = 0;`,
                        `${S} = '${id}'; continue ${FLOW};`
                    ]);
                    // Keys deleted during the loop are skipped, as in a real for…in.
                    body.push(`while (${loop.index} < ${loop.keys}.length && !(${loop.keys}[${loop.index}] in ${loop.object})) ${loop.index}++;`);
                    body.push(`if (${loop.index} >= ${loop.keys}.length) { ${go(leave, id)} }`);
                    body.push(`${withSemicolon(assign(header.target, `${loop.keys}[${loop.index}++]`))}`);
                    body.push(go(enter, id));
                }
                [loop.iterator, loop.step, loop.keys, loop.object, loop.index].filter(Boolean).forEach((v) => hoisted.add(v));
                break;
            }
            default:
                throw new Error(`The diagram is not structured and contains a ${node.kind} node, which cannot be expressed as a state machine.`);
        }
        cases.push({ state: id, body });
    }
    const order = new Map(ids.map((id, i) => [id, i]));
    const rank = (state) => {
        const [id, suffix] = state.split(':');
        return (order.get(id) ?? 0) * 3 + (suffix === 'init' ? 0 : suffix ? 2 : 1);
    };
    cases.sort((a, b) => rank(a.state) - rank(b.state));

    /* ---- the dispatcher ---- */
    const handlers = new Map();
    for (const c of cases) {
        const [id] = c.state.split(':');
        const handler = handlerOf(id);
        if (!handler) continue;
        if (!handlers.has(handler)) handlers.set(handler, []);
        handlers.get(handler).push(c.state);
    }
    const lines = [];
    const declarations = graph.nodes.filter((n) => n.unit === unitIndex && n.meta && n.meta.declaration);
    declarations.forEach((n) => (n.code || []).forEach((c) => lines.push(...reindent(String(c), ''))));
    const entry = next(unit.startId);
    const first = !entry || kindOf(entry) === 'end' ? null : (loops.has(entry) ? `${entry}:init` : entry);
    lines.push(`let ${S} = ${first ? `'${first}'` : 'null'};`);
    lines.push(`${FLOW}: while (${S} !== null) {`);
    const depth = handlers.size ? 2 : 1;
    if (handlers.size) lines.push(`${pad(1)}try {`);
    lines.push(`${pad(depth)}switch (${S}) {`);
    for (const c of cases) {
        lines.push(`${pad(depth + 1)}case '${c.state}': {`);
        c.body.forEach((l) => lines.push(l.startsWith(KEEP) ? l : `${pad(depth + 2)}${l}`));
        lines.push(`${pad(depth + 1)}}`);
    }
    lines.push(`${pad(depth + 1)}default:`);
    lines.push(`${pad(depth + 2)}break ${FLOW};`);
    lines.push(`${pad(depth)}}`);
    if (handlers.size) {
        lines.push(`${pad(1)}} catch (${ERROR}) {`);
        lines.push(`${pad(2)}switch (${S}) {`);
        for (const [handler, states] of handlers) {
            states.forEach((state) => lines.push(`${pad(3)}case '${state}':`));
            const node = nodes.get(handler);
            if (node.kind === 'catch') {
                const param = (node.code[0] || '').trim();
                const names = patternNames(param);
                hoist(names, handler);
                const bind = param ? `${withSemicolon(assign(param, ERROR))} ` : '';
                lines.push(`${pad(4)}${bind}${S} = '${next(handler) && loops.has(next(handler)) ? `${next(handler)}:init` : next(handler)}'; continue ${FLOW};`);
            } else {
                lines.push(`${pad(4)}${pending.get(handler)} = { error: ${ERROR} }; ${S} = '${handler}'; continue ${FLOW};`);
            }
        }
        lines.push(`${pad(3)}default:`);
        lines.push(`${pad(4)}throw ${ERROR};`);
        lines.push(`${pad(2)}}`);
        lines.push(`${pad(1)}}`);
    }
    lines.push('}');
    const variables = [...hoisted, ...pending.values()];
    if (variables.length) lines.unshift(`let ${[...new Set(variables)].join(', ')};`);

    for (const [name, sites] of declaredBy) {
        if (sites.size > 1 || params.has(name)) {
            warnings.push(`"${unit.name}": the variable "${name}" is declared in several places; the state machine uses one variable for all of them.`);
        }
    }
    return { lines, warnings };
}

/** Statements of a multi-line text typed in the editor (one per top-level line). */
function splitStatements(text) {
    const parts = [];
    let current = [];
    for (const line of text.split('\n')) {
        current.push(line);
        const joined = current.join('\n');
        let depth = 0;
        scanTopLevel(joined, (i, ch, d) => { depth = d; });
        if (depth <= 0 && !/[,(+\-*/=&|?:.]\s*$/.test(line.trim())) {
            if (joined.trim()) parts.push(joined);
            current = [];
        }
    }
    if (current.join('\n').trim()) parts.push(current.join('\n'));
    return parts;
}

/* ------------------------------------------------------------------------- */
/* Function headers                                                            */
/* ------------------------------------------------------------------------- */

function header(meta) {
    const asyncKw = meta.async ? 'async ' : '';
    const star = meta.generator ? '*' : '';
    const params = (meta.params || '').trim();
    const typeParams = meta.typeParameters || '';
    const returnType = meta.returnType || '';
    const exportKw = meta.exportDefault ? 'export default ' : (meta.exported ? 'export ' : '');
    const arrow = meta.isArrow && !meta.generator;
    // A named function expression keeps its own name (it may call itself through it).
    const ownName = typeof meta.ownName === 'string' && /^[A-Za-z_$][\w$]*$/.test(meta.ownName) ? ` ${meta.ownName}` : '';
    const fnExpr = arrow
        ? `${asyncKw}${typeParams}(${params})${returnType} => {`
        : `${asyncKw}function${star}${ownName}${typeParams}(${params})${returnType} {`;

    switch (meta.fnKind) {
        case 'function':
            return { open: `${exportKw}${asyncKw}function${star} ${meta.name}${typeParams}(${params})${returnType} {`, close: '}' };
        case 'variable':
            return { open: `${exportKw}${meta.declKind || 'const'} ${meta.name} = ${fnExpr}`, close: '};' };
        case 'method': {
            const prefix = [meta.static ? 'static' : '', meta.async ? 'async' : '', meta.accessor || ''].filter(Boolean).join(' ');
            return { open: `${prefix ? `${prefix} ` : ''}${star}${meta.name}${typeParams}(${params})${returnType} {`, close: '}' };
        }
        case 'field':
            return { open: `${meta.static ? 'static ' : ''}${meta.name} = ${fnExpr}`, close: '};' };
        case 'assignment':
            return { open: `${meta.target} = ${fnExpr}`, close: '};' };
        case 'expression':
        default:
            if (meta.exportDefault) return { open: `export default ${fnExpr}`, close: arrow ? '};' : '}' };
            // A function expression is regenerated as the expression itself, so it can replace the original in place.
            if (ownName) return { open: fnExpr, close: '}' };
            if (!arrow && meta.ownName !== false && meta.name && /^[A-Za-z_$][\w$]*$/.test(meta.name)
                && meta.name !== 'anonymous' && meta.name !== 'default' && meta.ownName) {
                return { open: `${asyncKw}function${star} ${meta.name}${typeParams}(${params})${returnType} {`, close: '}' };
            }
            return { open: fnExpr, close: '}' };
    }
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * @typedef {Object} CodegenResult
 * @property {string} code
 * @property {Array<{ name: string, mode: 'original' | 'structured' | 'state-machine' }>} units
 * @property {string[]} warnings
 */

/**
 * Generates source code from a flowchart graph.
 *
 * @param {import('./graph').Graph} graph
 * @param {{ indent?: string, unit?: number, forceStateMachine?: boolean, strict?: boolean, verbatim?: boolean }} [options]
 *   strict: throw instead of falling back to a state machine (used by tests)
 *   verbatim: print unchanged code as it was written (default true; false regenerates everything)
 * @returns {CodegenResult}
 */
function generateCode(graph, options = {}) {
    const indentUnit = options.indent || graph.indent || '    ';
    const verbatim = options.verbatim !== false && !options.forceStateMachine;
    // Inline callbacks are part of the code of the statement that contains them.
    const indices = typeof options.unit === 'number'
        ? [options.unit]
        : graph.units.map((u, i) => (isEmbeddedUnit(u) ? -1 : i)).filter((i) => i >= 0);
    const chunks = [];
    const units = [];
    const warnings = [];

    for (const index of indices) {
        const unit = graph.units[index];
        const start = graph.nodes.find((n) => n.id === unit.startId);
        const meta = (start && start.meta) || { isMain: true };
        let bodyLines;
        let mode = 'structured';
        let whole = null;
        try {
            if (options.forceStateMachine) throw new UnstructuredError('forced');
            const emitter = new StructuredEmitter(graph, index);
            emitter.indentUnit = indentUnit;
            let body = emitter.emitUnit();
            // Nothing changed in this function: print it back exactly as it was written.
            if (verbatim && typeof graph.source === 'string' && meta.sig && unit.span
                && unitRootSignature(emitter, body, meta) === meta.sig) {
                whole = dedent(graph.source.slice(unit.span[0], unit.span[1]), graph.baseIndent ?? closingIndent(graph.source, unit.span));
            } else {
                if (verbatim) {
                    emitter.warnings = [];
                    emitter.covered = [];
                    body = emitter.emitUnit({ verbatim: true });
                }
                warnings.push(...emitter.warnings);
                bodyLines = print(body, 0, indentUnit);
            }
        } catch (error) {
            if (!(error instanceof UnstructuredError)) throw error;
            if (options.strict) throw error;
            mode = 'state-machine';
            const machine = stateMachine(graph, index, indentUnit);
            bodyLines = machine.lines;
            warnings.push(...machine.warnings);
            if (!options.forceStateMachine) {
                warnings.push(`"${unit.name}" is not a structured flowchart; it was converted to an equivalent state machine.`);
            }
        }
        units.push({ name: unit.name, mode: whole !== null ? 'original' : mode });

        if (whole !== null) {
            chunks.push(whole);
        } else if (meta.isMain || meta.blockName) {
            const block = meta.blockName ? ['static {', ...bodyLines.map((l) => indentLine(l, indentUnit)), '}'] : bodyLines;
            chunks.push(block.join('\n'));
        } else {
            const { open, close } = header(meta);
            chunks.push([open, ...bodyLines.map((l) => indentLine(l, indentUnit)), close].join('\n'));
        }
    }

    return { code: `${chunks.join('\n\n').split(KEEP).join('')}\n`, units, warnings };
}

function indentLine(line, indent) {
    return line && !line.startsWith(KEEP) ? indent + line : line;
}

/** Signature of a whole function: its header and every statement of its body. */
function unitRootSignature(emitter, body, meta) {
    const parts = [meta.isMain ? 'main' : JSON.stringify(header(meta)), meta.blockName || ''];
    for (const stmt of body) {
        const sig = emitter.signature(stmt);
        if (sig.free.size) return null;
        parts.push(sig.hash);
    }
    return hash(parts.join('\u0001'));
}

/** Indentation of the last line of a span when it only closes the code (`}`, `};`). */
function closingIndent(source, span) {
    const text = source.slice(span[0], span[1]);
    const last = text.slice(text.lastIndexOf('\n') + 1);
    return text.includes('\n') && /^[ \t]*[}\])]/.test(last) ? last.match(/^[ \t]*/)[0] : '';
}

/** Removes `indent` from every line but the first (the code is re-indented where it is inserted). */
function dedent(text, indent) {
    if (!indent) return text;
    const keep = templateLines(text);
    return text.split('\n').map((l, i) => (i > 0 && !keep.has(i) && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n');
}

/**
 * Records, on a graph built from code, the signatures that let unchanged
 * statements and functions be printed back as written, and the signature of
 * every embedded flow (to detect the callbacks that were edited).
 * @param {import('./graph').Graph} graph
 * @returns {import('./graph').Graph}
 */
function annotateSource(graph) {
    const cache = new Map();
    graph.units.forEach((unit, index) => {
        if (isEmbeddedUnit(unit)) unit.sig = unitSignature(graph, index, cache);
    });
    if (typeof graph.source !== 'string') return graph;
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const spans = graph.units.filter((u) => !isEmbeddedUnit(u) && u.span).map((u) => u.span);

    graph.units.forEach((unit, index) => {
        if (isEmbeddedUnit(unit)) return;
        let emitter;
        let body;
        try {
            emitter = new StructuredEmitter(graph, index);
            body = emitter.emitUnit();
        } catch (error) {
            if (error instanceof UnstructuredError) return;
            throw error;
        }
        const producing = (n) => emitter.flow.reachable.has(n.id) && (
            ['process', 'decision', 'return', 'throw', 'try'].includes(n.kind)
            || (n.kind === 'loop' && !(n.meta && n.meta.subtype === 'dowhile'))
            || (n.kind === 'junction' && n.meta && n.meta.subtype === 'do'));
        const unitNodes = graph.nodes.filter((n) => n.unit === index);

        const visit = (list) => {
            for (const stmt of list) {
                const node = stmt.from && nodes.get(stmt.from);
                const meta = node && node.meta;
                if (meta && meta.span && meta.ids && COMPOUND.has(stmt.t) && stmt.line === 0) {
                    const sig = emitter.signature(stmt);
                    const [lo, hi] = meta.ids;
                    const inRange = (id) => nodeIndex(id) >= lo && nodeIndex(id) < hi;
                    const expected = unitNodes.filter((n) => inRange(n.id) && producing(n));
                    // The statement must be exactly the code of these nodes, with no jump to a label outside of it.
                    if (!sig.free.size && [...sig.froms].every(inRange) && expected.every((n) => sig.froms.has(n.id))) meta.sig = sig.hash;
                }
                forEachChildList(stmt, (child) => {
                    visit(child);
                    return child;
                });
            }
        };
        visit(body);

        const start = nodes.get(unit.startId);
        if (!start || !unit.span) return;
        const meta = start.meta || (start.meta = { isMain: true });
        if (meta.blockName) return;
        // Top-level code mixed with functions: its span also holds them.
        if (meta.isMain && spans.some((sp) => sp !== unit.span && sp[0] >= unit.span[0] && sp[1] <= unit.span[1])) return;
        if (!meta.isMain && !sameShape(header(meta), graph.source.slice(unit.span[0], unit.span[1]))) return;
        const sig = unitRootSignature(emitter, body, meta);
        if (sig) meta.sig = sig;
    });
    return graph;
}

/** Whether the source of a function starts and ends like the header the generator would write. */
function sameShape({ open, close }, text) {
    const squash = (t) => t.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '').replace(/,\)/g, ')');
    const source = squash(text);
    const head = squash(open);
    const tail = squash(close).replace(/;$/, '');
    return source.startsWith(head) && source.replace(/;$/, '').endsWith(tail);
}

/**
 * Body of one unit (without its header), e.g. to put the code of a callback
 * flow back into the statement that contains it.
 * @returns {string}
 */
function generateBody(graph, unitIndex, indent = graph.indent || '    ') {
    return bodyLines(graph, unitIndex, indent).join('\n').split(KEEP).join('');
}

/** The expression of a flow that only returns a value (`return a + b;` → `a + b`), else null. */
function singleReturn(graph, unitIndex) {
    try {
        const body = new StructuredEmitter(graph, unitIndex).emitUnit();
        if (body.length !== 1 || body[0].t !== 'return' || body[0].notes) return null;
        const expression = body[0].text.trim().replace(/^return\b/, '').replace(/;$/, '').trim();
        return expression || null;
    } catch (error) {
        if (error instanceof UnstructuredError) return null;
        throw error;
    }
}

/** Lines of the body of a unit; lines starting with KEEP must not be re-indented. */
function bodyLines(graph, unitIndex, indent) {
    try {
        const emitter = new StructuredEmitter(graph, unitIndex);
        emitter.indentUnit = indent;
        return print(emitter.emitUnit({ verbatim: true }), 0, indent);
    } catch (error) {
        if (!(error instanceof UnstructuredError)) throw error;
        return stateMachine(graph, unitIndex, indent).lines;
    }
}

module.exports = { generateCode, generateBody, annotateSource, unitSignature, UnstructuredError };
