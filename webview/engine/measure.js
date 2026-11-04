/** Text measuring with a canvas, cached; the layout engine needs real text widths. */
let context = null;
const cache = new Map();

export function makeMeasure(fontFamily) {
    return (text, fontSize) => {
        const key = `${fontSize}|${text}`;
        if (cache.has(key)) return cache.get(key);
        if (!context) {
            const canvas = document.createElement('canvas');
            context = canvas.getContext('2d');
        }
        context.font = `${fontSize}px ${fontFamily}`;
        const width = context.measureText(String(text)).width;
        if (cache.size > 20000) cache.clear();
        cache.set(key, width);
        return width;
    };
}
