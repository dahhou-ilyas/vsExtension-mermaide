import React, { useEffect, useMemo, useState } from 'react';
import { generateCode } from '../src/core/codegen';
import { updateNode, insertOnEdge, deleteNode, outgoingEdges, INSERTABLE } from '../src/core/graphEdit';
import { edgeLabel, displayLines } from '../src/core/graph';

const KIND_NAMES = {
    start: 'Function',
    end: 'End',
    process: 'Statements',
    decision: 'Condition',
    loop: 'Loop',
    return: 'Return',
    throw: 'Throw',
    try: 'try',
    catch: 'catch',
    finally: 'finally',
    junction: 'do … while'
};

/** Undo / redo history of immutable graphs. */
export function useGraphHistory(initial) {
    const [history, setHistory] = useState({ stack: [initial], index: 0 });
    const graph = history.stack[history.index];
    const push = (next) => setHistory((h) => ({ stack: [...h.stack.slice(0, h.index + 1), next].slice(-100), index: Math.min(h.index + 1, 99) }));
    const undo = () => setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) }));
    const redo = () => setHistory((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }));
    const reset = (g) => setHistory({ stack: [g], index: 0 });
    return {
        graph,
        push,
        undo,
        redo,
        reset,
        canUndo: history.index > 0,
        canRedo: history.index < history.stack.length - 1,
        dirty: history.index > 0
    };
}

function describeNode(node) {
    if (!node) return '';
    const subtype = node.meta && node.meta.subtype;
    if (node.kind === 'decision') return subtype === 'switch' ? 'Condition (switch)' : 'Condition (if)';
    if (node.kind === 'loop') {
        return {
            for: 'Loop (for)', forof: 'Loop (for…of)', forin: 'Loop (for…in)', dowhile: 'Loop (do…while)'
        }[subtype] || 'Loop (while)';
    }
    return KIND_NAMES[node.kind] || node.kind;
}

function initialFields(node) {
    if (!node) return {};
    const meta = node.meta || {};
    switch (node.kind) {
        case 'start':
            return { name: meta.name || '', params: meta.params || '' };
        case 'loop':
            return meta.subtype === 'for' || meta.subtype === 'forof' || meta.subtype === 'forin'
                ? { header: meta.header || '' }
                : { code: (node.code && node.code[0]) || '' };
        case 'process':
            return { code: (node.code || []).join('\n') };
        default:
            return { code: (node.code && node.code[0]) || '' };
    }
}

const EDITABLE = new Set(['start', 'process', 'decision', 'loop', 'return', 'throw', 'catch']);

