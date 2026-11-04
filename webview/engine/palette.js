/**
 * Visual themes of the native renderer. Each theme is a set of CSS custom
 * properties; the SVG carries its own <style>, so exported files look identical.
 */

export const THEMES = {
    cyberpunk: {
        '--fx-bg': '#05080f',
        '--fx-bg-2': '#0a1120',
        '--fx-grid': 'rgba(0, 229, 255, 0.07)',
        '--fx-frame': 'rgba(0, 229, 255, 0.28)',
        '--fx-frame-embedded': 'rgba(0, 255, 208, 0.28)',
        '--fx-title': '#7df9ff',
        '--fx-text': '#dff8ff',
        '--fx-muted': '#6b7a99',
        '--fx-process': '#00e5ff',
        '--fx-start': '#39ff88',
        '--fx-end': '#7b88a8',
        '--fx-decision': '#fcee0a',
        '--fx-loop': '#ff2bd6',
        '--fx-return': '#4d7cff',
        '--fx-throw': '#ff003c',
        '--fx-try': '#ff9f1c',
        '--fx-junction': '#8892b0',
        '--fx-async': '#00ffd0',
        '--fx-edge': '#45d4ff',
        '--fx-back': '#ff2bd6',
        '--fx-exception': '#ff3355',
        '--fx-abrupt': '#b14aed',
        '--fx-callback': '#00ffd0',
        '--fx-yes': '#39ff88',
        '--fx-no': '#ff4d8d',
        '--fx-fill-alpha': '0.07',
        '--fx-glow': '1',
        '--fx-font': "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Consolas, monospace"
    },
    minimal: {
        '--fx-bg': 'var(--vscode-editor-background, #1e1e1e)',
        '--fx-bg-2': 'var(--vscode-editor-background, #1e1e1e)',
        '--fx-grid': 'rgba(128, 128, 128, 0.08)',
        '--fx-frame': 'rgba(128, 128, 128, 0.35)',
        '--fx-frame-embedded': 'rgba(128, 128, 128, 0.25)',
        '--fx-title': 'var(--vscode-foreground, #cccccc)',
        '--fx-text': 'var(--vscode-editor-foreground, #d4d4d4)',
        '--fx-muted': 'var(--vscode-descriptionForeground, #8b8b8b)',
        '--fx-process': '#7f8ea3',
        '--fx-start': '#3fb950',
        '--fx-end': '#8b949e',
        '--fx-decision': '#d29922',
        '--fx-loop': '#a371f7',
        '--fx-return': '#2f81f7',
        '--fx-throw': '#f85149',
        '--fx-try': '#db6d28',
        '--fx-junction': '#8b949e',
        '--fx-async': '#39c5cf',
        '--fx-edge': '#8b949e',
        '--fx-back': '#a371f7',
        '--fx-exception': '#f85149',
        '--fx-abrupt': '#a371f7',
        '--fx-callback': '#39c5cf',
        '--fx-yes': '#3fb950',
        '--fx-no': '#f85149',
        '--fx-fill-alpha': '0.12',
        '--fx-glow': '0',
        '--fx-font': "var(--vscode-editor-font-family, Menlo, Consolas, monospace)"
    }
};

export const KIND_COLOR = {
    start: 'start', end: 'end', process: 'process', decision: 'decision', loop: 'loop', return: 'return',
    throw: 'throw', try: 'try', catch: 'try', finally: 'try', junction: 'junction'
};

export const KIND_TAG = {
    start: 'FN', end: 'END', decision: 'IF', loop: 'LOOP', return: 'RET', throw: 'THROW',
    try: 'TRY', catch: 'CATCH', finally: 'FINALLY'
};

export const EDGE_COLOR = { normal: 'edge', back: 'back', exception: 'exception', abrupt: 'abrupt', callback: 'callback' };

