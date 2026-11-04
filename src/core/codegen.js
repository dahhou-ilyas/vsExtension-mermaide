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
 */

const { indexGraph } = require('./graph');

class UnstructuredError extends Error {}

const EXIT = '__exit__';
const TERMINAL_KINDS = new Set(['end', 'return', 'throw']);

/* ------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* ------------------------------------------------------------------------- */

function withSemicolon(code) {
    const text = String(code).trimEnd();
    if (!text) return text;
    const lastLine = text.split('\n').pop().trim();
    if (lastLine.startsWith('//') || lastLine.endsWith('*/')) return text;
    return /[;}{]$/.test(text) ? text : `${text};`;
}

function negate(condition) {
    const text = condition.trim();
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
        succ.set(node.id, (out.get(node.id) || []).filter((e) => nodes.has(e.to)).map((e) => e.to));
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
    }

    node(id) {
        return this.flow.nodes.get(id);
    }

    outEdges(id) {
        return (this.flow.out.get(id) || []).filter((e) => this.flow.nodes.has(e.to));
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
        const inScope = (m) => !loop || loop.body.has(m) || m === loop.continueTarget;
        const merge = this.flow.ipd(id);
        if (merge && inScope(merge)) return merge;

        const blockers = new Set([...ctx.stops, id]);
        for (const j of ctx.jumps) {
            if (j.continueTarget) blockers.add(j.continueTarget);
            if (j.exit) blockers.add(j.exit);
        }
        const branches = [...new Set(this.flow.succ.get(id) || [])];
        const counts = new Map();
        for (const branch of branches) {
            const seen = new Set();
            const stack = [branch];
            while (stack.length) {
                const n = stack.pop();
                if (seen.has(n) || blockers.has(n) || !this.flow.succ.has(n)) continue;
                seen.add(n);
                (this.flow.succ.get(n) || []).forEach((s) => stack.push(s));
            }
            seen.forEach((n) => counts.set(n, (counts.get(n) || 0) + 1));
        }
        const candidates = [...counts].filter(([n, c]) => c >= 2 && inScope(n)).map(([n]) => n);
        if (!candidates.length) return null;
        candidates.sort((a, b) => (this.flow.rpo.get(a) ?? 0) - (this.flow.rpo.get(b) ?? 0));
        return candidates[0];
    }

    /** Single node outside the loop body that the body jumps to, if any. */
    loopExitFromBody(body, header) {
        const exits = new Set();
        for (const n of body) {
            for (const s of this.flow.succ.get(n) || []) {
                if (s !== header && !body.has(s)) exits.add(s);
            }
        }
        if (exits.size > 1) throw new UnstructuredError('Loop with several exits.');
        return exits.size ? [...exits][0] : null;
    }

    /**
     * Emits statements from `entry` until a node of `stops` is reached.
     * @returns {{ body: any[], stoppedAt: string | null }}
     */
    region(entry, stops, ctx) {
        ctx = { ...ctx, stops };
        const body = [];
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

            switch (node.kind) {
                case 'start':
                    cur = this.singleSuccessor(cur);
                    break;
                case 'end':
                    return { body, stoppedAt: null };
                case 'process':
                    for (const line of node.code || []) {
                        if (!String(line).trim()) continue;
                        body.push(node.meta && node.meta.multiline
                            ? { t: 'raw', text: withSemicolon(line) }
                            : { t: 'code', text: withSemicolon(line) });
                    }
                    if (ctx.stopAfter && ctx.stopAfter.has(cur)) {
                        return { body, stoppedAt: this.singleSuccessor(cur) || null, stoppedAfter: true };
                    }
                    cur = this.singleSuccessor(cur);
                    break;
                case 'return':
                    body.push({ t: 'return', text: withSemicolon(node.code[0] || 'return') });
                    return { body, stoppedAt: null };
                case 'throw':
                    body.push({ t: 'throw', text: withSemicolon(node.code[0] || 'throw new Error()') });
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
    jumpTo(id, ctx) {
        for (let i = ctx.jumps.length - 1; i >= 0; i--) {
            const j = ctx.jumps[i];
            const innermostBreakable = ctx.jumps.slice(i + 1).every((x) => x.type === 'if');
            const innermostLoop = !ctx.jumps.slice(i + 1).some((x) => x.type === 'loop');
            if (j.type === 'loop' && id === j.continueTarget) {
                const needsLabel = !innermostLoop;
                if (needsLabel) j.usedLabel = true;
                return { t: 'continue', label: needsLabel ? j.label : undefined };
            }
            if ((j.type === 'loop' || j.type === 'switch') && id === j.exit) {
                const needsLabel = !innermostBreakable;
                if (needsLabel) j.usedLabel = true;
                return { t: 'break', label: needsLabel ? j.label : undefined };
            }
        }
        return null;
    }

    withVisiting(ctx, id) {
        return { ...ctx, visiting: new Set([...ctx.visiting, id]) };
    }

    emitIf(id, body, ctx) {
        const node = this.node(id);
        const yes = this.edgeTo(id, ['yes', 'true']);
        const no = this.edgeTo(id, ['no', 'false']);
        if (!yes || !no) throw new UnstructuredError(`Condition ${id} needs a "yes" and a "no" branch.`);

        const merge = this.mergePoint(id, ctx);
        const stops = new Set(ctx.stops);
        if (merge) stops.add(merge);
        const inner = this.withVisiting(ctx, id);

        const thenRegion = this.region(yes, stops, inner);
        const elseRegion = this.region(no, stops, inner);
        const next = this.resolveEnds([thenRegion, elseRegion], merge, ctx);

        body.push({ t: 'if', cond: node.code[0] || 'true', then: thenRegion.body, else: elseRegion.body });
        return next;
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
        if (ends.length === 1 && ctx.stops.has(ends[0])) return ends[0];
        // Several different exits: keep the first one as fall-through, jump to the others.
        const [first, ...others] = ends;
        for (const region of regions) {
            if (region.stoppedAt === null || region.stoppedAt === first) continue;
            const jump = this.jumpTo(region.stoppedAt, { ...ctx, stops: new Set() });
            if (!jump) throw new UnstructuredError('A branch leaves its block.');
            region.body.push(jump);
        }
        if (!ctx.stops.has(first) && others.length) throw new UnstructuredError('A branch leaves its block.');
        return first;
    }

    loopEntryExit(id) {
        const node = this.node(id);
        const iteration = node.meta && (node.meta.subtype === 'forof' || node.meta.subtype === 'forin');
        const entry = this.edgeTo(id, iteration ? ['next', 'yes'] : ['yes', 'next', 'true']);
        let exit = this.edgeTo(id, iteration ? ['done', 'no'] : ['no', 'done', 'false']);
        if (!entry) throw new UnstructuredError(`Loop ${id} has no body edge.`);
        const body = loopBody(this.flow, entry, id);
        if (!exit) exit = this.loopExitFromBody(body, id);
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
            label: `loop${++this.labelCounter}`,
            usedLabel: false
        };
        const inner = { ...this.withVisiting(ctx, id), jumps: [...ctx.jumps, jump], stops: new Set([id]) };
        const region = this.region(entry, inner.stops, inner);
        if (region.stoppedAt !== null && region.stoppedAt !== id) throw new UnstructuredError('Loop body leaves the loop.');

        const meta = node.meta || {};
        let head;
        if (meta.subtype === 'for' || meta.subtype === 'forin' || meta.subtype === 'forof') {
            head = meta.header;
        } else {
            head = `while (${(node.code[0] || 'true').trim() || 'true'})`;
        }
        body.push({ t: 'loop', head, body: region.body, label: jump.usedLabel ? jump.label : undefined });
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
        const exit = this.edgeTo(test, ['no', 'false']) || this.loopExitFromBody(doBody, id);
        const jump = {
            type: 'loop',
            continueTarget: test,
            exit,
            body: doBody,
            label: `loop${++this.labelCounter}`,
            usedLabel: false
        };
        const inner = { ...this.withVisiting(ctx, id), jumps: [...ctx.jumps, jump], stops: new Set([test]) };
        const region = entry === test ? { body: [], stoppedAt: test } : this.region(entry, inner.stops, inner);
        if (region.stoppedAt !== null && region.stoppedAt !== test) throw new UnstructuredError('do…while body leaves the loop.');
        body.push({ t: 'do', cond: this.node(test).code[0] || 'true', body: region.body, label: jump.usedLabel ? jump.label : undefined });
        return exit || undefined;
    }

    emitSwitch(id, body, ctx) {
        const node = this.node(id);
        const merge = this.mergePoint(id, ctx);
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

        const jump = { type: 'switch', exit: merge, label: `switch${++this.labelCounter}`, usedLabel: false };
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
            } else if (ctx.stops.has(region.stoppedAt)) {
                const out = this.jumpTo(region.stoppedAt, { ...ctx, stops: new Set() });
                if (!out) throw new UnstructuredError('switch case leaves the switch.');
                region.body.push(out);
            } else {
                throw new UnstructuredError('switch case falls through to a non-adjacent case.');
            }
            cases.push({ tests: group.tests, body: region.body });
        });

        body.push({ t: 'switch', disc: node.code[0] || 'undefined', cases, label: jump.usedLabel ? jump.label : undefined });
        return merge || undefined;
    }

    emitTry(id, body, ctx) {
        const node = this.node(id);
        const meta = node.meta || {};
        const edges = this.outEdges(id);
        const catchEdge = edges.find((e) => e.label === 'error');
        const blockEdge = edges.find((e) => e !== catchEdge);
        const catchNode = catchEdge ? this.node(catchEdge.to) : null;
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
            body.push({ t: 'try', block: block.body, handler, finalizer: null });
            return next;
        }

        // finally: from its first statement to the recorded exits of the block.
        const finallyNode = this.node(finallyId);
        const exits = (finallyNode.meta && finallyNode.meta.exits) || [];
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
        body.push({ t: 'try', block: block.body, handler, finalizer });
        return after;
    }

    emitUnit() {
        const { unit } = this.flow;
        const ctx = { jumps: [], stops: new Set(), visiting: new Set() };
        const region = this.region(unit.startId, new Set(), ctx);
        const unreachable = this.graph.nodes.filter((n) => n.unit === this.graph.units.indexOf(unit)
            && !this.flow.reachable.has(n.id) && n.kind !== 'end');
        if (unreachable.length) {
            this.warnings.push(`${unreachable.length} unreachable node(s) in "${unit.name}" were not converted.`);
        }
        return cleanup(region.body);
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

function reindent(text, pad) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    if (lines.length === 1) return [pad + lines[0].trim()];
    // Keep the relative indentation of multi-line statements.
    const rest = lines.slice(1).filter((l) => l.trim());
    const common = rest.length ? Math.min(...rest.map((l) => l.match(/^\s*/)[0].length)) : 0;
    return [pad + lines[0].trim(), ...lines.slice(1).map((l) => (l.trim() ? pad + '    ' + l.slice(common) : ''))]
        .map((l) => l.replace(/\s+$/, ''));
}

