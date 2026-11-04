/**
 * Shapes and edge paths of the native renderer, in plain SVG path syntax.
 */

const r1 = (n) => Math.round(n * 10) / 10;

function polygon(points) {
    return `M${points.map(([x, y]) => `${r1(x)},${r1(y)}`).join(' L')} Z`;
}

function roundedRect(w, h, r) {
    const k = Math.min(r, h / 2, w / 2);
    return `M${r1(k)},0 H${r1(w - k)} Q${r1(w)},0 ${r1(w)},${r1(k)} V${r1(h - k)} Q${r1(w)},${r1(h)} ${r1(w - k)},${r1(h)} `
        + `H${r1(k)} Q0,${r1(h)} 0,${r1(h - k)} V${r1(k)} Q0,0 ${r1(k)},0 Z`;
}

function stadium(w, h) {
    const k = h / 2;
    return `M${r1(k)},0 H${r1(w - k)} A${r1(k)},${r1(k)} 0 0 1 ${r1(w - k)},${r1(h)} H${r1(k)} A${r1(k)},${r1(k)} 0 0 1 ${r1(k)},0 Z`;
}

/**
 * Classic flowchart symbols (ISO 5807): terminator, process, decision diamond,
 * preparation hexagon (loops), predefined process (try / catch / definitions), connector.
 * @returns {{ outline: string, detail?: string }}
 */
export function classicShape(kind, w, h, meta = {}) {
    switch (kind) {
        case 'start':
        case 'end':
        case 'return':
            return { outline: stadium(w, h) };
        case 'decision':
            return { outline: polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) };
        case 'loop': {
            const k = h / 2;
            return { outline: polygon([[k, 0], [w - k, 0], [w, h / 2], [w - k, h], [k, h], [0, h / 2]]) };
        }
        case 'junction':
            if (meta.subtype === 'finallyEnd') return { outline: stadium(w, h) };
            return { outline: `M${r1(w / 2)},0 A${r1(w / 2)},${r1(h / 2)} 0 0 1 ${r1(w / 2)},${r1(h)} A${r1(w / 2)},${r1(h / 2)} 0 0 1 ${r1(w / 2)},0 Z` };
        case 'try':
        case 'catch':
        case 'finally':
            return { outline: roundedRect(w, h, 3), detail: `M12,0 V${r1(h)} M${r1(w - 12)},0 V${r1(h)}` };
        case 'throw':
            return { outline: roundedRect(w, h, 3) };
        default:
            if (meta.declaration) return { outline: roundedRect(w, h, 3), detail: `M12,0 V${r1(h)} M${r1(w - 12)},0 V${r1(h)}` };
            return { outline: roundedRect(w, h, 4) };
    }
}

/**
 * Orthogonal polyline → smooth path: every bend becomes a curve whose radius
 * grows with the available room, so short jogs read as S-curves.
 */
export function smoothPath(points, maxRadius = 26) {
    if (points.length < 2) return '';
    let d = `M${r1(points[0][0])},${r1(points[0][1])}`;
    for (let i = 1; i < points.length - 1; i++) {
        const [px, py] = points[i - 1];
        const [x, y] = points[i];
        const [nx, ny] = points[i + 1];
        const inLen = Math.hypot(x - px, y - py);
        const outLen = Math.hypot(nx - x, ny - y);
        const r = Math.min(maxRadius, inLen / 2, outLen / 2);
        if (r < 0.5) {
            d += ` L${r1(x)},${r1(y)}`;
            continue;
        }
        const ax = x - ((x - px) / inLen) * r;
        const ay = y - ((y - py) / inLen) * r;
        const bx = x + ((nx - x) / outLen) * r;
        const by = y + ((ny - y) / outLen) * r;
        d += ` L${r1(ax)},${r1(ay)} Q${r1(x)},${r1(y)} ${r1(bx)},${r1(by)}`;
    }
    const last = points[points.length - 1];
    return `${d} L${r1(last[0])},${r1(last[1])}`;
}

