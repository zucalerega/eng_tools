import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { Palette } from "./colors";
import type { Commands } from "./commands";
import { DiagramView, type LiveValue } from "./DiagramView";
import { PART_SCALES, type Drawing, type PageSheet, type Point } from "./drawing";
import {
    addPart,
    connect,
    insertIntoLine,
    lineNear,
    moveItems,
    moveSegment,
    obstacles,
    reconnect,
    runOf,
    updatePart,
    type Target,
} from "./edit";
import { distance, grow, inBox, snapPoint, type Box, type Dir } from "./geometry";
import { boxOf, kindOf, presetOf } from "./library/index";
import type { DiagramMeta } from "./library/kinds";
import { labelPlace, textSizes } from "./labels";
import { linesOn, partsById, pathOf, placeEnd, portsOf } from "./ports";
import { PAPERS, sheetOutline } from "./pdf";
import { route } from "./route";
import { snapMove } from "./snap";
import { useEditor, type Aim, type EditorStore } from "./store";

// The drawing, to work on: click to select (Shift adds), drag to move (snapped; Alt for free), drag from a port to draw
// a line, drag a line's segment to move it or its end to another port, drag on nothing to select what's in a box, and
// the wheel to scroll (with Ctrl or ⌘ to zoom). Space or the middle button drags the view.

/**
 * The canvas, for a part dragged from the library (with the pointer, as the browser's own drag-and-drop doesn't start
 * from a button in every browser): over the canvas, the part's shown where it would go; let go there, it's placed.
 * Points are the pointer's, in the window; free: Alt, off the grid.
 */
export interface LibraryDrop {
    over(preset: string, client: Point, free: boolean): boolean; // whether it's over the canvas
    drop(preset: string, client: Point, free: boolean): boolean; // whether it was placed
    leave(): void;
}

/** The canvas taking parts from the library now, if one's open. */
export const libraryDrop: { target: LibraryDrop | null } = { target: null };

type Drag =
    | { kind: "pan"; client: Point; view: { x: number; y: number; zoom: number } }
    | {
          kind: "move";
          start: Point;
          ids: Set<string>;
          anchor: string;
          base: Drawing;
          moved: boolean;
          only: boolean;
          into: { line: string; at: Point } | null;
      }
    | {
          kind: "line";
          source: Target;
          start: { at: Point; dir: Dir | null };
          skip: { part?: string; port?: string };
          moved: boolean;
          aim: Aim | null;
      }
    | { kind: "segment"; line: string; index: number; start: Point; base: Drawing; moved: boolean }
    | { kind: "end"; line: string; end: "from" | "to"; base: Drawing; moved: boolean; aim: Aim | null }
    | { kind: "label"; part: string; start: Point; offset: Point; base: Drawing; moved: boolean }
    | { kind: "resize"; part: string; start: Point; base: Drawing; moved: boolean }
    | { kind: "scale"; part: string; middle: Point; reach: number; scale: number; base: Drawing; moved: boolean }
    | { kind: "marquee"; start: Point; before: string[]; moved: boolean };

/** What's under the pointer: the data-hit of the nearest thing drawn there that says what it is ("part:p1"). */
function hitOf(target: EventTarget | null): string[] | null {
    const element = target instanceof Element ? target.closest("[data-hit]") : null;
    return element ? (element.getAttribute("data-hit") ?? "").split(":") : null;
}

const targetOf = (aim: Aim): Target =>
    aim.kind === "port"
        ? { part: aim.part, port: aim.port }
        : aim.kind === "line"
          ? { line: aim.line, at: aim.at }
          : aim.at;

/**
 * Where a line being drawn would end: the nearest port within reach (or the nearest of a part the pointer's on), a
 * point on a line (a tee), or the grid's point (or the pointer's, with Alt).
 */
