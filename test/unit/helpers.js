'use strict';

const assert = require('assert');

/** Parses the generated Mermaid text back into nodes and edges for assertions. */
function parseMermaid(mermaid) {
    const nodes = new Map();
    const edges = [];
    for (const raw of mermaid.split('\n')) {
        const line = raw.trim();
        const edge = /^(n\d+) (-->|-\.->)(?:\|"([^"]*)"\|)? (n\d+)$/.exec(line);
        if (edge) {
            edges.push({ from: edge[1], to: edge[4], label: edge[3] || '', dashed: edge[2] === '-.->' });
            continue;
        }
        const node = /^(n\d+)(\(\[|\[\[|\{\{|\(\(|\[|\{|\(|>)"(.*)"(\]\)|\]\]|\}\}|\)\)|\]|\}|\))$/.exec(line);
        if (node) nodes.set(node[1], { id: node[1], shape: node[2], label: node[3] });
    }
    return { nodes, edges };
}

/** Asserts that the graph is well formed: every edge references declared nodes. */
function assertWellFormed(mermaid) {
    const { nodes, edges } = parseMermaid(mermaid);
    assert.ok(nodes.size > 0, 'expected at least one node');
    for (const edge of edges) {
        assert.ok(nodes.has(edge.from), `edge source ${edge.from} is not declared`);
        assert.ok(nodes.has(edge.to), `edge target ${edge.to} is not declared`);
    }
    assert.ok(!/^\s*end\s*[[({>]/m.test(mermaid), 'a node must never be called "end" (reserved word in Mermaid)');
    return { nodes, edges };
}

function findNode(graph, predicate) {
    const node = [...graph.nodes.values()].find((n) => (typeof predicate === 'string' ? n.label === predicate : predicate(n)));
    assert.ok(node, `node not found: ${predicate}`);
    return node;
}

function edgesFrom(graph, id) {
    return graph.edges.filter((e) => e.from === id);
}

module.exports = { parseMermaid, assertWellFormed, findNode, edgesFrom };
