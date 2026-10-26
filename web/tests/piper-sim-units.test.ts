import { expect, test } from "vitest";
import type { SimUnits } from "../src/piper/drawing";
import { fitOf } from "../src/piper/sim/Results";
import {
    ATMOSPHERE,
    channelToSiLinear,
    fromDisplay,
    PSI,
    siToDisplayLinear,
    toDisplay,
    unitOf,
    type Linear,
} from "../src/piper/sim/units";

// A simulation's units: settings in SI shown in the diagram's units, a test's channels read in theirs, and how far a
// run is from what was measured. No server: these are the web app's.

const US_GAUGE: SimUnits = { units: "us", gauge: true, ambient: ATMOSPHERE };
const SI_ABSOLUTE: SimUnits = { units: "si", gauge: false, ambient: ATMOSPHERE };

test("settings show in the diagram's units, gauge or absolute, and go back to SI", () => {
    expect(unitOf("pressure", US_GAUGE)).toBe("psig");
    expect(unitOf("pressure", SI_ABSOLUTE)).toBe("bara");
    expect(toDisplay("pressure", 300 * PSI + ATMOSPHERE, US_GAUGE)).toBeCloseTo(300, 9);
    expect(fromDisplay("pressure", 300, US_GAUGE)).toBeCloseTo(300 * PSI + ATMOSPHERE, 6);
    expect(toDisplay("temperature", 273.15, US_GAUGE)).toBeCloseTo(32, 9);
    expect(fromDisplay("temperature", -297, US_GAUGE)).toBeCloseTo(90.372, 3);
    expect(toDisplay("area", 0.00064516, US_GAUGE)).toBeCloseTo(1, 9);
    expect(toDisplay("diameter", 0.0127, SI_ABSOLUTE)).toBeCloseTo(12.7, 9);
    expect(toDisplay("ratio", 1.2, US_GAUGE)).toBe(1.2);
});

test("a vapor pressure is always absolute, a droop never has the atmosphere in it", () => {
    expect(unitOf("pressure_abs", US_GAUGE)).toBe("psia");
    expect(toDisplay("pressure_abs", 2 * PSI, US_GAUGE)).toBeCloseTo(2, 9);
    expect(unitOf("pressure_drop", US_GAUGE)).toBe("psi");
    expect(toDisplay("pressure_drop", 20 * PSI, US_GAUGE)).toBeCloseTo(20, 9);
    expect(fromDisplay("pressure_drop", 20, US_GAUGE)).toBeCloseTo(20 * PSI, 6);
});

test("a wall's mass, specific heat, and hA", () => {
    expect(toDisplay("mass", 0.45359237, US_GAUGE)).toBeCloseTo(1, 9);
    expect(toDisplay("specific_heat", 900, US_GAUGE)).toBeCloseTo(0.215, 3); // aluminum, BTU/lbm·°F
    expect(unitOf("conductance", SI_ABSOLUTE)).toBe("W/K");
    expect(toDisplay("conductance", 20, US_GAUGE)).toBeCloseTo(37.91, 2); // BTU/hr·°F
});

test("a channel goes on a plot in the diagram's units, from its own", () => {
    const through = (quantity: Parameters<typeof unitOf>[0], unit: string): Linear => {
        const toSi = channelToSiLinear(quantity, unit, US_GAUGE);
        const shown = siToDisplayLinear(quantity, US_GAUGE);
        return { scale: toSi.scale * shown.scale, offset: toSi.offset * shown.scale + shown.offset };
    };
    const at = ({ scale, offset }: Linear, value: number) => value * scale + offset;
    // psig in, psig shown: as it is.
    expect(at(through("pressure", "psig"), 250)).toBeCloseTo(250, 9);
    // psia in, psig shown.
    expect(at(through("pressure", "psia"), 250)).toBeCloseTo(250 - ATMOSPHERE / PSI, 9);
    // No unit: read in the diagram's (psi, gauge here).
    expect(at(through("pressure", ""), 250)).toBeCloseTo(250, 9);
    // bar gauge in, psig shown.
    expect(at(through("pressure", "barg"), 1)).toBeCloseTo(1e5 / PSI, 9);
    expect(at(through("temperature", "degC"), 100)).toBeCloseTo(212, 9);
    expect(at(through("mass_flow", "kg/s"), 1)).toBeCloseTo(1 / 0.45359237, 9);
    // A model's value (SI) on the same plot.
    expect(at(siToDisplayLinear("pressure", US_GAUGE), 250 * PSI + ATMOSPHERE)).toBeCloseTo(250, 9);
});

test("how far a run is from what was measured: at each measured sample in it, the model between its points", () => {
    const model = { times: [0, 1, 2], values: [100, 200, 200] };
    // Measured 10 above the model at 0.5 s and 1.5 s, and a sample outside the run, which doesn't count.
    const measured = { times: [0.5, 1.5, 5], values: [160, 210, 0] };
    const fit = fitOf(measured, model)!;
    expect([fit.count, fit.bias, fit.rms]).toEqual([2, 10, 10]);
    expect(fitOf({ times: [9], values: [1] }, model)).toBeNull();
});
