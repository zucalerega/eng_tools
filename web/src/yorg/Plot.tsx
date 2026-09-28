import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AxisSpec, Side } from "./layout";
import { trace, visibleRange, type Placement, type Samples } from "./samples";
import { formatDuration, formatTick, ticks } from "./scale";

// One plot: channels drawn over a time window on a canvas, with a y axis on either side. Everything that changes the
// view goes up to the workspace (which gives every plot the same window and cursor):
//   drag: zoom to the time you drag across; shift-drag: zoom to a box (time and values)
//   right-drag, middle-drag, or ctrl-drag: pan; drag on an axis: move it
//   wheel: zoom time around the pointer (on an axis: zoom it); shift-wheel or sideways: pan
//   double-click: show everything; right-click: a menu (marker, T0)

export interface PlotSeries {
    id: string;
    color: string;
    width: number;
    step: boolean;
    axis: Side;
    samples: Samples | null; // still loading
    placement: Placement;
    unit: string;
    labels: string[] | null; // a state's names, by value: the axis shows them
}

/** How the time axis is labeled: seconds, from T0, or times of day. */
export interface TimeAxis {
    ticks(from: number, to: number, count: number): { values: number[]; step: number };
    label(x: number, step: number): string;
}

export interface PlotMark {
    x: number;
    label: string;
    kind: "marker" | "event" | "t0";
}

export interface PlotColors {
    plot: string;
    grid: string;
    frame: string;
    text: string;
    cursor: string;
    selection: string;
    marker: string;
    event: string;
    t0: string;
    font: string;
}

export const LEFT_GUTTER = 70;
const RIGHT_GUTTER = 70;
const EDGE = 14;
const TOP = 8;
const BOTTOM = 24;

interface Geometry {
    width: number;
    height: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
}

type Ranges = Record<Side, [number, number] | null>;

interface Drag {
    mode: "zoom" | "box" | "pan" | "axis";
    side: Side;
    x0: number;
    y0: number;
    x: number;
    y: number;
    window: [number, number];
    range: [number, number] | null;
    moved: boolean;
}

interface Props {
    label: string;
    series: PlotSeries[];
    left: AxisSpec;
    right: AxisSpec;
    height: number;
    window: [number, number];
    time: TimeAxis;
    marks: PlotMark[];
    cursor: number | null;
    readouts: ReadonlyMap<string, { x: number; y: number } | null>;
    rightGutter: boolean; // every plot keeps room for a right axis if any has one, so their time axes line up
    colors: PlotColors;
    onCursor: (x: number | null) => void;
    onWindow: (window: [number, number] | null, remember: boolean) => void;
    onAxis: (side: Side, range: [number, number] | null) => void;
    onMenu: (x: number, clientX: number, clientY: number) => void;
}

/** What an axis shows: its fixed range, or what its channels have in view, with a little room around it. */
function axisRange(spec: AxisSpec, series: PlotSeries[], window: [number, number]): [number, number] | null {
    if (series.length === 0) {
        return null;
    }
    if (spec.min !== null && spec.max !== null && spec.max > spec.min) {
        return [spec.min, spec.max];
    }
    let low = Infinity;
    let high = -Infinity;
    for (const one of series) {
        const range = one.samples && visibleRange(one.samples, window[0], window[1], one.placement);
        if (range) {
            low = Math.min(low, range[0]);
            high = Math.max(high, range[1]);
        }
    }
    if (low > high) {
        return [0, 1];
    }
    if (spec.min !== null) {
        low = spec.min;
    }
    if (spec.max !== null) {
        high = spec.max;
    }
    const states = series.every((one) => one.labels);
    const room = states ? 0.3 : high > low ? (high - low) * 0.05 : Math.abs(low) * 0.05 || 1;
    return [spec.min ?? low - room, spec.max ?? high + room];
}

/** An axis's ticks: a state's names at whole numbers, when every channel on it is that state; else round numbers. */
function valueTicks(range: [number, number], series: PlotSeries[], count: number): { value: number; label: string }[] {
    const labels = series[0]?.labels;
    const sameStates = labels && series.every((one) => one.labels?.join("\n") === labels.join("\n"));
    const whole = Math.floor(range[1]) - Math.ceil(range[0]) + 1;
    if (sameStates && whole > 0 && whole <= Math.max(count, 2) * 2) {
        const found = [];
        for (let value = Math.ceil(range[0]); value <= range[1]; value++) {
            found.push({ value, label: labels[value] ?? String(value) });
        }
        return found;
    }
    const round = ticks(range[0], range[1], count);
    return round.values.map((value) => ({ value, label: formatTick(value, round.step) }));
}