export function aimAt(
    drawing: Drawing,
    at: Point,
    zoom: number,
    skip: { part?: string; port?: string; line?: string },
    free = false,
): Aim {
    const reach = 14 / zoom;
    let best: { part: string; port: string; at: Point; away: number } | null = null;
    for (const part of drawing.parts) {
        const on = part.id !== skip.part && inBox(at, grow(boxOf(part, drawing), 2));
        for (const port of portsOf(part)) {
            if (part.id === skip.part && port.id === skip.port) {
                continue;
            }
            const away = distance(port.at, at);
            if ((away <= reach || on) && (!best || away < best.away)) {
                best = { part: part.id, port: port.id, at: port.at, away };
            }
        }
    }
    if (best) {
        return { kind: "port", part: best.part, port: best.port, at: best.at };
    }
    const near = lineNear(drawing, at, 8 / zoom, new Set(skip.line ? [skip.line] : []));
    if (near) {
        return { kind: "line", line: near.line.id, at: near.at };
    }
    return { kind: "point", at: free ? at : snapPoint(at) };
}

/** Where a line ends up for the drawing's routing: a port, which way it faces, or a point. */
function placeAim(drawing: Drawing, aim: Aim) {
    if (aim.kind === "port") {
        return placeEnd(partsById(drawing), { part: aim.part, port: aim.port }) ?? { at: aim.at, dir: null };
    }
    return { at: aim.at, dir: null };
}

