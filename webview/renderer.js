import mermaid from 'mermaid';

let queue = Promise.resolve();
let counter = 0;

/**
 * Resolves the Mermaid theme to use for a setting value.
 * @param {string} setting  'auto' | Mermaid theme name
 */
export function resolveTheme(setting) {
    if (setting && setting !== 'auto') return setting;
    const classes = document.body.classList;
    if (classes.contains('vscode-high-contrast-light') || classes.contains('vscode-light')) return 'default';
    if (classes.contains('vscode-high-contrast') || classes.contains('vscode-dark')) return 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';
}

function fontFamily() {
    const value = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim();
    return value || '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
}

/**
 * Renders a Mermaid definition to SVG markup. Calls are serialized because
 * Mermaid keeps global state while rendering.
 *
 * @param {string} code
 * @param {string} theme
 * @returns {Promise<string>}
 */
export function renderMermaid(code, theme) {
    const run = async () => {
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme,
            fontFamily: fontFamily(),
            // SVG text labels (no <foreignObject>) keep PNG export possible.
            htmlLabels: false,
            // Labels are already wrapped by the extension: a wider wrapping width keeps Mermaid from re-wrapping them.
            flowchart: { htmlLabels: false, useMaxWidth: false, curve: 'basis', padding: 12, nodeSpacing: 40, rankSpacing: 48, wrappingWidth: 480 }
        });
        const id = `flowchart-svg-${++counter}`;
        try {
            const { svg } = await mermaid.render(id, code);
            return svg;
        } finally {
            // Mermaid may leave a temporary container behind when rendering fails.
            const leftover = document.getElementById(`d${id}`);
            if (leftover) leftover.remove();
        }
    };
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
}

/**
 * Extracts the flowchart node id (e.g. "n12") from a rendered node element.
 * @param {Element} element
 */
export function nodeIdOf(element) {
    const dataId = element.getAttribute('data-id');
    if (dataId) return dataId;
    const match = /-flowchart-(n\d+)-\d+$/.exec(element.id || '');
    return match ? match[1] : undefined;
}