const markColor = (mark: PlotMark, colors: PlotColors): string =>
    mark.kind === "t0" ? colors.t0 : mark.kind === "event" ? colors.event : colors.marker;

const unitsOf = (series: PlotSeries[]): string =>
    [...new Set(series.map((one) => one.unit).filter(Boolean))].join(", ");

/** Where the pointer is on the canvas, in the canvas's own pixels (the page may be zoomed or scaled around it). */
function pointerAt(canvas: HTMLElement, event: { clientX: number; clientY: number }): { px: number; py: number } {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvas.clientWidth / rect.width : 1;
    const scaleY = rect.height > 0 ? canvas.clientHeight / rect.height : 1;
    return { px: (event.clientX - rect.left) * scaleX, py: (event.clientY - rect.top) * scaleY };
}

function draw(
    canvas: HTMLCanvasElement,
    g: Geometry,
    props: Props,
    ranges: Ranges,
    titles: Record<Side, string>,
): void {
    const context = canvas.getContext("2d");
    if (!context || g.width <= 0) {
        return;
    }
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(g.width * ratio);
    canvas.height = Math.round(g.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, g.width, g.height);
    const { colors, window: view, time } = props;
    const plotWidth = g.right - g.left;
    const plotHeight = g.bottom - g.top;
    const toX = (x: number) => g.left + ((x - view[0]) / (view[1] - view[0])) * plotWidth;
    context.fillStyle = colors.plot;
    context.fillRect(g.left, g.top, plotWidth, plotHeight);
    context.font = `11px ${colors.font}`;
    context.lineWidth = 1;

    // Time: grid lines, and their labels under the plot.
    const timeTicks = time.ticks(view[0], view[1], Math.max(2, Math.floor(plotWidth / 110)));
    context.strokeStyle = colors.grid;
    context.beginPath();
    for (const x of timeTicks.values) {
        const at = Math.round(toX(x)) + 0.5;
        context.moveTo(at, g.top);
        context.lineTo(at, g.bottom);
    }
    context.stroke();
    context.fillStyle = colors.text;
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const x of timeTicks.values) {
        context.fillText(time.label(x, timeTicks.step), toX(x), g.bottom + 6);
    }

    // Values: the left axis draws the grid (or the right, if it's alone); each labels its own side.
    const gridSide: Side = ranges.left ? "left" : "right";
    for (const side of ["left", "right"] as const) {
        const range = ranges[side];
        if (!range) {
            continue;
        }
        const toY = (y: number) => g.bottom - ((y - range[0]) / (range[1] - range[0])) * plotHeight;
        const marks = valueTicks(
            range,
            props.series.filter((one) => one.axis === side),
            Math.max(2, Math.floor(plotHeight / 40)),
        );
        if (side === gridSide) {
            context.strokeStyle = colors.grid;
            context.beginPath();
            for (const { value } of marks) {
                const at = Math.round(toY(value)) + 0.5;
                context.moveTo(g.left, at);
                context.lineTo(g.right, at);
            }
            context.stroke();
        }
        context.fillStyle = colors.text;
        context.textAlign = side === "left" ? "right" : "left";
        context.textBaseline = "middle";
        for (const { value, label } of marks) {
            context.fillText(label, side === "left" ? g.left - 6 : g.right + 6, toY(value), LEFT_GUTTER - 20);
        }
        if (titles[side]) {
            context.save();
            context.translate(side === "left" ? 9 : g.width - 9, (g.top + g.bottom) / 2);
            context.rotate(side === "left" ? -Math.PI / 2 : Math.PI / 2);
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(titles[side], 0, 0, plotHeight);
            context.restore();
        }
    }

    // Markers, events, and T0, behind the data. Labels that would overlap go on the next line down.
    context.save();
    context.beginPath();
    context.rect(g.left, g.top, plotWidth, plotHeight);
    context.clip();
    const shown = props.marks.filter((mark) => mark.x >= view[0] && mark.x <= view[1]).sort((a, b) => a.x - b.x);
    const lineEnds: number[] = []; // where each line of labels is taken up to
    context.font = `600 11px ${colors.font}`;
    context.textAlign = "left";
    context.textBaseline = "top";
    for (const mark of shown) {
        const at = Math.round(toX(mark.x)) + 0.5;
        context.strokeStyle = markColor(mark, colors);
        context.setLineDash(mark.kind === "t0" ? [] : [4, 3]);
        context.beginPath();
        context.moveTo(at, g.top);
        context.lineTo(at, g.bottom);
        context.stroke();
    }
    context.setLineDash([]);
    for (const mark of shown) {
        if (!mark.label) {
            continue;
        }
        const at = Math.round(toX(mark.x)) + 0.5;
        const width = context.measureText(mark.label).width + 8;
        let line = lineEnds.findIndex((end) => end + 3 <= at);
        if (line < 0) {
            line = lineEnds.length;
        }
        if (g.top + 1 + (line + 1) * 17 > g.bottom) {
            continue; // no room left: the line's still there
        }
        lineEnds[line] = at + width + 1;
        const top = g.top + 1 + line * 17;
        context.fillStyle = colors.plot;
        context.fillRect(at + 1, top, width, 16);
        context.fillStyle = markColor(mark, colors);
        context.fillText(mark.label, at + 5, top + 2);
    }
    context.setLineDash([]);

    // The data.
    for (const one of props.series) {
        const range = ranges[one.axis];
        if (!one.samples || !range) {
            continue;
        }
        const toY = (y: number) => g.bottom - ((y - range[0]) / (range[1] - range[0])) * plotHeight;
        const points = trace(one.samples, view[0], view[1], plotWidth, one.placement);
        context.strokeStyle = one.color;
        context.lineWidth = one.width;
        context.lineJoin = "round";
        context.beginPath();
        let down = false;
        let lastY = 0;
        let spacing = Infinity;
        let lastX = NaN;
        for (let i = 0; i < points.length; i++) {
            const value = points.y[i]!;
            if (Number.isNaN(value)) {
                down = false;
                continue;
            }
            const x = toX(points.x[i]!);
            const y = toY(value);
            if (!down) {
                context.moveTo(x, y);
                down = true;
            } else {
                if (one.step) {
                    context.lineTo(x, lastY);
                }
                context.lineTo(x, y);
                spacing = Math.min(spacing, x - lastX);
            }
            lastX = x;
            lastY = y;
        }
        context.stroke();
        // Far enough apart to tell one sample from the next: show where each one is.
        if (points.raw && spacing > 7) {
            context.fillStyle = one.color;
            for (let i = 0; i < points.length; i++) {
                const value = points.y[i]!;
                if (!Number.isNaN(value)) {
                    context.beginPath();
                    context.arc(toX(points.x[i]!), toY(value), Math.max(2, one.width + 0.5), 0, 2 * Math.PI);
                    context.fill();
                }
            }
        }
    }
    context.restore();
    context.lineWidth = 1;
    context.strokeStyle = colors.frame;
    context.strokeRect(g.left + 0.5, g.top + 0.5, plotWidth - 1, plotHeight - 1);
}

