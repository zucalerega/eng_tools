import type { Part } from "../drawing";
import { ink, Letters } from "./draw";
import {
    ACTUATION,
    CHANNEL,
    CV,
    inlinePorts,
    MODEL,
    NORMAL,
    NOTES,
    RATING,
    SET,
    SIZE,
    type DrawContext,
    type Field,
    type Kind,
} from "./kinds";

// Valves, as ISA 5.1 draws them: a body of two triangles meeting at the middle (a bowtie), told apart by what's at
// its middle, with what works it on a stem above. Ports are 20 out from the middle, the body's ends 15.

/** The body's two triangles, point to point. */
const BOWTIE = "M-15 -10 L15 10 L15 -10 L-15 10 Z";

export const BODY: Field = {
    key: "body",
    label: "Body",
    type: "select",
    options: [
        { value: "ball", label: "Ball" },
        { value: "gate", label: "Gate" },
        { value: "globe", label: "Globe" },
        { value: "needle", label: "Needle" },
        { value: "butterfly", label: "Butterfly" },
        { value: "plug", label: "Plug" },
    ],
};

/** What's at a body's middle: a ball's hollow circle, a globe's dot, a needle's point... */
function bodyMark(body: string, context: DrawContext) {
    switch (body) {
        case "ball":
            return <circle r={5} fill={context.paper} {...ink(context)} />;
        case "globe":
            return <circle r={4} fill={context.ink} />;
        case "needle":
            return <path d="M-6 -10 L6 -10 L0 -1 Z" fill={context.ink} {...ink(context, 1)} />;
        case "butterfly":
            return (
                <>
                    <path d="M0 -10 V10" {...ink(context, 2)} />
                    <circle r={2.5} fill={context.ink} />
                </>
            );
        case "plug":
            return <rect x={-4} y={-3} width={8} height={6} fill={context.ink} />;
        default:
            return null; // gate: the bowtie alone
    }
}

/** How high an actuator reaches above the body's middle. */
function actuatorTop(actuation: string | undefined): number {
    switch (actuation) {
        case "manual":
            return 19;
        case "solenoid":
            return 35;
        case "pneumatic":
            return 29;
        case "motor":
            return 37;
        default:
            return 10;
    }
}

/** What works a valve, on a stem up from its middle: a handle, a solenoid, a diaphragm, a motor. */
function Actuator({ part, context }: { part: Part; context: DrawContext }) {
    const actuation = part.props.actuation ?? "";
    if (!actuation) {
        return null;
    }
    const stem = <path d="M0 0 V-18" {...ink(context)} />;
    switch (actuation) {
        case "manual":
            return (
                <>
                    {stem}
                    <path d="M-8 -18 H8" {...ink(context, 2.2)} />
                </>
            );
        case "solenoid":
            return (
                <>
                    {stem}
                    <rect x={-8} y={-34} width={16} height={16} fill={context.paper} {...ink(context)} />
                    <Letters part={part} x={0} y={-26} size={10} fill={context.ink} bold>
                        S
                    </Letters>
                </>
            );
        case "pneumatic":
            return (
                <>
                    {stem}
                    <path d="M-10 -18 A10 10 0 0 1 10 -18 Z" fill={context.paper} {...ink(context)} />
                </>
            );
        case "motor":
            return (
                <>
                    {stem}
                    <circle cy={-27} r={9} fill={context.paper} {...ink(context)} />
                    <Letters part={part} x={0} y={-27} size={10} fill={context.ink} bold>
                        M
                    </Letters>
                </>
            );
        default:
            return null;
    }
}

/** A valve's name: its body's, and how it's worked unless by hand ("Pneumatic ball valve"); a solenoid's is its own. */
function valveTitle(part: Part): string {
    const body = BODY.options?.find((option) => option.value === part.props.body)?.label ?? "Gate";
    switch (part.props.actuation) {
        case "solenoid":
            return "Solenoid valve";
        case "pneumatic":
            return `Pneumatic ${body.toLowerCase()} valve`;
        case "motor":
            return `Motorized ${body.toLowerCase()} valve`;
        default:
            return `${body} valve`;
    }
}