function print(body, indent, unit) {
    const pad = unit.repeat(indent);
    const lines = [];
    for (const stmt of body) {
        switch (stmt.t) {
            case 'code':
            case 'return':
            case 'throw':
                lines.push(...reindent(stmt.text, pad));
                break;
            case 'break':
            case 'continue':
                lines.push(`${pad}${stmt.t}${stmt.label ? ` ${stmt.label}` : ''};`);
                break;
            case 'raw': {
                // User-written block: keep its relative indentation.
                const rawLines = String(stmt.text).replace(/\r\n/g, '\n').split('\n');
                const filled = rawLines.filter((l) => l.trim());
                const common = filled.length ? Math.min(...filled.map((l) => l.match(/^\s*/)[0].length)) : 0;
                rawLines.forEach((l) => lines.push(l.trim() ? `${pad}${l.slice(common).trimEnd()}` : ''));
                break;
            }
            case 'if': {
                lines.push(`${pad}if (${stmt.cond.trim()}) {`);
                lines.push(...print(stmt.then, indent + 1, unit));
                let elseBody = stmt.else;
                while (elseBody.length === 1 && elseBody[0].t === 'if') {
                    const nested = elseBody[0];
                    lines.push(`${pad}} else if (${nested.cond.trim()}) {`);
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
            case 'loop':
                lines.push(`${pad}${stmt.label ? `${stmt.label}: ` : ''}${stmt.head.trim()} {`);
                lines.push(...print(stmt.body, indent + 1, unit));
                lines.push(`${pad}}`);
                break;
            case 'do':
                lines.push(`${pad}${stmt.label ? `${stmt.label}: ` : ''}do {`);
                lines.push(...print(stmt.body, indent + 1, unit));
                lines.push(`${pad}} while (${stmt.cond.trim()});`);
                break;
            case 'switch':
                lines.push(`${pad}${stmt.label ? `${stmt.label}: ` : ''}switch (${stmt.disc.trim()}) {`);
                for (const c of stmt.cases) {
                    for (const test of c.tests) lines.push(test === null ? `${pad}${unit}default:` : `${pad}${unit}case ${test.trim()}:`);
                    lines.push(...print(c.body, indent + 2, unit));
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
    return lines;
}

/* ------------------------------------------------------------------------- */
/* State machine fallback                                                     */
/* ------------------------------------------------------------------------- */

function stateMachine(graph, unitIndex, indentUnit) {
    const flow = buildFlow(graph, unitIndex);
    const ids = [...flow.reachable];
    const entry = (graph.units[unitIndex] && flow.succ.get(graph.units[unitIndex].startId)[0]) || null;
    const lines = [];
    const pad = (n) => indentUnit.repeat(n);
    const go = (target) => (!target || flow.nodes.get(target).kind === 'end' ? 'break flow;' : `state = '${target}'; continue flow;`);
    const hoisted = [];
    const hoist = (code) => {
        const text = String(code).trim();
        const match = /^(const|let|var)\s+([\s\S]*?);?$/.exec(text);
        if (!match) return text;
        const declarators = splitTopLevel(match[2], ',');
        const assignments = [];
        for (const declarator of declarators) {
            const m = /^([A-Za-z_$][\w$]*)\s*(?::[^=]+)?(?:=([\s\S]*))?$/.exec(declarator.trim());
            if (!m) throw new Error(`Cannot convert "${text}" to a state machine (destructuring). Restructure the diagram.`);
            hoisted.push(m[1]);
            if (m[2] !== undefined) assignments.push(`${m[1]} = ${m[2].trim()}`);
        }
        return assignments.length ? `${assignments.join(', ')};` : '';
    };

    lines.push(`let state = ${entry ? `'${entry}'` : 'null'};`);
    lines.push('flow: while (state !== null) {');
    lines.push(`${pad(1)}switch (state) {`);
    for (const id of ids) {
        const node = flow.nodes.get(id);
        const edges = (flow.out.get(id) || []).filter((e) => flow.nodes.has(e.to));
        const to = (labels) => {
            const edge = edges.find((e) => labels.includes(e.label));
            return edge ? edge.to : undefined;
        };
        if (node.kind === 'start' || node.kind === 'end') continue;
        lines.push(`${pad(2)}case '${id}': {`);
        const body = pad(3);
        switch (node.kind) {
            case 'process':
                (node.code || []).flatMap((c) => (node.meta && node.meta.multiline ? splitTopLevel(String(c), '\n') : [c])).forEach((c) => {
                    if (/^\s*\/\//.test(c)) {
                        lines.push(body + String(c).trim());
                        return;
                    }
                    const code = hoist(c);
                    if (code.trim()) lines.push(...reindent(withSemicolon(code), body));
                });
                lines.push(body + go(flow.succ.get(id)[0]));
                break;
            case 'junction':
                lines.push(body + go(flow.succ.get(id)[0]));
                break;
            case 'return':
            case 'throw':
                lines.push(...reindent(withSemicolon(node.code[0] || node.kind), body));
                break;
            case 'decision':
                if (node.meta && node.meta.subtype === 'switch') {
                    lines.push(`${body}switch (${node.code[0]}) {`);
                    for (const edge of edges) {
                        if (edge.code !== undefined && edge.code !== null) lines.push(`${body}${indentUnit}case ${edge.code}: ${go(edge.to)}`);
                    }
                    const fallback = edges.find((e) => e.label === 'default' || e.label === 'no match');
                    lines.push(`${body}${indentUnit}default: ${fallback ? go(fallback.to) : 'break flow;'}`);
                    lines.push(`${body}}`);
                    break;
                }
                lines.push(`${body}if (${node.code[0]}) { ${go(to(['yes', 'true']))} }`);
                lines.push(body + go(to(['no', 'false'])));
                break;
            case 'loop': {
                const subtype = node.meta && node.meta.subtype;
                if (subtype === 'for' || subtype === 'forin' || subtype === 'forof') {
                    throw new Error(`The diagram is not structured and contains a "${node.meta.header}" loop, which cannot be expressed as a state machine. Use a while loop or restructure the diagram.`);
                }
                lines.push(`${body}if (${node.code[0] || 'true'}) { ${go(to(['yes', 'next', 'true']))} }`);
                lines.push(body + go(to(['no', 'done', 'false'])));
                break;
            }
            default:
                throw new Error(`The diagram is not structured and contains a ${node.kind} node, which cannot be expressed as a state machine.`);
        }
        lines.push(`${pad(2)}}`);
    }
    lines.push(`${pad(2)}default:`);
    lines.push(`${pad(3)}break flow;`);
    lines.push(`${pad(1)}}`);
    lines.push('}');
    if (hoisted.length) lines.unshift(`let ${[...new Set(hoisted)].join(', ')};`);
    return lines;
}

/** Splits on `separator` outside of brackets and strings. */
function splitTopLevel(text, separator) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            current += ch;
            if (ch === '\\') {
                current += text[++i] || '';
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        if (ch === separator && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current);
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
    const fnExpr = arrow
        ? `${asyncKw}${typeParams}(${params})${returnType} => {`
        : `${asyncKw}function${star}${typeParams}(${params})${returnType} {`;

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
            if (meta.name && meta.name !== 'anonymous' && meta.name !== 'default' && !arrow) {
                return { open: `${asyncKw}function${star} ${meta.name}${typeParams}(${params})${returnType} {`, close: '}' };
            }
            return { open: arrow ? `(${fnExpr}` : `(${fnExpr}`, close: arrow ? '});' : '});' };
    }
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * @typedef {Object} CodegenResult
 * @property {string} code
 * @property {Array<{ name: string, mode: 'structured' | 'state-machine' }>} units
 * @property {string[]} warnings
 */

/**
 * Generates source code from a flowchart graph.
 *
 * @param {import('./graph').Graph} graph
 * @param {{ indent?: string, unit?: number, forceStateMachine?: boolean }} [options]
 * @returns {CodegenResult}
 */
function generateCode(graph, options = {}) {
    const indentUnit = options.indent || '    ';
    const indices = typeof options.unit === 'number' ? [options.unit] : graph.units.map((_, i) => i);
    const chunks = [];
    const units = [];
    const warnings = [];

    for (const index of indices) {
        const unit = graph.units[index];
        const start = graph.nodes.find((n) => n.id === unit.startId);
        const meta = (start && start.meta) || { isMain: true };
        let bodyLines;
        let mode = 'structured';
        try {
            if (options.forceStateMachine) throw new UnstructuredError('forced');
            const emitter = new StructuredEmitter(graph, index);
            const body = emitter.emitUnit();
            warnings.push(...emitter.warnings);
            bodyLines = print(body, 0, indentUnit);
        } catch (error) {
            if (!(error instanceof UnstructuredError)) throw error;
            mode = 'state-machine';
            bodyLines = stateMachine(graph, index, indentUnit);
            if (!options.forceStateMachine) {
                warnings.push(`"${unit.name}" is not a structured flowchart; it was converted to an equivalent state machine.`);
            }
        }
        units.push({ name: unit.name, mode });

        if (meta.isMain || meta.blockName) {
            const block = meta.blockName ? ['static {', ...bodyLines.map((l) => (l ? indentUnit + l : l)), '}'] : bodyLines;
            chunks.push(block.join('\n'));
        } else {
            const { open, close } = header(meta);
            chunks.push([open, ...bodyLines.map((l) => (l ? indentUnit + l : l)), close].join('\n'));
        }
    }

    return { code: `${chunks.join('\n\n')}\n`, units, warnings };
}

module.exports = { generateCode, UnstructuredError };
