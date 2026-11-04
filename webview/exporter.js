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