export const valve: Kind = {
    id: "valve",
    name: "Valve",
    box: (part) => [-20, -actuatorTop(part.props.actuation), 20, 10],
    ports: () => inlinePorts(5),
    fields: [BODY, ACTUATION, NORMAL, SIZE, CV, RATING, MODEL, CHANNEL, NOTES],
    title: valveTitle,
    state: true,
    reads: "state",
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (part, context) => (
        <>
            <Actuator part={part} context={context} />
            <path d={BOWTIE} fill={context.fill ?? context.paper} {...ink(context)} />
            {bodyMark(part.props.body ?? "gate", context)}
        </>
    ),
};

// A swing check's two seats, and its disc: hinged at the top of the seat flow comes in by, it swings toward the bottom
// of the one flow leaves by, drawn as an arrow the way flow goes.
const HINGE = { x: -12, y: -8 };
const TIP = { x: 12, y: 8 };

/** The disc's line, from the hinge to the arrowhead's notch, and its arrowhead, `length` long and `half` out to each
 * side: the point, a barb, the notch, a barb. */
function disc(length: number, half: number): { line: string; head: string } {
    const run = Math.hypot(TIP.x - HINGE.x, TIP.y - HINGE.y);
    const [ux, uy] = [(TIP.x - HINGE.x) / run, (TIP.y - HINGE.y) / run];
    // A point back from the tip along the disc, and out to one side of it.
    const at = (back: number, side: number) =>
        `${(TIP.x - ux * back - uy * side).toFixed(2)} ${(TIP.y - uy * back + ux * side).toFixed(2)}`;
    return {
        line: `M${HINGE.x} ${HINGE.y} L${at(length / 2, 0)}`,
        head: `M${TIP.x} ${TIP.y} L${at(length, half)} L${at(length / 2, 0)} L${at(length, -half)} Z`,
    };
}

const DISC = disc(8.5, 3.9);

/** A check valve, as a swing check: the dot is its disc's hinge, on the side flow comes in by (port a), and the arrow
 * points the way flow goes, to port b. */
export const check: Kind = {
    id: "check",
    name: "Check valve",
    box: () => [-20, -11, 20, 10],
    ports: () => inlinePorts(20 + HINGE.x), // lines end at the seats
    fields: [
        { key: "cracking", label: "Cracking pressure", type: "text", placeholder: "1 psi" },
        SIZE,
        CV,
        MODEL,
        NOTES,
    ],
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (_part, context) => (
        <>
            <path d={`M${HINGE.x} ${HINGE.y} V${TIP.y} M${TIP.x} ${HINGE.y} V${TIP.y}`} {...ink(context, 2)} />
            <path d={DISC.line} fill="none" {...ink(context)} />
            <path d={DISC.head} fill={context.ink} {...ink(context, 1)} />
            <circle cx={HINGE.x} cy={HINGE.y} r={2.8} fill={context.ink} />
        </>
    ),
};

/** A relief valve (PRV): in from below, out to the side, held shut by its spring until its set pressure. */
export const relief: Kind = {
    id: "relief",
    name: "Relief valve",
    box: () => [-10, -26, 20, 20],
    ports: () => [
        { id: "in", x: 0, y: 20, dir: "down", inset: 5 },
        { id: "out", x: 20, y: 0, dir: "right", inset: 5 },
    ],
    fields: [
        SET,
        SIZE,
        { key: "capacity", label: "Flow capacity", type: "text", placeholder: "0.5 lbm/s" },
        MODEL,
        NOTES,
    ],
    tag: "beside",
    through: true,
    draw: (_part, context) => (
        <>
            <path d="M-10 15 L10 15 L0 0 Z M15 -10 L15 10 L0 0 Z" fill={context.paper} {...ink(context)} />
            <path d="M0 0 V-6 L-5 -9 L5 -13 L-5 -17 L5 -21 L0 -24 M-6 -24 H6" fill="none" {...ink(context)} />
        </>
    ),
};

