import type { Point } from "./drawing";

// Where two lines cross without joining, P&IDs draw the one across hopping over the one down, so a crossing never reads
// as a tee. These are lines' SVG paths with their hops in.

export const HOP = 4; // a hop's radius

interface Run {
    a: Point;
    b: Point;
}

const level = (run: Run) => Math.abs(run.a.y - run.b.y) < 1e-6 && Math.abs(run.a.x - run.b.x) > 1e-6;
const upright = (run: Run) => Math.abs(run.a.x - run.b.x) < 1e-6 && Math.abs(run.a.y - run.b.y) > 1e-6;

function runsOf(points: Point[]): Run[] {
    const runs: Run[] = [];
    for (let index = 0; index + 1 < points.length; index++) {
        runs.push({ a: points[index]!, b: points[index + 1]! });
    }
    return runs;
}

/** Each line's path (id: its points, end to end), as SVG path data with a hop wherever it crosses another going down. */
export function pathsWithHops(lines: Map<string, Point[]>): Map<string, string> {
    const downs: { line: string; x: number; y0: number; y1: number }[] = [];
    for (const [id, points] of lines) {
        for (const run of runsOf(points).filter(upright)) {
            downs.push({ line: id, x: run.a.x, y0: Math.min(run.a.y, run.b.y), y1: Math.max(run.a.y, run.b.y) });
        }
    }
    const paths = new Map<string, string>();
    for (const [id, points] of lines) {
        if (points.length === 0) {
            paths.set(id, "");
            continue;
        }
        let d = `M${points[0]!.x} ${points[0]!.y}`;
        for (const run of runsOf(points)) {
            if (level(run)) {
                const y = run.a.y;
                const forward = run.b.x > run.a.x;
                const [x0, x1] = forward ? [run.a.x, run.b.x] : [run.b.x, run.a.x];
                const crossings = downs
                    .filter(
                        (down) =>
                            down.line !== id &&
                            down.x > x0 + HOP + 1 &&
                            down.x < x1 - HOP - 1 &&
                            y > down.y0 + 1e-6 &&
                            y < down.y1 - 1e-6,
                    )
                    .map((down) => down.x)
                    .sort((a, b) => (forward ? a - b : b - a));
                let last = Number.NaN;
                for (const x of crossings) {
                    if (Math.abs(x - last) < HOP * 2 + 1) {
                        continue; // two crossings closer than a hop's width: one hop over both
                    }
                    last = x;
                    const sign = forward ? 1 : -1;
                    // Over the top: clockwise going right, counterclockwise going left (y is down).
                    d += ` L${x - sign * HOP} ${y} A${HOP} ${HOP} 0 0 ${forward ? 1 : 0} ${x + sign * HOP} ${y}`;
                }
            }
            d += ` L${run.b.x} ${run.b.y}`;
        }
        paths.set(id, d);
    }
    return paths;
}
