import {
    ARC,
    CAP,
    CLOSE,
    ELLIPSE,
    LINE,
    MOVE,
    type Color,
    type Drawing,
    type Geometry,
    type Label,
    type Point,
} from "./dxf";

// Caliper's 2D view: a DXF file's drawing on a canvas, apart from the page's React. Around it as in a CAD program: drag
// to pan, scroll to zoom where the mouse points, double-click to see it all; two fingers on a phone. Layers shown or
// hidden, and lines, arcs, circles, and corners picked to measure. It draws only when something changes: the drawing
// on one canvas, what's under the mouse and picked on another, over it.

export interface SheetEvents {
    hover(geometry: Geometry | null): void; // what would be picked, when measuring
    pick(geometry: Geometry): void; // a click, when measuring
}

const PIXELS_TO_POINT = 9; // how near the mouse a corner is picked instead of what it's on
const PIXELS_TO_LINE = 7;
// How much nearer a line must be than a circle or arc to be picked instead: a hole's center lines cross its edge, and
// it's the hole that's measured.
const PIXELS_FOR_ARCS = 2;
const HOVER_COLOR = "#3d8bfd";
const PICK_COLOR = "#e0a500";
const SMALLEST_TEXT = 1.5; // pixels high: smaller text isn't drawn

interface Batch {
    color: Color;
    path: Path2D;
    dash: number[] | null;
    weight: number; // mm
    width: number; // drawing units
}

interface Hatch {
    color: Color;
    area: Path2D;
    lines: Path2D | null; // null: solid
}

/** A layer's things to draw, ready for the canvas: in coordinates from the drawing's middle, which keeps them exact. */
interface Prepared {
    strokes: Batch[];
    hatches: Hatch[];
    labels: Label[];
    points: Point[];
}

/** A path's numbers (dxf.ts) as a canvas path, moved by -origin. */
function toPath2D(path: number[], origin: Point, into = new Path2D()): Path2D {
    const [ox, oy] = origin;
    for (let i = 0; i < path.length;) {
        switch (path[i]) {
            case MOVE:
                into.moveTo(path[i + 1]! - ox, path[i + 2]! - oy);
                i += 3;
                break;
            case LINE:
                into.lineTo(path[i + 1]! - ox, path[i + 2]! - oy);
                i += 3;
                break;
            case ARC:
                into.arc(
                    path[i + 1]! - ox,
                    path[i + 2]! - oy,
                    path[i + 3]!,
                    path[i + 4]!,
                    path[i + 5]!,
                    path[i + 6] === 1,
                );
                i += 7;
                break;
            case ELLIPSE:
                into.ellipse(
                    path[i + 1]! - ox,
                    path[i + 2]! - oy,
                    path[i + 3]!,
                    path[i + 4]!,
                    path[i + 5]!,
                    path[i + 6]!,
                    path[i + 7]!,
                    path[i + 8] === 1,
                );
                i += 9;
                break;
            case CLOSE:
                into.closePath();
                i += 1;
                break;
            default:
                return into; // not a path dxf.ts makes
        }
    }
    return into;
}

