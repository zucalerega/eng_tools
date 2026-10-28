import type { Part } from "../drawing";
import { transducers } from "../testdata";
import { ink, Letters } from "./draw";
import { CHANNEL, DAQ, MAWP, MODEL, NOTES, OUTPUT, RANGE, SET, type Field, type Kind, type Port } from "./kinds";

// Instruments, as ISA 5.1 draws them: a bubble with the first letter of what it measures (P for pressure, T for
// temperature), whatever its tag says, and its whole tag at its side, connected to the line it measures by a tap from any
// side. Two or three transducers on one tap (a duplicated or triplicated one, for a measurement that mustn't be lost) are
// two or three bubbles side by side, A, B, and C, each reading its own channel (testdata.ts). A test's value shows
// beside it.

/** An instrument tag's letters and the rest: "PT-101" is PT and 101, "TC-OX-1" TC and OX-1. */
export function splitTag(tag: string): [string, string] {
    const match = /^([A-Za-z]+)[\s_-]*(.*)$/.exec(tag.trim());
    return match ? [match[1]!.toUpperCase(), match[2]!] : ["", tag.trim()];
}

export const MEASURES: Field = {
    key: "type",
    label: "Measures",
    type: "select",
    options: [
        { value: "pressure", label: "Pressure transducer" },
        { value: "temperature", label: "Thermocouple" },
        { value: "rtd", label: "RTD" },
        { value: "flow", label: "Flow transmitter" },
        { value: "force", label: "Load cell" },
        { value: "level", label: "Level sensor" },
        { value: "position", label: "Position sensor" },
        { value: "switch", label: "Pressure switch" },
        { value: "dp", label: "Differential pressure transducer" },
        { value: "other", label: "Instrument" },
    ],
};

/** What a bubble says it measures: ISA 5.1's first letter for it (W for a weight or force, Z for a position, PD for a
 * pressure difference: PDFs can't print a Δ). A sensor's tag is its name, and stays beside it. */
const LETTER: Record<string, string> = {
    pressure: "P",
    temperature: "T",
    rtd: "T",
    flow: "F",
    force: "W",
    level: "L",
    position: "Z",
    switch: "P",
    dp: "PD",
};

/** A bubble's letters: what it measures, or for an instrument of no kind the library knows, its tag's first letter. */
const lettersOf = (part: Part): string => LETTER[part.props.type ?? ""] ?? (splitTag(part.tag)[0].charAt(0) || "?");

/** How many sensors are on one tap: a pressure transducer's, a thermocouple's, whatever it measures. */
export const COUNT: Field = {
    key: "count",
    label: "Sensors",
    type: "select",
    options: [
        { value: "", label: "One" },
        { value: "2", label: "Two on one tap (duplicated)", short: "×2" },
        { value: "3", label: "Three on one tap (triplicated)", short: "×3" },
    ],
};

// What's known of a sensor, by what it measures: its range and output, and the pressure it holds (its MAWP: it's on the
// line, so it's in the system's pressure boundary), and its model, each with an example in the units it's written in;
// and a thermocouple's or an RTD's own (its type, its probe). A load cell and a position sensor aren't on a line: no MAWP.

export const TC_TYPE: Field = {
    key: "tc",
    label: "Thermocouple type",
    type: "select",
    options: [
        { value: "", label: "Not set" },
        { value: "K", label: "K (chromel-alumel)", short: "Type K" },
        { value: "T", label: "T (copper-constantan)", short: "Type T" },
        { value: "J", label: "J (iron-constantan)", short: "Type J" },
        { value: "E", label: "E (chromel-constantan)", short: "Type E" },
        { value: "N", label: "N (nicrosil-nisil)", short: "Type N" },
        { value: "R", label: "R (platinum-rhodium)", short: "Type R" },
        { value: "S", label: "S (platinum-rhodium)", short: "Type S" },
        { value: "B", label: "B (platinum-rhodium)", short: "Type B" },
    ],
};

export const JUNCTION: Field = {
    key: "junction",
    label: "Junction",
    type: "select",
    options: [
        { value: "", label: "Not set" },
        { value: "grounded", label: "Grounded" },
        { value: "ungrounded", label: "Ungrounded" },
        { value: "exposed", label: "Exposed" },
    ],
};

export const PROBE: Field = { key: "probe", label: "Probe", type: "text", placeholder: "1/8 in × 6 in" };
export const SHEATH: Field = { key: "sheath", label: "Sheath", type: "text", placeholder: "316 SS" };

export const ELEMENT: Field = {
    key: "element",
    label: "Element",
    type: "select",
    options: [
        { value: "", label: "Not set" },
        { value: "pt100", label: "Pt100", short: "Pt100" },
        { value: "pt1000", label: "Pt1000", short: "Pt1000" },
    ],
};

export const WIRES: Field = {
    key: "wires",
    label: "Wires",
    type: "select",
    options: [
        { value: "", label: "Not set" },
        { value: "2", label: "2-wire" },
        { value: "3", label: "3-wire" },
        { value: "4", label: "4-wire" },
    ],
};

/** A field with an example of its own: a range in its sensor's units. */
const withExample = (field: Field, placeholder: string): Field => ({ ...field, placeholder });

