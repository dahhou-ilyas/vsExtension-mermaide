'use strict';

const assert = require('assert');
const { buildFlowchart } = require('../../src/core/flowchartBuilder');

const metricsOf = (code, options) => buildFlowchart(code, options).units[0].metrics;
const codes = (code) => buildFlowchart(code).insights.map((i) => i.code);

describe('metrics', () => {
    it('computes cognitive complexity with nesting increments (SonarSource)', () => {
        // for +1, if +2 (nesting 1), if +3 (nesting 2), && then || +2, else +1, catch +4 (nesting 3), recursion +1
        const code = `function sync(items) {
            for (const i of items) {
                if (i.ok) {
                    if (i.x && i.y || i.z) { save(i); } else { try { x(); } catch (e) { log(e); } }
                }
            }
            return sync(items.slice(1));
        }`;
        assert.strictEqual(metricsOf(code).cognitive, 14);
    });

    it('counts else if without a nesting penalty', () => {
        const code = 'function f(a) { if (a === 1) { x(); } else if (a === 2) { y(); } else { z(); } }';
        // if +1, else if +1, else +1
        assert.strictEqual(metricsOf(code).cognitive, 3);
    });

    it('measures lines, parameters, nesting and statement counts', () => {
        const code = `async function f(a, b, c) {
            while (a) {
                if (b) { await c(); }
            }
            throw new Error('x');
        }`;
        const m = metricsOf(code);
        assert.strictEqual(m.params, 3);
        assert.strictEqual(m.loc, 6);
        assert.strictEqual(m.maxNesting, 2);
        assert.strictEqual(m.loops, 1);
        assert.strictEqual(m.branches, 1);
        assert.strictEqual(m.throws, 1);
        assert.strictEqual(m.awaits, 1);
    });

    describe('insights', () => {
        it('reports empty catch blocks', () => {
            assert.ok(codes('function f() { try { a(); } catch (e) {} }').includes('empty-catch'));
        });

        it('reports await inside loops but not for await', () => {
            assert.ok(codes('async function f(l) { for (const x of l) { await x(); } }').includes('await-in-loop'));
            assert.ok(!codes('async function f(l) { for await (const x of l) { await x(); } }').includes('await-in-loop'));
        });

        it('reports unreachable code with its location', () => {
            const code = 'function f() { return 1; dead(); }';
            const insight = buildFlowchart(code).insights.find((i) => i.code === 'unreachable');
            assert.ok(insight);
            assert.strictEqual(code.slice(insight.start, insight.end), 'dead();');
        });

        it('reports deep nesting, many parameters and debugger statements', () => {
            const code = 'function f(a, b, c, d, e) { debugger; if (a) { if (b) { if (c) { if (d) { e(); } } } } }';
            const found = codes(code);
            for (const expected of ['deep-nesting', 'many-params', 'debugger']) {
                assert.ok(found.includes(expected), `missing ${expected}`);
            }
        });

        it('reports switch without default and recursion', () => {
            const found = codes('function fact(n) { switch (n) { case 0: return 1; } return n * fact(n - 1); }');
            assert.ok(found.includes('switch-no-default'));
            assert.ok(found.includes('recursion'));
        });

        it('lists warnings before infos', () => {
            const insights = buildFlowchart('async function f(a, b, c, d, e) { for (const x of a) { await x; } try {} catch {} }').insights;
            const firstInfo = insights.findIndex((i) => i.severity === 'info');
            assert.ok(insights.slice(firstInfo).every((i) => i.severity === 'info'));
        });

        it('reports nothing for clean code', () => {
            assert.deepStrictEqual(codes('function add(a, b) { return a + b; }'), []);
        });
    });
});
