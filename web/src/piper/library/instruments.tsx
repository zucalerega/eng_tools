import type { Part } from "../drawing";
import { ink, Letters } from "./draw";
import { CHANNEL, DAQ, MAWP, MODEL, NOTES, OUTPUT, RANGE, type Field, type Kind, type Port } from "./kinds";

// Instruments, as ISA 5.1 draws them: a bubble with what it measures in letters over its loop's number (PT over 101),
// connected to the line it measures by a tap from any side. A test's channel shows its value beside it.

/** An instrument tag's letters and the rest: "PT-101" is PT and 101, "TC-OX-1" TC and OX-1. */
export function splitTag(tag: string): [string, string] {
    const match = /^([A-Za-z]+)[\s_-]*(.*)$/.exec(tag.trim());
    return match ? [match[1]!.toUpperCase(), match[2]!] : ["", tag.trim()];
}

const BUBBLE_PORTS: Port[] = [
    { id: "top", x: 0, y: -20, dir: "up", inset: 5 },
    { id: "right", x: 20, y: 0, dir: "right", inset: 5 },
    { id: "bottom", x: 0, y: 20, dir: "down", inset: 5 },
    { id: "left", x: -20, y: 0, dir: "left", inset: 5 },
];

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

function Bubble({
    part,
    letters,
    rest,
    ink: color,
    paper,
}: {
    part: Part;
    letters: string;
    rest: string;
    ink: string;
    paper: string;
}) {
    const small = Math.max(letters.length, rest.length) > 4;
    return (
        <>
            <circle r={15} fill={paper} stroke={color} strokeWidth={1.6} />
            {letters && rest ? (
                <>
                    <Letters part={part} x={0} y={-4.5} size={small ? 7.5 : 9} fill={color} bold>
                        {letters}
                    </Letters>
                    <Letters part={part} x={0} y={6} size={small ? 6.5 : 8} fill={color}>
                        {rest}
                    </Letters>
                </>
            ) : (
                <Letters part={part} x={0} y={0} size={small ? 7.5 : 9} fill={color} bold>
                    {letters || rest}
                </Letters>
            )}
        </>
    );
}

export const instrument: Kind = {
    id: "instrument",
    name: "Instrument",
    box: () => [-20, -20, 20, 20],
    ports: () => BUBBLE_PORTS,
    fields: [MEASURES, RANGE, OUTPUT, MAWP, MODEL, DAQ, CHANNEL, NOTES],
    title: (part) => MEASURES.options?.find((option) => option.value === part.props.type)?.label ?? "Instrument",
    reads: "value",
    tag: "inside",
    draw: (part, context) => {
        const [letters, rest] = splitTag(part.tag);
        return <Bubble part={part} letters={letters} rest={rest} ink={context.ink} paper={context.paper} />;
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
