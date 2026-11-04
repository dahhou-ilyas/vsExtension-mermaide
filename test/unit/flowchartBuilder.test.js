'use strict';

const assert = require('assert');
const { buildFlowchart, FlowchartParseError } = require('../../src/core/flowchartBuilder');
const { escapeLabel } = require('../../src/core/graph');
const { assertWellFormed, findNode, edgesFrom } = require('./helpers');

describe('buildFlowchart', () => {
    describe('structure', () => {
        it('connects a simple function from start to end', () => {
            const result = buildFlowchart('function add(a, b) { const sum = a + b; return sum; }');
            const graph = assertWellFormed(result.mermaid);
            assert.strictEqual(result.title, 'add');
            const start = findNode(graph, 'add(a, b)');
            const end = findNode(graph, 'End');
            const ret = findNode(graph, 'return sum');
            assert.deepStrictEqual(edgesFrom(graph, ret.id).map((e) => e.to), [end.id]);
            assert.strictEqual(edgesFrom(graph, start.id).length, 1);
        });

        it('never emits a node with the reserved id "end"', () => {
            const result = buildFlowchart('function f() { return 1; }');
            assert.ok(!/\bend\[|\bend\(/.test(result.mermaid));
            assert.ok(result.mermaid.split('\n').every((line) => !/^\s*end\s*-->/.test(line)));
        });

        it('creates yes/no branches for if / else', () => {
            const result = buildFlowchart('function f(x) { if (x > 0) { a(); } else { b(); } c(); }', { mergeSequentialStatements: false });
            const graph = assertWellFormed(result.mermaid);
            const decision = findNode(graph, 'if (x #gt; 0)');
            assert.strictEqual(decision.shape, '{');
            const labels = edgesFrom(graph, decision.id).map((e) => e.label).sort();
            assert.deepStrictEqual(labels, ['no', 'yes']);
            const c = findNode(graph, 'c()');
            assert.strictEqual(graph.edges.filter((e) => e.to === c.id).length, 2, 'both branches merge into c()');
        });

        it('adds a "no" edge when there is no else branch', () => {
            const graph = assertWellFormed(buildFlowchart('function f(x) { if (x) a(); b(); }').mermaid);
            const decision = findNode(graph, 'if (x)');
            const b = findNode(graph, (n) => n.label.includes('b()'));
            assert.ok(graph.edges.some((e) => e.from === decision.id && e.to === b.id && e.label === 'no'));
        });

        it('models loops with a back edge and an exit edge', () => {
            const graph = assertWellFormed(buildFlowchart('function f(list) { for (const item of list) { use(item); } done(); }').mermaid);
            const loop = findNode(graph, 'for (const item of list)');
            assert.strictEqual(loop.shape, '{{');
            const body = findNode(graph, 'use(item)');
            assert.ok(graph.edges.some((e) => e.from === body.id && e.to === loop.id), 'back edge');
            assert.ok(edgesFrom(graph, loop.id).some((e) => e.label === 'done'), 'exit edge');
            assert.ok(edgesFrom(graph, loop.id).some((e) => e.label === 'next'), 'iteration edge');
        });

        it('treats while(true) as an infinite loop exited only by break', () => {
            const graph = assertWellFormed(buildFlowchart('function f() { while (true) { if (ok()) break; } after(); }').mermaid);
            const loop = findNode(graph, 'while (true)');
            assert.ok(!edgesFrom(graph, loop.id).some((e) => e.label === 'no'));
            const after = findNode(graph, 'after()');
            assert.ok(graph.edges.some((e) => e.to === after.id && e.label === 'yes'), 'break leaves the loop from the if');
        });

        it('routes continue back to the loop header', () => {
            const graph = assertWellFormed(buildFlowchart('function f(a) { for (let i = 0; i < a.length; i++) { if (!a[i]) continue; use(a[i]); } }').mermaid);
            const loop = findNode(graph, (n) => n.label.startsWith('for (let i = 0'));
            const decision = findNode(graph, 'if (!a[i])');
            assert.ok(graph.edges.some((e) => e.from === decision.id && e.to === loop.id && e.label === 'yes'));
        });

        it('supports do...while loops', () => {
            const graph = assertWellFormed(buildFlowchart('function f() { do { step(); } while (more()); }').mermaid);
            const entry = findNode(graph, 'do');
            const test = findNode(graph, 'while (more())');
            assert.ok(graph.edges.some((e) => e.from === test.id && e.to === entry.id && e.label === 'yes'));
        });

        it('supports labeled break out of nested loops', () => {
            const code = 'function f(m) { outer: for (const r of m) { for (const c of r) { if (c) break outer; } } done(); }';
            const graph = assertWellFormed(buildFlowchart(code).mermaid);
            const decision = findNode(graph, 'if (c)');
            const done = findNode(graph, 'done()');
            assert.ok(graph.edges.some((e) => e.from === decision.id && e.to === done.id));
        });

        it('handles switch with fall-through, break and default', () => {
            const code = `function f(x) {
                switch (x) {
                    case 1:
                    case 2: one(); break;
                    case 3: three();
                    default: other();
                }
                end();
            }`;
            const graph = assertWellFormed(buildFlowchart(code).mermaid);
            const sw = findNode(graph, 'switch (x)');
            const one = findNode(graph, 'one()');
            const three = findNode(graph, 'three()');
            const other = findNode(graph, 'other()');
            const labelsToOne = graph.edges.filter((e) => e.from === sw.id && e.to === one.id).map((e) => e.label).sort();
            assert.deepStrictEqual(labelsToOne, ['case 1', 'case 2']);
            assert.ok(graph.edges.some((e) => e.from === three.id && e.to === other.id), 'fall-through');
            assert.ok(!edgesFrom(graph, sw.id).some((e) => e.label === 'no match'), 'default exists');
        });

        it('handles try / catch / finally and throw', () => {
            const code = 'function f() { try { if (bad) throw new Error("x"); ok(); } catch (e) { log(e); } finally { close(); } }';
            const graph = assertWellFormed(buildFlowchart(code).mermaid);
            const tryNode = findNode(graph, 'try');
            const catchNode = findNode(graph, 'catch (e)');
            const throwNode = findNode(graph, (n) => n.label.startsWith('throw'));
            const fin = findNode(graph, 'finally');
            assert.ok(graph.edges.some((e) => e.from === tryNode.id && e.to === catchNode.id && e.label === 'error'));
            assert.ok(graph.edges.some((e) => e.from === throwNode.id && e.to === catchNode.id));
            assert.strictEqual(graph.edges.filter((e) => e.to === fin.id).length, 2);
        });

        it('sends uncaught throws to the end node', () => {
            const graph = assertWellFormed(buildFlowchart('function f() { throw new Error("boom"); }').mermaid);
            const end = findNode(graph, 'End');
            assert.ok(graph.edges.some((e) => e.to === end.id && e.label === 'throws'));
        });

        it('marks unreachable statements', () => {
            const result = buildFlowchart('function f() { return 1; dead(); }');
            assert.strictEqual(result.stats.unreachable, 1);
            assert.match(result.mermaid, /class n\d+ cfUnreachable/);
            assert.match(result.mermaid, /-\.->/);
        });

        it('merges sequential statements when enabled', () => {
            const code = 'function f() { a(); b(); c(); }';
            const merged = assertWellFormed(buildFlowchart(code).mermaid);
            assert.ok([...merged.nodes.values()].some((n) => n.label === 'a()<br/>b()<br/>c()'));
            const split = assertWellFormed(buildFlowchart(code, { mergeSequentialStatements: false }).mermaid);
            assert.ok(['a()', 'b()', 'c()'].every((label) => [...split.nodes.values()].some((n) => n.label === label)));
        });

        it('respects maxStatementsPerBlock', () => {
            const graph = assertWellFormed(buildFlowchart('function f() { a(); b(); c(); d(); }', { maxStatementsPerBlock: 2 }).mermaid);
            assert.ok([...graph.nodes.values()].some((n) => n.label === 'a()<br/>b()'));
            assert.ok([...graph.nodes.values()].some((n) => n.label === 'c()<br/>d()'));
        });

        it('uses the configured direction', () => {
            assert.match(buildFlowchart('f();', { direction: 'LR' }).mermaid, /^flowchart LR/);
            assert.match(buildFlowchart('f();').mermaid, /^flowchart TD/);
        });

        it('flags await statements', () => {
            const result = buildFlowchart('async function f() { const r = await load(); }');
            assert.match(result.mermaid, /class n\d+ cfAsync/);
        });
    });

    describe('input forms', () => {
        it('accepts loose statements', () => {
            const result = buildFlowchart('const x = 1;\nif (x) { console.log(x); }');
            assertWellFormed(result.mermaid);
            assert.strictEqual(result.title, 'Selection');
        });

        it('accepts a selected class method', () => {
            const result = buildFlowchart('async save(item) {\n  if (!item) return;\n  await this.db.put(item);\n}');
            assertWellFormed(result.mermaid);
            assert.strictEqual(result.title, 'save');
        });

        it('accepts an anonymous function expression', () => {
            const result = buildFlowchart('function () { return 42; }', { nameHint: 'handler' });
            assert.strictEqual(result.title, 'handler');
        });

        it('creates one subgraph per function', () => {
            const result = buildFlowchart('function a() { x(); }\nconst b = () => { y(); };\nclass C { m() { z(); } }');
            assertWellFormed(result.mermaid);
            assert.deepStrictEqual(result.units.map((u) => u.name), ['a', 'b', 'C.m']);
            assert.strictEqual((result.mermaid.match(/subgraph sg\d+/g) || []).length, 3);
            assert.strictEqual(result.title, 'a, b +1');
        });

        it('renders nested function declarations as separate flows', () => {
            const result = buildFlowchart('function outer() { inner(); function inner() { return 1; } }');
            assert.deepStrictEqual(result.units.map((u) => u.name), ['outer', 'outer › inner']);
        });

        it('supports expression-bodied arrow functions', () => {
            const graph = assertWellFormed(buildFlowchart('const double = (n) => n * 2;').mermaid);
            findNode(graph, 'return n * 2');
        });

        it('supports TypeScript', () => {
            const code = 'export async function get<T>(id: string): Promise<T | undefined> { const v = cache.get(id) as T; if (!v) { return undefined; } return v; }';
            const result = buildFlowchart(code, { language: 'typescript' });
            assertWellFormed(result.mermaid);
            assert.strictEqual(result.title, 'get');
        });

        it('supports JSX / TSX', () => {
            const code = 'const List = ({ items }: Props) => { if (!items.length) return <Empty />; return <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>; };';
            const result = buildFlowchart(code, { language: 'typescriptreact' });
            assertWellFormed(result.mermaid);
            assert.match(result.mermaid, /#lt;Empty \/#gt;/);
        });

        it('supports CommonJS exports', () => {
            const result = buildFlowchart('module.exports.run = function () { go(); };');
            assert.strictEqual(result.title, 'module.exports.run');
        });

        it('ignores type-only declarations', () => {
            assert.throws(() => buildFlowchart('interface A { x: number }\ntype B = string;', { language: 'typescript' }), FlowchartParseError);
        });

        it('reports syntax errors with a location', () => {
            assert.throws(() => buildFlowchart('function (') , (error) => {
                assert.ok(error instanceof FlowchartParseError);
                assert.ok(error.loc && error.loc.line === 1);
                return true;
            });
        });

        it('rejects empty input', () => {
            assert.throws(() => buildFlowchart('   '), FlowchartParseError);
        });
    });

    describe('labels', () => {
        it('escapes characters that would break Mermaid', () => {
            const graph = assertWellFormed(buildFlowchart('function f() { log("a <b> & c => d"); }').mermaid);
            findNode(graph, "log('a #lt;b#gt; #amp; c =#gt; d')");
        });

        it('guards labels starting with a backtick', () => {
            assert.ok(escapeLabel('`x`').startsWith('​'));
        });

        it('truncates long labels', () => {
            const result = buildFlowchart(`function f() { call(${'x, '.repeat(50)}y); }`, { maxLabelLength: 30 });
            assert.match(result.mermaid, /…/);
        });

        it('maps nodes back to source offsets', () => {
            const code = 'function f() {\n  if (ready) {\n    go();\n  }\n}';
            const result = buildFlowchart(code);
            const graph = assertWellFormed(result.mermaid);
            const decision = findNode(graph, 'if (ready)');
            const loc = result.nodes[decision.id];
            assert.strictEqual(code.slice(loc.start, loc.end), 'ready');
        });

        it('maps offsets correctly when the code had to be wrapped', () => {
            const code = 'run() {\n  step();\n}';
            const result = buildFlowchart(code);
            const graph = assertWellFormed(result.mermaid);
            const node = findNode(graph, 'step()');
            const loc = result.nodes[node.id];
            assert.strictEqual(code.slice(loc.start, loc.end), 'step();');
        });
    });

    describe('complexity', () => {
        it('computes cyclomatic complexity', () => {
            const result = buildFlowchart('function f(a, b) { if (a && b) {} for (;;) { break; } return a ? 1 : 2; }');
            // 1 + if + && + for + ?: = 5
            assert.strictEqual(result.complexity, 5);
        });

        it('excludes nested functions from the parent complexity', () => {
            const result = buildFlowchart('function f() { const g = () => { if (x) {} }; }');
            assert.strictEqual(result.units[0].complexity, 1);
        });
    });
});
