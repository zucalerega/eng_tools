import type { Part } from "../drawing";
import { transducers } from "../testdata";
import { ink, Letters } from "./draw";
import { CHANNEL, DAQ, MAWP, MODEL, NOTES, OUTPUT, RANGE, type Field, type Kind, type Port } from "./kinds";

// Instruments, as ISA 5.1 draws them: a bubble with what it measures in its tag's letters (PT), its tag at its side,
// connected to the line it measures by a tap from any side. Two or three transducers on one tap (a duplicated or
// triplicated one, for a measurement that mustn't be lost) are two or three bubbles side by side, A, B, and C, each
// reading its own channel (testdata.ts). A test's value shows beside it.

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

/** What a bubble says when its tag has no letters of its own: the letters the library tags it with. */
const LETTERS = new Map([
    ["pressure", "PT"],
    ["temperature", "TC"],
    ["rtd", "RTD"],
    ["flow", "FT"],
    ["force", "LC"],
    ["level", "LT"],
    ["position", "ZT"],
    ["switch", "PS"],
    ["dp", "DPT"],
]);

const lettersOf = (part: Part): string => splitTag(part.tag)[0] || (LETTERS.get(part.props.type ?? "") ?? "");

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
        const letters = lettersOf(part);
        const size = letters.length > 3 ? 7.5 : 9;
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
