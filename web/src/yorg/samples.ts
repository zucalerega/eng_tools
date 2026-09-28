// A channel's samples, and what drawing them needs quickly at any zoom: where a time falls among them, the
// smallest and largest values over any run of them, and a screen's worth of points (a few per pixel column, however
// many samples that column covers).

/** The first index whose time is at or after t (the length, if none is). */
export function lowerBound(times: Float64Array, t: number, from = 0, to = times.length): number {
    let low = from;
    let high = to;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (times[middle]! < t) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

/** The first index whose time is after t (the length, if none is). */
export function upperBound(times: Float64Array, t: number, from = 0, to = times.length): number {
    let low = from;
    let high = to;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (times[middle]! <= t) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

const FAN = 32;

/**
 * The smallest and largest of any run of values, without looking at each one: the values in blocks of 32, those
 * blocks in blocks of 32, and so on, each with its minimum and maximum. NaN (a missing sample) is left out.
 */
export class MinMax {
    private readonly mins: Float64Array[] = [];
    private readonly maxes: Float64Array[] = [];

    constructor(private readonly values: Float64Array) {
        let mins = values;
        let maxes = values;
        while (mins.length > FAN) {
            const count = Math.ceil(mins.length / FAN);
            const nextMins = new Float64Array(count);
            const nextMaxes = new Float64Array(count);
            for (let block = 0; block < count; block++) {
                let low = Infinity;
                let high = -Infinity;
                const end = Math.min(mins.length, (block + 1) * FAN);
                for (let i = block * FAN; i < end; i++) {
                    const min = mins[i]!; // NaN compares false, so it's never taken
                    const max = maxes[i]!;
                    if (min < low) low = min;
                    if (max > high) high = max;
                }
                nextMins[block] = low;
                nextMaxes[block] = high;
            }
            this.mins.push(nextMins);
            this.maxes.push(nextMaxes);
            mins = nextMins;
            maxes = nextMaxes;
        }
    }

    /** The smallest and largest values in [from, to): [Infinity, -Infinity] if it has none. */
    range(from: number, to: number): [number, number] {
        let low = Infinity;
        let high = -Infinity;
        const scan = (mins: Float64Array, maxes: Float64Array, start: number, end: number) => {
            for (let i = start; i < end; i++) {
                const min = mins[i]!;
                const max = maxes[i]!;
                if (min < low) low = min;
                if (max > high) high = max;
            }
        };
        let start = from;
        let end = to;
        for (let level = 0; start < end; level++) {
            const mins = level === 0 ? this.values : this.mins[level - 1]!;
            const maxes = level === 0 ? this.values : this.maxes[level - 1]!;
            if (level === this.mins.length || end - start <= 2 * FAN) {
                scan(mins, maxes, start, end);
                break;
            }
            // The ragged ends here; the whole blocks between them one level up.
            const blockStart = Math.ceil(start / FAN) * FAN;
            const blockEnd = Math.floor(end / FAN) * FAN;
            scan(mins, maxes, start, Math.min(blockStart, end));
            scan(mins, maxes, Math.max(blockEnd, blockStart), end);
            start = blockStart / FAN;
            end = blockEnd / FAN;
        }
        return [low, high];
    }
}

/** How far apart two samples can be and still be joined by a line: 20 times the usual step between them. */
function gapLimit(times: Float64Array): number {
    const count = times.length;
    if (count < 2) {
        return Infinity;
    }
    const stride = Math.max(1, Math.floor((count - 1) / 2000));
    const steps: number[] = [];
    for (let i = stride; i < count; i += stride) {
        steps.push((times[i]! - times[i - stride]!) / stride);
    }
    steps.sort((a, b) => a - b);
    const usual = steps[steps.length >> 1]!;
    return usual > 0 ? usual * 20 : Infinity;
}

/** A channel's samples: times (seconds, in order) and values (NaN where one is missing). */
export class Samples {
    readonly index: MinMax;
    readonly gap: number; // samples further apart than this are a pause in logging: no line across it

    constructor(
        readonly times: Float64Array,
        readonly values: Float64Array,
    ) {
        this.index = new MinMax(values);
        this.gap = gapLimit(times);
    }

    get length(): number {
        return this.times.length;
    }
}

/** How a series places its samples: time + shift on the time axis, and value * scale + offset. */
export interface Placement {
    shift: number;
    scale: number;
    offset: number;
}

/**
 * Points to draw: x on the time axis, y after scale and offset. A NaN y lifts the pen (a missing sample, or a pause
 * in logging). With few samples in view (raw) each point is a sample; with more, each pixel column gets its first,
 * lowest, highest, and last value, which draws exactly what drawing every sample would.
 */
export interface Trace {
    x: Float64Array;
    y: Float64Array;
    length: number;
    raw: boolean;
}

export function trace(samples: Samples, from: number, to: number, columns: number, placement: Placement): Trace {
    const { times, values, index, gap } = samples;
    const { shift, scale, offset } = placement;
    const start = from - shift;
    const end = to - shift;
    // One sample either side too, so lines run to the edges.
    const first = Math.max(0, lowerBound(times, start) - 1);
    const last = Math.min(times.length, upperBound(times, end) + 1);
    const pixels = Math.max(1, Math.floor(columns));

    if (last - first <= pixels * 2) {
        const x = new Float64Array(2 * (last - first));
        const y = new Float64Array(2 * (last - first));
        let length = 0;
        let previous = NaN;
        for (let i = first; i < last; i++) {
            const t = times[i]!;
            const value = values[i]!;
            if (t - previous > gap) {
                x[length] = t + shift;
                y[length++] = NaN;
            }
            x[length] = t + shift;
            y[length++] = value * scale + offset;
            previous = t;
        }
        return { x, y, length, raw: true };
    }

    const width = (end - start) / pixels;
    const x = new Float64Array(6 * pixels + 8);
    const y = new Float64Array(6 * pixels + 8);
    let length = 0;
    const point = (at: number, value: number) => {
        x[length] = at;
        y[length++] = value;
    };
    let previous = NaN; // the time of the last sample drawn
    const lead = lowerBound(times, start, first, last);
    for (let i = first; i < lead; i++) {
        point(times[i]! + shift, values[i]! * scale + offset);
        previous = times[i]!;
    }
    let a = lead;
    for (let column = 0; column < pixels; column++) {
        const b =
            column === pixels - 1
                ? upperBound(times, end, a, last)
                : lowerBound(times, start + (column + 1) * width, a, last);
        if (b > a) {
            const [low, high] = index.range(a, b);
            if (low > high) {
                point(times[a]! + shift, NaN); // only missing samples here
            } else {
                if (times[a]! - previous > gap) {
                    point(times[a]! + shift, NaN);
                }
                const firstValue = values[a]!;
                const lastValue = values[b - 1]!;
                const at = start + (column + 0.5) * width + shift;
                point(at, (Number.isNaN(firstValue) ? low : firstValue) * scale + offset);
                point(at, low * scale + offset);
                point(at, high * scale + offset);
                point(at, (Number.isNaN(lastValue) ? high : lastValue) * scale + offset);
            }
            previous = times[b - 1]!;
            a = b;
        }
    }
    for (let i = a; i < last; i++) {
        if (times[i]! - previous > gap) {
            point(times[i]! + shift, NaN);
        }
        point(times[i]! + shift, values[i]! * scale + offset);
        previous = times[i]!;
    }
    return { x, y, length, raw: false };
}

/** The lowest and highest values a series shows between two times, placed; null if there are none. */
export function visibleRange(
    samples: Samples,
    from: number,
    to: number,
    placement: Placement,
): [number, number] | null {
    const { times, index } = samples;
    let a = lowerBound(times, from - placement.shift);
    let b = upperBound(times, to - placement.shift);
    if (a >= b) {
        // Between two samples: the line from one to the other crosses the view.
        a = Math.max(0, a - 1);
        b = Math.min(times.length, b + 1);
    }
    const [low, high] = index.range(a, b);
    if (low > high) {
        return null;
    }
    const ends = [low * placement.scale + placement.offset, high * placement.scale + placement.offset];
    return [Math.min(ends[0]!, ends[1]!), Math.max(ends[0]!, ends[1]!)];
}

/** The sample nearest a time on the time axis, if one is near enough to it to be what's there. */
export function sampleAt(samples: Samples, x: number, placement: Placement): { x: number; y: number } | null {
    const { times, values, gap } = samples;
    const t = x - placement.shift;
    const i = lowerBound(times, t);
    const before = i - 1;
    let nearest = i;
    if (i >= times.length || (before >= 0 && t - times[before]! <= times[i]! - t)) {
        nearest = before;
    }
    if (nearest < 0 || Math.abs(times[nearest]! - t) > (Number.isFinite(gap) ? gap / 2 : Infinity)) {
        return null;
    }
    return { x: times[nearest]! + placement.shift, y: values[nearest]! * placement.scale + placement.offset };
}
