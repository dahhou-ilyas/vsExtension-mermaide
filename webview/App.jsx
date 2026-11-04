import React, { useEffect, useMemo, useState } from 'react';
import DiagramCard from './DiagramCard';
import { post, getState, setState } from './vscodeApi';
import { FlowIcon, SearchIcon } from './icons';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

export default function App() {
    const [diagrams, setDiagrams] = useState([]);
    const [settings, setSettings] = useState({ style: 'classic', animate: true });
    const [focus, setFocus] = useState({ id: undefined, tick: 0, edit: false });
    const [received, setReceived] = useState(false);
    const [filter, setFilter] = useState(() => getState().filter || '');
    const [zooms, setZooms] = useState(() => getState().zooms || {});
    const [details, setDetails] = useState(() => getState().details || {});
    const [highlights, setHighlights] = useState({});

    useEffect(() => {
        const onMessage = (event) => {
            const message = event.data;
            if (message && message.type === 'highlight') {
                setHighlights(message.highlights || {});
                return;
            }
            if (!message || message.type !== 'state') return;
            setDiagrams(Array.isArray(message.diagrams) ? message.diagrams : []);
            if (message.settings) setSettings(message.settings);
            if (message.focusId) setFocus((f) => ({ id: message.focusId, tick: f.tick + 1, edit: message.editId === message.focusId }));
            setReceived(true);
        };
        window.addEventListener('message', onMessage);
        post('ready');
        return () => window.removeEventListener('message', onMessage);
    }, []);

    useEffect(() => setState({ filter }), [filter]);

    const onZoomChange = (id, value) => {
        setZooms((current) => {
            const next = { ...current, [id]: value };
            setState({ zooms: next });
            return next;
        });
    };

    const onToggleDetails = (id, open) => {
        setDetails((current) => {
            const next = { ...current, [id]: open };
            setState({ details: next });
            return next;
        });
    };

    const visible = useMemo(() => {
        const query = filter.trim().toLowerCase();
        if (!query) return diagrams;
        return diagrams.filter((d) => `${d.title} ${d.fileName}`.toLowerCase().includes(query));
    }, [diagrams, filter]);

    return (
        <div className={`fc-app style-${settings.style || 'classic'}`}>
            <header className="fc-header">
                <div className="fc-brand">
                    <FlowIcon />
                    <h1>Flowcharts</h1>
                    {diagrams.length ? <span className="fc-count">{diagrams.length}</span> : null}
                </div>
                {diagrams.length ? (
                    <div className="fc-header-actions">
                        <label className="fc-search">
                            <SearchIcon />
                            <input
                                type="search"
                                placeholder="Filter by function or file"
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)}
                                aria-label="Filter flowcharts"
                            />
                        </label>
                        <button type="button" className="fc-button fc-secondary" onClick={() => post('clear')}>Clear all</button>
                    </div>
                ) : null}
            </header>

            {!received ? <div className="fc-loading">Loading…</div> : null}

            {received && diagrams.length === 0 ? (
                <section className="fc-empty">
                    <FlowIcon />
                    <h2>No flowcharts yet</h2>
                    <p>Visualize the control flow of any JavaScript or TypeScript function.</p>
                    <ol>
                        <li>Place the cursor inside a function, or select some code.</li>
                        <li>Press <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd>+<kbd>{isMac ? '⌥' : 'Alt'}</kbd>+<kbd>G</kbd>, click the <em>Flowchart</em> CodeLens, or right-click → <em>Generate Flowchart</em>.</li>
                        <li>Click any node to jump to the matching line of code. <kbd>Ctrl</kbd>+wheel zooms, drag to pan, double-click to fit.</li>
                        <li>Click <em>Edit</em> on a chart to change it and generate the code back, or run <em>Flowchart: New Flowchart</em> to design a function from scratch.</li>
                    </ol>
                </section>
            ) : null}

            {received && diagrams.length > 0 && visible.length === 0 ? (
                <p className="fc-muted fc-center">No flowchart matches “{filter}”.</p>
            ) : null}

            <main className="fc-list">
                {visible.map((diagram) => (
                    <DiagramCard
                        key={diagram.id}
                        diagram={diagram}
                        theme={settings.style || 'classic'}
                        animate={settings.animate !== false}
                        focused={focus.id === diagram.id}
                        focusTick={focus.tick}
                        zoom={zooms[diagram.id]}
                        onZoomChange={onZoomChange}
                        highlightNodeId={highlights[diagram.id]}
                        detailsOpen={!!details[diagram.id]}
                        startEditing={focus.edit && focus.id === diagram.id}
                        labels={settings.labels}
                        onToggleDetails={onToggleDetails}
                    />
                ))}
            </main>

            {diagrams.length ? (
                <footer className="fc-legend" aria-label="Legend">
                    <span><i className="fc-swatch fc-sw-start" />Start / End</span>
                    <span><i className="fc-swatch fc-sw-decision" />Condition</span>
                    <span><i className="fc-swatch fc-sw-loop" />Loop</span>
                    <span><i className="fc-swatch fc-sw-return" />Return</span>
                    <span><i className="fc-swatch fc-sw-throw" />Throw</span>
                    <span><i className="fc-swatch fc-sw-try" />try / catch</span>
                    <span><i className="fc-swatch fc-sw-async" />await</span>
                    <span><i className="fc-swatch fc-sw-unreachable" />Unreachable</span>
                    <span><i className="fc-line fc-line-loop" />loop back edge (right gutter)</span>
                    <span><i className="fc-line fc-line-exception" />may throw → catch / finally (left gutter)</span>
                    <span><i className="fc-line fc-line-abrupt" />return / rethrow through finally</span>
                    <span><i className="fc-line fc-line-callback" />inline callback</span>
                </footer>
            ) : null}
        </div>
    );
}
