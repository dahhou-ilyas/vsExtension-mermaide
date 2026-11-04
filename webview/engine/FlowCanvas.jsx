import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { layoutGraph } from '../../src/core/layout';
import { nodeShape, classicShape, cornerBrackets, tracePath, smoothPath, curvePath, labelPoint } from './geometry';
import { svgStyles, KIND_COLOR, KIND_TAG, THEMES, LOOKS } from './palette';
import { makeMeasure } from './measure';
import { tokenize } from './syntax';

const MARGIN = 40;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const EDGE_KINDS = ['edge', 'back', 'exception', 'abrupt', 'callback', 'muted'];

export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

function edgeColor(edge, unreachable) {
    if (unreachable) return 'muted';
    if (edge.kind === 'exception') return 'exception';
    if (edge.kind === 'abrupt') return 'abrupt';
    if (edge.kind === 'callback') return 'callback';
    if (edge.back) return 'back';
    return 'edge';
}

function labelColor(label) {
    if (/^(yes|true|next)$/.test(label)) return 'yes';
    if (/^(no|false|done|no match)$/.test(label)) return 'no';
    return null;
}

/** Easing animation of the view transform. */
function useAnimatedView(initial) {
    const [view, setView] = useState(initial);
    const target = useRef(initial);
    const frame = useRef(0);
    const animateTo = useCallback((next, instant = false) => {
        target.current = next;
        cancelAnimationFrame(frame.current);
        if (instant || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            setView(next);
            return;
        }
        const step = () => {
            setView((current) => {
                const t = target.current;
                const k = current.k + (t.k - current.k) * 0.22;
                const x = current.x + (t.x - current.x) * 0.22;
                const y = current.y + (t.y - current.y) * 0.22;
                const done = Math.abs(t.k - k) < 0.001 && Math.abs(t.x - x) < 0.3 && Math.abs(t.y - y) < 0.3;
                if (!done) frame.current = requestAnimationFrame(step);
                return done ? t : { k, x, y };
            });
        };
        frame.current = requestAnimationFrame(step);
    }, []);
    useEffect(() => () => cancelAnimationFrame(frame.current), []);
    return [view, animateTo, target];
}

function CodeTokens({ code }) {
    return tokenize(code).map((token, i) => <span key={i} className={`fx-tok-${token.t}`}>{token.v}</span>);
}

/**
 * Native flowchart renderer (replaces Mermaid): our own layout, SVG and interactions.
 */
