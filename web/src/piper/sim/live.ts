import { formatValue } from "../../scale";
import { valueAt, type Samples, type TestDetail } from "../testdata";
import type { Quantity } from "./api";
import type { Shown } from "./SimPanel";
import { channelToSiLinear, siToDisplayLinear, unitOf } from "./units";

// What the drawing shows of a run at the time shown, a part's in one badge, in the diagram's units: an instrument's or a
// flow meter's the test's value beside the model's, to compare; a tank's or a vessel's pressure, unless an instrument on
// it shows it; and what flows through a valve, an orifice, or a regulator, while anything does and no flow meter in line
// with it shows it. An outlet's pressure is what it was given, so it isn't shown.

/** A part's value on the drawing: what the test measured there (in the model's units, without them; null: nothing
 * to compare, or not loaded yet), and the model's (with its unit). */
export interface SimLive {
    measured: string | null;
    model: string;
}

const HOLDERS = new Set(["tank", "supply", "vessel"]);
const CARRIERS = new Set(["valve", "check", "regulator", "orifice", "venturi"]);

/** A series' value at a time: its last point then, as a test's channel's is read beside it and on the plots (null
 * outside the run, or where it has none). */
function at(times: number[], values: (number | null)[], t: number): number | null {
    if (times.length === 0 || t < times[0]! || t > times[times.length - 1]!) {
        return null;
    }
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid]! <= t) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return values[lo] ?? null;
}

/** A value to four figures, as a badge has room for. */
const short = (value: number) => formatValue(Number(value.toPrecision(4)));

/** The run's values on the drawing at a time, by the P&ID's parts' ids; and what the test measured beside the model's,
 * where the test's samples are loaded. */
export function simLive(
    shown: Shown,
    time: number,
    test: { detail: TestDetail; samples: ReadonlyMap<string, Samples> } | null,
): Map<string, SimLive> {
    const found = new Map<string, SimLive>();
    const { result, built } = shown;
    const units = shown.model.display;
    const model = (key: string, quantity: Quantity): { value: number; text: string } | null => {
        const values = result.series[key];
        const value = values ? at(result.times, values, time) : null;
        if (value === null) {
            return null;
        }
        const display = siToDisplayLinear(quantity, units);
        const shownValue = value * display.scale + display.offset;
        return { value: shownValue, text: `${short(shownValue)} ${unitOf(quantity, units)}`.trim() };
    };
    /** What a part's channel measured at the time, in the model's units: left out of the model or not, it's compared. */
    const measured = (partId: string, quantity: Quantity): string | null => {
        const channel = [...built.links, ...built.left].find((one) => one.from === partId)?.channel;
        const found = channel && test ? test.detail.channels.find((one) => one.name === channel) : undefined;
        const samples = found ? test?.samples.get(found.name) : undefined;
        const value = samples ? valueAt(samples, time) : null;
        if (!found || value === null) {
            return null;
        }
        const toSi = channelToSiLinear(quantity, found.unit, units);
        const display = siToDisplayLinear(quantity, units);
        return short((value * toSi.scale + toSi.offset) * display.scale + display.offset);
    };

    // Instruments and flow meters: what they measure, beside the model's.
    const shownAt = new Set<string>(); // the model's outputs an instrument or a meter shows already
    for (const [id, placed] of built.placed) {
        const target = placed.ids[0];
        if (target === undefined || (placed.role !== "sensor" && placed.role !== "meter")) {
            continue;
        }
        const output = placed.role === "meter" ? "mass_flow" : placed.reads;
        const quantity: Quantity =
            placed.role === "meter" ? "mass_flow" : placed.reads === "pressure" ? "pressure" : "temperature";
        const value = output ? model(`${target}.${output}`, quantity) : null;
        if (value) {
            found.set(id, { measured: measured(id, quantity), model: value.text });
            shownAt.add(`${target}.${output}`);
        }
    }
    // Tanks and vessels: their pressure. What carries flow: the flow, while there is any.
    for (const [id, placed] of built.placed) {
        const target = placed.ids[0];
        if (target === undefined) {
            continue;
        }
        if (HOLDERS.has(placed.role) && !shownAt.has(`${target}.pressure`)) {
            const value = model(`${target}.pressure`, "pressure");
            if (value) {
                found.set(id, { measured: null, model: value.text });
            }
        } else if (CARRIERS.has(placed.role) && !shownAt.has(`${target}.mass_flow`)) {
            const value = model(`${target}.mass_flow`, "mass_flow");
            if (value && Math.abs(value.value) >= 1e-6) {
                found.set(id, { measured: null, model: value.text });
            }
        }
    }
    return found;
}