/** A pressure regulator: a valve worked by a diaphragm against a spring, sensing the pressure after it. */
export const regulator: Kind = {
    id: "regulator",
    name: "Pressure regulator",
    box: () => [-20, -37, 20, 10],
    ports: () => inlinePorts(5),
    fields: [
        SET,
        {
            key: "type",
            label: "Type",
            type: "select",
            options: [
                { value: "", label: "Pressure-reducing" },
                { value: "dome", label: "Dome-loaded" },
                { value: "back", label: "Back-pressure" },
            ],
        },
        RATING,
        CV,
        SIZE,
        MODEL,
        NOTES,
    ],
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (part, context) => (
        <>
            <path d="M10 -14 H18 V-4" fill="none" strokeDasharray="3 2" {...ink(context, 1.2)} />
            <path d="M0 0 V-14" {...ink(context)} />
            <path d="M-10 -14 A10 10 0 0 1 10 -14 Z" fill={context.paper} {...ink(context)} />
            {part.props.type === "dome" ? (
                <path d="M0 -24 V-34 M-5 -34 H5" fill="none" {...ink(context)} />
            ) : (
                <path d="M0 -24 L-4 -27 L4 -30 L-4 -33 L0 -36" fill="none" {...ink(context)} />
            )}
            <path d={BOWTIE} fill={context.paper} {...ink(context)} />
        </>
    ),
};

/** A burst disc: a dome between two flanges, bulging the way it bursts. */
export const burst: Kind = {
    id: "burst",
    name: "Burst disc",
    box: () => [-20, -11, 20, 11],
    ports: () => inlinePorts(15),
    fields: [{ key: "burst", label: "Burst pressure", type: "text", placeholder: "900 psi" }, SIZE, MODEL, NOTES],
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (_part, context) => (
        <>
            <path d="M-5 -11 V11 M5 -11 V11" {...ink(context, 2)} />
            <path d="M-5 -9 Q7 0 -5 9" fill="none" {...ink(context)} />
        </>
    ),
};

/** A three-way valve: a bowtie with a third triangle down, for the third port. */
export const valve3: Kind = {
    id: "valve3",
    name: "Three-way valve",
    box: (part) => [-20, -actuatorTop(part.props.actuation), 20, 20],
    ports: () => [...inlinePorts(5), { id: "c", x: 0, y: 20, dir: "down", inset: 5 }],
    fields: [ACTUATION, SIZE, CV, RATING, MODEL, CHANNEL, NOTES],
    reads: "state",
    tag: "beside",
    through: true,
    draw: (part, context) => (
        <>
            <Actuator part={part} context={context} />
            <path
                d="M-15 -10 L0 0 L-15 10 Z M15 -10 L0 0 L15 10 Z M-10 15 L0 0 L10 15 Z"
                fill={context.fill ?? context.paper}
                {...ink(context)}
            />
            <circle r={4} fill={context.paper} {...ink(context)} />
        </>
    ),
};

/** An angle valve: in from the side, out below. */
export const angle: Kind = {
    id: "angle",
    name: "Angle valve",
    box: (part) => [-20, -actuatorTop(part.props.actuation), 10, 20],
    ports: () => [
        { id: "a", x: -20, y: 0, dir: "left", inset: 5 },
        { id: "b", x: 0, y: 20, dir: "down", inset: 5 },
    ],
    fields: [ACTUATION, NORMAL, SIZE, CV, RATING, MODEL, CHANNEL, NOTES],
    state: true,
    reads: "state",
    tag: "beside",
    through: true,
    draw: (part, context) => (
        <>
            <Actuator part={part} context={context} />
            <path
                d="M-15 -10 L0 0 L-15 10 Z M-10 15 L0 0 L10 15 Z"
                fill={context.fill ?? context.paper}
                {...ink(context)}
            />
        </>
    ),
};

/** A quick disconnect: its two halves, each a check that shuts when they're parted. */
export const qd: Kind = {
    id: "qd",
    name: "Quick disconnect",
    box: () => [-20, -9, 20, 9],
    ports: () => inlinePorts(6),
    fields: [
        {
            key: "connected",
            label: "Connected",
            type: "select",
            options: [
                { value: "", label: "Connected" },
                { value: "no", label: "Parted", short: "Parted" },
            ],
        },
        SIZE,
        MODEL,
        NOTES,
    ],
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (part, context) => {
        const apart = part.props.connected === "no" ? 4 : 0;
        return (
            <>
                <path
                    d={`M${-14 - apart} -8 L${-3 - apart} 0 L${-14 - apart} 8 Z M${14 + apart} -8 L${3 + apart} 0 L${
                        14 + apart
                    } 8 Z`}
                    fill={context.paper}
                    {...ink(context)}
                />
                <path d={`M${-3 - apart} -8 V8 M${3 + apart} -8 V8`} {...ink(context, 2)} />
            </>
        );
    },
};

export const VALVE_KINDS: Kind[] = [valve, check, relief, regulator, burst, valve3, angle, qd];