function drawOverlay(canvas: HTMLCanvasElement, g: Geometry, props: Props, ranges: Ranges, drag: Drag | null): void {
    const context = canvas.getContext("2d");
    if (!context || g.width <= 0) {
        return;
    }
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(g.width * ratio) || canvas.height !== Math.round(g.height * ratio)) {
        canvas.width = Math.round(g.width * ratio);
        canvas.height = Math.round(g.height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, g.width, g.height);
    const { colors, window: view, cursor } = props;
    const toX = (x: number) => g.left + ((x - view[0]) / (view[1] - view[0])) * (g.right - g.left);

    if (drag && (drag.mode === "zoom" || drag.mode === "box") && drag.moved) {
        const x = Math.min(drag.x0, drag.x);
        const width = Math.abs(drag.x - drag.x0);
        const y = drag.mode === "box" ? Math.min(drag.y0, drag.y) : g.top;
        const height = drag.mode === "box" ? Math.abs(drag.y - drag.y0) : g.bottom - g.top;
        context.fillStyle = colors.selection;
        context.fillRect(x, y, width, height);
        context.strokeStyle = colors.cursor;
        context.strokeRect(x + 0.5, y + 0.5, width, height);
        const span = (width / (g.right - g.left)) * (view[1] - view[0]);
        context.font = `600 11px ${colors.font}`;
        context.fillStyle = colors.cursor;
        context.textAlign = "center";
        context.textBaseline = "bottom";
        context.fillText(`Δ ${formatDuration(span)}`, x + width / 2, y - 2 > g.top + 12 ? y - 2 : y + 14);
    }

    if (cursor === null || cursor < view[0] || cursor > view[1]) {
        return;
    }
    const at = Math.round(toX(cursor)) + 0.5;
    context.strokeStyle = colors.cursor;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(at, g.top);
    context.lineTo(at, g.bottom);
    context.stroke();
    for (const one of props.series) {
        const point = props.readouts.get(one.id);
        const range = ranges[one.axis];
        if (!point || !range || Number.isNaN(point.y)) {
            continue;
        }
        const y = g.bottom - ((point.y - range[0]) / (range[1] - range[0])) * (g.bottom - g.top);
        if (y < g.top || y > g.bottom) {
            continue;
        }
        context.beginPath();
        context.arc(toX(point.x), y, 3.5, 0, 2 * Math.PI);
        context.fillStyle = one.color;
        context.fill();
        context.strokeStyle = colors.plot;
        context.lineWidth = 1.5;
        context.stroke();
    }
}