/** Outline of a node of size w × h at the origin. */
export function nodeShape(kind, w, h, meta = {}) {
    const c = Math.min(10, h / 3);
    switch (kind) {
        case 'start':
        case 'end': {
            const k = h / 2;
            return polygon([[k, 0], [w - k, 0], [w, h / 2], [w - k, h], [k, h], [0, h / 2]]);
        }
        case 'decision': {
            const k = Math.min(h / 2 + 6, 24);
            return polygon([[k, 0], [w - k, 0], [w, h / 2], [w - k, h], [k, h], [0, h / 2]]);
        }
        case 'loop': {
            const k = 7;
            return polygon([[k, 0], [w - k, 0], [w, k], [w, h - k], [w - k, h], [k, h], [0, h - k], [0, k]]);
        }
        case 'return': {
            const k = Math.min(14, h / 2);
            return polygon([[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h]]);
        }
        case 'throw': {
            const k = 8;
            return polygon([[0, 0], [w, 0], [w - k, h / 2], [w, h], [0, h], [k, h / 2]]);
        }
        case 'junction':
            if (meta.subtype === 'finallyEnd') {
                const k = h / 2;
                return polygon([[k, 0], [w - k, 0], [w, h / 2], [w - k, h], [k, h], [0, h / 2]]);
            }
            {
                // Octagon "via" (a junction on a circuit board).
                const k = Math.min(w, h) * 0.29;
                return polygon([[k, 0], [w - k, 0], [w, k], [w, h - k], [w - k, h], [k, h], [0, h - k], [0, k]]);
            }
        case 'try':
        case 'catch':
        case 'finally':
            return polygon([[c, 0], [w, 0], [w, h], [0, h], [0, c]]);
        default:
            // Statement panel: chamfered top-left and bottom-right corners.
            return polygon([[c, 0], [w, 0], [w, h - c], [w - c, h], [0, h], [0, c]]);
    }
}

/** HUD corner brackets around a box (used for flows and the selection reticle). */
export function cornerBrackets(x, y, w, h, size = 10) {
    const s = size;
    return [
        `M${x},${y + s} L${x},${y} L${x + s},${y}`,
        `M${x + w - s},${y} L${x + w},${y} L${x + w},${y + s}`,
        `M${x + w},${y + h - s} L${x + w},${y + h} L${x + w - s},${y + h}`,
        `M${x + s},${y + h} L${x},${y + h} L${x},${y + h - s}`
    ].join(' ');
}

/**
 * Orthogonal polyline → path with 45° chamfered bends, like a PCB trace.
 * @param {number[][]} points
 */
export function tracePath(points, radius = 9) {
    if (points.length < 2) return '';
    let d = `M${r1(points[0][0])},${r1(points[0][1])}`;
    for (let i = 1; i < points.length - 1; i++) {
        const [px, py] = points[i - 1];
        const [x, y] = points[i];
        const [nx, ny] = points[i + 1];
        const inLen = Math.hypot(x - px, y - py);
        const outLen = Math.hypot(nx - x, ny - y);
        const r = Math.min(radius, inLen / 2, outLen / 2);
        if (r < 0.5) {
            d += ` L${r1(x)},${r1(y)}`;
            continue;
        }
        const ax = x - ((x - px) / inLen) * r;
        const ay = y - ((y - py) / inLen) * r;
        const bx = x + ((nx - x) / outLen) * r;
        const by = y + ((ny - y) / outLen) * r;
        d += ` L${r1(ax)},${r1(ay)} L${r1(bx)},${r1(by)}`;
    }
    const last = points[points.length - 1];
    return `${d} L${r1(last[0])},${r1(last[1])}`;
}

/** Smooth curve between two points (links between flows). */
export function curvePath([x1, y1], [x2, y2]) {
    // Horizontal S-curve: leaves to the right, arrives from the left.
    const dx = Math.max(50, Math.abs(x2 - x1) / 2);
    return `M${r1(x1)},${r1(y1)} C${r1(x1 + dx)},${r1(y1)} ${r1(x2 - dx)},${r1(y2)} ${r1(x2)},${r1(y2)}`;
}

/** Where to put an edge label: on the first segment, just after the source. */
export function labelPoint(points, at = 'start') {
    if (points.length < 2) return points[0] || [0, 0];
    if (at === 'lane' && points.length >= 4) {
        // Middle of the longest vertical run: the gutter lane of a bus.
        let best = null;
        for (let i = 0; i + 1 < points.length; i++) {
            const [a, b] = [points[i], points[i + 1]];
            if (Math.abs(a[0] - b[0]) < 0.5) {
                const len = Math.abs(b[1] - a[1]);
                if (!best || len > best.len) best = { len, x: a[0], y: (a[1] + b[1]) / 2 };
            }
        }
        if (best) return [best.x, best.y, best.len];
    }
    if (at === 'curve') {
        const [a, b] = [points[0], points[points.length - 1]];
        return [a[0] + Math.min(60, (b[0] - a[0]) / 2), a[1] + (b[1] - a[1]) * 0.12];
    }
    if (at === 'end') {
        // On the segment that enters the target, a little before the arrow.
        const a = points[points.length - 2];
        const b = points[points.length - 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const t = len > 50 ? 1 - 24 / len : 0.5;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    const [a, b] = points;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t = len > 60 ? 26 / len : 0.5;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
