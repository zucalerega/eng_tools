// Axis ticks at round numbers, and numbers, times, and durations written for people.

const ROUND = [1, 2, 2.5, 5, 10];

/** A round step (1, 2, 2.5, or 5 times a power of ten) for about count ticks across span. */
export function niceStep(span: number, count: number): number {
    if (!(span > 0) || !Number.isFinite(span)) {
        return 1;
    }
    const raw = span / Math.max(1, count);
    const power = 10 ** Math.floor(Math.log10(raw));
    return ROUND.find((multiple) => raw <= multiple * power * (1 + 1e-9))! * power;
}

/** Ticks at a round step from low to high. */
export function ticks(low: number, high: number, count: number): { values: number[]; step: number } {
    const step = niceStep(high - low, count);
    const values: number[] = [];
    for (let k = Math.ceil(low / step - 1e-9); k * step <= high + step * 1e-9 && values.length < 500; k++) {
        values.push(k * step || 0); // not -0
    }
    return { values, step };
}

/** How many decimals a step needs: 0.25 -> 2, 5 -> 0, 0.001 -> 3. */
export function decimalsFor(step: number): number {
    for (let decimals = 0; decimals < 15; decimals++) {
        const scaled = step * 10 ** decimals;
        if (Math.abs(scaled - Math.round(scaled)) <= 1e-7 * scaled) {
            return decimals;
        }
    }
    return 15;
}

const withoutMinusZero = (text: string): string => (/^-0(\.0*)?$/.test(text) ? text.slice(1) : text);

/** A tick's label, with as many decimals as its step needs. */
export function formatTick(value: number, step: number): string {
    const size = Math.max(Math.abs(value), step);
    if (size >= 1e7 || step < 1e-6) {
        return withoutMinusZero(value.toExponential(Math.min(6, Math.max(0, Math.round(Math.log10(size / step))))));
    }
    return withoutMinusZero(value.toFixed(decimalsFor(step)));
}

/** A value to read: as many decimals as the file wrote (if known), else six significant digits. */
export function formatValue(value: number, decimals: number | null = null): string {
    if (!Number.isFinite(value)) {
        return "—";
    }
    if (decimals !== null && Math.abs(value) < 1e15) {
        return withoutMinusZero(value.toFixed(decimals));
    }
    if (value === 0) {
        return "0";
    }
    const size = Math.abs(value);
    if (size >= 1e9 || size < 1e-4) {
        return value.toExponential(5).replace(/\.?0+e/, "e");
    }
    return withoutMinusZero(String(Number(value.toPrecision(6))));
}

// --- time ---------------------------------------------------------------------------------------------------------

const CLOCK_STEPS = [
    0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200,
    10800, 21600, 43200, 86400,
];

/** Ticks for times of day: steps a clock would use (5 s, 15 s, 1 min, 15 min, 1 h). */
export function clockTicks(low: number, high: number, count: number): { values: number[]; step: number } {
    const raw = (high - low) / Math.max(1, count);
    const step = CLOCK_STEPS.find((candidate) => candidate >= raw) ?? niceStep(high - low, count);
    const values: number[] = [];
    for (let k = Math.ceil(low / step - 1e-9); k * step <= high + step * 1e-9 && values.length < 500; k++) {
        values.push(k * step || 0); // not -0
    }
    return { values, step };
}

const two = (value: number) => String(value).padStart(2, "0");

/** 14:32:05, or 14:32:05.250 for steps under a second: seconds since midnight (or a Unix time), as a clock. */
export function formatClock(seconds: number, step = 1): string {
    const day = ((seconds % 86400) + 86400) % 86400;
    const decimals = step < 1 ? Math.min(3, decimalsFor(step)) : 0;
    // Round first, so 59.9996 shows as the next minute rather than as :60.
    const rounded = Math.round(day * 10 ** decimals) / 10 ** decimals;
    const whole = Math.floor(rounded);
    const clock = `${two(Math.floor(whole / 3600) % 24)}:${two(Math.floor(whole / 60) % 60)}:${two(whole % 60)}`;
    return decimals > 0 ? `${clock}.${(rounded - whole).toFixed(decimals).slice(2)}` : clock;
}

/** 850 ms, 12.5 s, 3 min 20 s, 1 h 5 min. */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds)) {
        return "—";
    }
    const size = Math.abs(seconds);
    if (size < 1) {
        return `${formatValue(seconds * 1000)} ms`;
    }
    if (size < 60) {
        return `${formatValue(Number(seconds.toPrecision(4)))} s`;
    }
    if (size < 3600) {
        const minutes = Math.floor(size / 60);
        const rest = Math.round(size - minutes * 60);
        return `${minutes} min${rest ? ` ${rest} s` : ""}`;
    }
    const hours = Math.floor(size / 3600);
    const minutes = Math.round((size - hours * 3600) / 60);
    return `${hours} h${minutes ? ` ${minutes} min` : ""}`;
}

/** 1 kHz, 100 Hz, 12.5 Hz, 0.2 Hz. */
export function formatRate(perSecond: number | null): string {
    if (perSecond === null || !Number.isFinite(perSecond) || perSecond <= 0) {
        return "—";
    }
    if (perSecond >= 1e6) {
        return `${formatValue(Number((perSecond / 1e6).toPrecision(3)))} MHz`;
    }
    if (perSecond >= 1000) {
        return `${formatValue(Number((perSecond / 1000).toPrecision(3)))} kHz`;
    }
    return `${formatValue(Number(perSecond.toPrecision(3)))} Hz`;
}