export function Plot(props: Props) {
    const box = useRef<HTMLDivElement>(null);
    const base = useRef<HTMLCanvasElement>(null);
    const overlay = useRef<HTMLCanvasElement>(null);
    const drag = useRef<Drag | null>(null);
    const latest = useRef(props);
    latest.current = props;
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const element = box.current;
        if (!element) {
            return;
        }
        const measure = () => setWidth(element.clientWidth);
        measure();
        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", measure);
            return () => window.removeEventListener("resize", measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const geometry: Geometry = useMemo(
        () => ({
            width,
            height: props.height,
            left: LEFT_GUTTER,
            right: width - (props.rightGutter ? RIGHT_GUTTER : EDGE),
            top: TOP,
            bottom: props.height - BOTTOM,
        }),
        [width, props.height, props.rightGutter],
    );
    const bySide = useMemo(
        () => ({
            left: props.series.filter((one) => one.axis === "left"),
            right: props.series.filter((one) => one.axis === "right"),
        }),
        [props.series],
    );
    const ranges: Ranges = useMemo(
        () => ({
            left: axisRange(props.left, bySide.left, props.window),
            right: axisRange(props.right, bySide.right, props.window),
        }),
        [props.left, props.right, bySide, props.window],
    );
    const leftTitle = props.left.label || unitsOf(bySide.left);
    const rightTitle = props.right.label || unitsOf(bySide.right);
    const geometryRef = useRef(geometry);
    geometryRef.current = geometry;
    const rangesRef = useRef(ranges);
    rangesRef.current = ranges;

    useEffect(() => {
        if (base.current) {
            draw(base.current, geometry, latest.current, ranges, { left: leftTitle, right: rightTitle });
        }
    }, [geometry, ranges, leftTitle, rightTitle, props.series, props.window, props.marks, props.time, props.colors]);

    useEffect(() => {
        if (overlay.current) {
            drawOverlay(overlay.current, geometry, latest.current, ranges, drag.current);
        }
    }, [geometry, ranges, props.cursor, props.readouts, props.series, props.window, props.colors]);

    // The wheel zooms, so the page mustn't scroll: that needs a listener that isn't passive, which React's aren't.
    useEffect(() => {
        const canvas = overlay.current;
        if (!canvas) {
            return;
        }
        const wheel = (event: WheelEvent) => {
            const current = latest.current;
            const g = geometryRef.current;
            const { px, py } = pointerAt(canvas, event);
            const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
            const dx = event.deltaX * lines;
            const dy = event.deltaY * lines;
            event.preventDefault();
            const [start, end] = current.window;
            const span = end - start;
            const onAxis: Side | null = px < g.left ? "left" : px > g.right ? "right" : null;
            const range = onAxis ? rangesRef.current[onAxis] : null;
            if (onAxis && range) {
                const factor = Math.exp(dy * 0.002);
                const anchor = range[0] + ((g.bottom - py) / (g.bottom - g.top)) * (range[1] - range[0]);
                current.onAxis(onAxis, [anchor - (anchor - range[0]) * factor, anchor + (range[1] - anchor) * factor]);
            } else if (event.shiftKey || Math.abs(dx) > Math.abs(dy)) {
                const shift = ((event.shiftKey ? dy || dx : dx) / (g.right - g.left)) * span;
                current.onWindow([start + shift, end + shift], true);
            } else {
                const factor = Math.exp(dy * (event.ctrlKey ? 0.01 : 0.002));
                const anchor = start + ((px - g.left) / (g.right - g.left)) * span;
                current.onWindow([anchor - (anchor - start) * factor, anchor + (end - anchor) * factor], true);
            }
        };
        canvas.addEventListener("wheel", wheel, { passive: false });
        return () => canvas.removeEventListener("wheel", wheel);
    }, []);

    const place = (event: ReactPointerEvent<HTMLCanvasElement>) => pointerAt(event.currentTarget, event);
    const timeAt = (px: number) =>
        props.window[0] +
        ((px - geometry.left) / (geometry.right - geometry.left)) * (props.window[1] - props.window[0]);
    const valueAt = (range: [number, number], py: number) =>
        range[0] + ((geometry.bottom - py) / (geometry.bottom - geometry.top)) * (range[1] - range[0]);
    const redrawOverlay = () => {
        if (overlay.current) {
            drawOverlay(overlay.current, geometry, props, ranges, drag.current);
        }
    };

    function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
        const { px, py } = place(event);
        const onAxis: Side | null = px < geometry.left ? "left" : px > geometry.right ? "right" : null;
        const pan =
            event.button === 1 || event.button === 2 || (event.button === 0 && (event.ctrlKey || event.metaKey));
        if (!pan && event.button !== 0) {
            return;
        }
        const mode: Drag["mode"] = onAxis && ranges[onAxis] ? "axis" : pan ? "pan" : event.shiftKey ? "box" : "zoom";
        drag.current = {
            mode,
            side: onAxis ?? "left",
            x0: px,
            y0: py,
            x: px,
            y: py,
            window: props.window,
            range: onAxis ? ranges[onAxis] : null,
            moved: false,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    }

    function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
        const { px, py } = place(event);
        const current = drag.current;
        if (!current) {
            props.onCursor(px >= geometry.left && px <= geometry.right ? timeAt(px) : null);
            return;
        }
        current.x = px;
        current.y = py;
        if (!current.moved && Math.hypot(px - current.x0, py - current.y0) > 4) {
            current.moved = true;
            if (current.mode === "pan") {
                props.onWindow(current.window, true); // back to here, with Back
            }
        }
        if (!current.moved) {
            return;
        }
        if (current.mode === "pan") {
            const shift =
                (-(px - current.x0) / (geometry.right - geometry.left)) * (current.window[1] - current.window[0]);
            props.onWindow([current.window[0] + shift, current.window[1] + shift], false);
        } else if (current.mode === "axis" && current.range) {
            const [low, high] = current.range;
            const shift = ((py - current.y0) / (geometry.bottom - geometry.top)) * (high - low);
            props.onAxis(current.side, [low + shift, high + shift]);
        } else {
            props.onCursor(timeAt(px));
            redrawOverlay();
        }
    }

    function pointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
        const current = drag.current;
        drag.current = null;
        if (!current) {
            return;
        }
        const { px, py } = place(event);
        if (current.moved && (current.mode === "zoom" || current.mode === "box") && Math.abs(px - current.x0) > 4) {
            const [a, b] = [timeAt(current.x0), timeAt(px)];
            props.onWindow([Math.min(a, b), Math.max(a, b)], true);
            if (current.mode === "box" && Math.abs(py - current.y0) > 4) {
                for (const side of ["left", "right"] as const) {
                    const range = ranges[side];
                    if (range) {
                        const [c, d] = [valueAt(range, current.y0), valueAt(range, py)];
                        props.onAxis(side, [Math.min(c, d), Math.max(c, d)]);
                    }
                }
            }
        }
        // A right-click that didn't move opens the menu (here rather than on contextmenu, which some browsers send
        // when the button goes down, before anyone can tell a click from a drag).
        if (
            current.mode === "pan" &&
            !current.moved &&
            event.button === 2 &&
            px >= geometry.left &&
            px <= geometry.right
        ) {
            props.onMenu(timeAt(px), event.clientX, event.clientY);
        }
        redrawOverlay();
    }

    return (
        <div className="plot" ref={box} style={{ height: props.height }}>
            <canvas ref={base} className="plot-canvas" style={{ width: "100%", height: props.height }} />
            <canvas
                ref={overlay}
                className="plot-canvas plot-overlay"
                style={{ width: "100%", height: props.height }}
                role="img"
                aria-label={props.label}
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={() => {
                    drag.current = null;
                    redrawOverlay();
                }}
                onPointerLeave={() => {
                    if (!drag.current) {
                        props.onCursor(null);
                    }
                }}
                onDoubleClick={() => {
                    props.onWindow(null, true);
                    props.onAxis("left", null);
                    props.onAxis("right", null);
                }}
                onContextMenu={(event) => event.preventDefault()}
            />
        </div>
    );
}
