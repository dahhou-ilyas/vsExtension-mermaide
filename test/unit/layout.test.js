'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildFlowchart } = require('../../src/core/flowchartBuilder');
const { layoutGraph, placeWithGaps } = require('../../src/core/layout');
const { locateFunctions } = require('../../src/core/functionLocator');

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Invariants every layout must satisfy. */
function assertGoodLayout(graph, layout) {
    const nodes = Object.values(layout.nodes);
    assert.strictEqual(nodes.length, graph.nodes.length, 'every node is placed');
    for (const n of nodes) {
        for (const v of [n.x, n.y, n.width, n.height]) assert.ok(Number.isFinite(v), `finite geometry for ${n.id}`);
    }
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            assert.ok(!overlap(nodes[i], nodes[j]), `${nodes[i].id} overlaps ${nodes[j].id}`);
        }
    }
    for (const e of layout.edges) {
        assert.ok(e.points.length >= 2, 'edge has a route');
        e.points.forEach((p) => assert.ok(p.every(Number.isFinite), 'finite route'));
        const a = layout.nodes[e.from];
        const b = layout.nodes[e.to];
        const near = (p, n) => p[0] >= n.x - 1 && p[0] <= n.x + n.width + 1 && p[1] >= n.y - 1 && p[1] <= n.y + n.height + 1;
        assert.ok(near(e.points[0], a), `edge ${e.from}->${e.to} starts on its source`);
        assert.ok(near(e.points[e.points.length - 1], b), `edge ${e.from}->${e.to} ends on its target`);
        if (!e.curve) {
            for (let i = 0; i + 1 < e.points.length; i++) {
                const [p, q] = [e.points[i], e.points[i + 1]];
                assert.ok(Math.abs(p[0] - q[0]) < 0.5 || Math.abs(p[1] - q[1]) < 0.5, 'traces are orthogonal');
            }
        }
    }
    for (const u of layout.units) {
        for (const n of nodes.filter((x) => x.unit === u.index)) {
            assert.ok(n.x >= u.x - 0.5 && n.y >= u.y - 0.5 && n.x + n.width <= u.x + u.width + 0.5 && n.y + n.height <= u.y + u.height + 0.5,
                `${n.id} is inside its flow frame`);
        }
    }
    for (let i = 0; i < layout.units.length; i++) {
        for (let j = i + 1; j < layout.units.length; j++) {
            assert.ok(!overlap(layout.units[i], layout.units[j]), 'flow frames do not overlap');
        }
    }
}

describe('layout engine', () => {
    it('removes overlaps optimally (isotonic regression)', () => {
        assert.deepStrictEqual(placeWithGaps([0, 0, 0], [10, 10], [1, 1, 1]), [-10, 0, 10]);
        assert.deepStrictEqual(placeWithGaps([0, 50], [10], [1, 1]), [0, 50]);
        assert.deepStrictEqual(placeWithGaps([5, 0], [10], [3, 1]), [1.25, 11.25]);
    });

    it('lays out a function top-down with the flow ordered by layer', () => {
        const { graph } = buildFlowchart('function f(x) { if (x) { a(); } else { b(); } return c(); }');
        const layout = layoutGraph(graph);
        assertGoodLayout(graph, layout);
        const start = layout.nodes[graph.units[0].startId];
        const end = layout.nodes[graph.units[0].endId];
        assert.ok(start.y < end.y, 'start above end');
        const yes = graph.edges.find((e) => e.label === 'yes').to;
        const no = graph.edges.find((e) => e.label === 'no').to;
        assert.ok(layout.nodes[yes].x < layout.nodes[no].x, '"yes" is drawn left of "no"');
    });

    it('routes loops in the right gutter and exceptions in the left gutter', () => {
        const { graph } = buildFlowchart('function f(a) { for (const x of a) { try { g(x); } catch (e) { h(e); } } }');
        const layout = layoutGraph(graph);
        assertGoodLayout(graph, layout);
        const back = layout.edges.find((e) => e.back);
        const header = layout.nodes[back.to];
        assert.ok(Math.max(...back.points.map((p) => p[0])) > header.x + header.width, 'loop edge runs right of the header');
        const exception = layout.edges.find((e) => e.kind === 'exception' && e.gutter);
        if (exception) {
            const target = layout.nodes[exception.to];
            assert.ok(Math.min(...exception.points.map((p) => p[0])) < target.x, 'exception edge runs left of its handler');
        }
    });

    it('stacks callback flows in a column right of their parent', () => {
        const { graph } = buildFlowchart('function f(a) { a.forEach((x) => { if (x) g(x); }); a.map((y) => { if (y) h(y); }); }');
        const layout = layoutGraph(graph);
        assertGoodLayout(graph, layout);
        const [main, first, second] = layout.units;
        assert.ok(first.x > main.x + main.width && second.x === first.x, 'callbacks in a column on the right');
        assert.ok(second.y > first.y, 'stacked vertically');
        assert.ok(layout.edges.filter((e) => e.kind === 'callback').every((e) => e.curve));
    });

    it('supports left-to-right layouts', () => {
        const { graph } = buildFlowchart('function f(x) { a(); b(); if (x) c(); }', { direction: 'LR' });
        const layout = layoutGraph(graph);
        assertGoodLayout(graph, layout);
        assert.ok(layout.nodes[graph.units[0].startId].x < layout.nodes[graph.units[0].endId].x);
    });

    it('is deterministic', () => {
        const { graph } = buildFlowchart('function f(a) { while (a) { if (a.x) break; a = a.next; } return a; }');
        assert.deepStrictEqual(layoutGraph(graph), layoutGraph(graph));
    });

    it('keeps its guarantees on real-world code and stays fast', function () {
        this.timeout(60000);
        const root = path.join(__dirname, '../../node_modules/webpack/lib');
        if (!fs.existsSync(root)) this.skip();
        const files = [];
        const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
            const p = path.join(dir, d.name);
            if (d.isDirectory()) walk(p);
            else if (d.name.endsWith('.js')) files.push(p);
        });
        walk(root);
        let count = 0;
        let slowest = 0;
        for (const file of files.slice(0, 60)) {
            const text = fs.readFileSync(file, 'utf8');
            for (const fn of locateFunctions(text, 'javascript').filter((f) => f.named && !f.trivial).slice(0, 12)) {
                const { graph } = buildFlowchart(text.slice(fn.start, fn.end), { preferClassMember: fn.preferClassMember, nameHint: fn.nameHint });
                const t = Date.now();
                const layout = layoutGraph(graph);
                slowest = Math.max(slowest, Date.now() - t);
                assertGoodLayout(graph, layout);
                count++;
            }
        }
        assert.ok(count > 150, `checked ${count} functions`);
        assert.ok(slowest < 1500, `slowest layout took ${slowest} ms`);
    });
});