export function Canvas({
    store,
    commands,
    palette,
    meta,
    live,
    onEdit,
}: {
    store: EditorStore;
    commands: Commands;
    palette: Palette;
    meta: DiagramMeta;
    live: ReadonlyMap<string, LiveValue> | null;
    onEdit: (id: string) => void; // a part double-clicked: its tag (or words) to type in
}) {
    const state = useEditor(store, (all) => all);
    const svg = useRef<SVGSVGElement>(null);
    const drag = useRef<Drag | null>(null);
    const [hover, setHover] = useState<string | null>(null);
    const [space, setSpace] = useState(false);
    const { view, size, shown } = state;

    // The canvas's size, for the view's box.
    useLayoutEffect(() => {
        const element = svg.current?.parentElement;
        if (!element) {
            return;
        }
        const measure = () => {
            const rect = element.getBoundingClientRect();
            store.setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
        };
        measure();
        if (typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [store]);

    // The wheel scrolls, and zooms with Ctrl or ⌘ (a trackpad's pinch is one): the browser's own zoom would take the
    // whole page, so the listener isn't passive.
    useEffect(() => {
        const element = svg.current;
        if (!element) {
            return;
        }
        const wheel = (event: WheelEvent) => {
            event.preventDefault();
            const { view: now } = store.getState();
            if (event.ctrlKey || event.metaKey) {
                const rect = element.getBoundingClientRect();
                const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015));
                commands.zoomBy(factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
            } else {
                const lines = event.deltaMode === 1 ? 16 : 1;
                const [dx, dy] =
                    event.shiftKey && event.deltaX === 0 ? [event.deltaY, 0] : [event.deltaX, event.deltaY];
                store.setView({ ...now, x: now.x + (dx * lines) / now.zoom, y: now.y + (dy * lines) / now.zoom });
            }
        };
        element.addEventListener("wheel", wheel, { passive: false });
        return () => element.removeEventListener("wheel", wheel);
    }, [store, commands]);

    // Space held: dragging moves the view. Not while a field or a button has the keys: Space types, or presses it.
    useEffect(() => {
        const typing = (target: EventTarget | null) =>
            target instanceof Element &&
            !!target.closest("input, textarea, select, button, a, [contenteditable='true'], .dialog-backdrop");
        const down = (event: KeyboardEvent) => {
            if (event.key === " " && !typing(event.target)) {
                event.preventDefault();
                setSpace(true);
            }
        };
        const up = (event: KeyboardEvent) => {
            if (event.key === " ") {
                setSpace(false);
            }
        };
        window.addEventListener("keydown", down);
        window.addEventListener("keyup", up);
        return () => {
            window.removeEventListener("keydown", down);
            window.removeEventListener("keyup", up);
        };
    }, []);

    const pointAt = (event: { clientX: number; clientY: number }): Point => {
        const rect = svg.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const now = store.getState().view;
        return { x: now.x + (event.clientX - rect.left) / now.zoom, y: now.y + (event.clientY - rect.top) / now.zoom };
    };

    /** A library entry placed at a point (into a line, if it can go in one and it's on one). */
    function placed(
        presetId: string,
        at: Point,
        free: boolean,
    ): { drawing: Drawing; id: string; into: string | null } | null {
        const preset = presetOf(presetId);
        const { drawing, view: now } = store.getState();
        if (!preset) {
            return null;
        }
        const added = addPart(drawing, preset, at, free);
        if (kindOf(preset.kind).inline) {
            const near = lineNear(drawing, at, 10 / now.zoom);
            const into = near ? insertIntoLine(added.drawing, added.id, near.line.id, at) : null;
            if (near && into) {
                return { drawing: into, id: added.id, into: near.line.id };
            }
        }
        return { ...added, into: null };
    }

    // Taking parts dragged from the library, while it's open.
    const dropTarget = useRef<LibraryDrop | null>(null);
    dropTarget.current = {
        over(preset, client, free) {
            const rect = svg.current?.getBoundingClientRect();
            const inside =
                !!rect &&
                client.x >= rect.left &&
                client.x <= rect.right &&
                client.y >= rect.top &&
                client.y <= rect.bottom;
            const made = inside ? placed(preset, pointAt({ clientX: client.x, clientY: client.y }), free) : null;
            if (made) {
                store.preview(made.drawing, { into: made.into });
            } else if (store.getState().shown !== store.getState().drawing) {
                store.cancel();
            }
            return inside;
        },
        drop(preset, client, free) {
            const inside = this.over(preset, client, free);
            const made = inside ? placed(preset, pointAt({ clientX: client.x, clientY: client.y }), free) : null;
            if (made) {
                store.commit(made.drawing, [made.id]);
            } else {
                store.cancel();
            }
            return made !== null;
        },
        leave() {
            store.cancel();
        },
    };
    useEffect(() => {
        const target: LibraryDrop = {
            over: (...args) => dropTarget.current!.over(...args),
            drop: (...args) => dropTarget.current!.drop(...args),
            leave: () => dropTarget.current!.leave(),
        };
        libraryDrop.target = target;
        return () => {
            if (libraryDrop.target === target) {
                libraryDrop.target = null;
            }
        };
    }, []);

    function onPointerDown(event: PointerEvent<SVGSVGElement>) {
        if (event.button === 2) {
            return;
        }
        const now = store.getState();
        const at = pointAt(event);
        svg.current?.setPointerCapture?.(event.pointerId);
        if (event.button === 1 || space) {
            drag.current = { kind: "pan", client: { x: event.clientX, y: event.clientY }, view: now.view };
            return;
        }
        const hit = hitOf(event.target);
        if (now.tool.mode === "place") {
            const made = placed(now.tool.preset, at, event.altKey);
            if (made) {
                store.commit(made.drawing, [made.id]);
            }
            if (!event.shiftKey) {
                store.setTool({ mode: "select" }); // Shift keeps placing more
            }
            return;
        }
        if (hit?.[0] === "port" || now.tool.mode === "line") {
            // A line, from a port, or with the line tool from wherever: a port near, a line (a tee), or a point.
            const aim =
                hit?.[0] === "port"
                    ? ({ kind: "port", part: hit[1]!, port: hit[2]!, at } as Aim)
                    : aimAt(now.drawing, at, now.view.zoom, {}, event.altKey);
            const start = placeAim(now.drawing, aim);
            drag.current = {
                kind: "line",
                source: targetOf(aim),
                start: { at: start.at, dir: start.dir },
                skip: aim.kind === "port" ? { part: aim.part, port: aim.port } : {},
                moved: false,
                aim: null,
            };
            return;
        }
        if (!hit) {
            drag.current = { kind: "marquee", start: at, before: event.shiftKey ? now.selection : [], moved: false };
            return;
        }
        const [what, id = "", detail = ""] = hit;
        const additive = event.shiftKey || event.ctrlKey || event.metaKey;
        const choose = (one: string) => {
            if (additive) {
                const on = now.selection.includes(one);
                store.select(on ? now.selection.filter((entry) => entry !== one) : [...now.selection, one]);
                return !on;
            }
            if (!now.selection.includes(one)) {
                store.select([one]);
            }
            return true;
        };
        switch (what) {
            case "end":
                store.select([id]);
                drag.current = {
                    kind: "end",
                    line: id,
                    end: detail === "from" ? "from" : "to",
                    base: now.drawing,
                    moved: false,
                    aim: null,
                };
                break;
            case "segment":
                if (choose(id) && !additive) {
                    drag.current = {
                        kind: "segment",
                        line: id,
                        index: Number(detail),
                        start: at,
                        base: now.drawing,
                        moved: false,
                    };
                }
                break;
            case "label": {
                store.select([id]);
                const part = now.drawing.parts.find((entry) => entry.id === id);
                if (part) {
                    const place = labelPlace(
                        part,
                        boxOf(part, now.drawing),
                        textSizes(now.drawing, part).tag,
                        now.drawing,
                    ).at;
                    const offset = part.label ?? { x: place.x - part.x, y: place.y - part.y };
                    drag.current = { kind: "label", part: id, start: at, offset, base: now.drawing, moved: false };
                }
                break;
            }
            case "resize":
                drag.current = { kind: "resize", part: id, start: at, base: now.drawing, moved: false };
                break;
            case "scale": {
                // Bigger or smaller as the pointer goes out from its middle, or back toward it.
                const part = now.drawing.parts.find((entry) => entry.id === id);
                if (part) {
                    const middle = { x: part.x, y: part.y };
                    const reach = Math.max(1, distance(at, middle));
                    drag.current = {
                        kind: "scale",
                        part: id,
                        middle,
                        reach,
                        scale: part.scale,
                        base: now.drawing,
                        moved: false,
                    };
                }
                break;
            }
            case "part": {
                const wasOnly = now.selection.includes(id) && !additive;
                if (choose(id)) {
                    const ids = new Set(store.getState().selection);
                    drag.current = {
                        kind: "move",
                        start: at,
                        ids,
                        anchor: id,
                        base: now.drawing,
                        moved: false,
                        only: wasOnly,
                        into: null,
                    };
                }
                break;
            }
        }
    }

    function onPointerMove(event: PointerEvent<SVGSVGElement>) {
        const current = drag.current;
        const now = store.getState();
        const at = pointAt(event);
        const zoom = now.view.zoom;
        if (!current) {
            const hit = hitOf(event.target);
            const id = hit && ["part", "port", "label"].includes(hit[0] ?? "") ? (hit[1] ?? null) : null;
            if (id !== hover) {
                setHover(id);
            }
            if (now.tool.mode === "place") {
                const made = placed(now.tool.preset, at, event.altKey);
                if (made) {
                    store.preview(made.drawing, { into: made.into });
                }
            }
            return;
        }
        const far = (start: Point) => Math.hypot(at.x - start.x, at.y - start.y) * zoom >= 3;
        switch (current.kind) {
            case "pan":
                store.setView({
                    ...current.view,
                    x: current.view.x - (event.clientX - current.client.x) / current.view.zoom,
                    y: current.view.y - (event.clientY - current.client.y) / current.view.zoom,
                });
                break;
            case "move": {
                if (!current.moved && !far(current.start)) {
                    return;
                }
                current.moved = true;
                const by = { x: at.x - current.start.x, y: at.y - current.start.y };
                const snapped = event.altKey
                    ? { by, guides: [] }
                    : snapMove(current.base, current.ids, current.anchor, by, 6 / zoom);
                const next = moveItems(current.base, current.ids, snapped.by);
                // One part that can go into a line, not on any yet, over a line: it'll go in where it's dropped.
                let into: { line: string; at: Point } | null = null;
                const part = current.ids.size === 1 ? next.parts.find((entry) => entry.id === current.anchor) : null;
                if (part && kindOf(part.kind).inline && linesOn(next, part.id).length === 0) {
                    const near = lineNear(next, { x: part.x, y: part.y }, 12 / zoom);
                    into = near ? { line: near.line.id, at: near.at } : null;
                }
                current.into = into;
                store.preview(next, { guides: snapped.guides, into: into?.line ?? null });
                break;
            }
            case "line": {
                if (!current.moved && !far(current.start.at)) {
                    return;
                }
                current.moved = true;
                const aim = aimAt(now.drawing, at, zoom, current.skip, event.altKey);
                current.aim = aim;
                const end = placeAim(now.drawing, aim);
                const parts = partsById(now.drawing);
                const busy = now.drawing.lines.map((line) => runOf(parts, line) ?? []);
                const sketch = route(current.start, end, obstacles(now.drawing), busy);
                store.preview(now.drawing, { aim, sketch });
                break;
            }
            case "segment": {
                if (!current.moved && !far(current.start)) {
                    return;
                }
                current.moved = true;
                const by = { x: at.x - current.start.x, y: at.y - current.start.y };
                store.preview(moveSegment(current.base, current.line, current.index, by));
                break;
            }
            case "end": {
                current.moved = true;
                const aim = aimAt(current.base, at, zoom, { line: current.line }, event.altKey);
                current.aim = aim;
                store.preview(reconnect(current.base, current.line, current.end, targetOf(aim)), { aim });
                break;
            }
            case "label": {
                current.moved = true;
                const offset = {
                    x: current.offset.x + at.x - current.start.x,
                    y: current.offset.y + at.y - current.start.y,
                };
                store.preview(updatePart(current.base, current.part, (part) => ({ ...part, label: offset })));
                break;
            }
            case "resize": {
                current.moved = true;
                store.preview(
                    updatePart(current.base, current.part, (part) => {
                        // From its top left, which stays put: in its kind's steps (a region's the grid's), and no
                        // smaller than its least. (A text block sized to its words until now starts from its box.)
                        const { step, least } = kindOf(part.kind).resize ?? { step: 10, least: [60, 40] };
                        const box = boxOf(part, current.base);
                        const left = box.x0;
                        const top = box.y0;
                        const w = Math.max(least[0], Math.round((at.x - left) / step) * step);
                        const h = Math.max(least[1], Math.round((at.y - top) / step) * step);
                        return { ...part, w, h, x: left + w / 2, y: top + h / 2 };
                    }),
                );
                break;
            }
            case "scale": {
                current.moved = true;
                const wanted = (current.scale * distance(at, current.middle)) / current.reach;
                const scale = PART_SCALES.reduce((best, each) =>
                    Math.abs(each - wanted) < Math.abs(best - wanted) ? each : best,
                );
                store.preview(updatePart(current.base, current.part, (part) => ({ ...part, scale })));
                break;
            }
            case "marquee": {
                if (!current.moved && !far(current.start)) {
                    return;
                }
                current.moved = true;
                const box: Box = {
                    x0: Math.min(current.start.x, at.x),
                    y0: Math.min(current.start.y, at.y),
                    x1: Math.max(current.start.x, at.x),
                    y1: Math.max(current.start.y, at.y),
                };
                // What's wholly in the box: parts by their boxes, lines by all of their points.
                const parts = partsById(now.drawing);
                const within = (inner: Box) =>
                    inner.x0 >= box.x0 && inner.y0 >= box.y0 && inner.x1 <= box.x1 && inner.y1 <= box.y1;
                const ids = [
                    ...now.drawing.parts.filter((part) => within(boxOf(part, now.drawing))).map((part) => part.id),
                    ...now.drawing.lines
                        .filter((line) => {
                            const path = pathOf(parts, line);
                            return path.length > 0 && path.every((point) => inBox(point, box));
                        })
                        .map((line) => line.id),
                ];
                store.select([...new Set([...current.before, ...ids])]);
                store.preview(now.drawing, { marquee: box });
                break;
            }
        }
    }

    function onPointerUp(event: PointerEvent<SVGSVGElement>) {
        const current = drag.current;
        drag.current = null;
        svg.current?.releasePointerCapture?.(event.pointerId);
        if (!current) {
            return;
        }
        const now = store.getState();
        switch (current.kind) {
            case "pan":
                return;
            case "move":
                if (!current.moved) {
                    // A click on one of several selected: just it.
                    if (current.only && now.selection.length > 1) {
                        store.select([current.anchor]);
                    }
                    store.cancel();
                } else if (current.into) {
                    store.commit(
                        insertIntoLine(now.shown, current.anchor, current.into.line, current.into.at) ?? now.shown,
                    );
                } else {
                    store.commit(now.shown);
                }
                return;
            case "line": {
                if (!current.moved) {
                    store.cancel();
                    return;
                }
                const aim =
                    current.aim ?? aimAt(now.drawing, pointAt(event), now.view.zoom, current.skip, event.altKey);
                const made = connect(now.drawing, current.source, targetOf(aim));
                if (made) {
                    store.commit(made.drawing, [made.id]);
                } else {
                    store.cancel();
                }
                return;
            }
            case "marquee":
                if (!current.moved) {
                    store.select(current.before);
                }
                store.cancel();
                return;
            default:
                if (current.moved) {
                    store.commit(now.shown);
                } else {
                    store.cancel();
                }
        }
    }

    const selection = useMemo(() => new Set(state.selection), [state.selection]);
    const drawingLine = state.sketch !== null || state.tool.mode === "line";
    const ports = drawingLine ? ("all" as const) : new Set(hover ? [hover, ...state.selection] : state.selection);
    const intoPath = useMemo(() => {
        const line = state.into ? shown.lines.find((entry) => entry.id === state.into) : null;
        return line ? pathOf(partsById(shown), line) : null;
    }, [state.into, shown]);
    const width = size.width / view.zoom;
    const height = size.height / view.zoom;
    const cursor =
        space || drag.current?.kind === "pan" ? "piper-panning" : state.tool.mode !== "select" ? "piper-placing" : "";

    return (
        <svg
            ref={svg}
            className={`piper-canvas ${cursor}`}
            role="application"
            aria-label="Drawing"
            viewBox={`${view.x} ${view.y} ${width} ${height}`}
            preserveAspectRatio="xMinYMin meet"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
                drag.current = null;
                store.cancel();
            }}
            onPointerLeave={() => {
                if (!drag.current && state.tool.mode === "place") {
                    store.cancel();
                }
            }}
            onDoubleClick={(event) => {
                const hit = hitOf(event.target);
                if (hit && (hit[0] === "part" || hit[0] === "label") && hit[1]) {
                    onEdit(hit[1]);
                }
            }}
            // Nothing's dropped here with the browser's own drag-and-drop: a file let go on the drawing isn't opened in
            // the tab, leaving the editor.
            onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "none";
            }}
            onDrop={(event) => event.preventDefault()}
        >
            <Grid view={view} width={width} height={height} palette={palette} />
            {shown.sheet && <SheetOutline sheet={shown.sheet} zoom={view.zoom} palette={palette} />}
            <DiagramView
                drawing={shown}
                palette={palette}
                meta={meta}
                selection={selection}
                live={live}
                interactive
                zoom={view.zoom}
                ports={ports}
            />
            {intoPath && (
                <polyline
                    points={intoPath.map((point) => `${point.x},${point.y}`).join(" ")}
                    fill="none"
                    stroke={palette.guide}
                    strokeOpacity={0.45}
                    strokeWidth={10}
                    strokeLinejoin="round"
                    pointerEvents="none"
                />
            )}
            {state.guides.map((guide, index) => (
                <line
                    key={index}
                    x1={guide.x ?? guide.from}
                    y1={guide.y ?? guide.from}
                    x2={guide.x ?? guide.to}
                    y2={guide.y ?? guide.to}
                    stroke={palette.guide}
                    strokeWidth={1.2 / view.zoom}
                    strokeDasharray={`${5 / view.zoom} ${3 / view.zoom}`}
                    pointerEvents="none"
                />
            ))}
            {state.sketch && (
                <polyline
                    points={state.sketch.map((point) => `${point.x},${point.y}`).join(" ")}
                    fill="none"
                    stroke={palette.select}
                    strokeWidth={2.5}
                    strokeDasharray="6 4"
                    strokeLinejoin="round"
                    pointerEvents="none"
                />
            )}
            {state.aim && (
                <circle
                    cx={state.aim.at.x}
                    cy={state.aim.at.y}
                    r={(state.aim.kind === "point" ? 3.5 : 7) / view.zoom}
                    fill={state.aim.kind === "point" ? palette.select : "none"}
                    stroke={palette.select}
                    strokeWidth={2 / view.zoom}
                    pointerEvents="none"
                />
            )}
            {state.marquee && (
                <rect
                    x={state.marquee.x0}
                    y={state.marquee.y0}
                    width={state.marquee.x1 - state.marquee.x0}
                    height={state.marquee.y1 - state.marquee.y0}
                    fill={palette.select}
                    fillOpacity={0.08}
                    stroke={palette.select}
                    strokeWidth={1 / view.zoom}
                    strokeDasharray={`${4 / view.zoom} ${3 / view.zoom}`}
                    pointerEvents="none"
                />
            )}
        </svg>
    );
}

