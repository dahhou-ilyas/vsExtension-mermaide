'use strict';

const assert = require('assert');
const vm = require('vm');
const { buildFlowchart } = require('../../src/core/flowchartBuilder');
const { generateCode } = require('../../src/core/codegen');
const { toMermaid } = require('../../src/core/graph');
const { updateNode, insertOnEdge, deleteNode, newGraph, GraphEditError } = require('../../src/core/graphEdit');
const { importMermaid } = require('../../src/core/mermaidImport');

function call(code, fn, args) {
    const sandbox = { args, out: undefined };
    vm.createContext(sandbox);
    vm.runInContext(`${code}\nout = ${fn}(...args);`, sandbox, { timeout: 1000 });
    return sandbox.out;
}

const edgeIndex = (graph, from, label = '') => graph.edges.findIndex((e) => e.from === from && e.label === label);
const nodeByCode = (graph, text) => graph.nodes.find((n) => (n.code || []).some((c) => c.includes(text)));

describe('graph editing', () => {
    it('builds a blank function and fills it', () => {
        let graph = newGraph({ name: 'clamp', params: 'x, max' });
        const step = nodeByCode(graph, 'your code');
        graph = updateNode(graph, step.id, { code: 'let y = x;' });
        let result = insertOnEdge(graph, edgeIndex(graph, step.id), 'decision');
        graph = updateNode(result.graph, result.nodeId, { code: 'y > max' });
        const decision = result.nodeId;
        result = insertOnEdge(graph, edgeIndex(graph, decision, 'yes'), 'process');
        graph = updateNode(result.graph, result.nodeId, { code: 'y = max;' });
        const merge = graph.edges.find((e) => e.from === result.nodeId).to;
        result = insertOnEdge(graph, graph.edges.findIndex((e) => e.from === result.nodeId && e.to === merge), 'return');
        graph = updateNode(result.graph, result.nodeId, { code: 'y' });

        const { code, units } = generateCode(graph);
        assert.strictEqual(units[0].mode, 'structured');
        assert.strictEqual(code, [
            'function clamp(x, max) {',
            '    let y = x;',
            '    if (y > max) {',
            '        y = max;',
            '        return y;',
            '    }',
            '}',
            ''
        ].join('\n'));
        assert.strictEqual(call(code, 'clamp', [12, 10]), 10);
        assert.strictEqual(call(code, 'clamp', [3, 10]), undefined);
    });

    it('inserts a loop with a body', () => {
        let graph = newGraph({ name: 'count', params: 'n' });
        const step = nodeByCode(graph, 'your code');
        graph = updateNode(graph, step.id, { code: 'let i = 0;\nconst seen = [];' });
        let result = insertOnEdge(graph, edgeIndex(graph, step.id), 'loop');
        graph = updateNode(result.graph, result.nodeId, { code: 'i < n' });
        const body = graph.edges.find((e) => e.from === result.nodeId && e.label === 'yes').to;
        graph = updateNode(graph, body, { code: 'seen.push(i);\ni++;' });
        const exit = graph.edges.findIndex((e) => e.from === result.nodeId && e.label === 'no');
        result = insertOnEdge(graph, exit, 'return');
        graph = updateNode(result.graph, result.nodeId, { code: 'return seen' });
        const { code } = generateCode(graph);
        assert.strictEqual(JSON.stringify(call(code, 'count', [3])), '[0,1,2]');
        assert.match(code, /while \(i < n\) \{\n {8}seen\.push\(i\);\n {8}i\+\+;\n {4}\}/);
    });

    it('deletes statements, conditions and loops', () => {
        const source = 'function f(a) { pre(); if (a) { yes(); } else { no(); } while (a) { a--; } return a; }';
        let graph = buildFlowchart(source, { mergeSequentialStatements: false }).graph;
        graph = deleteNode(graph, nodeByCode(graph, 'pre()').id);
        assert.ok(!nodeByCode(graph, 'pre()'));
        graph = deleteNode(graph, graph.nodes.find((n) => n.kind === 'decision').id);
        assert.ok(nodeByCode(graph, 'yes()'));
        assert.ok(!nodeByCode(graph, 'no()'), 'the "no" branch is removed');
        graph = deleteNode(graph, graph.nodes.find((n) => n.kind === 'loop').id);
        assert.ok(!nodeByCode(graph, 'a--'));
        const { code } = generateCode(graph);
        assert.strictEqual(code, 'function f(a) {\n    yes();\n    return a;\n}\n');
    });

    it('refuses invalid edits', () => {
        const graph = buildFlowchart('function f() { try { a(); } catch (e) {} }').graph;
        assert.throws(() => deleteNode(graph, graph.units[0].startId), GraphEditError);
        assert.throws(() => deleteNode(graph, graph.nodes.find((n) => n.kind === 'try').id), GraphEditError);
        const ret = buildFlowchart('function f() { return 1; }').graph;
        const retNode = ret.nodes.find((n) => n.kind === 'return');
        assert.throws(() => insertOnEdge(ret, ret.edges.findIndex((e) => e.from === retNode.id), 'process'), GraphEditError);
    });

    it('renames a function and edits its parameters', () => {
        let graph = newGraph();
        graph = updateNode(graph, graph.units[0].startId, { name: 'sum', params: 'a, b' });
        assert.match(generateCode(graph).code, /^function sum\(a, b\) \{/);
        assert.throws(() => updateNode(graph, graph.units[0].startId, { name: 'not valid' }), GraphEditError);
    });

    it('never mutates the original graph', () => {
        const graph = newGraph();
        const snapshot = JSON.stringify(graph);
        updateNode(graph, 'n2', { code: 'x();' });
        insertOnEdge(graph, 0, 'loop');
        assert.strictEqual(JSON.stringify(graph), snapshot);
    });
});

describe('importMermaid', () => {
    it('imports a hand-written flowchart and generates code', () => {
        const graph = importMermaid(`
            flowchart TD
                A([abs(x)]) --> B{x < 0?}
                B -- Yes --> C[x = -x]
                B -- No --> D(return x)
                C --> D
        `);
        const { code, units } = generateCode(graph);
        assert.strictEqual(units[0].mode, 'structured');
        assert.strictEqual(call(code, 'abs', [-4]), 4);
        assert.strictEqual(call(code, 'abs', [3]), 3);
    });

    it('detects loops in hand-written diagrams', () => {
        const graph = importMermaid(`graph LR
            S([sum(n)]) --> I[let total = 0<br>let i = 1]
            I --> C{i <= n}
            C -->|oui| B[total += i<br/>i++]
            B --> C
            C -->|non| R(return total)`);
        assert.strictEqual(graph.direction, 'LR');
        assert.ok(graph.nodes.some((n) => n.kind === 'loop'));
        const { code } = generateCode(graph);
        assert.strictEqual(call(code, 'sum', [4]), 10);
        assert.match(code, /while \(i <= n\)/);
    });

    it('falls back to a state machine for unstructured diagrams', () => {
        // Jumps into the middle of a loop: no structured equivalent.
        const graph = importMermaid(`flowchart TD
            S([f(n)]) --> A{n > 5}
            A -->|yes| B[n = n + 2]
            A -->|no| C[n = n + 1]
            B --> C
            C --> D{n < 10}
            D -->|yes| B
            D -->|no| E(return n)`);
        const { code, units, warnings } = generateCode(graph);
        assert.strictEqual(units[0].mode, 'state-machine');
        assert.ok(warnings.length > 0);
        const reference = (n) => {
            let state = n > 5 ? 'B' : 'C';
            for (;;) {
                if (state === 'B') { n += 2; state = 'C'; }
                if (state === 'C') { n += 1; if (n < 10) { state = 'B'; continue; } return n; }
            }
        };
        for (const n of [0, 3, 7, 12]) assert.strictEqual(call(code, 'f', [n]), reference(n));
    });

    it('round-trips code → Mermaid text → code', () => {
        const source = `function score(list) {
            let total = 0;
            for (const x of list) {
                if (x < 0) {
                    continue;
                }
                total += x;
            }
            switch (total) {
                case 0:
                    return 'none';
                default:
                    return 'total ' + total;
            }
        }`;
        const { graph } = buildFlowchart(source);
        const mermaid = toMermaid(graph, { maxLabelLength: 500 });
        const imported = importMermaid(mermaid);
        const { code } = generateCode(imported);
        for (const input of [[[1, -2, 3]], [[]], [[-1]]]) {
            assert.strictEqual(call(code, 'score', input), call(source, 'score', input));
        }
    });

    it('extracts the diagram from a Markdown code block', () => {
        const graph = importMermaid('# Doc\n\n```mermaid\nflowchart TD\n  A[go()] --> B[stop()]\n```\n');
        assert.strictEqual(generateCode(graph).code, 'go();\nstop();\n');
    });

    it('rejects text without a flowchart', () => {
        assert.throws(() => importMermaid('sequenceDiagram\n A->>B: hi'), /No "flowchart"/);
    });
});