const FlowCanvas = React.forwardRef(function FlowCanvas({
    graph, labels, theme = 'classic', zoom, onZoom, onNodeClick, selectedId, highlightId,
    nodeLines = {}, nodeTexts = {}, tooltipHint, animate = true, maxHeight
}, ref) {
    const containerRef = useRef(null);
    const svgRef = useRef(null);
    const [size, setSize] = useState({ width: 800, height: 400 });
    const [hovered, setHovered] = useState(null);
    const [tooltip, setTooltip] = useState(null);
    const tooltipTimer = useRef(0);
    const fontFamily = useMemo(() => {
        const style = getComputedStyle(document.body);
        return style.getPropertyValue('--vscode-editor-font-family').trim() || 'Menlo, Consolas, monospace';
    }, []);
    const measure = useMemo(() => makeMeasure(fontFamily), [fontFamily]);

    const look = LOOKS[theme] || LOOKS.classic;
    const LINE_HEIGHT = look.lineHeight;
    const layout = useMemo(
        () => layoutGraph(graph, { labels, measure, lineHeight: look.lineHeight, fontSize: look.fontSize, shapes: look.shapes }),
        [graph, labels, measure, look]
    );
    // Animated packets on very large graphs would cost frames: keep them for readable sizes.
    const packets = look.packets && animate && layout.edges.length <= 160;
    const nodesById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

    // Container width.
    useLayoutEffect(() => {
        const element = containerRef.current;
        if (!element) return undefined;
        const observer = new ResizeObserver(([entry]) => setSize((s) => ({ ...s, width: entry.contentRect.width })));
        observer.observe(element);
        setSize((s) => ({ ...s, width: element.clientWidth }));
        return () => observer.disconnect();
    }, []);

    const contentW = layout.width + MARGIN * 2;
    const contentH = layout.height + MARGIN * 2;
    const limit = maxHeight || Math.round(window.innerHeight * 0.78);
    // Fit the width, and the height too as long as the text stays readable.
    const fitScale = Math.max(MIN_ZOOM, Math.min(1.1, (size.width || 800) / contentW, Math.max(0.55, limit / contentH)));
    const scale = zoom === 'fit' || zoom === undefined ? fitScale : clampZoom(zoom);
    const height = Math.max(160, Math.min(limit, contentH * scale));

    const centered = useCallback((k) => ({
        k,
        x: Math.max(0, ((size.width || 800) - contentW * k) / 2) + MARGIN * k,
        y: MARGIN * k + Math.max(0, (height - contentH * k) / 2)
    }), [size.width, contentW, contentH, height]);

    const [view, animateTo, target] = useAnimatedView({ k: scale, x: MARGIN, y: MARGIN });
    const first = useRef(true);
    useEffect(() => {
        animateTo(centered(scale), first.current);
        first.current = false;
    }, [scale, layout, size.width]);

    useImperativeHandle(ref, () => ({
        /** Standalone SVG markup of the whole flowchart (styles included). */
        toSvg() {
            const svg = svgRef.current;
            if (!svg) return null;
            const clone = svg.cloneNode(true);
            // Resolve colours (VS Code variables, color-mix) so the file looks the same anywhere.
            const originals = svg.querySelectorAll('path, rect, circle, text, line');
            const copies = clone.querySelectorAll('path, rect, circle, text, line');
            originals.forEach((el, i) => {
                const cs = getComputedStyle(el);
                const c = copies[i];
                if (!c) return;
                for (const prop of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-family', 'font-weight', 'fill-opacity']) {
                    const value = cs.getPropertyValue(prop);
                    if (value) c.setAttribute(prop, value);
                }
                c.removeAttribute('class');
            });
            clone.querySelectorAll('style').forEach((n) => n.remove());
            clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            clone.setAttribute('width', String(Math.ceil(contentW)));
            clone.setAttribute('height', String(Math.ceil(contentH)));
            clone.setAttribute('viewBox', `0 0 ${Math.ceil(contentW)} ${Math.ceil(contentH)}`);
            clone.removeAttribute('style');
            const scene = clone.querySelector('.fx-scene');
            if (scene) scene.setAttribute('transform', `translate(${MARGIN},${MARGIN})`);
            const grid = clone.querySelector('#fx-grid');
            if (grid) grid.setAttribute('patternTransform', '');
            clone.querySelectorAll('.fx-packet').forEach((n) => n.remove());
            // Standalone files: SVG attributes rather than CSS for positions and paths.
            clone.querySelectorAll('[data-node]').forEach((n) => {
                const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)/.exec(n.style.transform || '');
                if (m) n.setAttribute('transform', `translate(${m[1]},${m[2]})`);
                n.style.removeProperty('transform');
            });
            clone.querySelectorAll('path').forEach((n) => n.style.removeProperty('d'));
            clone.querySelectorAll('.fx-appear').forEach((n) => n.classList.remove('fx-appear'));
            return { markup: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`, width: contentW, height: contentH };
        }
    }), [contentW, contentH]);

    // Ctrl / Cmd + wheel (and trackpad pinch) zooms around the pointer.
    useEffect(() => {
        const element = containerRef.current;
        if (!element) return undefined;
        const onWheel = (event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            const rect = element.getBoundingClientRect();
            const px = event.clientX - rect.left;
            const py = event.clientY - rect.top;
            const current = target.current;
            const k = clampZoom(current.k * Math.exp(-event.deltaY * 0.0022));
            const x = px - ((px - current.x) / current.k) * k;
            const y = py - ((py - current.y) / current.k) * k;
            animateTo({ k, x, y });
            if (onZoom) onZoom(k, true);
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, [animateTo, onZoom, target]);

    // Drag to pan.
    const onPointerDown = (event) => {
        if (event.button !== 0 || event.target.closest('.fx-node')) return;
        const start = { x: event.clientX, y: event.clientY, view: target.current };
        containerRef.current.classList.add('fx-dragging');
        const move = (e) => animateTo({ ...start.view, x: start.view.x + e.clientX - start.x, y: start.view.y + e.clientY - start.y }, true);
        const up = () => {
            containerRef.current && containerRef.current.classList.remove('fx-dragging');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    // Focus mode: what is connected to the hovered node.
    const related = useMemo(() => {
        if (!hovered) return null;
        const nodes = new Set([hovered]);
        const edges = new Set();
        layout.edges.forEach((e, i) => {
            if (e.from === hovered || e.to === hovered) {
                edges.add(i);
                nodes.add(e.from);
                nodes.add(e.to);
            }
        });
        return { nodes, edges };
    }, [hovered, layout]);

    const showTooltip = (event, id) => {
        clearTimeout(tooltipTimer.current);
        const rect = containerRef.current.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        tooltipTimer.current = setTimeout(() => setTooltip({ id, x, y }), 280);
    };
    const hideTooltip = () => {
        clearTimeout(tooltipTimer.current);
        setTooltip(null);
    };

    const { k, x, y } = view;
    const gridSize = 24 * k;

    return (
        <div className={`fx-canvas fx-theme-${theme}`} ref={containerRef} style={{ ...(THEMES[theme] || THEMES.cyberpunk), height }} onPointerDown={onPointerDown}
            onDoubleClick={(e) => { if (!e.target.closest('.fx-node') && onZoom) onZoom('fit'); }}>
            <svg ref={svgRef} className="fx-root" width="100%" height="100%" role="img" aria-label="Flowchart">
                <style>{svgStyles(theme)}</style>
                <defs>
                    <pattern id="fx-grid" width={24} height={24} patternUnits="userSpaceOnUse"
                        patternTransform={`translate(${x % gridSize} ${y % gridSize}) scale(${k})`}>
                        {look.shapes === 'classic'
                            ? <circle cx={1} cy={1} r={1} className="fx-grid-dot" />
                            : <path d="M24 0 L0 0 0 24" className="fx-grid-line" fill="none" />}
                    </pattern>
                    <radialGradient id="fx-vignette" cx="50%" cy="40%" r="75%">
                        <stop offset="0%" stopColor="var(--fx-bg-2)" stopOpacity="0.9" />
                        <stop offset="100%" stopColor="var(--fx-bg)" stopOpacity="0" />
                    </radialGradient>
                    {EDGE_KINDS.map((kind) => (
                        <marker key={kind} id={`fx-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                            <path d="M0,0 L10,5 L0,10 L3,5 Z" fill={kind === 'muted' ? 'var(--fx-muted)' : `var(--fx-${kind})`} />
                        </marker>
                    ))}
                </defs>
                <rect className="fx-bg" width="100%" height="100%" />
                {look.shapes === 'classic' ? null : <rect width="100%" height="100%" fill="url(#fx-vignette)" />}
                <rect width="100%" height="100%" fill="url(#fx-grid)" />

                <g className="fx-scene" transform={`translate(${x},${y}) scale(${k})`}>
                    {layout.units.filter((u) => u.grouped).map((u) => (
                        <g key={`u${u.index}`} className="fx-unit">
                            <rect className={`fx-unit-frame${u.embedded ? ' embedded' : ''}`} x={u.x} y={u.y} width={u.width} height={u.height}
                                rx={look.shapes === 'classic' ? 10 : 0} />
                            {look.tags ? <path className="fx-unit-bracket" d={cornerBrackets(u.x, u.y, u.width, u.height, 14)} /> : null}
                            <text className="fx-unit-kind" x={u.x + 16} y={u.y + 16}>{u.kind === 'callback' ? 'CALLBACK' : u.kind === 'nested' ? 'NESTED FUNCTION' : u.kind === 'main' ? 'TOP LEVEL' : 'FUNCTION'}</text>
                            <text className="fx-unit-title" x={u.x + 16} y={u.y + 32}>{u.name}</text>
                        </g>
                    ))}

                    {layout.edges.map((edge, i) => {
                        const unreachable = nodesById.get(edge.from) && nodesById.get(edge.from).unreachable;
                        const color = edgeColor(edge, unreachable);
                        const d = edge.curve
                            ? curvePath(edge.points[0], edge.points[edge.points.length - 1])
                            : (look.edges === 'smooth' ? smoothPath(edge.points) : tracePath(edge.points));
                        const secondary = look.faintSecondary && (edge.kind === 'exception' || edge.kind === 'abrupt' || edge.kind === 'callback');
                        const state = (related ? (related.edges.has(i) ? ' hovered' : ' dimmed') : '') + (secondary ? ' secondary' : '');
                        const lp = !edge.label ? null : (look.chips ? labelPoint(edge.points, edge.labelAt) : (secondary ? null : edge.labelPos));
                        const lc = labelColor(edge.label) || color;
                        const text = (edge.label === 'then return' ? 'return' : String(edge.label || '')).toUpperCase();
                        const tw = text.length * 6.4 + 10;
                        // A vertical lane label needs room along its lane.
                        const fits = !(edge.labelAt === 'lane' && lp && lp[2] !== undefined && lp[2] < tw + 10);
                        return (
                            <g key={`${edge.from}>${edge.to}:${edge.edgeIndex}`} className={`fx-edge ${edge.kind || 'normal'}${state}`} style={{ '--c': `var(--fx-${color})` }}>
                                <path className="fx-trace" d={d} style={{ d: `path("${d}")` }} stroke={`var(--fx-${color})`} markerEnd={`url(#fx-arrow-${color})`} />
                                {packets && !unreachable && edge.kind !== 'callback' ? (
                                    <path className="fx-packet" d={d} style={{ d: `path("${d}")`, animationDelay: `${-(i % 7) * 0.2}s` }} stroke={`var(--fx-${color})`} />
                                ) : null}
                                {lp && !look.chips ? (
                                    <text className="fx-edge-text" x={lp[0]} y={lp[1]} textAnchor={edge.labelAlign === 'end' ? 'end' : 'start'}
                                        fill={`var(--fx-${labelColor(edge.label) || 'muted'})`}>
                                        {edge.label.charAt(0).toUpperCase() + edge.label.slice(1)}
                                    </text>
                                ) : null}
                                {lp && fits && look.chips ? (
                                    <g className="fx-edge-label" transform={`translate(${lp[0]},${lp[1]})${edge.labelAt === 'lane' ? ' rotate(-90)' : ''}`}>
                                        <rect x={-tw / 2} y={-8} width={tw} height={16} rx={2} stroke={`var(--fx-${lc})`} />
                                        <text textAnchor="middle" y={3.5} fill={`var(--fx-${lc})`}>{text}</text>
                                    </g>
                                ) : null}
                            </g>
                        );
                    })}

                    {Object.values(layout.nodes).map((placed) => {
                        const node = nodesById.get(placed.id);
                        if (!node) return null;
                        const finallyEnd = node.kind === 'junction' && node.meta && node.meta.subtype === 'finallyEnd';
                        const colorKey = node.unreachable ? 'muted' : (finallyEnd ? 'try' : KIND_COLOR[node.kind] || 'process');
                        const color = colorKey === 'muted' ? 'var(--fx-muted)' : `var(--fx-${colorKey})`;
                        const classic = look.shapes === 'classic';
                        const symbol = classic ? classicShape(node.kind, placed.width, placed.height, node.meta || {}) : { outline: nodeShape(node.kind, placed.width, placed.height, node.meta) };
                        const shape = symbol.outline;
                        const leftAligned = node.kind === 'process' && placed.lines.length > 1 && !(node.meta && node.meta.declaration);
                        const textX = leftAligned ? 16 : placed.width / 2;
                        const textTop = (placed.height - placed.lines.length * LINE_HEIGHT) / 2 + LINE_HEIGHT * 0.72;
                        let tag = KIND_TAG[node.kind];
                        if (node.kind === 'decision' && node.meta && node.meta.subtype === 'switch') tag = 'SWITCH';
                        if (node.kind === 'start' && node.meta && node.meta.fnKind === 'callback') tag = 'CALLBACK';
                        if (node.kind === 'process' && node.meta && node.meta.declaration) tag = 'DEF';
                        if (finallyEnd || node.kind === 'junction' || node.kind === 'end' || !look.tags) tag = null;
                        const line = look.lineNumbers ? nodeLines[placed.id] : undefined;
                        const state = [
                            node.unreachable ? 'unreachable' : '',
                            related ? (related.nodes.has(placed.id) ? 'hovered' : 'dimmed') : '',
                            `fx-kind-${node.kind}`
                        ].filter(Boolean).join(' ');
                        return (
                            <g key={placed.id} data-node={placed.id} className={`fx-node ${state}`}
                                style={{ '--c': color, transform: `translate(${placed.x}px,${placed.y}px)` }}
                                onClick={(e) => { e.stopPropagation(); if (onNodeClick) onNodeClick(placed.id); }}
                                onMouseEnter={(e) => { setHovered(placed.id); showTooltip(e, placed.id); }}
                                onMouseMove={(e) => { if (tooltip) showTooltip(e, placed.id); }}
                                onMouseLeave={() => { setHovered(null); hideTooltip(); }}>
                                <g className={animate ? 'fx-appear' : undefined} style={{ animationDelay: `${Math.min(placed.rank, 30) * 28}ms` }}>
                                    {classic ? null : <path d={shape} fill="var(--fx-bg)" />}
                                    {classic
                                        ? <path className="fx-shape" d={shape} stroke={color} />
                                        : <path className="fx-shape" d={shape} fill={color} stroke={color} style={{ fillOpacity: 'var(--fx-fill-alpha)' }} />}
                                    {symbol.detail ? <path className="fx-detail" d={symbol.detail} /> : null}
                                    {placed.lines.map((l, i) => (
                                        <text key={i} className="fx-text" x={textX} y={textTop + i * LINE_HEIGHT} textAnchor={leftAligned ? 'start' : 'middle'}>{l}</text>
                                    ))}
                                    {tag ? (
                                        <g className="fx-tag-group">
                                            <rect className="fx-tag-bg" x={10} y={-6} width={tag.length * 6.2 + 8} height={11} />
                                            <text className="fx-tag" x={14} y={2.5} fill={color}>{tag}</text>
                                        </g>
                                    ) : null}
                                    {line ? <text className="fx-line-no" x={placed.width - 6} y={-4} textAnchor="end">L{line}</text> : null}
                                    {node.async && classic ? (
                                        <text className="fx-async" x={placed.width - 6} y={placed.height - 5} textAnchor="end">await</text>
                                    ) : null}
                                    {node.async && !classic ? (
                                        <g className="fx-badge" transform={`translate(${placed.width - 46},${placed.height - 5})`}>
                                            <rect width={40} height={10} stroke="var(--fx-async)" />
                                            <text x={20} y={7.5} textAnchor="middle" fill="var(--fx-async)">AWAIT</text>
                                        </g>
                                    ) : null}
                                </g>
                                {selectedId === placed.id ? (
                                    look.tags
                                        ? <path className="fx-reticle" d={cornerBrackets(-7, -7, placed.width + 14, placed.height + 14, 9)} />
                                        : <rect className="fx-reticle" x={-6} y={-6} width={placed.width + 12} height={placed.height + 12} rx={8} />
                                ) : null}
                                {highlightId === placed.id ? (
                                    <rect className="fx-cursor" x={-5} y={-5} width={placed.width + 10} height={placed.height + 10} rx={4} />
                                ) : null}
                            </g>
                        );
                    })}
                </g>
            </svg>

            {tooltip && nodesById.get(tooltip.id) ? (
                <div className="fx-tooltip" style={{ left: Math.min(tooltip.x + 16, (size.width || 800) - 340), top: tooltip.y + 18 }}>
                    <div className="fx-tooltip-head">
                        <span>{(KIND_TAG[nodesById.get(tooltip.id).kind] || nodesById.get(tooltip.id).kind).toUpperCase()}</span>
                        {nodeLines[tooltip.id] ? <span>LINE {nodeLines[tooltip.id]}</span> : null}
                    </div>
                    <pre><CodeTokens code={nodeTexts[tooltip.id] || ''} /></pre>
                    <div className="fx-tooltip-hint">{tooltipHint || 'Click to open in the editor'}</div>
                </div>
            ) : null}

            <Minimap layout={layout} view={view} size={{ width: size.width, height }} nodesById={nodesById}
                onMove={(nx, ny) => animateTo({ ...target.current, x: (size.width || 800) / 2 - (nx + MARGIN) * target.current.k, y: height / 2 - (ny + MARGIN) * target.current.k })} />
        </div>
    );
});

