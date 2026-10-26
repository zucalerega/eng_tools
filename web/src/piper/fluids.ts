import type { Drawing, Fluid } from "./drawing";

// The fluids lines carry, each with a color its lines are drawn in and a label written on them. The standard ones are
// the propellants, pressurants, and test fluids the team uses, in the colors rocketry P&IDs give them (oxidizers blue,
// fuels red, nitrogen green, helium purple); a diagram can change any of them, and add its own.

export interface StandardFluid extends Fluid {
    gas: boolean; // a tank of it is full of it, rather than holding it in its lower part
}

export const STANDARD_FLUIDS: StandardFluid[] = [
    { id: "lox", name: "Liquid oxygen", label: "LOX", color: "#2f6fd6", gas: false },
    { id: "gox", name: "Gaseous oxygen", label: "GOX", color: "#5fa8f5", gas: true },
    { id: "n2o", name: "Nitrous oxide", label: "N2O", color: "#159a9c", gas: false },
    { id: "h2o2", name: "Hydrogen peroxide", label: "H2O2", color: "#b23a8c", gas: false },
    { id: "rp1", name: "RP-1", label: "RP-1", color: "#d1392b", gas: false },
    { id: "ethanol", name: "Ethanol", label: "ETH", color: "#e8702a", gas: false },
    { id: "ipa", name: "Isopropyl alcohol", label: "IPA", color: "#d38a0c", gas: false },
    { id: "methane", name: "Liquid methane", label: "LCH4", color: "#a0522d", gas: false },
    { id: "lh2", name: "Liquid hydrogen", label: "LH2", color: "#4cb5c4", gas: false },
    { id: "gn2", name: "Nitrogen", label: "GN2", color: "#2e9e4f", gas: true },
    { id: "ghe", name: "Helium", label: "GHe", color: "#8a55d0", gas: true },
    { id: "air", name: "Air", label: "AIR", color: "#7d8794", gas: true },
    { id: "water", name: "Water", label: "H2O", color: "#22a6d6", gas: false },
    { id: "hydraulic", name: "Hydraulic oil", label: "HYD", color: "#7b7b2a", gas: false },
    { id: "fuel", name: "Fuel", label: "FUEL", color: "#d1392b", gas: false },
    { id: "oxidizer", name: "Oxidizer", label: "OX", color: "#2f6fd6", gas: false },
    { id: "pressurant", name: "Pressurant", label: "PRESS", color: "#2e9e4f", gas: true },
    { id: "purge", name: "Purge", label: "PURGE", color: "#5d9b8a", gas: true },
    { id: "vent", name: "Vent", label: "VENT", color: "#9aa3ad", gas: true },
    // What leaves a chamber or a gas generator: hot, so in a color no propellant or pressurant has.
    { id: "combustion", name: "Combustion gas", label: "HOT GAS", color: "#e0457b", gas: true },
];

const STANDARD = new Map(STANDARD_FLUIDS.map((fluid) => [fluid.id, fluid]));

/** Every fluid a diagram can use: the standard ones as it has them (its colors and labels), then its own. */
export function fluidsOf(drawing: Drawing): Fluid[] {
    const own = new Map(drawing.fluids.map((fluid) => [fluid.id, fluid]));
    const standard = STANDARD_FLUIDS.map((fluid) => own.get(fluid.id) ?? fluid);
    return [...standard, ...drawing.fluids.filter((fluid) => !STANDARD.has(fluid.id))];
}

export function fluidOf(drawing: Drawing, id: string): Fluid | null {
    if (!id) {
        return null;
    }
    return drawing.fluids.find((fluid) => fluid.id === id) ?? STANDARD.get(id) ?? null;
}

/** Whether a fluid is a gas: as the diagram (or its scheme) says, else as the standard one is, else a liquid. */
export const isGas = (drawing: Drawing, id: string): boolean =>
    drawing.fluids.find((fluid) => fluid.id === id)?.gas ?? STANDARD.get(id)?.gas ?? false;

/** The fluids a diagram's lines carry, and its vessels hold, in the order they first appear: its legend's. */
export function fluidsUsed(drawing: Drawing): Fluid[] {
    const ids = [
        ...drawing.lines.map((line) => line.fluid),
        ...drawing.parts.map((part) => part.props.fluid ?? ""),
    ].filter(Boolean);
    return [...new Set(ids)].map((id) => fluidOf(drawing, id)).filter((fluid) => fluid !== null);
}

/** A diagram's fluids with one changed, or added: kept as its own only where it differs from the standard one. */
export function withFluid(drawing: Drawing, fluid: Fluid): Fluid[] {
    const standard = STANDARD.get(fluid.id);
    const others = drawing.fluids.filter((entry) => entry.id !== fluid.id);
    const same =
        standard &&
        standard.name === fluid.name &&
        standard.label === fluid.label &&
        standard.color === fluid.color &&
        (fluid.gas ?? standard.gas) === standard.gas;
    return same ? others : [...others, fluid];
}

/** An id for a fluid of the diagram's own, from its label: "Kerosene" is "kerosene", unless that's taken. */
export function newFluidId(drawing: Drawing, label: string): string {
    const base =
        label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "fluid";
    const taken = new Set(fluidsOf(drawing).map((fluid) => fluid.id));
    let id = base;
    for (let count = 2; taken.has(id); count++) {
        id = `${base}-${count}`;
    }
    return id;
}

/** A color scheme, as the team defines it in Piper (server: piper/schemes.py). */
export interface SchemeColors {
    id: number;
    name: string;
    fluids: Required<Fluid>[];
    states: { no: string; nc: string; fip: string; other: string };
    updated_at: string;
}

/**
 * A drawing in a scheme's colors: each of the scheme's fluids as the drawing's own (its name, label, color, and whether
 * it's a gas), over what the drawing had for it, the drawing's other own fluids kept, and its valves' states in the
 * scheme's colors; noted with the scheme and when it last changed, to see it's changed since.
 */
export function applyScheme(drawing: Drawing, scheme: SchemeColors): Drawing {
    const ids = new Set(scheme.fluids.map((fluid) => fluid.id));
    return {
        ...drawing,
        fluids: [
            ...drawing.fluids.filter((fluid) => !ids.has(fluid.id)),
            ...scheme.fluids.map((fluid) => ({ ...fluid })),
        ],
        style: {
            ...drawing.style,
            no: scheme.states.no,
            nc: scheme.states.nc,
            fip: scheme.states.fip,
            scheme: String(scheme.id),
            schemeAt: scheme.updated_at,
        },
    };
}

/** Whether the scheme a drawing took its colors from has changed since. */
export const schemeChanged = (drawing: Drawing, scheme: SchemeColors): boolean =>
    drawing.style.scheme === String(scheme.id) && drawing.style.schemeAt !== scheme.updated_at;

const INK = "#1b2433";

/**
 * A drawing in black and white, to print on a printer without color: its lines in ink, a normally closed valve filled
 * in ink, one that fails in place in grey, and a normally open one left white (as P&IDs drawn in ink have them).
 */
export function monochrome(drawing: Drawing): Drawing {
    return {
        ...drawing,
        fluids: fluidsOf(drawing).map((fluid) => ({ ...fluid, color: INK })),
        style: { ...drawing.style, no: "#ffffff", nc: INK, fip: "#9aa3ad" },
    };
}
