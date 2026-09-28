import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AxisSpec, Note, Side } from "./layout";
import type { Runs } from "./masks";
import { sampleAt, trace, visibleRange, type Placement, type Samples } from "./samples";
import { formatDuration, formatTick, ticks } from "./scale";

// One plot: channels drawn over a time window on a canvas, with a y axis on either side. Everything that changes the
// view goes up to the workspace (which gives every plot the same window and cursor):
//   drag: zoom to the time you drag across; shift-drag: zoom to a box (time and values)
//   right-drag, middle-drag, or ctrl-drag: pan; drag on an axis: move it (a plot has an axis for each unit, or as
//   many as it's given, from the plot out on either side)
//   wheel: zoom time around the pointer (on an axis: zoom it); shift-wheel or sideways: pan
//   double-click: show everything; right-click: a menu (marker, label, T0)
//   drag a marker (its line or label) to move it; drag a label to move it, or its arrow's tip to point elsewhere;
//   double-click a label to change it. While placing a label (or T0, or a measurement's points), a click puts it
//   there.

export interface PlotSeries {
    id: string;
    color: string;
    width: number;
    step: boolean;
    axis: string; // its value axis's id
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
    id?: string; // a marker you can drag
}

/** Where a mask holds, shaded: its runs (in its dataset's time: shift puts them on the time axis), in its color. */
export interface Shading {
    runs: Runs;
    shift: number;
    color: string;
}

/** A place in a plot's data: a time, and a value on one of its axes. */
export interface Anchor {
    t: number;
    y: number;
    axis: string;
}

/** A measurement between two points: where they are (the second, once it's clicked), and what it says. */
export interface Measurement {
    a: Anchor;
    b: Anchor | null;
    lines: string[];
    color: string;
}

/** What a right-click was on: a place (if the plot has an axis to say what value), and maybe a label or marker. */
export interface MenuTarget {
    anchor: Anchor | null;
    note: string | null;
    marker: string | null;
}

interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Where a label was drawn: its box, and the point its arrow ends at. */
export interface NoteHit {
    id: string;
    box: Box;
    tip: { x: number; y: number };
    lines: string[];
}

