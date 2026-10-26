import { isPortEnd, type Drawing, type End, type Line, type Part, type Point } from "./drawing";
import { orthogonal, snapPoint, toWorld, turnDir, VECTORS, type Dir } from "./geometry";
import { kindOf } from "./library/index";

// Where lines meet parts: each part's ports in the drawing, and the points a line runs through, from end to end.

/** A port where it is in the drawing. */
export interface PlacedPort {
    part: string;
    id: string;
    at: Point; // on the grid: where the line's route starts
    dir: Dir | null; // the way a line leaves it (null: any way)
    edge: Point; // where the line is drawn to: the symbol's outline
    many: boolean;
}

export function portsOf(part: Part): PlacedPort[] {
    const scale = part.scale ?? 1;
    return kindOf(part.kind)
        .ports(part)
        .map((port) => {
            const exact = toWorld(part, { x: port.x, y: port.y });
            // A part drawn bigger or smaller has its ports where they'd fall, put back on the grid, so lines between
            // parts lined up stay straight; a line's still drawn to its outline, in line with its port.
            const at = scale === 1 ? exact : snapPoint(exact);
            const dir = port.dir ? turnDir(part, port.dir) : null;
            const back = dir ? VECTORS[dir] : { x: 0, y: 0 };
            const outline = { x: exact.x - back.x * port.inset * scale, y: exact.y - back.y * port.inset * scale };
            return {
                part: part.id,
                id: port.id,
                at,
                dir,
                edge: back.x !== 0 ? { x: outline.x, y: at.y } : back.y !== 0 ? { x: at.x, y: outline.y } : at,
                many: port.many === true,
            };
        });
}

export function portOf(part: Part, id: string): PlacedPort | null {
    return portsOf(part).find((port) => port.id === id) ?? null;
}

/** Where a line's end is, which way it leaves, and where it's drawn to. */
export interface PlacedEnd {
    at: Point;
    dir: Dir | null;
    edge: Point;
}

export function placeEnd(parts: Map<string, Part>, end: End): PlacedEnd | null {
    if (!isPortEnd(end)) {
        return { at: { x: end.x, y: end.y }, dir: null, edge: { x: end.x, y: end.y } };
    }
    const part = parts.get(end.part);
    const port = part ? portOf(part, end.port) : null;
    return port ? { at: port.at, dir: port.dir, edge: port.edge } : null;
}

export const partsById = (drawing: Drawing): Map<string, Part> => new Map(drawing.parts.map((part) => [part.id, part]));

/**
 * The points a line runs through, end to end, as it's drawn: from the outline at one end, through its bends, to the
 * outline at the other, bent where it isn't orthogonal (a drawing changed by hand, or a part turned under a line
 * routed by hand) so it always is.
 */
export function pathOf(parts: Map<string, Part>, line: Line): Point[] {
    const from = placeEnd(parts, line.from);
    const to = placeEnd(parts, line.to);
    if (!from || !to) {
        return [];
    }
    return withEnds(orthogonal([from.at, ...line.points, to.at], from.dir), from.edge, to.edge);
}

/**
 * A route drawn on in to the symbols' outlines: where its first and last segments leave their ports straight, the
 * outline is on the same run, just behind the port.
 */
function withEnds(route: Point[], first: Point, last: Point): Point[] {
    if (route.length < 2) {
        return route;
    }
    const drawn = [...route];
    if (lines(first, drawn[0]!, drawn[1]!)) {
        drawn[0] = first;
    }
    const end = drawn.length - 1;
    if (lines(last, drawn[end]!, drawn[end - 1]!)) {
        drawn[end] = last;
    }
    return drawn;
}

/** Whether moving the end of a segment from b to a keeps it on its run (along its axis). */
const lines = (a: Point, b: Point, c: Point): boolean =>
    (Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - c.y) < 1e-6) ||
    (Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - c.x) < 1e-6);

/** The lines that end on a part, each with the end that does. */
export function linesOn(drawing: Drawing, partId: string): { line: Line; end: "from" | "to"; port: string }[] {
    const found: { line: Line; end: "from" | "to"; port: string }[] = [];
    for (const line of drawing.lines) {
        if (isPortEnd(line.from) && line.from.part === partId) {
            found.push({ line, end: "from", port: line.from.port });
        }
        if (isPortEnd(line.to) && line.to.part === partId) {
            found.push({ line, end: "to", port: line.to.port });
        }
    }
    return found;
}