/** CSS embedded in the SVG (also used by exports). */
export function svgStyles(themeName) {
    const theme = THEMES[themeName] || THEMES.cyberpunk;
    const vars = Object.entries(theme).map(([k, v]) => `${k}:${v};`).join('');
    const glow = themeName === 'minimal' ? 0 : 1;
    return `
.fx-root{${vars}font-family:var(--fx-font);}
.fx-bg{fill:var(--fx-bg);}
.fx-grid-line{stroke:var(--fx-grid);stroke-width:1;}
.fx-unit-frame{fill:rgba(255,255,255,0.012);stroke:var(--fx-frame);stroke-width:1;}
.fx-unit-frame.embedded{stroke:var(--fx-frame-embedded);stroke-dasharray:6 5;}
.fx-unit-bracket{fill:none;stroke:var(--fx-title);stroke-width:2;opacity:.85;}
.fx-unit-title{fill:var(--fx-title);font-size:12px;letter-spacing:.03em;font-weight:600;}
.fx-unit-kind{fill:var(--fx-muted);font-size:9px;letter-spacing:.2em;}
.fx-node{cursor:pointer;}
.fx-node .fx-shape{stroke-width:1.6;fill-opacity:1;}
.fx-node .fx-text{fill:var(--fx-text);font-size:12.5px;}
.fx-node .fx-tag{font-size:8.5px;letter-spacing:.16em;font-weight:700;}
.fx-node .fx-tag-bg{fill:var(--fx-bg);}
.fx-node .fx-line-no{fill:var(--fx-muted);font-size:8.5px;letter-spacing:.06em;}
.fx-node:hover .fx-shape,.fx-node.hovered .fx-shape{stroke-width:2.4;}
${glow ? '.fx-node .fx-shape{filter:drop-shadow(0 0 3px var(--c));}.fx-node:hover .fx-shape,.fx-node.hovered .fx-shape{filter:drop-shadow(0 0 6px var(--c)) drop-shadow(0 0 14px var(--c));}' : ''}
.fx-node.unreachable{opacity:.45;}
.fx-node.unreachable .fx-shape{stroke-dasharray:5 4;}
.fx-node.dimmed,.fx-edge.dimmed{opacity:.18;}
.fx-node{transition:opacity .25s ease,transform .38s cubic-bezier(.2,.8,.2,1);}
.fx-edge{transition:opacity .25s ease;}
.fx-trace,.fx-packet{transition:d .38s cubic-bezier(.2,.8,.2,1);}
.fx-edge .fx-trace{fill:none;stroke-width:1.6;stroke-linejoin:round;}
.fx-edge.hovered .fx-trace{stroke-width:2.6;}
.fx-edge.exception .fx-trace,.fx-edge.abrupt .fx-trace{stroke-dasharray:6 4;}
.fx-edge.callback .fx-trace{stroke-dasharray:2 5;stroke-linecap:round;}
${glow ? '.fx-edge .fx-trace{filter:drop-shadow(0 0 2px var(--c));}' : ''}
.fx-packet{fill:none;stroke-width:2.6;stroke-linecap:round;stroke-dasharray:2 22;animation:fx-flow 1.4s linear infinite;opacity:.95;}
@keyframes fx-flow{to{stroke-dashoffset:-24;}}
.fx-edge-label rect{fill:var(--fx-bg);stroke-width:1;}
.fx-edge-label text{font-size:9px;letter-spacing:.12em;font-weight:700;text-transform:uppercase;}
.fx-badge rect{fill:var(--fx-bg);}
.fx-badge text{font-size:7.5px;letter-spacing:.14em;font-weight:700;}
.fx-reticle{fill:none;stroke:var(--fx-title);stroke-width:2;animation:fx-pulse 1.4s ease-in-out infinite;}
.fx-cursor{fill:none;stroke:var(--fx-async);stroke-width:2;stroke-dasharray:4 4;animation:fx-dash 1s linear infinite;}
@keyframes fx-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}
@keyframes fx-dash{to{stroke-dashoffset:-16;}}
.fx-appear{animation:fx-in .45s cubic-bezier(.2,.8,.2,1) both;}
@keyframes fx-in{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:none;}}
@media (prefers-reduced-motion: reduce){.fx-packet,.fx-reticle,.fx-cursor,.fx-appear{animation:none;}.fx-node,.fx-trace,.fx-packet{transition:none;}}
`;
}