/** How far a point is from a segment. */
function toSegment(p: Point, a: Point, b: Point): number {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Whether an angle is on an arc that starts at start and goes counterclockwise by sweep. */
function onArc(angle: number, start: number, sweep: number): boolean {
    if (sweep >= 2 * Math.PI - 1e-12) {
        return true;
    }
    const along = (((angle - start) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return along <= sweep;
}

/** Where an arc starts and ends. */
export function arcEnds(arc: Extract<Geometry, { kind: "arc" }>): [Point, Point] {
    const at = (t: number): Point => [
        arc.center[0] + arc.radius * Math.cos(t),
        arc.center[1] + arc.radius * Math.sin(t),
    ];
    return [at(arc.start), at(arc.start + arc.sweep)];
}

/** How far a point is from a line, arc, or point. */
function distanceTo(p: Point, geometry: Geometry): number {
    switch (geometry.kind) {
        case "point":
            return Math.hypot(p[0] - geometry.at[0], p[1] - geometry.at[1]);
        case "line":
            return toSegment(p, geometry.a, geometry.b);
        case "arc": {
            const [dx, dy] = [p[0] - geometry.center[0], p[1] - geometry.center[1]];
            if (onArc(Math.atan2(dy, dx), geometry.start, geometry.sweep)) {
                return Math.abs(Math.hypot(dx, dy) - geometry.radius);
            }
            const [a, b] = arcEnds(geometry);
            return Math.min(Math.hypot(p[0] - a[0], p[1] - a[1]), Math.hypot(p[0] - b[0], p[1] - b[1]));
        }
    }
}

/** A color with enough contrast against the background to see: AutoCAD's yellow on white, its dark blue on black. */
function legible(color: string, dark: boolean): string {
    const match = /^#([0-9a-f]{6})$/i.exec(color);
    if (!match) {
        return color;
    }
    const value = parseInt(match[1]!, 16);
    let rgb = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => c / 255);
    const light = 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
    if (!dark && light > 0.6) {
        rgb = rgb.map((c) => (c * 0.45) / light); // darker, to a lightness of 0.45
    } else if (dark && light < 0.15) {
        const t = (0.3 - light) / (1 - light); // toward white, to a lightness of 0.3
        rgb = rgb.map((c) => c + (1 - c) * t);
    } else {
        return color;
    }
    return (
        "#" +
        rgb
            .map((c) =>
                Math.round(Math.min(1, Math.max(0, c)) * 255)
                    .toString(16)
                    .padStart(2, "0"),
            )
            .join("")
    );
}

export class SheetView {
    private readonly canvas: HTMLCanvasElement;
    private readonly overlay: HTMLCanvasElement;
    private readonly context: CanvasRenderingContext2D;
    private readonly marks: CanvasRenderingContext2D;
    private readonly label: HTMLDivElement; // the measurement, beside its line
    private readonly resize: ResizeObserver;
    private readonly cleanup: (() => void)[] = [];
    private drawing: Drawing | null = null;
    private prepared: Prepared[] = [];
    private origin: Point = [0, 0];
    private hidden = new Set<number>();
    private measuring = false;
    private hovered: Geometry | null = null;
    private picked: Geometry[] = [];
    private annotation: { line: [Point, Point]; text: string } | null = null;
    private readonly wrapped = new WeakMap<Label, string[]>();
    // The view: the drawing's point at the canvas's top left, and pixels to one of the drawing's units.
    private left = 0;
    private top = 0;
    private scale = 1;
    private fitted = true; // still showing it all, so it stays so as the view's size changes
    private frame = 0;
    private width = 0;
    private height = 0;

    /** Throws if the browser can't draw (no 2D canvas). */
    constructor(
        private readonly container: HTMLElement,
        private readonly events: SheetEvents,
    ) {
        this.canvas = document.createElement("canvas");
        this.overlay = document.createElement("canvas");
        const context = this.canvas.getContext("2d");
        const marks = this.overlay.getContext("2d");
        if (!context || !marks) {
            throw new Error("This browser can't draw on a canvas");
        }
        this.context = context;
        this.marks = marks;
        this.canvas.className = "caliper-canvas";
        this.overlay.className = "caliper-canvas caliper-sheet-marks";
        this.label = document.createElement("div");
        this.label.className = "caliper-annotation";
        this.label.hidden = true;
        container.append(this.canvas, this.overlay, this.label);
        this.resize = new ResizeObserver(() => this.fitCanvas());
        this.resize.observe(container);
        this.listen();
        this.fitCanvas();
    }

    dispose(): void {
        cancelAnimationFrame(this.frame);
        this.resize.disconnect();
        this.cleanup.forEach((undo) => undo());
        this.canvas.remove();
        this.overlay.remove();
        this.label.remove();
    }

    setDrawing(drawing: Drawing): void {
        this.drawing = drawing;
        const box = drawing.bounds;
        this.origin = box ? [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2] : [0, 0];
        this.prepared = drawing.layers.map(() => ({ strokes: [], hatches: [], labels: [], points: [] }));
        // One canvas path for each layer's strokes of a color, dashes, and weight: thousands of lines draw at once.
        const batches = new Map<string, Batch>();
        for (const stroke of drawing.strokes) {
            const key = [stroke.layer, stroke.color, stroke.dash?.join(","), stroke.weight, stroke.width].join("|");
            let batch = batches.get(key);
            if (!batch) {
                batch = {
                    color: stroke.color,
                    path: new Path2D(),
                    dash: stroke.dash,
                    weight: stroke.weight,
                    width: stroke.width,
                };
                batches.set(key, batch);
                this.prepared[stroke.layer]!.strokes.push(batch);
            }
            toPath2D(stroke.path, this.origin, batch.path);
        }
        for (const fill of drawing.fills) {
            const lines = fill.lines ? new Path2D() : null;
            for (let i = 0; lines && fill.lines && i + 3 < fill.lines.length; i += 4) {
                lines.moveTo(fill.lines[i]! - this.origin[0], fill.lines[i + 1]! - this.origin[1]);
                lines.lineTo(fill.lines[i + 2]! - this.origin[0], fill.lines[i + 3]! - this.origin[1]);
            }
            this.prepared[fill.layer]!.hatches.push({
                color: fill.color,
                area: toPath2D(fill.path, this.origin),
                lines,
            });
        }
        drawing.labels.forEach((label) => this.prepared[label.layer]!.labels.push(label));
        drawing.features.forEach(
            (feature) => feature.kind === "point" && this.prepared[feature.layer]!.points.push(feature.at),
        );
        this.fit();
    }

    setHiddenLayers(hidden: ReadonlySet<number>): void {
        this.hidden = new Set(hidden);
        this.request();
    }

    setMeasuring(on: boolean): void {
        this.measuring = on;
        this.canvas.style.cursor = on ? "crosshair" : "";
        this.overlay.style.cursor = on ? "crosshair" : "";
        if (!on) {
            this.setHover(null);
        }
        this.request();
    }

    setPicked(picked: Geometry[]): void {
        this.picked = picked;
        this.request();
    }

    setAnnotation(annotation: { line: [Point, Point]; text: string } | null): void {
        this.annotation = annotation;
        this.request();
    }

    /** Zoom to show it all. */
    fit(): void {
        const box = this.drawing?.bounds;
        this.fitted = true;
        if (!box || this.width === 0 || this.height === 0) {
            this.request();
            return;
        }
        const [w, h] = [Math.max(box.max[0] - box.min[0], 1e-9), Math.max(box.max[1] - box.min[1], 1e-9)];
        this.scale = Math.min(this.width / w, this.height / h) * 0.92;
        this.left = (box.min[0] + box.max[0]) / 2 - this.width / 2 / this.scale;
        this.top = (box.min[1] + box.max[1]) / 2 + this.height / 2 / this.scale;
        this.request();
    }

    /** Pixels to one of the drawing's units: how far in it is zoomed. */
    get zoom(): number {
        return this.scale;
    }

    // --- drawing -------------------------------------------------------------------------------------------------

    private fitCanvas(): void {
        const { clientWidth, clientHeight } = this.container;
        if (clientWidth === this.width && clientHeight === this.height) {
            return;
        }
        const ratio = window.devicePixelRatio || 1;
        for (const canvas of [this.canvas, this.overlay]) {
            canvas.width = Math.max(1, Math.round(clientWidth * ratio));
            canvas.height = Math.max(1, Math.round(clientHeight * ratio));
            canvas.style.width = `${clientWidth}px`;
            canvas.style.height = `${clientHeight}px`;
        }
        if (this.fitted || this.width === 0) {
            [this.width, this.height] = [clientWidth, clientHeight];
            this.fit();
        } else {
            // Keep the middle where it was.
            this.left += (this.width - clientWidth) / 2 / this.scale;
            this.top -= (this.height - clientHeight) / 2 / this.scale;
            [this.width, this.height] = [clientWidth, clientHeight];
            this.request();
        }
    }

    private request(): void {
        if (this.frame === 0) {
            this.frame = requestAnimationFrame(() => {
                this.frame = 0;
                this.draw();
            });
        }
    }

    /** The page's colors, as the theme has them: the sheet's background, and what AutoCAD's color 7 is on it. */
    private colors(): { paper: string; ink: string; dark: boolean } {
        const style = getComputedStyle(this.container);
        const paper = style.getPropertyValue("--caliper-sheet").trim() || "#ffffff";
        const ink = style.getPropertyValue("--caliper-ink").trim() || "#111111";
        return { paper, ink, dark: style.getPropertyValue("--caliper-sheet-dark").trim() === "1" };
    }

    /** From the drawing (less its origin) to the canvas's pixels. */
    private toCanvas(ratio: number): [number, number, number, number, number, number] {
        const s = this.scale * ratio;
        return [s, 0, 0, -s, (this.origin[0] - this.left) * s, (this.top - this.origin[1]) * s];
    }

    private draw(): void {
        const ratio = window.devicePixelRatio || 1;
        const context = this.context;
        const { paper, ink, dark } = this.colors();
        const shade = new Map<string, string>();
        const colorOf = (color: Color) => {
            if (color === null) {
                return ink;
            }
            let found = shade.get(color);
            if (!found) {
                found = legible(color, dark);
                shade.set(color, found);
            }
            return found;
        };
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = paper;
        context.fillRect(0, 0, this.canvas.width, this.canvas.height);
        context.setTransform(...this.toCanvas(ratio));
        const pixel = 1 / this.scale; // a pixel, in the drawing's units
        context.lineCap = "round";
        context.lineJoin = "round";
        this.prepared.forEach((layer, index) => {
            if (this.hidden.has(index)) {
                return;
            }
            for (const hatch of layer.hatches) {
                const color = colorOf(hatch.color);
                if (!hatch.lines) {
                    context.fillStyle = color;
                    context.fill(hatch.area, "evenodd");
                    continue;
                }
                context.save();
                context.clip(hatch.area, "evenodd");
                context.strokeStyle = color;
                context.lineWidth = pixel;
                context.setLineDash([]);
                context.stroke(hatch.lines);
                context.restore();
            }
            for (const batch of layer.strokes) {
                context.strokeStyle = colorOf(batch.color);
                // Heavier lines a little thicker, as plotted: up to three pixels.
                const pixels = batch.weight > 0.3 ? Math.min(3, batch.weight / 0.25) : 1;
                context.lineWidth = Math.max(batch.width, pixels * pixel);
                const period = batch.dash?.reduce((sum, d) => sum + d, 0) ?? 0;
                context.setLineDash(batch.dash && period * this.scale > 4 ? batch.dash : []);
                context.stroke(batch.path);
            }
            context.setLineDash([]);
            for (const point of layer.points) {
                context.fillStyle = ink;
                context.beginPath();
                context.arc(point[0] - this.origin[0], point[1] - this.origin[1], 1.5 * pixel, 0, 2 * Math.PI);
                context.fill();
            }
            for (const label of layer.labels) {
                this.drawLabel(label, colorOf(label.color));
            }
        });
        this.drawMarks(ratio);
    }

    private drawLabel(label: Label, color: string): void {
        const m = label.matrix;
        const up = Math.hypot(m[2], m[3]); // the text's own units, up, in the drawing's
        if (label.height * up * this.scale < SMALLEST_TEXT) {
            return;
        }
        const context = this.context;
        context.save();
        context.transform(m[0], m[1], m[2], m[3], m[4] - this.origin[0], m[5] - this.origin[1]);
        context.fillStyle = color;
        context.font = `100px ${label.font}`;
        context.textAlign = label.align;
        context.textBaseline = "alphabetic";
        const k = label.height / CAP / 100; // the font is drawn at 100 px, scaled to its height
        const lines = label.wrap > 0 ? this.wrap(label, k) : label.lines;
        lines.forEach((line, i) => {
            context.save();
            context.translate(0, label.top - i * label.spacing);
            context.scale(k, -k);
            if (label.fit > 0) {
                const width = context.measureText(line).width;
                if (width > 0) {
                    context.scale(label.fit / k / width, 1);
                }
            }
            context.fillText(line, 0, 0);
            context.restore();
        });
        context.restore();
    }

    /** MTEXT's lines, wrapped at its width, as AutoCAD wraps them: between words. Kept once worked out. */
    private wrap(label: Label, k: number): string[] {
        const kept = this.wrapped.get(label);
        if (kept) {
            return kept;
        }
        const width = (text: string) => this.context.measureText(text).width * k;
        const out: string[] = [];
        for (const line of label.lines) {
            let current = "";
            for (const word of line.split(" ")) {
                const tried = current ? `${current} ${word}` : word;
                if (current && width(tried) > label.wrap * 1.001) {
                    out.push(current);
                    current = word;
                } else {
                    current = tried;
                }
            }
            out.push(current);
        }
        this.wrapped.set(label, out);
        return out;
    }

    /** What's under the mouse and what's picked, and the measurement's line, over the drawing. */
    private drawMarks(ratio: number): void {
        const marks = this.marks;
        marks.setTransform(1, 0, 0, 1, 0, 0);
        marks.clearRect(0, 0, this.overlay.width, this.overlay.height);
        marks.setTransform(...this.toCanvas(ratio));
        const pixel = 1 / this.scale;
        const mark = (geometry: Geometry, color: string) => {
            marks.strokeStyle = color;
            marks.fillStyle = color;
            marks.lineWidth = 3 * pixel;
            marks.beginPath();
            const [ox, oy] = this.origin;
            if (geometry.kind === "point") {
                marks.arc(geometry.at[0] - ox, geometry.at[1] - oy, 4 * pixel, 0, 2 * Math.PI);
                marks.fill();
                return;
            }
            if (geometry.kind === "line") {
                marks.moveTo(geometry.a[0] - ox, geometry.a[1] - oy);
                marks.lineTo(geometry.b[0] - ox, geometry.b[1] - oy);
            } else {
                const { center, radius, start, sweep } = geometry;
                marks.arc(center[0] - ox, center[1] - oy, radius, start, start + sweep);
            }
            marks.stroke();
        };
        this.picked.forEach((geometry) => mark(geometry, PICK_COLOR));
        if (this.hovered && this.measuring) {
            mark(this.hovered, HOVER_COLOR);
        }
        const annotation = this.annotation;
        this.label.hidden = !annotation;
        if (annotation) {
            const [a, b] = annotation.line;
            marks.strokeStyle = PICK_COLOR;
            marks.lineWidth = 1.5 * pixel;
            marks.setLineDash([6 * pixel, 4 * pixel]);
            marks.beginPath();
            marks.moveTo(a[0] - this.origin[0], a[1] - this.origin[1]);
            marks.lineTo(b[0] - this.origin[0], b[1] - this.origin[1]);
            marks.stroke();
            marks.setLineDash([]);
            const [x, y] = this.toScreen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
            this.label.textContent = annotation.text;
            this.label.style.left = `${x}px`;
            this.label.style.top = `${y}px`;
        }
    }

    // --- the view and the mouse --------------------------------------------------------------------------------------

    private toScreen(p: Point): Point {
        return [(p[0] - this.left) * this.scale, (this.top - p[1]) * this.scale];
    }

    private toDrawing(event: { clientX: number; clientY: number }): Point {
        const box = this.canvas.getBoundingClientRect();
        return [this.left + (event.clientX - box.left) / this.scale, this.top - (event.clientY - box.top) / this.scale];
    }

    private pan(dx: number, dy: number): void {
        this.fitted = false;
        this.left -= dx / this.scale;
        this.top += dy / this.scale;
        this.request();
    }

    /** Zoom by a factor, keeping the point under the mouse where it is. */
    private zoomAt(factor: number, at: Point): void {
        const scale = Math.min(Math.max(this.scale * factor, 1e-9), 1e9);
        this.fitted = false;
        this.left = at[0] - ((at[0] - this.left) * this.scale) / scale;
        this.top = at[1] + ((this.top - at[1]) * this.scale) / scale;
        this.scale = scale;
        this.request();
    }

    /** What would be picked at the mouse: a corner (an end of a line or arc, or a point) near it; else the line or arc. */
    private geometryAt(event: { clientX: number; clientY: number }): Geometry | null {
        const drawing = this.drawing;
        if (!drawing) {
            return null;
        }
        const p = this.toDrawing(event);
        // The nearest corner, and the nearest line or arc (arcs a little nearer), each as near as a few pixels.
        const best: { corner: Point | null; cornerAway: number; nearest: Geometry | null; nearestAway: number } = {
            corner: null,
            cornerAway: PIXELS_TO_POINT,
            nearest: null,
            nearestAway: PIXELS_TO_LINE,
        };
        const consider = (at: Point) => {
            const distance = Math.hypot(p[0] - at[0], p[1] - at[1]) * this.scale;
            if (distance <= best.cornerAway) {
                [best.corner, best.cornerAway] = [at, distance];
            }
        };
        for (const feature of drawing.features) {
            if (this.hidden.has(feature.layer)) {
                continue;
            }
            if (feature.kind === "point") {
                consider(feature.at);
                continue;
            }
            const distance = distanceTo(p, feature) * this.scale;
            if (distance > PIXELS_TO_POINT + PIXELS_TO_LINE) {
                continue;
            }
            const ends =
                feature.kind === "line" ? [feature.a, feature.b] : feature.sweep < 2 * Math.PI ? arcEnds(feature) : [];
            ends.forEach(consider);
            const away = feature.kind === "arc" ? distance - PIXELS_FOR_ARCS : distance;
            if (distance <= PIXELS_TO_LINE && away <= best.nearestAway) {
                [best.nearest, best.nearestAway] = [feature, away];
            }
        }
        return best.corner ? { kind: "point", at: best.corner } : best.nearest;
    }

    private setHover(geometry: Geometry | null): void {
        if (geometry === this.hovered) {
            return;
        }
        this.hovered = geometry;
        this.events.hover(geometry);
        this.request();
    }

    private listen(): void {
        const target = this.overlay;
        const down = new Map<number, { x: number; y: number }>();
        let dragging = false;
        let start = { x: 0, y: 0 };
        let pinch = 0;
        let pending: PointerEvent | null = null;
        const on = <K extends keyof HTMLElementEventMap>(
            name: K,
            handler: (event: HTMLElementEventMap[K]) => void,
            options?: AddEventListenerOptions,
        ) => {
            target.addEventListener(name, handler, options);
            this.cleanup.push(() => target.removeEventListener(name, handler, options));
        };

        on("contextmenu", (event) => event.preventDefault());
        on("pointerdown", (event) => {
            target.setPointerCapture(event.pointerId);
            down.set(event.pointerId, { x: event.clientX, y: event.clientY });
            start = { x: event.clientX, y: event.clientY };
            dragging = false;
        });
        on("pointermove", (event) => {
            const last = down.get(event.pointerId);
            if (!last) {
                // Hovering: what would be picked, once a frame at most.
                if (this.measuring) {
                    if (pending === null) {
                        requestAnimationFrame(() => {
                            const latest = pending;
                            pending = null;
                            if (latest) {
                                this.setHover(this.geometryAt(latest));
                            }
                        });
                    }
                    pending = event;
                }
                return;
            }
            if (!dragging && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3) {
                dragging = true;
                this.setHover(null);
            }
            if (!dragging) {
                return;
            }
            const [dx, dy] = [event.clientX - last.x, event.clientY - last.y];
            down.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (down.size === 2) {
                // Two fingers: pinch to zoom, move to pan.
                const [a, b] = [...down.values()] as [{ x: number; y: number }, { x: number; y: number }];
                const spread = Math.hypot(a.x - b.x, a.y - b.y);
                if (pinch > 0) {
                    this.zoomAt(spread / pinch, this.toDrawing({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }));
                }
                pinch = spread;
                this.pan(dx / 2, dy / 2);
            } else {
                this.pan(dx, dy);
            }
        });
        const up = (event: PointerEvent) => {
            const wasDown = down.delete(event.pointerId);
            pinch = 0;
            if (!wasDown || dragging || event.button !== 0 || !this.measuring) {
                return;
            }
            const picked = this.geometryAt(event);
            if (picked) {
                this.events.pick(picked);
            }
        };
        on("pointerup", up);
        on("pointercancel", (event) => (down.delete(event.pointerId), (pinch = 0)));
        on("pointerleave", () => {
            if (this.measuring && down.size === 0) {
                pending = null;
                this.setHover(null);
            }
        });
        on(
            "wheel",
            (event) => {
                event.preventDefault();
                const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
                this.zoomAt(Math.exp(-pixels * 0.0015), this.toDrawing(event));
            },
            { passive: false },
        );
        on("dblclick", () => {
            if (!this.measuring) {
                this.fit();
            }
        });
    }
}