interface Hits {
    notes: NoteHit[];
    marks: { id: string; x: number; chip: Box | null }[];
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

export const AXIS_WIDTH = 66; // each value axis's room beside the plot: its numbers, and its title
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

type Ranges = ReadonlyMap<string, [number, number]>; // by axis: those with something to show

interface Drag {
    mode: "zoom" | "box" | "pan" | "axis" | "note" | "tip" | "mark";
    target: string | null; // the label or marker being moved
    offset: { dx: number; dy: number }; // a label's, when it was picked up
    center: { x: number; y: number } | null; // its box's, when its arrow's tip was picked up
    axis: string | null; // the value axis being moved
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
    axes: AxisSpec[];
    height: number;
    window: [number, number];
    time: TimeAxis;
    marks: PlotMark[];
    shading: Shading[];
    cursor: number | null;
    readouts: ReadonlyMap<string, { x: number; y: number } | null>;
    // Every plot keeps room for as many axes on each side as any has, so their time axes line up.
    gutters: { left: number; right: number };
    colors: PlotColors;
    onCursor: (x: number | null) => void;
    onWindow: (window: [number, number] | null, remember: boolean) => void;
    onAxis: (axis: string, range: [number, number] | null) => void;
    onMenu: (x: number, clientX: number, clientY: number, target: MenuTarget) => void;
    notes: Note[];
    placing: boolean; // a click puts a label there
    onPlace: (anchor: Anchor, clientX: number, clientY: number, series: string | null) => void; // series: on one
    measure: Measurement | null;
    onNote: (id: string, change: Partial<Omit<Note, "id">>) => void;
    onEditNote: (id: string, clientX: number, clientY: number) => void;
    onMoveMark: (id: string, x: number) => void;
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

/**
 * An axis's ticks: states' names at whole numbers when every channel on it is a state (each name where they agree on
 * it: valves' closed and open), else round numbers.
 */
function valueTicks(range: [number, number], series: PlotSeries[], count: number): { value: number; label: string }[] {
    const whole = Math.floor(range[1]) - Math.ceil(range[0]) + 1;
    if (series.length > 0 && series.every((one) => one.labels) && whole > 0 && whole <= Math.max(count, 2) * 2) {
        const found = [];
        for (let value = Math.ceil(range[0]); value <= range[1]; value++) {
            const names = new Set(series.map((one) => one.labels![value] ?? String(value)));
            found.push({ value, label: names.size === 1 ? [...names][0]! : String(value) });
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

/** How far out from the plot each axis is, on its side (0: next to it). */
function axisSlots(axes: AxisSpec[]): Map<string, number> {
    const count = { left: 0, right: 0 };
    return new Map(axes.map((axis) => [axis.id, count[axis.side]++]));
}

/** The axis whose room beside the plot x is in, if there's one there. */
function axisAt(axes: AxisSpec[], g: Geometry, px: number): AxisSpec | null {
    const side: Side | null = px < g.left ? "left" : px > g.right ? "right" : null;
    if (!side) {
        return null;
    }
    const slot = Math.floor((side === "left" ? g.left - px : px - g.right) / AXIS_WIDTH);
    return axes.filter((axis) => axis.side === side)[slot] ?? null;
}

const NOTE_LINE = 15;

/**
 * Where each label goes: its box, dx and dy pixels from the point it's about (kept inside the plot), and the point
 * itself. Labels about times out of view aren't drawn.
 */
export function placeNotes(
    notes: Note[],
    measure: (text: string) => number,
    g: Geometry,
    ranges: Ranges,
    view: [number, number],
): NoteHit[] {
    const found: NoteHit[] = [];
    for (const note of notes) {
        const range = ranges.get(note.axis) ?? ranges.values().next().value;
        if (!range || note.t < view[0] || note.t > view[1]) {
            continue;
        }
        const tip = {
            x: g.left + ((note.t - view[0]) / (view[1] - view[0])) * (g.right - g.left),
            y: g.bottom - ((note.y - range[0]) / (range[1] - range[0])) * (g.bottom - g.top),
        };
        const lines = (note.text || "…").split("\n");
        const w = Math.max(...lines.map(measure)) + 14;
        const h = lines.length * NOTE_LINE + 8;
        const x = Math.min(Math.max(tip.x + note.dx - w / 2, g.left + 1), g.right - 1 - w);
        const y = Math.min(Math.max(tip.y + note.dy - h / 2, g.top + 1), g.bottom - 1 - h);
        found.push({ id: note.id, box: { x, y, w, h }, tip, lines });
    }
    return found;
}

/** Where an arrow from a box to a point leaves the box: on its edge, on the way to the point (null: it's inside). */
export function arrowStart(box: Box, tip: { x: number; y: number }): { x: number; y: number } | null {
    const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const [dx, dy] = [tip.x - center.x, tip.y - center.y];
    const share = Math.min(dx ? Math.abs(box.w / 2 / dx) : Infinity, dy ? Math.abs(box.h / 2 / dy) : Infinity);
    return share >= 1 ? null : { x: center.x + dx * share, y: center.y + dy * share };
}

/** A measurement: its two points, a line between them, and what it says, by the line (kept inside the plot). */
function drawMeasurement(
    context: CanvasRenderingContext2D,
    measure: Measurement,
    g: Geometry,
    ranges: Ranges,
    view: [number, number],
    colors: PlotColors,
): void {
    const at = (point: Anchor) => {
        const range = ranges.get(point.axis); // none once nothing's on that axis: the measurement goes with it
        return range
            ? {
                  x: g.left + ((point.t - view[0]) / (view[1] - view[0])) * (g.right - g.left),
                  y: g.bottom - ((point.y - range[0]) / (range[1] - range[0])) * (g.bottom - g.top),
              }
            : null;
    };
    const a = at(measure.a);
    if (!a) {
        return;
    }
    const b = measure.b ? at(measure.b) : null;
    context.strokeStyle = measure.color;
    context.fillStyle = measure.color;
    context.lineWidth = 1.5;
    if (b) {
        context.setLineDash([5, 4]);
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
        context.setLineDash([]);
    }
    for (const point of [a, b]) {
        if (point) {
            context.beginPath();
            context.arc(point.x, point.y, 4, 0, 2 * Math.PI);
            context.fill();
        }
    }
    const by = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a;
    if (measure.lines.length === 0) {
        return;
    }
    context.font = `12px ${colors.font}`;
    const w = Math.max(...measure.lines.map((line) => context.measureText(line).width)) + 14;
    const h = measure.lines.length * NOTE_LINE + 8;
    const x = Math.min(Math.max(by.x + 12, g.left + 1), g.right - 1 - w);
    const y = Math.min(Math.max(by.y - h - 12, g.top + 1), g.bottom - 1 - h);
    context.fillStyle = colors.plot;
    context.beginPath();
    if (context.roundRect) {
        context.roundRect(x, y, w, h, 4);
    } else {
        context.rect(x, y, w, h);
    }
    context.fill();
    context.stroke();
    context.fillStyle = colors.cursor;
    context.textAlign = "left";
    context.textBaseline = "top";
    measure.lines.forEach((line, index) => context.fillText(line, x + 7, y + 5 + index * NOTE_LINE));
}

function drawNote(context: CanvasRenderingContext2D, hit: NoteHit, note: Note, colors: PlotColors): void {
    const { box, tip } = hit;
    context.strokeStyle = colors.cursor;
    context.fillStyle = colors.cursor;
    context.lineWidth = 1.25;
    const start = note.arrow ? arrowStart(box, tip) : null;
    if (start) {
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(tip.x, tip.y);
        context.stroke();
        const angle = Math.atan2(tip.y - start.y, tip.x - start.x);
        context.beginPath();
        context.moveTo(tip.x, tip.y);
        context.lineTo(tip.x - 9 * Math.cos(angle - 0.4), tip.y - 9 * Math.sin(angle - 0.4));
        context.lineTo(tip.x - 9 * Math.cos(angle + 0.4), tip.y - 9 * Math.sin(angle + 0.4));
        context.closePath();
        context.fill();
    }
    context.fillStyle = colors.plot;
    context.beginPath();
    if (context.roundRect) {
        context.roundRect(box.x, box.y, box.w, box.h, 4);
    } else {
        context.rect(box.x, box.y, box.w, box.h);
    }
    context.fill();
    context.stroke();
    context.fillStyle = colors.cursor;
    context.textAlign = "left";
    context.textBaseline = "top";
    hit.lines.forEach((line, index) => context.fillText(line, box.x + 7, box.y + 5 + index * NOTE_LINE));
}

const inBox = (box: Box, px: number, py: number) =>
    px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;

/** Where the pointer is on the canvas, in the canvas's own pixels (the page may be zoomed or scaled around it). */
function pointerAt(canvas: HTMLElement, event: { clientX: number; clientY: number }): { px: number; py: number } {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvas.clientWidth / rect.width : 1;
    const scaleY = rect.height > 0 ? canvas.clientHeight / rect.height : 1;
    return { px: (event.clientX - rect.left) * scaleX, py: (event.clientY - rect.top) * scaleY };
}

function draw(canvas: HTMLCanvasElement, g: Geometry, props: Props, ranges: Ranges): Hits {
    const hits: Hits = { notes: [], marks: [] };
    const context = canvas.getContext("2d");
    if (!context || g.width <= 0) {
        return hits;
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

    // Where masks hold, under everything: runs closer than a pixel are one band, so a test that flickers stays quick.
    context.save();
    context.globalAlpha = 0.16;
    for (const { runs, shift, color } of props.shading) {
        context.fillStyle = color;
        let low = 0;
        let high = runs.length / 2;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (runs[middle * 2 + 1]! + shift < view[0]) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        let [open, close] = [NaN, NaN];
        for (let r = low * 2; r < runs.length && runs[r]! + shift <= view[1]; r += 2) {
            const [from, to] = [Math.max(g.left, toX(runs[r]! + shift)), Math.min(g.right, toX(runs[r + 1]! + shift))];
            if (from <= close + 1) {
                close = Math.max(close, to);
                continue;
            }
            if (!Number.isNaN(open)) {
                context.fillRect(open, g.top, Math.max(1, close - open), plotHeight);
            }
            [open, close] = [from, to];
        }
        if (!Number.isNaN(open)) {
            context.fillRect(open, g.top, Math.max(1, close - open), plotHeight);
        }
    }
    context.restore();

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

    // Values: an axis for each unit (or as it's set), from the plot out on each side; the first draws the grid. When
    // there's more than one, each is in its first channel's color, to say whose it is.
    const slots = axisSlots(props.axes);
    const several = props.axes.length > 1;
    let gridded = false;
    for (const axis of props.axes) {
        const range = ranges.get(axis.id);
        if (!range) {
            continue;
        }
        const on = props.series.filter((one) => one.axis === axis.id);
        const toY = (y: number) => g.bottom - ((y - range[0]) / (range[1] - range[0])) * plotHeight;
        const marks = valueTicks(range, on, Math.max(2, Math.floor(plotHeight / 40)));
        if (!gridded) {
            gridded = true;
            context.strokeStyle = colors.grid;
            context.beginPath();
            for (const { value } of marks) {
                const at = Math.round(toY(value)) + 0.5;
                context.moveTo(g.left, at);
                context.lineTo(g.right, at);
            }
            context.stroke();
        }
        const left = axis.side === "left";
        const slot = slots.get(axis.id) ?? 0;
        const x = left ? g.left - slot * AXIS_WIDTH : g.right + slot * AXIS_WIDTH;
        const color = several ? (on[0]?.color ?? colors.text) : colors.text;
        if (slot > 0) {
            // An axis out from the plot gets its own line.
            const at = Math.round(x) + 0.5;
            context.strokeStyle = color;
            context.globalAlpha = 0.6;
            context.beginPath();
            context.moveTo(at, g.top);
            context.lineTo(at, g.bottom);
            context.stroke();
            context.globalAlpha = 1;
        }
        context.fillStyle = color;
        context.textAlign = left ? "right" : "left";
        context.textBaseline = "middle";
        for (const { value, label } of marks) {
            context.fillText(label, left ? x - 6 : x + 6, toY(value), AXIS_WIDTH - 24);
        }
        const title = axis.label || unitsOf(on) || (on.length > 0 && on.every((one) => one.labels) ? "state" : "");
        if (title) {
            context.save();
            context.translate(left ? x - AXIS_WIDTH + 9 : x + AXIS_WIDTH - 9, (g.top + g.bottom) / 2);
            context.rotate(left ? -Math.PI / 2 : Math.PI / 2);
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(title, 0, 0, plotHeight);
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
        const at = Math.round(toX(mark.x)) + 0.5;
        const hit = mark.id ? { id: mark.id, x: at, chip: null as Box | null } : null;
        if (hit) {
            hits.marks.push(hit);
        }
        if (!mark.label) {
            continue;
        }
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
        if (hit) {
            hit.chip = { x: at + 1, y: top, w: width, h: 16 };
        }
    }
    context.setLineDash([]);

    // The data.
    for (const one of props.series) {
        const range = ranges.get(one.axis) ?? ranges.values().next().value;
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

    // Labels, over the data.
    context.font = `12px ${colors.font}`;
    hits.notes = placeNotes(props.notes, (text) => context.measureText(text).width, g, ranges, view);
    for (const hit of hits.notes) {
        drawNote(
            context,
            hit,
            props.notes.find((note) => note.id === hit.id)!,
            colors,
        );
    }
    if (props.measure) {
        drawMeasurement(context, props.measure, g, ranges, view, colors);
    }
    context.restore();
    context.lineWidth = 1;
    context.strokeStyle = colors.frame;
    context.strokeRect(g.left + 0.5, g.top + 0.5, plotWidth - 1, plotHeight - 1);
    return hits;
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
        const range = ranges.get(one.axis) ?? ranges.values().next().value;
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
    const hits = useRef<Hits>({ notes: [], marks: [] });
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
            left: Math.max(1, props.gutters.left) * AXIS_WIDTH,
            right: width - (props.gutters.right > 0 ? props.gutters.right * AXIS_WIDTH : EDGE),
            top: TOP,
            bottom: props.height - BOTTOM,
        }),
        [width, props.height, props.gutters.left, props.gutters.right],
    );
    const ranges: Ranges = useMemo(() => {
        const found = new Map<string, [number, number]>();
        for (const axis of props.axes) {
            const on = props.series.filter((one) => one.axis === axis.id);
            const range = axisRange(axis, on, props.window);
            if (range) {
                found.set(axis.id, range);
            }
        }
        return found;
    }, [props.axes, props.series, props.window]);
    const geometryRef = useRef(geometry);
    geometryRef.current = geometry;
    const rangesRef = useRef(ranges);
    rangesRef.current = ranges;

    useEffect(() => {
        if (base.current) {
            hits.current = draw(base.current, geometry, latest.current, ranges);
        }
    }, [
        geometry,
        ranges,
        props.axes,
        props.series,
        props.window,
        props.marks,
        props.shading,
        props.notes,
        props.measure,
        props.time,
        props.colors,
    ]);

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
            const onAxis = axisAt(current.axes, g, px);
            const range = onAxis ? rangesRef.current.get(onAxis.id) : undefined;
            if (onAxis && range) {
                const factor = Math.exp(dy * 0.002);
                const anchor = range[0] + ((g.bottom - py) / (g.bottom - g.top)) * (range[1] - range[0]);
                current.onAxis(onAxis.id, [
                    anchor - (anchor - range[0]) * factor,
                    anchor + (range[1] - anchor) * factor,
                ]);
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

    /** The label, arrow tip, or marker under the pointer: what a drag there moves. */
    function hitAt(px: number, py: number): { kind: "note" | "tip" | "mark"; id: string } | null {
        const { notes, marks } = hits.current;
        for (const note of [...notes].reverse()) {
            if (inBox(note.box, px, py)) {
                return { kind: "note", id: note.id };
            }
        }
        for (const note of notes) {
            if (Math.hypot(note.tip.x - px, note.tip.y - py) <= 7) {
                return { kind: "tip", id: note.id };
            }
        }
        for (const mark of marks) {
            if (
                (mark.chip && inBox(mark.chip, px, py)) ||
                (Math.abs(mark.x - px) <= 4 && py >= geometry.top && py <= geometry.bottom)
            ) {
                return { kind: "mark", id: mark.id };
            }
        }
        return null;
    }

    /** The place in the data at the pointer: on the nearest channel if it's close (and which), else on an axis. */
    function anchorAt(px: number, py: number): { anchor: Anchor; series: string | null } | null {
        const t = timeAt(px);
        let best: { distance: number; anchor: Anchor; series: string } | null = null;
        for (const one of props.series) {
            const range = ranges.get(one.axis);
            const point = one.samples && range ? sampleAt(one.samples, t, one.placement) : null;
            if (!point || !range || Number.isNaN(point.y)) {
                continue;
            }
            const y =
                geometry.bottom - ((point.y - range[0]) / (range[1] - range[0])) * (geometry.bottom - geometry.top);
            const distance = Math.abs(y - py);
            if (distance <= 14 && (!best || distance < best.distance)) {
                best = { distance, anchor: { t: point.x, y: point.y, axis: one.axis }, series: one.id };
            }
        }
        if (best) {
            return { anchor: best.anchor, series: best.series };
        }
        const [first] = ranges; // else on the first axis
        return first ? { anchor: { t, y: valueAt(first[1], py), axis: first[0] }, series: null } : null;
    }

    function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
        const { px, py } = place(event);
        const beside = px < geometry.left || px > geometry.right; // where the axes are
        const onAxis = axisAt(props.axes, geometry, px);
        const pan =
            event.button === 1 || event.button === 2 || (event.button === 0 && (event.ctrlKey || event.metaKey));
        if (!pan && event.button !== 0) {
            return;
        }
        if (props.placing && !pan && !beside) {
            const found = anchorAt(px, py);
            if (found) {
                props.onPlace(found.anchor, event.clientX, event.clientY, found.series);
            }
            return;
        }
        const hit = pan || beside ? null : hitAt(px, py);
        const note = hit ? props.notes.find((one) => one.id === hit.id) : undefined;
        const box = hit?.kind === "tip" ? hits.current.notes.find((one) => one.id === hit.id)?.box : undefined;
        const mode: Drag["mode"] = hit
            ? hit.kind
            : onAxis && ranges.has(onAxis.id)
              ? "axis"
              : pan
                ? "pan"
                : event.shiftKey
                  ? "box"
                  : "zoom";
        drag.current = {
            mode,
            target: hit?.id ?? null,
            offset: { dx: note?.dx ?? 0, dy: note?.dy ?? 0 },
            center: box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : null,
            axis: onAxis?.id ?? null,
            x0: px,
            y0: py,
            x: px,
            y: py,
            window: props.window,
            range: onAxis ? (ranges.get(onAxis.id) ?? null) : null,
            moved: false,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    }

    function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
        const { px, py } = place(event);
        const current = drag.current;
        if (!current) {
            props.onCursor(px >= geometry.left && px <= geometry.right ? timeAt(px) : null);
            // Say what a drag here would do.
            const hit = props.placing ? null : hitAt(px, py);
            event.currentTarget.style.cursor = props.placing
                ? "copy"
                : hit?.kind === "mark"
                  ? "ew-resize"
                  : hit
                    ? "move"
                    : "";
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
        if (current.mode === "note" && current.target) {
            props.onNote(current.target, {
                dx: current.offset.dx + px - current.x0,
                dy: current.offset.dy + py - current.y0,
            });
        } else if (current.mode === "tip" && current.target) {
            const anchor = anchorAt(px, py)?.anchor;
            const range = anchor ? ranges.get(anchor.axis) : undefined;
            if (anchor && range) {
                // The label stays put: its offset from the new tip is where its box was.
                const [start, end] = props.window;
                const tip = {
                    x: geometry.left + ((anchor.t - start) / (end - start)) * (geometry.right - geometry.left),
                    y:
                        geometry.bottom -
                        ((anchor.y - range[0]) / (range[1] - range[0])) * (geometry.bottom - geometry.top),
                };
                const center = current.center ?? tip;
                props.onNote(current.target, { ...anchor, dx: center.x - tip.x, dy: center.y - tip.y });
            }
        } else if (current.mode === "mark" && current.target) {
            props.onMoveMark(current.target, timeAt(Math.min(Math.max(px, geometry.left), geometry.right)));
        } else if (current.mode === "pan") {
            const shift =
                (-(px - current.x0) / (geometry.right - geometry.left)) * (current.window[1] - current.window[0]);
            props.onWindow([current.window[0] + shift, current.window[1] + shift], false);
        } else if (current.mode === "axis" && current.range && current.axis) {
            const [low, high] = current.range;
            const shift = ((py - current.y0) / (geometry.bottom - geometry.top)) * (high - low);
            props.onAxis(current.axis, [low + shift, high + shift]);
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
                for (const [axis, range] of ranges) {
                    const [c, d] = [valueAt(range, current.y0), valueAt(range, py)];
                    props.onAxis(axis, [Math.min(c, d), Math.max(c, d)]);
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
            const hit = hitAt(px, py);
            props.onMenu(timeAt(px), event.clientX, event.clientY, {
                anchor: anchorAt(px, py)?.anchor ?? null,
                note: hit && hit.kind !== "mark" ? hit.id : null,
                marker: hit?.kind === "mark" ? hit.id : null,
            });
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
                onDoubleClick={(event) => {
                    const { px, py } = pointerAt(event.currentTarget, event);
                    const hit = hitAt(px, py);
                    if (hit && hit.kind !== "mark") {
                        props.onEditNote(hit.id, event.clientX, event.clientY);
                        return;
                    }
                    props.onWindow(null, true);
                    props.axes.forEach((axis) => props.onAxis(axis.id, null));
                }}
                onContextMenu={(event) => event.preventDefault()}
            />
        </div>
    );
}
