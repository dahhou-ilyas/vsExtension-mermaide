'use strict';

const assert = require('assert');
const { buildFlowchart } = require('../../src/core/flowchartBuilder');
const { generateCode } = require('../../src/core/codegen');
const { updateNode, editableText } = require('../../src/core/graphEdit');
const { indentCode, templateLines } = require('../../src/core/text');
const { patternNames, parseForHeader, parseDeclaration } = require('../../src/core/lowering');

const SOURCE = `function report(orders, log) {
\t// Totals by user
\tconst totals = {};

\tfor (const order of orders) {
\t\tif (
\t\t\torder.cancelled ||
\t\t\torder.amount <= 0
\t\t) continue; // ignored
\t\ttotals[order.user] = (totals[order.user] || 0) + order.amount;
\t}

\t/* Summary */
\tlog(\`done:
  \${Object.keys(totals).length} users\`);
\treturn totals;
}`;

const byCode = (graph, text) => graph.nodes.find((n) => (n.code || []).some((c) => c.includes(text)));

describe('graph → code fidelity', () => {
    it('gives back the original code, byte for byte, when nothing changed', () => {
        const { graph } = buildFlowchart(SOURCE);
        const result = generateCode(graph);
        assert.strictEqual(result.code, `${SOURCE}\n`);
        assert.strictEqual(result.units[0].mode, 'original');
    });

    it('changes only the edited statement, keeping comments, blank lines and formatting', () => {
        const { graph } = buildFlowchart(SOURCE);
        const edited = updateNode(graph, byCode(graph, 'totals[order.user]').id, { code: 'totals[order.user] = order.amount;' });
        const code = generateCode(edited).code;
        const before = SOURCE.split('\n');
        const after = code.trimEnd().split('\n');
        assert.strictEqual(after.length, before.length, code);
        const changed = before.filter((line, i) => line !== after[i]);
        assert.deepStrictEqual(changed, ['\t\ttotals[order.user] = (totals[order.user] || 0) + order.amount;'], code);
    });

    it('keeps comments when everything is regenerated', () => {
        const { graph } = buildFlowchart(SOURCE);
        const code = generateCode(graph, { verbatim: false }).code;
        for (const comment of ['// Totals by user', '// ignored', '/* Summary */']) assert.ok(code.includes(comment), comment);
        assert.ok(code.includes('\t\t\torder.cancelled ||'), 'multi-line condition kept as written');
        assert.ok(code.includes('done:\n  ${Object'), 'template literal untouched');
    });

    it('shows inner comments in the node editor', () => {
        const { graph } = buildFlowchart('function f() {\n  a();\n  // then b\n  b(); // why\n}');
        const node = byCode(graph, 'a();');
        assert.strictEqual(editableText(node), 'a();\n// then b\nb(); // why');
    });

    it('never re-indents the inside of template literals', () => {
        const code = 'const a = `x\n  y ${`z\nw`}`;\nf(/`/);\nconst b = 1;';
        assert.deepStrictEqual([...templateLines(code)], [1, 2]);
        assert.strictEqual(indentCode(code, '\t'), 'const a = `x\n  y ${`z\nw`}`;\n\tf(/`/);\n\tconst b = 1;');
    });
});

describe('lowering helpers', () => {
    it('reads binding patterns, declarations and loop headers', () => {
        assert.deepStrictEqual(patternNames('{ a, b: [c, , ...d], e = f(1, 2), [k]: { g }, ...rest }'), ['a', 'c', 'd', 'e', 'g', 'rest']);
        assert.deepStrictEqual(parseDeclaration('let n: number = 0, { x } = p, y;').declarators.map((d) => [d.target, d.init]), [['n', '0'], ['{ x }', 'p'], ['y', null]]);
        assert.deepStrictEqual(parseForHeader('for (;;)'), { kind: 'for', init: '', test: '', update: '' });
        const of = parseForHeader('for await (const [k, v] of map.entries())');
        assert.deepStrictEqual([of.kind, of.await, of.names, of.right], ['of', true, ['k', 'v'], 'map.entries()']);
        assert.strictEqual(parseForHeader('for (key in obj)').kind, 'in');
    });
});
