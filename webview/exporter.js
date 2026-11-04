/**
 * Serializes a rendered SVG element into a standalone SVG document,
 * painting the current editor background behind it so it stays readable.
 * @param {SVGSVGElement} svg
 * @param {string} background
 */
export function toSvgMarkup(svg, background) {
    const clone = svg.cloneNode(true);
    const box = svg.viewBox.baseVal;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(Math.ceil(box.width)));
    clone.setAttribute('height', String(Math.ceil(box.height)));
    clone.removeAttribute('style');
    clone.querySelectorAll('[tabindex]').forEach((n) => n.removeAttribute('tabindex'));
    clone.querySelectorAll('[role="button"]').forEach((n) => n.removeAttribute('role'));
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(box.x));
    rect.setAttribute('y', String(box.y));
    rect.setAttribute('width', String(box.width));
    rect.setAttribute('height', String(box.height));
    rect.setAttribute('fill', background);
    clone.insertBefore(rect, clone.firstChild);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/**
 * Rasterizes SVG markup into a PNG data URL.
 * @param {string} markup
 * @param {number} scale
 * @returns {Promise<string>}
 */
export function toPngDataUrl(markup, width, height, scale = 2) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = Math.ceil(width * scale);
                canvas.height = Math.ceil(height * scale);
                const context = canvas.getContext('2d');
                context.scale(scale, scale);
                context.drawImage(image, 0, 0, width, height);
                resolve(canvas.toDataURL('image/png'));
            } catch (error) {
                reject(error);
            }
        };
        image.onerror = () => reject(new Error('The flowchart image could not be rasterized.'));
        const bytes = new TextEncoder().encode(markup);
        let binary = '';
        bytes.forEach((b) => { binary += String.fromCharCode(b); });
        image.src = `data:image/svg+xml;base64,${btoa(binary)}`;
    });
}

export function editorBackground() {
    const value = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
    return value || '#ffffff';
}
