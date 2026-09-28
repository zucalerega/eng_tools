import { lowerBound, Samples, upperBound } from "./samples";

// Masks: where a test on channels holds (a valve open, a pressure over its redline), as runs of time. A mask shades the
// plots where it holds, hides data where it doesn't, and finds the tests in a file of several, to split it into them.

/** Where something holds: runs of time as [start, end] pairs in one array, in order and apart. */
export type Runs = Float64Array;

/**
 * Where samples hold (aren't 0, and aren't missing): each run from its first sample that holds to its last. A pause in
 * logging ends a run, as a missing sample does.
 */
export function runsOf(samples: Samples): Runs {
    const { times, values, gap } = samples;
    const found: number[] = [];
    let start = NaN;
    let last = NaN;
    for (let i = 0; i < times.length; i++) {
        const value = values[i]!;
        const t = times[i]!;
        const holds = value !== 0 && !Number.isNaN(value);
        if (!Number.isNaN(start) && (!holds || t - last > gap)) {
            found.push(start, last);
            start = NaN;
        }
        if (holds) {
            if (Number.isNaN(start)) {
                start = t;
            }
            last = t;
        }
    }
    if (!Number.isNaN(start)) {
        found.push(start, last);
    }
    return Float64Array.from(found);
}

/** Where both hold. */
export function intersect(a: Runs, b: Runs): Runs {
    const found: number[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        const start = Math.max(a[i]!, b[j]!);
        const end = Math.min(a[i + 1]!, b[j + 1]!);
        if (start <= end) {
            found.push(start, end);
        }
        if (a[i + 1]! < b[j + 1]!) {
            i += 2;
        } else {
            j += 2;
        }
    }
    return Float64Array.from(found);
}

/** The samples in the runs, with the rest missing (so they aren't drawn, and axes fit what's left). */
export function within(samples: Samples, runs: Runs): Samples {
    const { times, values } = samples;
    const kept = new Float64Array(values.length).fill(NaN);
    for (let r = 0; r < runs.length; r += 2) {
        const from = lowerBound(times, runs[r]!);
        const to = upperBound(times, runs[r + 1]!, from);
        kept.set(values.subarray(from, to), from);
    }
    return new Samples(times, kept);
}

/** How many runs there are, and how long they hold in all. */
export function measure(runs: Runs): { count: number; total: number } {
    let total = 0;
    for (let r = 0; r < runs.length; r += 2) {
        total += runs[r + 1]! - runs[r]!;
    }
    return { count: runs.length / 2, total };
}

// --- splitting a file into its tests ------------------------------------------------------------------------------

/** How runs become tests: all in seconds. */
export interface Finding {
    before: number; // a test starts this long before its run
    after: number; // and ends this long after it
    join: number; // runs closer than this are one test (a valve that chattered)
    shortest: number; // runs shorter than this aren't tests (a blip)
}

/** A span of a file to make a dataset of, and where its mask holds in it (null: it has no mask). */
export interface Piece {
    start: number;
    end: number;
    run: [number, number] | null;
}

/** Where a piece's mask starts holding, if it does in the piece: where to count its time from. */
export const edgeOf = (piece: Piece): number | null =>
    piece.run && Math.max(piece.start, piece.run[0]) <= Math.min(piece.end, piece.run[1])
        ? Math.max(piece.start, piece.run[0])
        : null;

/** Runs as tests: joined when they're close, the short ones left out, then padded (inside the file's span). */
export function testsOf(runs: Runs, span: [number, number], finding: Finding): Piece[] {
    const joined: [number, number][] = [];
    for (let r = 0; r < runs.length; r += 2) {
        const last = joined[joined.length - 1];
        if (last && runs[r]! - last[1] < finding.join) {
            last[1] = runs[r + 1]!;
        } else {
            joined.push([runs[r]!, runs[r + 1]!]);
        }
    }
    return joined
        .filter(([start, end]) => end - start >= finding.shortest)
        .map((run) => ({
            start: Math.max(span[0], run[0] - finding.before),
            end: Math.min(span[1], run[1] + finding.after),
            run,
        }))
        .filter((piece) => piece.end > piece.start);
}

/** Pieces cut in two (or more) at the times that fall inside them. */
export function cutAt(pieces: Piece[], cuts: readonly number[]): Piece[] {
    const sorted = [...new Set(cuts)].filter(Number.isFinite).sort((a, b) => a - b);
    const found: Piece[] = [];
    for (const piece of pieces) {
        let start = piece.start;
        for (const cut of sorted) {
            if (cut > start && cut < piece.end) {
                found.push({ ...piece, start, end: cut });
                start = cut;
            }
        }
        found.push({ ...piece, start });
    }
    return found;
}

/** Times typed as a list ("12.5, 30 45"), or why they can't be read. */
export function readTimes(text: string): number[] | string {
    const words = text.split(/[\s,;]+/).filter(Boolean);
    const times = words.map(Number);
    const bad = words.find((_, index) => !Number.isFinite(times[index]));
    return bad === undefined ? times : `${bad} isn't a time: write seconds, like 12.5, 30`;
}
