/**
 * Visual themes of the native renderer. Each theme is a set of CSS custom
 * properties; the SVG carries its own <style>, so exported files look identical.
 */

export const THEMES = {
    classic: {
        '--fx-bg': 'var(--vscode-editor-background, #ffffff)',
        '--fx-bg-2': 'var(--vscode-editor-background, #ffffff)',
        '--fx-fg': 'var(--vscode-editor-foreground, #1f2328)',
        '--fx-grid': 'color-mix(in srgb, var(--fx-fg) 13%, transparent)',
        '--fx-frame': 'color-mix(in srgb, var(--fx-fg) 16%, transparent)',
        '--fx-frame-embedded': 'color-mix(in srgb, var(--fx-fg) 13%, transparent)',
        '--fx-frame-fill': 'color-mix(in srgb, var(--fx-fg) 2.5%, transparent)',
        '--fx-title': 'var(--fx-fg)',
        '--fx-text': 'var(--fx-fg)',
        '--fx-muted': 'var(--vscode-descriptionForeground, #6e7781)',
        '--fx-process': '#3b82f6',
        '--fx-start': '#22a06b',
        '--fx-end': '#7d8590',
        '--fx-decision': '#d98c0a',
        '--fx-loop': '#8b5cf6',
        '--fx-return': '#0e9f8e',
        '--fx-throw': '#e5534b',
        '--fx-try': '#e8833a',
        '--fx-junction': '#7d8590',
        '--fx-async': '#0e9f8e',
        '--fx-edge': 'color-mix(in srgb, var(--fx-fg) 52%, transparent)',
        '--fx-back': 'color-mix(in srgb, var(--fx-fg) 52%, transparent)',
        '--fx-exception': '#e5534b',
        '--fx-abrupt': '#8b5cf6',
        '--fx-callback': '#0e9f8e',
        '--fx-yes': '#22a06b',
        '--fx-no': '#e5534b',
        '--fx-fill-alpha': '1',
        '--fx-glow': '0',
        '--fx-font': "var(--vscode-editor-font-family, 'SF Mono', Menlo, Consolas, monospace)",
        '--fx-ui-font': "var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif)"
    },
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

/** What each style draws. */
export const LOOKS = {
    classic: { shapes: 'classic', edges: 'smooth', tags: false, lineNumbers: false, packets: false, chips: false, faintSecondary: true, fontSize: 13, lineHeight: 18 },
    cyberpunk: { shapes: 'compact', edges: 'trace', tags: true, lineNumbers: true, packets: true, chips: true, faintSecondary: false, fontSize: 12.5, lineHeight: 17 }
};

function classicStyles() {
    const vars = Object.entries(THEMES.classic).map(([k, v]) => `${k}:${v};`).join('');
    return `
.fx-root{${vars}font-family:var(--fx-font);}
.fx-bg{fill:var(--fx-bg);}
.fx-grid-dot{fill:var(--fx-grid);}
.fx-unit-frame{fill:var(--fx-frame-fill);stroke:var(--fx-frame);stroke-width:1;}
.fx-unit-frame.embedded{stroke-dasharray:5 4;}
.fx-unit-title{fill:var(--fx-text);font-family:var(--fx-ui-font);font-size:13px;font-weight:600;}
.fx-unit-kind{fill:var(--fx-muted);font-family:var(--fx-ui-font);font-size:10px;letter-spacing:.08em;}
.fx-node{cursor:pointer;}
.fx-node .fx-shape{stroke-width:1.5;fill:color-mix(in srgb, var(--c) 11%, var(--fx-bg));filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.16));transition:stroke-width .15s ease,filter .15s ease;}
.fx-node .fx-detail{fill:none;stroke:var(--c);stroke-width:1.2;opacity:.7;}
.fx-node .fx-text{fill:var(--fx-text);font-size:13px;}
.fx-node .fx-async{fill:var(--fx-async);font-family:var(--fx-ui-font);font-size:9.5px;font-style:italic;}
.fx-node:hover .fx-shape,.fx-node.hovered .fx-shape{stroke-width:2.2;filter:drop-shadow(0 3px 8px rgba(0,0,0,.22));}
.fx-node.unreachable{opacity:.5;}
.fx-node.unreachable .fx-shape{stroke-dasharray:5 4;}
.fx-node.dimmed{opacity:.28;}
.fx-edge.dimmed{opacity:.12;}
.fx-node{transition:opacity .2s ease,transform .38s cubic-bezier(.2,.8,.2,1);}
.fx-edge{transition:opacity .2s ease;}
.fx-trace{transition:d .38s cubic-bezier(.2,.8,.2,1);}
.fx-edge .fx-trace{fill:none;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round;}
.fx-edge.hovered .fx-trace{stroke-width:2.4;}
.fx-edge.secondary{opacity:.38;}
.fx-edge.secondary.hovered{opacity:1;}
.fx-edge.exception .fx-trace,.fx-edge.abrupt .fx-trace{stroke-dasharray:5 4;}
.fx-edge.callback .fx-trace{stroke-dasharray:1.5 4;stroke-linecap:round;stroke-width:1.6;}
.fx-edge-text{font-family:var(--fx-ui-font);font-size:11px;font-weight:600;}
.fx-reticle{fill:none;stroke:var(--vscode-focusBorder, #0969da);stroke-width:2;}
.fx-cursor{fill:none;stroke:var(--vscode-focusBorder, #0969da);stroke-width:2;stroke-dasharray:4 4;animation:fx-dash 1s linear infinite;}
@keyframes fx-dash{to{stroke-dashoffset:-16;}}
.fx-appear{animation:fx-in .35s ease-out both;}
@keyframes fx-in{from{opacity:0;}to{opacity:1;}}
@media (prefers-reduced-motion: reduce){.fx-cursor,.fx-appear{animation:none;}.fx-node,.fx-trace{transition:none;}}
`;
}

/** CSS embedded in the SVG (also used by exports). */
export function svgStyles(themeName) {
    if (themeName === 'classic' || !THEMES[themeName]) return classicStyles();
    const theme = THEMES[themeName];
    const vars = Object.entries(theme).map(([k, v]) => `${k}:${v};`).join('');
    const glow = 1;
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
