import React, { useEffect, useRef, useState } from 'react';
import MermaidDiagram, { clampZoom } from './MermaidDiagram';
import { MetricStrip, Insights, UnitTable } from './DiagramDetails';
import { post } from './vscodeApi';
import { toSvgMarkup, toPngDataUrl, editorBackground } from './exporter';
import {
    ZoomInIcon, ZoomOutIcon, FitIcon, CopyIcon, MarkdownIcon, DownloadIcon, TrashIcon, RefreshIcon, CodeIcon, InfoIcon
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

export default function DiagramCard({ diagram, theme, focused, focusTick, zoom, onZoomChange, highlightNodeId, detailsOpen, onToggleDetails }) {
    const svgRef = useRef(null);
    const cardRef = useRef(null);
    const [exportOpen, setExportOpen] = useState(false);
    const complexity = complexityLevel(diagram.complexity);
    const warnings = (diagram.insights || []).filter((i) => i.severity === 'warning').length;
    const nodeLines = {};
    for (const [nodeId, span] of Object.entries(diagram.nodes || {})) nodeLines[nodeId] = span.start.line + 1;

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
                        <button type="button" className="fc-link" onClick={() => post('reveal', { id: diagram.id })} title="Go to source">
                            <CodeIcon /> {diagram.fileName}:{line}
                        </button>
                        <span className={`fc-badge fc-complexity-${complexity.level}`}
                            title={`Cyclomatic complexity: ${unitSummary}. ${complexity.text} complexity.`}>
                            CC {diagram.complexity}
                        </span>
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
                    <span className="fc-separator" />
                    <ToolButton label={detailsOpen ? 'Hide details' : 'Show details & insights'} active={detailsOpen} onClick={() => onToggleDetails(diagram.id, !detailsOpen)}><InfoIcon /></ToolButton>
                    <ToolButton label="Regenerate from current source" onClick={() => post('regenerate', { id: diagram.id })}><RefreshIcon /></ToolButton>
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
            <MetricStrip diagram={diagram} />
            {detailsOpen ? (
                <section className="fc-details" aria-label="Details and insights">
                    <h3>Insights</h3>
                    <Insights diagram={diagram} />
                    <UnitTable diagram={diagram} />
                </section>
            ) : null}
            <MermaidDiagram
                code={diagram.mermaid}
                theme={theme}
                zoom={zoom === undefined ? 'fit' : zoom}
                onZoom={setZoom}
                svgRef={svgRef}
                nodeLines={nodeLines}
                highlightNodeId={highlightNodeId}
                onNodeClick={(nodeId) => post('reveal', { id: diagram.id, nodeId })}
            />
        </article>
    );
}