const SPECS: Record<string, Field[]> = {
    pressure: [
        withExample(RANGE, "0-1000 psi"),
        withExample(OUTPUT, "0.5-4.5 V"),
        MAWP,
        withExample(MODEL, "Omega PX309-1KG5V"),
    ],
    temperature: [
        TC_TYPE,
        JUNCTION,
        PROBE,
        SHEATH,
        withExample(RANGE, "0-1000 °F"),
        MAWP,
        withExample(MODEL, "Omega KMQSS-125U-6"),
    ],
    rtd: [
        ELEMENT,
        WIRES,
        PROBE,
        SHEATH,
        withExample(RANGE, "0-500 °F"),
        MAWP,
        withExample(MODEL, "Omega PR-21-2-100-1/8-6"),
    ],
    flow: [
        withExample(RANGE, "0-5 gpm"),
        withExample(OUTPUT, "4-20 mA"),
        MAWP,
        withExample(MODEL, "Flow Technology FT4-8"),
    ],
    force: [withExample(RANGE, "0-500 lbf"), withExample(OUTPUT, "2 mV/V"), withExample(MODEL, "Interface 1210")],
    level: [withExample(RANGE, "0-24 in"), withExample(OUTPUT, "4-20 mA"), MAWP, MODEL],
    position: [withExample(RANGE, "0-2 in"), withExample(OUTPUT, "0-10 V"), MODEL],
    switch: [withExample(SET, "500 psi"), MAWP, MODEL],
    dp: [withExample(RANGE, "0-50 psid"), withExample(OUTPUT, "0.5-4.5 V"), MAWP, MODEL],
    other: [RANGE, OUTPUT, MAWP, MODEL],
};

/** A sensor's fields: what it measures, how many, its own specs for that, then its channels and notes. */
const sensorFields = (type: string): Field[] => [
    MEASURES,
    COUNT,
    ...(SPECS[type] ?? SPECS.other!),
    DAQ,
    CHANNEL,
    NOTES,
];

const RADIUS = 15; // a bubble's

/** How far out its side taps are: on the grid, at least 5 past its outer bubbles. */
const sideOf = (part: Part) => Math.ceil((RADIUS * transducers(part) + 5) / 10) * 10;

/**
 * Its taps: on each side, drawn on to the bubbles. A duplicated one's top and bottom taps reach in to where its two
 * bubbles meet, so a line to it ends on both.
 */
function bubblePorts(part: Part): Port[] {
    const count = transducers(part);
    const side = sideOf(part);
    const middle = count === 2 ? 20 : 5;
    return [
        { id: "top", x: 0, y: -20, dir: "up", inset: middle },
        { id: "right", x: side, y: 0, dir: "right", inset: side - RADIUS * count },
        { id: "bottom", x: 0, y: 20, dir: "down", inset: middle },
        { id: "left", x: -side, y: 0, dir: "left", inset: side - RADIUS * count },
    ];
}

export const instrument: Kind = {
    id: "instrument",
    name: "Instrument",
    box: (part) => [-sideOf(part), -20, sideOf(part), 20],
    ports: bubblePorts,
    // Every sensor's, for what's said of any one (a thermocouple's type, under its tag), whatever it measures now.
    fields: [
        ...new Map(
            Object.keys(SPECS).flatMap((type) => sensorFields(type).map((field) => [field.key, field])),
        ).values(),
    ],
    fieldsOf: (part) => sensorFields(part.props.type ?? ""),
    title: (part) => {
        const what = MEASURES.options?.find((option) => option.value === part.props.type)?.label ?? "Instrument";
        const count = transducers(part);
        return count === 1 ? what : `${count === 2 ? "Duplicated" : "Triplicated"} ${what.toLowerCase()}`;
    },
    reads: "value",
    tag: "side",
    draw: (part, context) => {
        const count = transducers(part);
        const letters = lettersOf(part);
        const size = (count > 1 ? 9.5 : 11) - (letters.length > 1 ? 2 : 0);
        return (
            <>
                {Array.from({ length: count }, (_, index) => {
                    const x = (index - (count - 1) / 2) * 2 * RADIUS;
                    return (
                        <g key={index}>
                            <circle cx={x} r={RADIUS} fill={context.paper} stroke={context.ink} strokeWidth={1.6} />
                            {count > 1 ? (
                                <>
                                    <Letters part={part} x={x} y={-4.5} size={size} fill={context.ink} bold>
                                        {letters}
                                    </Letters>
                                    <Letters part={part} x={x} y={6} size={8} fill={context.ink}>
                                        {"ABC"[index]}
                                    </Letters>
                                </>
                            ) : (
                                <Letters part={part} x={x} y={0} size={size} fill={context.ink} bold>
                                    {letters}
                                </Letters>
                            )}
                        </g>
                    );
                })}
            </>
        );
    },
};

/** A pressure gauge: a dial, read where it is rather than logged. */
export const gauge: Kind = {
    id: "gauge",
    name: "Pressure gauge",
    box: () => [-15, -15, 15, 20],
    ports: () => [{ id: "bottom", x: 0, y: 20, dir: "down", inset: 5 }],
    fields: [RANGE, MAWP, MODEL, NOTES],
    tag: "beside",
    draw: (_part, context) => (
        <>
            <circle r={15} fill={context.paper} {...ink(context)} />
            <path d="M-10.6 8 A13 13 0 1 1 10.6 8" fill="none" strokeDasharray="1.5 3.2" {...ink(context, 1)} />
            <path d="M0 0 L7 -8" {...ink(context, 1.6)} />
            <circle r={2.2} fill={context.ink} />
        </>
    ),
};

export const INSTRUMENT_KINDS: Kind[] = [instrument, gauge];