/**
 * Where the page prints, if its sheet's been set: the paper's edge, the sheet's border inside it, and the corner its
 * title block and revisions can take, as a PDF on a drawing sheet prints them. Under the drawing, and not to be picked.
 */
function SheetOutline({ sheet, zoom, palette }: { sheet: PageSheet; zoom: number; palette: Palette }) {
    const { paper, frame, corner } = sheetOutline(sheet);
    const rect = (box: Box) => ({ x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 });
    const name = PAPERS.find((entry) => entry.id === sheet.paper)?.name ?? sheet.paper;
    return (
        <g className="piper-sheet-outline" pointerEvents="none" aria-hidden="true">
            <rect {...rect(paper)} fill="none" stroke={palette.muted} strokeWidth={1.5 / zoom} />
            <rect
                {...rect(frame)}
                fill="none"
                stroke={palette.muted}
                strokeOpacity={0.6}
                strokeWidth={1 / zoom}
                strokeDasharray={`${6 / zoom} ${4 / zoom}`}
            />
            <rect
                {...rect(corner)}
                fill={palette.muted}
                fillOpacity={0.08}
                stroke={palette.muted}
                strokeOpacity={0.6}
                strokeWidth={1 / zoom}
            />
            <text x={paper.x0} y={paper.y0 - 6 / zoom} fontSize={11 / zoom} fill={palette.muted}>
                {name}, {sheet.landscape ? "landscape" : "portrait"}: as it prints
            </text>
        </g>
    );
}

