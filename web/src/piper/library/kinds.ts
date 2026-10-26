import type { ReactNode } from "react";
import type { Drawing, Part } from "../drawing";
import type { Dir } from "../geometry";

// What a kind of part is: how it's drawn (in its own frame, centered, unturned), where lines connect to it, what's
// known about it, and how it behaves on a line. Kinds are drawn as the ISA (5.1) and ISO (10628, 1219) standards draw
// them, at the size of a 10-unit grid that their ports sit on.

export type Category = "valves" | "vessels" | "flow" | "instruments" | "equipment" | "fittings" | "notes";

export const CATEGORIES: { id: Category; name: string }[] = [
    { id: "valves", name: "Valves" },
    { id: "vessels", name: "Tanks and vessels" },
    { id: "flow", name: "Flow elements" },
    { id: "instruments", name: "Instruments" },
    { id: "equipment", name: "Equipment" },
    { id: "fittings", name: "Fittings" },
    { id: "notes", name: "Notes" },
];

/** Where lines connect to a part: a point of its frame, on the grid, and the way a line leaves it. */
export interface Port {
    id: string;
    x: number;
    y: number;
    dir: Dir | null; // null: any way (a junction's)
    inset: number; // how far in from the port the symbol's outline is: its lines are drawn on to it
    many?: boolean; // takes any number of lines, as a junction does
}

export interface Option {
    value: string;
    label: string;
    short?: string; // how it reads on the drawing ("NC")
}

/** Something known about a part: text, with its units, as people write them. */
export interface Field {
    key: string;
    label: string;
    type: "text" | "select" | "fluid" | "channel" | "long";
    options?: Option[];
    placeholder?: string; // an example, with its unit
    prefix?: string; // how it reads under the tag: "Cv " for "Cv 1.2"
}

/** What a part needs to know to draw itself, besides itself. */
export interface DrawContext {
    ink: string; // lines and letters
    paper: string; // behind: what fills a symbol so lines under it don't show through
    muted: string;
    fill: string | null; // its state's color (a valve's NO or NC, or what a test says it is), if it has one
    fluid: string | null; // the color of what it holds (a tank's fluid), if anything
    fluidLabel: string;
    gas: boolean; // what it holds is a gas: a tank's all of it, not its lower part
    pipe: string | null; // the color of a line on it: a hose is drawn as the pipe it is
    states: { no: string; nc: string; fip: string }; // the colors of valves' normal states, for a legend
    lines: number; // how many lines meet it: a junction shows its dot where three or more do
    drawing: Drawing;
    meta: DiagramMeta;
}

/** The diagram's own particulars, for a title block. */
export interface DiagramMeta {
    name: string;
    // Its revision as a title block writes it: a released one's letter ("B"), else its number ("7"), and after a
    // release, which release it follows ("7 (after B)"). "": none.
    revision: string;
    savedAt: string | null; // ISO time of its last save
    by: string; // who made it
}

export interface Kind {
    id: string;
    name: string;
    /** Around everything it draws, in its frame: left, top, right, bottom. */
    box: (part: Part, drawing: Drawing) => readonly [number, number, number, number];
    ports: (part: Part) => Port[];
    fields: Field[];
    draw: (part: Part, context: DrawContext) => ReactNode;
    /** What it's called on the drawing's lists, if more than its kind (a valve's body and actuation). */
    title?: (part: Part) => string;
    state?: boolean; // it has a normal state, NO or NC, which colors it
    reads?: "value" | "state"; // a test's channel shows its value, or its state
    // Where its tag's drawn: beside it (under it, or beside it in a line going down), at its side (a sensor's), in it,
    // or not at all.
    tag: "beside" | "side" | "inside" | "none";
    inline?: readonly [string, string]; // two ports facing apart: it can be dropped into a line
    through?: boolean; // what flows in flows out: a line's fluid carries on through it
    resizable?: boolean; // a region or a box: dragged to a size
    resize?: { step: number; least: readonly [number, number] }; // the steps it's sized in, and its least size
    behind?: boolean; // drawn under everything else
    text?: string; // what its words are called, if it has them (a note's Text, a region's Title)
}

/** An entry in the library: a kind, set up as one of the team's parts is (a solenoid valve: a valve, NC). */
export interface Preset {
    id: string;
    kind: string;
    name: string;
    category: Category;
    prefix: string; // a new one's tag: "SV" for SV-1, SV-2...; "" for none
    keywords: string; // other names it's searched by
    props?: Record<string, string>;
    shown?: string[];
    text?: string;
    w?: number;
    h?: number;
}

// --- fields many kinds have ----------------------------------------------------------------------------------------

export const NORMAL: Field = {
    key: "normal",
    label: "Normal state",
    type: "select",
    options: [
        { value: "", label: "Not set" },
        { value: "NO", label: "Normally open", short: "NO" },
        { value: "NC", label: "Normally closed", short: "NC" },
        { value: "FIP", label: "Fails in place (double-acting)", short: "FIP" },
    ],
};

export const SIZE: Field = { key: "size", label: "Size", type: "text", placeholder: "1/2 in" };
export const CV: Field = { key: "cv", label: "Cv", type: "text", placeholder: "1.2", prefix: "Cv " };
/** The most pressure it's rated to hold, as each component (and line) on a P&ID lists it: a tank's MEOP is beside. */
export const MAWP: Field = { key: "mawp", label: "MAWP", type: "text", placeholder: "3000 psi", prefix: "MAWP " };
export const MODEL: Field = { key: "model", label: "Model", type: "text", placeholder: "Swagelok SS-45S8" };
export const MATERIAL: Field = { key: "material", label: "Material", type: "text", placeholder: "316 SS" };
export const NOTES: Field = { key: "notes", label: "Notes", type: "long" };
export const CHANNEL: Field = { key: "channel", label: "Test channel", type: "channel" };
export const DAQ: Field = { key: "daq", label: "DAQ channel", type: "text", placeholder: "AI3" };
export const RANGE: Field = { key: "range", label: "Range", type: "text", placeholder: "0-1000 psi" };
export const OUTPUT: Field = { key: "output", label: "Output", type: "text", placeholder: "0.5-4.5 V" };
export const HOLDS: Field = { key: "fluid", label: "Holds", type: "fluid" };
export const VOLUME: Field = { key: "volume", label: "Volume", type: "text", placeholder: "10 L" };
export const MEOP: Field = { key: "meop", label: "MEOP", type: "text", placeholder: "750 psi", prefix: "MEOP " };
export const SET: Field = { key: "set", label: "Set pressure", type: "text", placeholder: "500 psi", prefix: "Set " };

export const ACTUATION: Field = {
    key: "actuation",
    label: "Actuation",
    type: "select",
    options: [
        { value: "", label: "None shown" },
        { value: "manual", label: "Manual (handle)" },
        { value: "solenoid", label: "Solenoid" },
        { value: "pneumatic", label: "Pneumatic" },
        { value: "motor", label: "Motor" },
    ],
};

/** A part's ports, two facing apart across its middle: the ones a valve, an orifice, or a filter has. */
export const inlinePorts = (inset: number, half = 20): Port[] => [
    { id: "a", x: -half, y: 0, dir: "left", inset },
    { id: "b", x: half, y: 0, dir: "right", inset },
];
