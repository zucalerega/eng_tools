import type { Part } from "../drawing";
import { transducers } from "../testdata";
import { ink, Letters } from "./draw";
import { CHANNEL, DAQ, MAWP, MODEL, NOTES, OUTPUT, RANGE, type Field, type Kind, type Port } from "./kinds";

// Instruments, as the team draws them: a small box with the letter of what it measures (P for pressure, T for
// temperature, ISA 5.1's first letters), its tag at its side, connected to the line it measures by a tap from any side.
// Two or three transducers on one tap (a duplicated or triplicated one, for a measurement that mustn't be lost) are two
// or three boxes side by side, A, B, and C, each reading its own channel (testdata.ts). A test's value shows beside it.

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

/** What a box says it measures: ISA 5.1's first letter for it (W for a weight or force, Z for a position). */
const LETTER: Record<string, string> = {
    pressure: "P",
    temperature: "T",
    rtd: "T",
    flow: "F",
    force: "W",
    level: "L",
    position: "Z",
    switch: "P",
    dp: "ΔP",
};

const letterOf = (part: Part): string => LETTER[part.props.type ?? ""] ?? (splitTag(part.tag)[0][0] || "?");

export const COUNT: Field = {
    key: "count",
    label: "Transducers",
    type: "select",
    options: [
        { value: "", label: "One" },
        { value: "2", label: "Two on one tap (duplicated)", short: "×2" },
        { value: "3", label: "Three on one tap (triplicated)", short: "×3" },
    ],
};

const SIZE = 20; // a box's side: small beside a tank or an engine

/** Half how wide it is: a box for each transducer, side by side. */
const halfWidth = (part: Part) => (SIZE / 2) * transducers(part);

/** Its taps: the middle of each side. A duplicated or triplicated one's sides are 20 or 30 out, still on the grid. */
function sensorPorts(part: Part): Port[] {
    const half = halfWidth(part);
    return [
        { id: "top", x: 0, y: -SIZE / 2, dir: "up", inset: 0 },
        { id: "right", x: half, y: 0, dir: "right", inset: 0 },
        { id: "bottom", x: 0, y: SIZE / 2, dir: "down", inset: 0 },
        { id: "left", x: -half, y: 0, dir: "left", inset: 0 },
    ];
}

export const instrument: Kind = {
    id: "instrument",
    name: "Instrument",
    box: (part) => [-halfWidth(part), -SIZE / 2, halfWidth(part), SIZE / 2],
    ports: sensorPorts,
    fields: [MEASURES, COUNT, RANGE, OUTPUT, MAWP, MODEL, DAQ, CHANNEL, NOTES],
    title: (part) => {
        const what = MEASURES.options?.find((option) => option.value === part.props.type)?.label ?? "Instrument";
        const count = transducers(part);
        return count === 1 ? what : `${count === 2 ? "Duplicated" : "Triplicated"} ${what.toLowerCase()}`;
    },
    reads: "value",
    tag: "side",
    draw: (part, context) => {
        const count = transducers(part);
        const letter = letterOf(part);
        return (
            <>
                {Array.from({ length: count }, (_, index) => {
                    const left = -halfWidth(part) + index * SIZE;
                    return (
                        <g key={index}>
                            <rect
                                x={left}
                                y={-SIZE / 2}
                                width={SIZE}
                                height={SIZE}
                                fill={context.paper}
                                {...ink(context, 1.4)}
                            />
                            <Letters
                                part={part}
                                x={left + SIZE / 2}
                                y={count > 1 ? -1 : 0}
                                size={letter.length > 1 ? 7.5 : 10}
                                fill={context.ink}
                                bold
                            >
                                {letter}
                            </Letters>
                            {count > 1 && (
                                <Letters part={part} x={left + SIZE / 2} y={6.5} size={5.5} fill={context.muted}>
                                    {"ABC"[index]}
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