/** The grid: a dot each 10 units, a stronger one each 50, the small ones only when there's room to see them. */
function Grid({
    view,
    width,
    height,
    palette,
}: {
    view: { x: number; y: number; zoom: number };
    width: number;
    height: number;
    palette: Palette;
}) {
    const fine = view.zoom >= 0.6;
    const dot = 1.1 / view.zoom;
    return (
        <>
            <defs>
                {/* Each dot in the middle of its tile (a tile's offset by half), so none is cut by its tile's edge. */}
                <pattern id="piper-grid-fine" x={-5} y={-5} width={10} height={10} patternUnits="userSpaceOnUse">
                    <circle cx={5} cy={5} r={dot} fill={palette.gridMajor} />
                </pattern>
                <pattern id="piper-grid" x={-25} y={-25} width={50} height={50} patternUnits="userSpaceOnUse">
                    <circle cx={25} cy={25} r={dot * 1.6} fill={palette.gridMajor} />
                </pattern>
            </defs>
            <rect x={view.x} y={view.y} width={width} height={height} fill={palette.paper} />
            {fine && (
                <rect
                    x={view.x}
                    y={view.y}
                    width={width}
                    height={height}
                    fill="url(#piper-grid-fine)"
                    pointerEvents="none"
                />
            )}
            <rect x={view.x} y={view.y} width={width} height={height} fill="url(#piper-grid)" pointerEvents="none" />
        </>
    );
}
