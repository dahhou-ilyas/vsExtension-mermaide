'use strict';

const assert = require('assert');
const vm = require('vm');
const { buildFlowchart } = require('../../src/core/flowchartBuilder');
const { generateCode } = require('../../src/core/codegen');
const { toMermaid, formatText, elide, labelOptions } = require('../../src/core/graph');
const { importMermaid } = require('../../src/core/mermaidImport');
const { updateNode, deleteNode, insertOnEdge, GraphEditError } = require('../../src/core/graphEdit');
const { assertWellFormed } = require('./helpers');

const byCode = (graph, text) => graph.nodes.find((n) => (n.code || []).some((c) => c.includes(text)));
const edgesBetween = (graph, a, b) => graph.edges.filter((e) => e.from === a.id && e.to === b.id);

function run(code, fn, args) {
    const logs = [];
    const sandbox = { args, out: undefined, console: { log: (...a) => logs.push(a.join(' ')) } };
    vm.createContext(sandbox);
    try {
        vm.runInContext(`${code}\nout = ${fn}(...args);`, sandbox, { timeout: 1000 });
        return { value: JSON.stringify(sandbox.out), logs };
    } catch (error) {
        return { error: String(error && error.message), logs };
    }
}

describe('exceptions (precise exceptional flow)', () => {
    const source = `function load(id) {
        let data = null;
        try {
            const raw = read(id);
            data = parse(raw);
            data.loaded = true;
        } catch (e) {
            report(e);
        }
        return data;
    }`;

    it('links every statement that may throw to the catch, and only those', () => {
        const { graph } = buildFlowchart(source, { mergeSequentialStatements: false });
        const catchNode = graph.nodes.find((n) => n.kind === 'catch');
        for (const text of ['read(id)', 'parse(raw)']) {
            const edges = edgesBetween(graph, byCode(graph, text), catchNode);
            assert.strictEqual(edges.length, 1, text);
            assert.strictEqual(edges[0].kind, 'exception');
        }
        assert.strictEqual(edgesBetween(graph, byCode(graph, 'data.loaded'), catchNode).length, 0, 'an assignment does not throw');
        assert.strictEqual(edgesBetween(graph, byCode(graph, 'let data'), catchNode).length, 0, 'code before try is not covered');
    });

    it('keeps a single summary edge in summary mode', () => {
        const { graph } = buildFlowchart(source, { exceptionEdges: 'summary' });
        const tryNode = graph.nodes.find((n) => n.kind === 'try');
        const catchNode = graph.nodes.find((n) => n.kind === 'catch');
        assert.strictEqual(graph.edges.filter((e) => e.to === catchNode.id && e.kind === 'exception').length, 1);
        assert.strictEqual(edgesBetween(graph, tryNode, catchNode).length, 1);
    });

    it('draws conditions and returns that may throw', () => {
        const { graph } = buildFlowchart('function f() { try { if (check()) { return compute(); } } catch (e) {} }');
        const catchNode = graph.nodes.find((n) => n.kind === 'catch');
        assert.strictEqual(edgesBetween(graph, graph.nodes.find((n) => n.kind === 'decision'), catchNode).length, 1);
        assert.strictEqual(edgesBetween(graph, graph.nodes.find((n) => n.kind === 'return'), catchNode).length, 1);
    });

    it('routes return through finally, then returns', () => {
        const { graph } = buildFlowchart('function f() { try { return work(); } finally { cleanup(); } }');
        const ret = graph.nodes.find((n) => n.kind === 'return');
        const fin = graph.nodes.find((n) => n.kind === 'finally');
        const end = graph.nodes.find((n) => n.kind === 'end');
        assert.ok(graph.edges.some((e) => e.from === ret.id && e.to === fin.id && e.label === 'return' && e.kind === 'abrupt'));
        assert.ok(!graph.edges.some((e) => e.from === ret.id && e.to === end.id), 'return does not skip the finally');
        const cleanup = byCode(graph, 'cleanup()');
        const finallyEnd = graph.nodes.find((n) => n.meta && n.meta.subtype === 'finallyEnd');
        assert.ok(graph.edges.some((e) => e.from === cleanup.id && e.to === finallyEnd.id), 'the finally block ends at an explicit node');
        assert.ok(graph.edges.some((e) => e.from === finallyEnd.id && e.to === end.id && e.label === 'then return' && e.kind === 'abrupt'));
        assert.ok(graph.edges.some((e) => e.from === byCode(graph, 'work()').id && e.to === fin.id && e.kind === 'exception'),
            'an exception in try without catch runs the finally');
        assert.ok(graph.edges.some((e) => e.from === finallyEnd.id && e.label === 'rethrow'));
    });

    it('sends exceptions of the catch block to the finally', () => {
        const { graph } = buildFlowchart('function f() { try { a(); } catch (e) { log(e); } finally { done(); } }');
        const fin = graph.nodes.find((n) => n.kind === 'finally');
        assert.strictEqual(edgesBetween(graph, byCode(graph, 'log(e)'), fin).filter((e) => e.kind === 'exception').length, 1);
    });

    it('propagates a rethrow to the enclosing catch', () => {
        const code = 'function f() { try { try { a(); } finally { b(); } } catch (outer) { c(); } }';
        const { graph } = buildFlowchart(code);
        const outer = graph.nodes.find((n) => n.kind === 'catch');
        const finallyEnd = graph.nodes.find((n) => n.meta && n.meta.subtype === 'finallyEnd');
        assert.ok(graph.edges.some((e) => e.from === finallyEnd.id && e.to === outer.id && e.label === 'rethrow'));
    });

    it('styles exceptional edges in the Mermaid output', () => {
        const { mermaid } = buildFlowchart(source);
        assertWellFormed(mermaid);
        assert.match(mermaid, /linkStyle [\d,]+ stroke:#e53935/);
    });

    it('still generates equivalent code', () => {
        const code = `function f(x) {
            const log = [];
            try {
                if (x < 0) return 'negative';
                if (x === 0) throw new Error('zero');
                log.push(JSON.parse('{"v":' + x + '}').v);
            } catch (e) {
                log.push(e.message);
            } finally {
                log.push('finally');
            }
            return log.join(',');
        }`;
        const generated = generateCode(buildFlowchart(code).graph, { verbatim: false });
        assert.strictEqual(generated.units[0].mode, 'structured', generated.code);
        for (const x of [-1, 0, 5]) assert.deepStrictEqual(run(generated.code, 'f', [x]), run(code, 'f', [x]));
    });
});

describe('inline callbacks', () => {
    const source = `function report(orders) {
        const totals = {};
        orders.forEach((order) => {
            if (order.cancelled) return;
            totals[order.user] = (totals[order.user] || 0) + order.amount;
        });
        const big = orders.filter((o) => o.amount > 100);
        return fetch('/api').then((res) => {
            if (!res.ok) throw new Error('failed');
            return res.json();
        }).catch((e) => console.log(e));
    }`;

    it('draws each non-trivial callback as its own flow', () => {
        const result = buildFlowchart(source);
        assertWellFormed(result.mermaid);
        const names = result.units.map((u) => u.name);
        assert.deepStrictEqual(names, ['report', 'report › orders.forEach', 'report › fetch(…).then']);
        assert.strictEqual(result.title, 'report');
    });

    it('links the statement to the callback start with a callback edge', () => {
        const { graph } = buildFlowchart(source);
        const callbackUnit = graph.units[1];
        const edge = graph.edges.find((e) => e.to === callbackUnit.startId);
        assert.ok(edge && edge.kind === 'callback' && edge.label === 'callback');
        assert.ok(byCode(graph, 'orders.forEach') && byCode(graph, 'orders.forEach').id === edge.from);
        const start = graph.nodes.find((n) => n.id === callbackUnit.startId);
        assert.strictEqual(start.meta.fnKind, 'callback');
        assert.match(toMermaid(graph), /↳ orders\.forEach\(\(order\) =#gt; …\)/);
    });

    it('gives a statement holding a callback its own node', () => {
        const { graph } = buildFlowchart('function f(a) { const x = 1; a.forEach((v) => { use(v); }); const y = 2; }');
        const holder = byCode(graph, 'a.forEach');
        assert.deepStrictEqual(holder.code.length, 1, 'not merged with its neighbours');
        assert.ok(graph.edges.some((e) => e.from === holder.id && e.kind === 'callback'));
    });

    it('models return inside a callback as the end of the callback', () => {
        const { graph } = buildFlowchart(source);
        const ret = graph.nodes.find((n) => n.kind === 'return' && n.unit === 1);
        const end = graph.nodes.find((n) => n.id === graph.units[1].endId);
        assert.ok(edgesBetween(graph, ret, end).length === 1);
    });

    it('ignores trivial callbacks and respects the depth limit', () => {
        const nested = 'function f(a) { a.forEach((x) => { x.forEach((y) => { y.forEach((z) => { use(z); }); }); }); }';
        assert.strictEqual(buildFlowchart(nested).units.length, 4);
        assert.strictEqual(buildFlowchart(nested, { maxCallbackDepth: 1 }).units.length, 2);
        assert.strictEqual(buildFlowchart(nested, { expandCallbacks: false }).units.length, 1);
        assert.strictEqual(buildFlowchart('function f(a) { return a.map((x) => x * 2); }').units.length, 1);
        assert.strictEqual(buildFlowchart('function f(a) { return a.map((x) => (x > 0 ? x : -x)); }').units.length, 2,
            'an expression callback with a condition is expanded');
    });

    it('supports JSX handlers, promises and IIFEs', () => {
        const jsx = 'function Button({ onSave }) { return <button onClick={(e) => { e.preventDefault(); onSave(); }}>Save</button>; }';
        const result = buildFlowchart(jsx, { language: 'javascriptreact' });
        assert.strictEqual(result.units[1].name, 'Button › onClick');
        assert.match(result.mermaid, /↳ onClick=\{\(e\) =#gt; …\}/);
        const iife = buildFlowchart('(() => { setup(); start(); })();');
        assert.ok(iife.units.some((u) => u.name.endsWith('IIFE')));
        const promise = buildFlowchart('function f() { return new Promise((resolve) => { setTimeout(resolve, 10); }); }');
        assert.strictEqual(promise.units[1].name, 'f › new Promise');
    });

    it('reports insights of a callback once', () => {
        const result = buildFlowchart('function f(l) { l.forEach((x) => { try { x(); } catch (e) {} }); }');
        assert.strictEqual(result.insights.filter((i) => i.code === 'empty-catch').length, 1);
        assert.strictEqual(result.insights[0].unit, 'f › l.forEach');
    });

    it('does not change the generated code', () => {
        const code = `function sum(list) {
            let total = 0;
            list.forEach((n) => {
                if (n < 0) return;
                total += n;
            });
            return total;
        }`;
        const graph = buildFlowchart(code).graph;
        const generated = generateCode(graph);
        assert.strictEqual(generated.units.length, 1, 'callback flows are not emitted separately');
        assert.deepStrictEqual(run(generated.code, 'sum', [[1, -2, 3]]), run(code, 'sum', [[1, -2, 3]]));
        assert.ok(generated.code.includes('list.forEach((n) => {'));
    });

    it('edits callback flows in place and drops them when their statement changes', () => {
        const { graph } = buildFlowchart(source);
        const inner = graph.nodes.find((n) => n.unit === 1 && n.kind === 'decision');
        // Editing the flow of a callback rewrites its body inside the statement that holds it.
        const edited1 = updateNode(graph, inner.id, { code: 'order.cancelled || order.amount < 0' });
        const code1 = generateCode(edited1).code;
        assert.match(code1, /orders\.forEach\(\(order\) => \{\n\s+if \(order\.cancelled \|\| order\.amount < 0\) \{/, code1);
        assert.ok(code1.includes('fetch(') && code1.includes('.then('), 'untouched callbacks are kept as written');
        assert.doesNotThrow(() => deleteNode(graph, inner.id));
        // The parameters of a callback belong to the parent statement.
        const callbackStart = graph.nodes.find((n) => n.unit === 1 && n.kind === 'start');
        assert.throws(() => updateNode(graph, callbackStart.id, { params: 'x' }), GraphEditError);
        const callbackEdge = graph.edges.findIndex((e) => e.kind === 'callback');
        assert.throws(() => insertOnEdge(graph, callbackEdge, 'process'), GraphEditError);

        const statement = byCode(graph, 'orders.forEach');
        const edited = updateNode(graph, statement.id, { code: 'orders.length = 0;' });
        assert.ok(!edited.units.some((u) => u.name === 'report › orders.forEach'), 'stale callback flow removed');
        assert.ok(edited.units.some((u) => u.name === 'report › fetch(…).then'), 'other callbacks kept');
        edited.nodes.forEach((n) => assert.ok(n.unit < edited.units.length));
        assertWellFormed(toMermaid(edited));
    });

    it('rebuilds folded callback and nested function bodies when importing Mermaid', () => {
        const code = `function totals(groups) {
            const out = [];
            groups.forEach((group) => {
                let sum = 0;
                group.items.forEach((item) => {
                    if (item.skip) return;
                    sum += scale(item.value);
                });
                out.push(sum);
            });
            return out.join(',');
            function scale(v) { return v * 10; }
        }`;
        const mermaid = toMermaid(buildFlowchart(code).graph);
        assert.ok(mermaid.includes('{…}'), 'bodies are folded in the diagram');
        const generated = generateCode(importMermaid(mermaid));
        const input = [[{ items: [{ value: 1 }, { value: 2, skip: true }] }, { items: [{ value: 3 }] }]];
        assert.deepStrictEqual(run(generated.code, 'totals', input), run(code, 'totals', input));
    });

    it('round-trips through Mermaid text (subgraphs, callback and exception edges)', () => {
        const code = `function check(items) {
            let errors = 0;
            items.forEach((item) => {
                try {
                    validate(item);
                } catch (e) {
                    errors++;
                }
            });
            return errors;
        }`;
        const mermaid = toMermaid(buildFlowchart(code).graph, { labelMode: 'truncate', maxLabelLength: 1000 });
        const imported = importMermaid(mermaid);
        assert.strictEqual(imported.units.length, 2);
        assert.strictEqual(imported.units[1].kind, 'callback');
        assert.ok(imported.edges.some((e) => e.kind === 'callback'));
        assert.ok(imported.edges.some((e) => e.kind === 'exception'));
        const generated = generateCode(imported);
        const validate = 'function validate(x) { if (!x) throw new Error("bad"); }\n';
        assert.deepStrictEqual(
            run(validate + generated.code, 'check', [[1, 0, 2, null]]),
            run(validate + code, 'check', [[1, 0, 2, null]])
        );
    });
});

describe('long labels', () => {
    const opts = labelOptions({});

    it('wraps long code on several lines instead of cutting it', () => {
        const lines = formatText('if (user.subscription.plan.features.includes(featureName) && !user.isSuspended)', opts);
        assert.ok(lines.length > 1);
        assert.ok(lines.every((l) => l.length <= opts.lineWidth));
        assert.strictEqual(lines.join(' ').replace(/ \./g, '.'), 'if (user.subscription.plan.features.includes(featureName) && !user.isSuspended)'.replace(/ \./g, '.'));
    });

    it('folds nested brackets, innermost first, when the code is very long', () => {
        const text = "fetchData(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, retries: 3 })";
        assert.strictEqual(elide(text, 60), 'fetchData(url, { headers: {…}, retries: 3 })');
    });

    it('ignores brackets inside strings', () => {
        assert.strictEqual(elide("log('(not a group)', { a: 1, b: 2, c: 3, d: 4 })", 30), "log('(not a group)', {…})");
    });

    it('limits the number of lines', () => {
        const lines = formatText(`call(${'argument, '.repeat(40)}last)`, labelOptions({ maxLines: 2 }));
        assert.ok(lines.length <= 2);
        assert.ok(lines.join(' ').includes('…'), 'shortened text is marked');
    });

    it('keeps the truncate mode available', () => {
        assert.deepStrictEqual(formatText('a'.repeat(100), labelOptions({ labelMode: 'truncate', maxLabelLength: 20 })), [`${'a'.repeat(19)}…`]);
    });

    it('wraps every kind of node', () => {
        const code = `function f() {
            for (const [key, value] of Object.entries(configuration.environment.variables.production)) { use(key, value); }
            if (someVeryLongConditionName && anotherVeryLongConditionName || yetAnotherVeryLongCondition) { go(); }
            return computeTheFinalResultFrom(firstArgument, secondArgument, thirdArgument);
        }`;
        const mermaid = buildFlowchart(code).mermaid;
        assertWellFormed(mermaid);
        assert.ok(!/…/.test(mermaid), 'nothing is cut');
        assert.ok((mermaid.match(/<br\/>/g) || []).length >= 3);
    });
});