/** Overview with the visible area; click or drag to navigate. */
function Minimap({ layout, view, size, nodesById, onMove }) {
    const W = 168;
    const contentW = layout.width + MARGIN * 2;
    const contentH = layout.height + MARGIN * 2;
    const visibleW = size.width / view.k;
    const visibleH = size.height / view.k;
    if (visibleW >= contentW - 4 && visibleH >= contentH - 4) return null;
    const s = W / Math.max(contentW, contentH * 1.4);
    const H = Math.max(40, contentH * s);
    const vx = (-view.x / view.k + MARGIN) * s;
    const vy = (-view.y / view.k + MARGIN) * s;
    const go = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onMove((event.clientX - rect.left) / s - MARGIN, (event.clientY - rect.top) / s - MARGIN);
    };
    return (
        <svg className="fx-minimap" width={W} height={H}
            onPointerDown={(e) => {
                e.stopPropagation();
                go(e);
                const target = e.currentTarget;
                const move = (ev) => go({ ...ev, currentTarget: target, clientX: ev.clientX, clientY: ev.clientY });
                const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
            }}>
            {Object.values(layout.nodes).map((n) => {
                const node = nodesById.get(n.id);
                const key = node ? (KIND_COLOR[node.kind] || 'process') : 'process';
                return <rect key={n.id} x={(n.x + MARGIN) * s} y={(n.y + MARGIN) * s} width={Math.max(2, n.width * s)} height={Math.max(1.5, n.height * s)} fill={`var(--fx-${key})`} opacity={0.8} />;
            })}
            <rect className="fx-minimap-view" x={vx} y={vy} width={visibleW * s} height={visibleH * s} />
        </svg>
    );
}

export default FlowCanvas;
