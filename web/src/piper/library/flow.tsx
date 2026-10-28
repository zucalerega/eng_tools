import { ink } from "./draw";
import { CHANNEL, DAQ, inlinePorts, MAWP, MODEL, NOTES, RANGE, SIZE, type Field, type Kind } from "./kinds";

// What's put into a line to measure or shape its flow: orifices, venturis, flow meters, filters.

const CD: Field = { key: "cd", label: "Discharge coefficient", type: "text", placeholder: "0.61", prefix: "Cd " };

export const orifice: Kind = {
    id: "orifice",
    name: "Orifice",
    box: () => [-20, -9, 20, 9],
    ports: () => inlinePorts(0), // the line runs on through it, as ISA draws an orifice plate in a pipe
    fields: [
        { key: "diameter", label: "Diameter", type: "text", placeholder: "0.062 in", prefix: "Ø " },
        CD,
        MAWP,
        MODEL,
        NOTES,
    ],
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (_part, context) => (
        <>
            <path d="M-20 0 H20" stroke={context.pipe ?? context.ink} strokeWidth={2.5} />
            <path d="M-2.5 -8 V8 M2.5 -8 V8" {...ink(context, 1.6)} />
        </>
    ),
};

/** A venturi: converging, a throat, diverging; cavitating, it holds the flow whatever's downstream. */
export const venturi: Kind = {
    id: "venturi",
    name: "Venturi",
    box: () => [-20, -9, 20, 9],
    ports: () => inlinePorts(0),
    fields: [
        { key: "throat", label: "Throat diameter", type: "text", placeholder: "0.080 in", prefix: "Ø " },
        CD,
        {
            key: "cavitating",
            label: "Cavitating",
            type: "select",
            options: [
                { value: "", label: "No" },
                { value: "yes", label: "Yes", short: "CAV" },
            ],
        },
        MAWP,
        MODEL,
        NOTES,
    ],
    title: (part) => (part.props.cavitating === "yes" ? "Cavitating venturi" : "Venturi"),
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (_part, context) => (
        <path d="M-20 -9 L-6 -4 H6 L20 -9 V9 L6 4 H-6 L-20 9 Z" fill={context.paper} {...ink(context)} />
    ),
};

/** A turbine flow meter: a propeller in the line, whose channel says the flow. */
export const flowmeter: Kind = {
    id: "flowmeter",
    name: "Flow meter",
    box: () => [-20, -10, 20, 10],
    ports: () => inlinePorts(5),
    fields: [
        {
            key: "type",
            label: "Type",
            type: "select",
            options: [
                { value: "", label: "Turbine" },
                { value: "coriolis", label: "Coriolis" },
                { value: "venturi", label: "Venturi" },
                { value: "other", label: "Other" },
            ],
        },
        RANGE,
        SIZE,
        MAWP,
        MODEL,
        DAQ,
        CHANNEL,
        NOTES,
    ],
    reads: "value",
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (_part, context) => (
        <>
            <rect x={-15} y={-10} width={30} height={20} fill={context.paper} {...ink(context)} />
            <path d="M0 0 L-7 -5 L-7 5 Z M0 0 L7 -5 L7 5 Z" fill={context.ink} {...ink(context, 1)} />
        </>
    ),
};

export const filter: Kind = {
    id: "filter",
    name: "Filter",
    box: () => [-20, -12, 20, 12],
    ports: () => inlinePorts(8),
    fields: [{ key: "rating", label: "Rating", type: "text", placeholder: "10 µm" }, SIZE, MAWP, MODEL, NOTES],
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (_part, context) => (
        <>
            <path d="M-12 0 L0 -12 L12 0 L0 12 Z" fill={context.paper} {...ink(context)} />
            <path d="M0 -12 V12" strokeDasharray="3 2" {...ink(context, 1.2)} />
        </>
    ),
};

/** A diffuser's spread: arrows from along its perforated face, fanning out the way it lets the flow go. */
const SPREAD = [-1, 0, 1].map((side) => {
    const [cos, sin] = [Math.cos((side * 32 * Math.PI) / 180), Math.sin((side * 32 * Math.PI) / 180)];
    const start = { x: 4, y: side * 4 };
    const length = side === 0 ? 11 : 10;
    const tip = { x: start.x + length * cos, y: start.y + length * sin };
    const back = (by: number, across: number) =>
        `${(tip.x - cos * by - sin * across).toFixed(2)} ${(tip.y - sin * by + cos * across).toFixed(2)}`;
    return {
        line: `M${start.x} ${start.y} L${back(3.5, 0)}`,
        head: `M${tip.x.toFixed(2)} ${tip.y.toFixed(2)} L${back(4, 1.8)} L${back(4, -1.8)} Z`,
    };
});

/**
 * A diffuser, as a tank's pressurant comes in through one: its body on the line, a perforated face (dashed) the flow
 * leaves by, and arrows spreading out from it, so the gas comes in gently rather than jetting into what's there.
 */
export const diffuser: Kind = {
    id: "diffuser",
    name: "Diffuser",
    box: () => [-20, -11, 20, 11],
    ports: () => [
        { id: "a", x: -20, y: 0, dir: "left", inset: 11 },
        { id: "b", x: 20, y: 0, dir: "right", inset: 5 },
    ],
    fields: [{ key: "holes", label: "Holes", type: "text", placeholder: "24 × 0.040 in" }, SIZE, MAWP, MODEL, NOTES],
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (_part, context) => (
        <>
            <rect x={-9} y={-9} width={8} height={18} fill={context.paper} {...ink(context, 1.4)} />
            <path d="M1.5 -9 V9" {...ink(context, 1.6)} strokeDasharray="3 2" strokeLinecap="butt" />
            {SPREAD.map(({ line, head }, index) => (
                <g key={index}>
                    <path d={line} fill="none" {...ink(context, 1.2)} />
                    <path d={head} fill={context.ink} {...ink(context, 0.8)} />
                </g>
            ))}
        </>
    ),
};

export const FLOW_KINDS: Kind[] = [orifice, venturi, flowmeter, filter, diffuser];
