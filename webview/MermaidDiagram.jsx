import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { renderMermaid, nodeIdOf } from './renderer';

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;

export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

/**
 * Renders one Mermaid definition, with zoom, drag-to-pan and clickable nodes.
 */
export default function MermaidDiagram({ code, theme, zoom, onZoom, onNodeClick, svgRef, nodeLines, highlightNodeId }) {
    const viewportRef = useRef(null);
    const hostRef = useRef(null);
    const sizeRef = useRef(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    // Render (or re-render when the code or theme changes).
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        renderMermaid(code, theme)
            .then((svg) => {
                if (cancelled || !hostRef.current) return;
                hostRef.current.innerHTML = svg;
                const element = hostRef.current.querySelector('svg');
                if (!element) throw new Error('Mermaid did not produce an SVG.');
                const box = element.viewBox && element.viewBox.baseVal;
                sizeRef.current = box && box.width
                    ? { width: box.width, height: box.height }
                    : { width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height };
                element.removeAttribute('width');
                element.removeAttribute('height');
                element.style.maxWidth = 'none';
                if (svgRef) svgRef.current = element;

                element.querySelectorAll('g.node').forEach((node) => {
                    const nodeId = nodeIdOf(node);
                    if (!nodeId) return;
                    node.classList.add('fc-clickable');
                    node.setAttribute('data-node', nodeId);
                    const line = nodeLines && nodeLines[nodeId];
                    const tooltip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                    tooltip.textContent = line ? `Line ${line} — click to open in the editor` : 'Click to open in the editor';
                    node.insertBefore(tooltip, node.firstChild);
                    node.setAttribute('tabindex', '0');
                    node.setAttribute('role', 'button');
                    const activate = (event) => {
                        event.stopPropagation();
                        onNodeClick && onNodeClick(nodeId);
                    };
                    node.addEventListener('click', activate);
                    node.addEventListener('keydown', (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            activate(event);
                        }
                    });
                });
                applyZoom();
                applyHighlight();
                setError(null);
                setLoading(false);
            })
            .catch((err) => {
                if (cancelled) return;
                setError(err && err.message ? err.message : String(err));
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [code, theme]);

    const applyZoom = () => {
        const element = hostRef.current && hostRef.current.querySelector('svg');
        const size = sizeRef.current;
        if (!element || !size) return;
        const z = zoom === 'fit' ? fitZoom() : zoom;
        element.style.width = `${size.width * z}px`;
        element.style.height = `${size.height * z}px`;
    };

    const fitZoom = () => {
        const size = sizeRef.current;
        const viewport = viewportRef.current;
        if (!size || !viewport) return 1;
        const available = viewport.clientWidth - 32;
        return clampZoom(Math.min(1, available / size.width));
    };

    useLayoutEffect(applyZoom, [zoom]);

    const applyHighlight = () => {
        const host = hostRef.current;
        if (!host) return;
        host.querySelectorAll('.fc-highlight').forEach((n) => n.classList.remove('fc-highlight'));
        if (!highlightNodeId) return;
        const node = host.querySelector(`[data-node="${highlightNodeId}"]`);
        if (node) node.classList.add('fc-highlight');
    };

    useEffect(applyHighlight, [highlightNodeId]);

    // Ctrl / Cmd + wheel zoom.
    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return undefined;
        const onWheel = (event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            const current = zoom === 'fit' ? fitZoom() : zoom;
            onZoom(clampZoom(current * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
        };
        viewport.addEventListener('wheel', onWheel, { passive: false });
        return () => viewport.removeEventListener('wheel', onWheel);
    });

    // Drag to pan.
    const onPointerDown = (event) => {
        if (event.button !== 0 || event.target.closest('.fc-clickable')) return;
        const viewport = viewportRef.current;
        const start = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
        viewport.classList.add('fc-dragging');
        const move = (e) => {
            viewport.scrollLeft = start.left - (e.clientX - start.x);
            viewport.scrollTop = start.top - (e.clientY - start.y);
        };
        const up = () => {
            viewport.classList.remove('fc-dragging');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    return (
        <div className="fc-viewport" ref={viewportRef} onPointerDown={onPointerDown}>
            {loading && !error ? <div className="fc-loading">Rendering…</div> : null}
            {error ? (
                <div className="fc-error" role="alert">
                    <strong>This flowchart could not be rendered.</strong>
                    <p>{error}</p>
                    <details>
                        <summary>Mermaid definition</summary>
                        <pre>{code}</pre>
                    </details>
                </div>
            ) : null}
            <div className="fc-svg-host" ref={hostRef} hidden={!!error} />
        </div>
    );
}
