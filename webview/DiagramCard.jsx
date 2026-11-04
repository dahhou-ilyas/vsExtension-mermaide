import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toMermaid, fullText } from '../src/core/graph';
import { Inspector, CodePreview, useGraphHistory } from './FlowEditor';
import MermaidDiagram, { clampZoom } from './MermaidDiagram';
import { MetricStrip, Insights, UnitTable } from './DiagramDetails';
import { post } from './vscodeApi';
import { toSvgMarkup, toPngDataUrl, editorBackground } from './exporter';
import {
    ZoomInIcon, ZoomOutIcon, FitIcon, CopyIcon, MarkdownIcon, DownloadIcon, TrashIcon, RefreshIcon, CodeIcon, InfoIcon,
    EditIcon, UndoIcon, RedoIcon, ExpandIcon
} from './icons';

function complexityLevel(value) {
    if (value <= 5) return { level: 'low', text: 'Low' };
    if (value <= 10) return { level: 'moderate', text: 'Moderate' };
    if (value <= 20) return { level: 'high', text: 'High' };
    return { level: 'very-high', text: 'Very high' };
}

function timeAgo(timestamp) {
    const seconds = Math.round((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return new Date(timestamp).toLocaleDateString();
}

function cognitiveLevel(value) {
    if (value <= 7) return 'low';
    if (value <= 15) return 'moderate';
    if (value <= 25) return 'high';
    return 'very-high';
}

const ToolButton = ({ label, onClick, children, danger, active }) => (
    <button type="button" className={`fc-icon-button${danger ? ' fc-danger' : ''}${active ? ' fc-active-button' : ''}`}
        title={label} aria-label={label} aria-pressed={active === undefined ? undefined : active} onClick={onClick}>
        {children}
    </button>
);

/** Toolbar and two-pane layout shown while a flowchart is being edited. */
function EditorBar({ diagram, history, onClose }) {
    const attached = !!diagram.uri;
    const save = () => post('saveGraph', { id: diagram.id, graph: history.graph });
    return (
        <div className="fc-editbar" role="toolbar" aria-label="Flowchart editor">
            <span className="fc-editbar-title">Editing{history.dirty ? ' •' : ''}</span>
            <ToolButton label="Undo (Ctrl+Z)" onClick={history.undo}><UndoIcon /></ToolButton>
            <ToolButton label="Redo (Ctrl+Y)" onClick={history.redo}><RedoIcon /></ToolButton>
            <span className="fc-separator" />
            <button type="button" className="fc-button fc-secondary" onClick={save} disabled={!history.dirty}
                title="Save the chart in the flowchart history">Save chart</button>
            {attached ? (
                <button type="button" className="fc-button" onClick={() => post('applyCode', { id: diagram.id, graph: history.graph })}
                    title="Show a diff, then replace the original code with the code generated from this chart">Apply to source…</button>
            ) : (
                <button type="button" className="fc-button" onClick={() => post('insertCode', { id: diagram.id, graph: history.graph })}
                    title="Insert the generated code at the cursor of the last active editor">Insert at cursor</button>
            )}
            <button type="button" className="fc-button fc-secondary" onClick={() => post('openCode', { id: diagram.id, graph: history.graph })}>Open as new file</button>
            <span className="fc-spacer" />
            <button type="button" className="fc-button fc-secondary" onClick={onClose}>{history.dirty ? 'Discard & close' : 'Close editor'}</button>
        </div>
    );
}

export default function DiagramCard({
    diagram, theme, focused, focusTick, zoom, onZoomChange, highlightNodeId, detailsOpen, onToggleDetails, startEditing, labels
}) {
    const svgRef = useRef(null);
    const cardRef = useRef(null);
    const [exportOpen, setExportOpen] = useState(false);
    const [editing, setEditing] = useState(!!startEditing && !!diagram.graph);
    const [selectedId, setSelectedId] = useState(undefined);
    const [fullLabels, setFullLabels] = useState(false);
    const history = useGraphHistory(diagram.graph);
    const complexity = complexityLevel(diagram.complexity);
    const attached = !!diagram.uri;
    const warnings = (diagram.insights || []).filter((i) => i.severity === 'warning').length;
    const nodeLines = {};
    for (const [nodeId, span] of Object.entries(diagram.nodes || {})) nodeLines[nodeId] = span.start.line + 1;

    useEffect(() => {
        if (startEditing && diagram.graph) setEditing(true);
    }, [startEditing, focusTick]);

    // Restart from the stored graph whenever it changes outside the editor (save, regenerate).
    useEffect(() => {
        if (diagram.graph) history.reset(diagram.graph);
        setSelectedId(undefined);
    }, [diagram.graph]);

    useEffect(() => {
        if (!editing) return undefined;
        const onKey = (event) => {
            if (!(event.ctrlKey || event.metaKey) || /^(INPUT|TEXTAREA)$/.test(event.target.tagName)) return;
            if (event.key === 'z' && !event.shiftKey) { event.preventDefault(); history.undo(); }
            if (event.key === 'y' || (event.key === 'z' && event.shiftKey)) { event.preventDefault(); history.redo(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const labelOptions = useMemo(
        () => ({ ...(labels || {}), ...(fullLabels ? { labelMode: 'wrap', maxLines: 60 } : {}) }),
        [labels, fullLabels]
    );
    const editMermaid = useMemo(
        () => (editing && history.graph ? toMermaid(history.graph, { ...labelOptions, selectedId }) : null),
        [editing, history.graph, selectedId, labelOptions]
    );
    // Rendered from the graph so label settings apply immediately; older records only have Mermaid text.
    const viewMermaid = useMemo(
        () => (diagram.graph ? toMermaid(diagram.graph, labelOptions) : diagram.mermaid),
        [diagram.graph, diagram.mermaid, labelOptions]
    );
    const shownGraph = editing ? history.graph : diagram.graph;
    const nodeTexts = useMemo(() => {
        const texts = {};
        for (const node of (shownGraph && shownGraph.nodes) || []) {
            const text = fullText(node);
            if (text && node.kind !== 'end') texts[node.id] = text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
        }
        return texts;
    }, [shownGraph]);

    const closeEditor = () => {
        history.reset(diagram.graph);
        setSelectedId(undefined);
        setEditing(false);
    };

    useEffect(() => {
        if (focused && cardRef.current) {
            cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, [focused, focusTick]);

    const currentZoom = typeof zoom === 'number' ? zoom : 1;
    const setZoom = (value) => onZoomChange(diagram.id, value);

    const exportAs = async (format) => {
        setExportOpen(false);
        const svg = svgRef.current;
        if (!svg) return;
        try {
            const markup = toSvgMarkup(svg, editorBackground());
            if (format === 'svg') {
                post('export', { id: diagram.id, format, data: markup });
                return;
            }
            const box = svg.viewBox.baseVal;
            const data = await toPngDataUrl(markup, box.width, box.height, 2);
            post('export', { id: diagram.id, format, data });
        } catch (error) {
            post('error', { message: `Export failed: ${error && error.message ? error.message : error}` });
        }
    };

    const line = diagram.range.start.line + 1;
    const unitSummary = diagram.units.length > 1
        ? `${diagram.units.length} flows · max complexity ${diagram.complexity}`
        : `complexity ${diagram.complexity}`;

    return (
        <article ref={cardRef} className={`fc-card${focused ? ' fc-card-focused' : ''}`} aria-label={`Flowchart ${diagram.title}`}>
            <header className="fc-card-header">
                <div className="fc-card-title">
                    <h2 title={diagram.title}>{diagram.title}</h2>
                    <div className="fc-card-meta">
                        {attached ? (
                            <button type="button" className="fc-link" onClick={() => post('reveal', { id: diagram.id })} title="Go to source">
                                <CodeIcon /> {diagram.fileName}:{line}
                            </button>
                        ) : <span className="fc-muted">{diagram.fileName}</span>}
                        {typeof diagram.complexity === 'number' ? (
                            <span className={`fc-badge fc-complexity-${complexity.level}`}
                                title={`Cyclomatic complexity: ${unitSummary}. ${complexity.text} complexity.`}>
                                CC {diagram.complexity}
                            </span>
                        ) : null}
                        {typeof diagram.cognitive === 'number' ? (
                            <span className={`fc-badge fc-complexity-${cognitiveLevel(diagram.cognitive)}`}
                                title="Cognitive complexity (SonarSource): how hard the code is to understand. Recommended ≤ 15.">
                                COG {diagram.cognitive}
                            </span>
                        ) : null}
                        {warnings > 0 ? (
                            <button type="button" className="fc-badge fc-badge-button fc-warning-strong" onClick={() => onToggleDetails(diagram.id, true)}
                                title="Show insights">
                                ⚠ {warnings} {warnings === 1 ? 'issue' : 'issues'}
                            </button>
                        ) : null}
                        {diagram.edited ? <span className="fc-badge fc-warning" title="This chart was edited after it was generated from the code">edited</span> : null}
                        <span className="fc-muted">{timeAgo(diagram.createdAt)}</span>
                    </div>
                </div>
                <div className="fc-toolbar" role="toolbar" aria-label="Flowchart actions">
                    <ToolButton label="Zoom out" onClick={() => setZoom(clampZoom(currentZoom / 1.25))}><ZoomOutIcon /></ToolButton>
                    <button type="button" className="fc-zoom-label" title="Reset zoom to 100%" onClick={() => setZoom(1)}>
                        {zoom === 'fit' || zoom === undefined ? 'Fit' : `${Math.round(currentZoom * 100)}%`}
                    </button>
                    <ToolButton label="Zoom in" onClick={() => setZoom(clampZoom(currentZoom * 1.25))}><ZoomInIcon /></ToolButton>
                    <ToolButton label="Fit to width" onClick={() => setZoom('fit')}><FitIcon /></ToolButton>
                    {diagram.graph ? (
                        <ToolButton label={fullLabels ? 'Compact labels' : 'Show the full code in every node'} active={fullLabels}
                            onClick={() => setFullLabels((v) => !v)}><ExpandIcon /></ToolButton>
                    ) : null}
                    <span className="fc-separator" />
                    {diagram.graph ? (
                        <ToolButton label={editing ? 'Close the editor' : 'Edit the chart and generate code'} active={editing}
                            onClick={() => (editing ? closeEditor() : setEditing(true))}><EditIcon /></ToolButton>
                    ) : null}
                    <ToolButton label={detailsOpen ? 'Hide details' : 'Show details & insights'} active={detailsOpen} onClick={() => onToggleDetails(diagram.id, !detailsOpen)}><InfoIcon /></ToolButton>
                    {attached ? <ToolButton label="Regenerate from current source" onClick={() => post('regenerate', { id: diagram.id })}><RefreshIcon /></ToolButton> : null}
                    <ToolButton label="Copy Mermaid definition" onClick={() => post('copy', { text: diagram.mermaid })}><CopyIcon /></ToolButton>
                    <ToolButton label="Open as Markdown" onClick={() => post('openMarkdown', { id: diagram.id })}><MarkdownIcon /></ToolButton>
                    <div className="fc-menu-anchor">
                        <ToolButton label="Export image" onClick={() => setExportOpen((open) => !open)}><DownloadIcon /></ToolButton>
                        {exportOpen ? (
                            <div className="fc-menu" role="menu" onMouseLeave={() => setExportOpen(false)}>
                                <button type="button" role="menuitem" onClick={() => exportAs('svg')}>Export as SVG</button>
                                <button type="button" role="menuitem" onClick={() => exportAs('png')}>Export as PNG</button>
                            </div>
                        ) : null}
                    </div>
                    <ToolButton label="Remove flowchart" danger onClick={() => post('remove', { id: diagram.id })}><TrashIcon /></ToolButton>
                </div>
            </header>
            {!editing ? <MetricStrip diagram={diagram} /> : null}
            {detailsOpen && !editing ? (
                <section className="fc-details" aria-label="Details and insights">
                    <h3>Insights</h3>
                    <Insights diagram={diagram} />
                    <UnitTable diagram={diagram} />
                </section>
            ) : null}
            {editing ? <EditorBar diagram={diagram} history={history} onClose={closeEditor} /> : null}
            <div className={editing ? 'fc-edit-layout' : undefined}>
                <MermaidDiagram
                    code={editing ? editMermaid : viewMermaid}
                    theme={theme}
                    zoom={zoom === undefined ? 'fit' : zoom}
                    onZoom={setZoom}
                    svgRef={svgRef}
                    nodeLines={editing ? {} : nodeLines}
                    nodeTexts={nodeTexts}
                    highlightNodeId={editing ? undefined : highlightNodeId}
                    tooltip={editing ? 'Click to select and edit' : undefined}
                    onNodeClick={(nodeId) => {
                        if (editing) setSelectedId(nodeId === selectedId ? undefined : nodeId);
                        else if (attached) post('reveal', { id: diagram.id, nodeId });
                    }}
                />
                {editing ? (
                    <aside className="fc-edit-side">
                        <Inspector graph={history.graph} selectedId={selectedId} onChange={history.push} onSelect={setSelectedId} />
                        <CodePreview graph={history.graph} />
                    </aside>
                ) : null}
            </div>
        </article>
    );
}