/** Side panel to edit the selected node and insert new steps after it. */
export function Inspector({ graph, selectedId, onChange, onSelect }) {
    const node = graph.nodes.find((n) => n.id === selectedId);
    const [fields, setFields] = useState(() => initialFields(node));
    const [error, setError] = useState(null);

    useEffect(() => {
        setFields(initialFields(node));
        setError(null);
        // Reset the form only when another node is selected.
    }, [selectedId]);

    if (!node) {
        return (
            <div className="fc-inspector fc-inspector-empty">
                <p><strong>Click a node</strong> to edit it, insert steps after it, or delete it.</p>
                <p className="fc-muted">The code on the right is regenerated live from the chart.</p>
            </div>
        );
    }

    const run = (operation) => {
        try {
            const result = operation();
            setError(null);
            return result;
        } catch (err) {
            setError(err && err.message ? err.message : String(err));
            return undefined;
        }
    };

    const apply = () => run(() => onChange(updateNode(graph, node.id, fields)));
    const insert = (edgeIndex, kind) => run(() => {
        const result = insertOnEdge(graph, edgeIndex, kind);
        onChange(result.graph);
        onSelect(result.nodeId);
    });
    const remove = () => run(() => {
        onChange(deleteNode(graph, node.id));
        onSelect(undefined);
    });

    const onKeyDown = (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            apply();
        }
    };

    const field = (key, label, multiline, placeholder) => (
        <label className="fc-field">
            <span>{label}</span>
            {multiline ? (
                <textarea
                    value={fields[key] || ''}
                    rows={Math.min(12, Math.max(3, String(fields[key] || '').split('\n').length + 1))}
                    spellCheck={false}
                    placeholder={placeholder}
                    onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
                    onKeyDown={onKeyDown}
                />
            ) : (
                <input
                    type="text"
                    value={fields[key] || ''}
                    spellCheck={false}
                    placeholder={placeholder}
                    onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
                />
            )}
        </label>
    );

    const edges = outgoingEdges(graph, node.id).filter(({ edge }) => {
        const target = graph.nodes.find((n) => n.id === edge.to);
        return !['return', 'throw', 'end'].includes(node.kind) && !(node.kind === 'try' && edge.label === 'error') && target;
    });
    const deletable = !['start', 'end', 'try', 'catch', 'finally'].includes(node.kind);

    return (
        <div className="fc-inspector">
            <div className="fc-inspector-title">
                <span className={`fc-kind fc-kind-${node.kind}`}>{describeNode(node)}</span>
                <code>{node.id}</code>
            </div>

            {EDITABLE.has(node.kind) && !(node.kind === 'start' && (node.meta.isMain || node.meta.blockName)) ? (
                <div className="fc-form">
                    {node.kind === 'start' ? (
                        <>
                            {field('name', 'Function name', false, 'myFunction')}
                            {field('params', 'Parameters', false, 'a, b = 1')}
                        </>
                    ) : null}
                    {node.kind === 'process' ? field('code', 'Code (one or more statements)', true, 'doSomething();') : null}
                    {node.kind === 'decision' ? field('code', node.meta.subtype === 'switch' ? 'Value tested by switch' : 'Condition', false, 'x > 0') : null}
                    {node.kind === 'loop' && fields.header !== undefined ? field('header', 'Loop header', false, 'for (const item of items)') : null}
                    {node.kind === 'loop' && fields.header === undefined ? field('code', 'Repeat while', false, 'i < n') : null}
                    {node.kind === 'return' ? field('code', 'Return statement', false, 'return value;') : null}
                    {node.kind === 'throw' ? field('code', 'Throw statement', false, "throw new Error('…');") : null}
                    {node.kind === 'catch' ? field('code', 'Error variable', false, 'error') : null}
                    <div className="fc-form-actions">
                        <button type="button" className="fc-button" onClick={apply} title="Apply (Ctrl+Enter)">Apply</button>
                        {deletable ? <button type="button" className="fc-button fc-secondary fc-danger-text" onClick={remove}>Delete node</button> : null}
                    </div>
                </div>
            ) : (
                <div className="fc-form-actions">
                    {deletable ? <button type="button" className="fc-button fc-secondary fc-danger-text" onClick={remove}>Delete node</button> : null}
                </div>
            )}

            {error ? <p className="fc-form-error" role="alert">{error}</p> : null}

            {edges.length ? (
                <div className="fc-insert">
                    <h4>Insert after</h4>
                    {edges.map(({ edge, index }) => {
                        const target = graph.nodes.find((n) => n.id === edge.to);
                        const label = edgeLabel(edge);
                        return (
                            <div key={index} className="fc-insert-row">
                                <div className="fc-insert-where">
                                    {label ? <span className="fc-branch">{label}</span> : null}
                                    <span className="fc-muted">→ {displayLines(target, 28)[0]}</span>
                                </div>
                                <div className="fc-insert-buttons">
                                    {Object.entries(INSERTABLE).map(([kind, def]) => (
                                        <button key={kind} type="button" className={`fc-chip fc-chip-${kind}`} onClick={() => insert(index, kind)}>
                                            + {def.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
}

/** Live preview of the code generated from the graph. */
export function CodePreview({ graph }) {
    const result = useMemo(() => {
        try {
            return { ...generateCode(graph), error: null };
        } catch (error) {
            return { code: '', units: [], warnings: [], error: error && error.message ? error.message : String(error) };
        }
    }, [graph]);
    const stateMachine = result.units.some((u) => u.mode === 'state-machine');

    return (
        <div className="fc-code-preview">
            <div className="fc-code-header">
                <span>Generated code</span>
                {result.error ? null : (
                    <span className={`fc-badge ${stateMachine ? 'fc-warning-strong' : 'fc-complexity-low'}`}
                        title={stateMachine
                            ? 'The chart has jumps that do not map to if / loops; the code uses an equivalent state machine.'
                            : 'The chart maps to structured code (if / else, loops, switch, try).'}>
                        {stateMachine ? 'state machine' : 'structured'}
                    </span>
                )}
            </div>
            {result.error ? <p className="fc-form-error">{result.error}</p> : <pre><code>{result.code}</code></pre>}
            {result.warnings.map((w, i) => <p key={i} className="fc-muted fc-small">⚠ {w}</p>)}
        </div>
    );
}
