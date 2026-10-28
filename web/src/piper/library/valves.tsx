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
    MAWP,
    SET,
    SIZE,
    type DrawContext,
    type Field,
    type Kind,
    type Port,
} from "./kinds";

// Valves, as ISA 5.1 draws them: a body of two triangles meeting at the middle (a bowtie), told apart by what's at
// its middle, with what works it on a stem above. Ports are 20 out from the middle, as every inline part's are, and
// the body's ends 11: small on its line, the line running on into it, as a P&ID draws a valve.

/** The body's two triangles, point to point. */
const BOWTIE = "M-11 -6.5 L11 6.5 L11 -6.5 L-11 6.5 Z";

/** How far in from a port a line's drawn to, to meet the body's end. */
const BODY_INSET = 9;

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
            return <circle r={3.6} fill={context.paper} {...ink(context, 1.2)} />;
        case "globe":
            return <circle r={3} fill={context.ink} />;
        case "needle":
            return <path d="M-4.5 -6.5 L4.5 -6.5 L0 -0.8 Z" fill={context.ink} {...ink(context, 0.8)} />;
        case "butterfly":
            return (
                <>
                    <path d="M0 -6.5 V6.5" {...ink(context, 1.6)} />
                    <circle r={1.8} fill={context.ink} />
                </>
            );
        case "plug":
            return <rect x={-3} y={-2} width={6} height={4} fill={context.ink} />;
        default:
            return null; // gate: the bowtie alone
    }
}

/** How high an actuator reaches above the body's middle. */
function actuatorTop(actuation: string | undefined): number {
    switch (actuation) {
        case "manual":
            return 16;
        case "solenoid":
        case "pneumatic":
        case "motor":
            return 26;
        default:
            return 8;
    }
}

/** The letter in an actuator's box: S for a solenoid, P for pneumatic (worked by air), M for a motor. */
function actuatorLetter(actuation: string): string | null {
    switch (actuation) {
        case "solenoid":
            return "S";
        case "pneumatic":
            return "P";
        case "motor":
            return "M";
        default:
            return null;
    }
}

/** What works a valve, on a stem up from its middle: a handle, or a box with a letter saying what drives it. */
function Actuator({ part, context }: { part: Part; context: DrawContext }) {
    const actuation = part.props.actuation ?? "";
    const stem = <path d="M0 0 V-14" {...ink(context, 1.2)} />;
    if (actuation === "manual") {
        return (
            <>
                {stem}
                <path d="M-6 -14 H6" {...ink(context, 1.8)} />
            </>
        );
    }
    const letter = actuatorLetter(actuation);
    if (!letter) {
        return null;
    }
    return (
        <>
            {stem}
            <rect x={-6} y={-26} width={12} height={12} fill={context.paper} {...ink(context, 1.2)} />
            <Letters part={part} x={0} y={-20} size={8} fill={context.ink} bold>
                {letter}
            </Letters>
        </>
    );
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
    box: (part) => [-20, -actuatorTop(part.props.actuation), 20, 8],
    ports: () => inlinePorts(BODY_INSET),
    fields: [BODY, ACTUATION, NORMAL, SIZE, CV, MAWP, MODEL, CHANNEL, NOTES],
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
        MAWP,
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
    box: () => [-10, -21, 20, 20],
    ports: () => [
        { id: "in", x: 0, y: 20, dir: "down", inset: BODY_INSET },
        { id: "out", x: 20, y: 0, dir: "right", inset: BODY_INSET },
    ],
    fields: [
        SET,
        SIZE,
        { key: "capacity", label: "Flow capacity", type: "text", placeholder: "0.5 lbm/s" },
        MAWP,
        MODEL,
        NOTES,
    ],
    tag: "beside",
    through: true,
    draw: (_part, context) => (
        <>
            <path d="M-6.5 11 L6.5 11 L0 0 Z M11 -6.5 L11 6.5 L0 0 Z" fill={context.paper} {...ink(context)} />
            <path
                d="M0 0 V-5 L-4 -7.5 L4 -10.5 L-4 -13.5 L4 -16.5 L0 -19 M-5 -19 H5"
                fill="none"
                {...ink(context, 1.2)}
            />
        </>
    ),
};

/**
 * A pressure regulator, as ISA 5.1 draws a self-contained one: a valve worked by a diaphragm, against a spring (or the
 * gas loading its dome), with a line from the diaphragm to the pressure it holds: downstream for a reducing regulator,
 * upstream for a back-pressure one.
 */
export const regulator: Kind = {
    id: "regulator",
    name: "Pressure regulator",
    box: () => [-20, -31, 20, 8],
    ports: () => inlinePorts(BODY_INSET),
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
        MAWP,
        CV,
        SIZE,
        MODEL,
        NOTES,
    ],
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (part, context) => {
        const side = part.props.type === "back" ? -1 : 1; // which side it senses
        return (
            <>
                <path d={`M${8 * side} -13 H${15.5 * side} V0`} fill="none" {...ink(context, 1)} />
                <path d="M0 0 V-12" {...ink(context, 1.2)} />
                <path d="M-8 -12 A8 8 0 0 1 8 -12 Z" fill={context.paper} {...ink(context, 1.2)} />
                {part.props.type === "dome" ? (
                    <path d="M0 -20 V-29 M-3.5 -26 L0 -29 L3.5 -26" fill="none" {...ink(context, 1.2)} />
                ) : (
                    <path
                        d="M0 -20 L-3.5 -22.5 L3.5 -25 L-3.5 -27.5 L3.5 -30 L0 -31"
                        fill="none"
                        {...ink(context, 1.2)}
                    />
                )}
                <path d={BOWTIE} fill={context.paper} {...ink(context)} />
            </>
        );
    },
};

/** A burst disc: a dome between two flanges, bulging the way it bursts. */
export const burst: Kind = {
    id: "burst",
    name: "Burst disc",
    box: () => [-20, -10, 20, 10],
    ports: () => inlinePorts(16),
    fields: [{ key: "burst", label: "Burst pressure", type: "text", placeholder: "900 psi" }, SIZE, MAWP, MODEL, NOTES],
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (_part, context) => (
        <>
            <path d="M-4 -9 V9 M4 -9 V9" {...ink(context, 1.8)} />
            <path d="M-4 -7.5 Q6 0 -4 7.5" fill="none" {...ink(context, 1.2)} />
        </>
    ),
};

/** A three-way valve: a bowtie with a third triangle down, for the third port. */
export const valve3: Kind = {
    id: "valve3",
    name: "Three-way valve",
    box: (part) => [-20, -actuatorTop(part.props.actuation), 20, 20],
    ports: () => [...inlinePorts(BODY_INSET), { id: "c", x: 0, y: 20, dir: "down", inset: BODY_INSET }],
    fields: [ACTUATION, SIZE, CV, MAWP, MODEL, CHANNEL, NOTES],
    reads: "state",
    tag: "beside",
    through: true,
    draw: (part, context) => (
        <>
            <Actuator part={part} context={context} />
            <path
                d="M-11 -6.5 L0 0 L-11 6.5 Z M11 -6.5 L0 0 L11 6.5 Z M-6.5 11 L0 0 L6.5 11 Z"
                fill={context.fill ?? context.paper}
                {...ink(context)}
            />
            <circle r={3} fill={context.paper} {...ink(context, 1.2)} />
        </>
    ),
};

/** An angle valve: in from the side, out below. */
export const angle: Kind = {
    id: "angle",
    name: "Angle valve",
    box: (part) => [-20, -actuatorTop(part.props.actuation), 10, 20],
    ports: () => [
        { id: "a", x: -20, y: 0, dir: "left", inset: BODY_INSET },
        { id: "b", x: 0, y: 20, dir: "down", inset: BODY_INSET },
    ],
    fields: [ACTUATION, NORMAL, SIZE, CV, MAWP, MODEL, CHANNEL, NOTES],
    state: true,
    reads: "state",
    tag: "beside",
    through: true,
    draw: (part, context) => (
        <>
            <Actuator part={part} context={context} />
            <path
                d="M-11 -6.5 L0 0 L-11 6.5 Z M-6.5 11 L0 0 L6.5 11 Z"
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
    box: () => [-20, -8, 20, 8],
    ports: () => inlinePorts(BODY_INSET),
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
        MAWP,
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
                    d={`M${-11 - apart} -6.5 L${-2 - apart} 0 L${-11 - apart} 6.5 Z M${11 + apart} -6.5 L${2 + apart} 0 L${
                        11 + apart
                    } 6.5 Z`}
                    fill={context.paper}
                    {...ink(context)}
                />
                <path d={`M${-2 - apart} -6.5 V6.5 M${2 + apart} -6.5 V6.5`} {...ink(context, 1.8)} />
            </>
        );
    },
};

// Directional control valves, as ISO 1219 draws them in pneumatic schematics: a box for each of the valve's two
// positions, side by side, each with its flow paths (an arrow from port to port) and its shut ports (a T); a solenoid
// works it from its left end, and a spring returns it from its right. Its ports are on the box of the position it rests
// in, by the spring, numbered as ISO 5599 numbers them: 1 the supply, 2 and 4 what it feeds, 3 and 5 its exhausts. Each
// box is 40 across and 30 high, its ports a quarter, a half, and three quarters of the way across, on the grid.

/** A position's paths, in its box from x to x + 40: arrows [from, to], and shut ports, each as [x, top or bottom]. */
interface Position {
    arrows: [[number, number], [number, number]][];
    shut: [number, number][];
}

const TOP = -15;
const FOOT = 15;

/** An arrow from a port to another across a box, its head on the box's edge. */
function flowPath([x1, y1]: [number, number], [x2, y2]: [number, number]): { line: string; head: string } {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const [ux, uy] = [(x2 - x1) / length, (y2 - y1) / length];
    const back = (by: number, side: number) =>
        `${(x2 - ux * by - uy * side).toFixed(2)} ${(y2 - uy * by + ux * side).toFixed(2)}`;
    return { line: `M${x1} ${y1} L${back(5, 0)}`, head: `M${x2} ${y2} L${back(5.5, 2.4)} L${back(5.5, -2.4)} Z` };
}

/**
 * A directional control valve's two positions, worked by its solenoid (left) and returned by its spring (right). The one
 * its state puts it in (a test's, or at rest its normal state's) is tinted in that state's color: open, the position
 * that's open (that feeds what it feeds from its supply); closed, the other; a test's neither, both.
 */
function DirectionalValve({
    worked,
    rest,
    open,
    context,
}: {
    worked: Position;
    rest: Position;
    open: "worked" | "rest"; // which position is open
    context: DrawContext;
}) {
    const shown = context.fill && context.state ? context.state : null;
    const tinted = (which: "worked" | "rest") =>
        shown === "other" || (shown === "open" && which === open) || (shown === "closed" && which !== open);
    const box = (x: number, position: Position, which: "worked" | "rest") => (
        <g key={which}>
            <rect x={x} y={TOP} width={40} height={30} fill={context.paper} stroke="none" />
            {tinted(which) && (
                <rect x={x} y={TOP} width={40} height={30} fill={context.fill!} fillOpacity={0.35} stroke="none" />
            )}
            {position.arrows.map(([from, to], index) => {
                const { line, head } = flowPath([x + from[0], from[1]], [x + to[0], to[1]]);
                return (
                    <g key={index}>
                        <path d={line} fill="none" {...ink(context, 1.2)} />
                        <path d={head} fill={context.ink} {...ink(context, 0.8)} />
                    </g>
                );
            })}
            {position.shut.map(([at, y], index) => {
                const inward = y < 0 ? 6 : -6;
                return (
                    <path
                        key={index}
                        d={`M${x + at} ${y} V${y + inward} M${x + at - 4} ${y + inward} H${x + at + 4}`}
                        fill="none"
                        {...ink(context, 1.2)}
                    />
                );
            })}
        </g>
    );
    return (
        <>
            {box(-40, worked, "worked")}
            {box(0, rest, "rest")}
            <rect x={-40} y={TOP} width={80} height={30} fill="none" {...ink(context, 1.4)} />
            <path d="M0 -15 V15" {...ink(context, 1.4)} />
            {/* The solenoid: a coil's box, struck through. */}
            <rect x={-50} y={-8} width={10} height={16} fill={context.paper} {...ink(context, 1.2)} />
            <path d="M-50 8 L-40 -8" {...ink(context, 1)} />
            {/* The spring that returns it. */}
            <path d="M40 0 L42 -5 L45 5 L48 -5 L51 5 L53 0" fill="none" {...ink(context, 1.2)} />
        </>
    );
}

const PORT_INSET = 5; // from a port on the grid to its box's edge

const dcvPort = (id: string, x: number, top: boolean): Port => ({
    id,
    x,
    y: top ? -20 : 20,
    dir: top ? "up" : "down",
    inset: PORT_INSET,
});

/** A 3/2 valve's normal state: what its supply does at rest. */
const NORMAL_32: Field = {
    key: "normal",
    label: "Normal state",
    type: "select",
    options: [
        { value: "", label: "Not set" },
        { value: "NC", label: "Normally closed: 1 shut, 2 to 3 at rest", short: "NC" },
        { value: "NO", label: "Normally open: 1 to 2 at rest", short: "NO" },
    ],
};

/** 1 to 2, the supply to what it feeds, with 3 shut; and 2 to 3, what it feeds exhausted, with 1 shut. */
const FEEDS_32: Position = {
    arrows: [
        [
            [10, FOOT],
            [10, TOP],
        ],
    ],
    shut: [[30, FOOT]],
};
const EXHAUSTS_32: Position = {
    arrows: [
        [
            [10, TOP],
            [30, FOOT],
        ],
    ],
    shut: [[10, FOOT]],
};

/**
 * A 3/2 solenoid valve: three ports, two positions. Normally closed, it rests with its supply (1) shut and what it
 * feeds (2) exhausted (3), and feeds 2 from 1 while its solenoid's on; normally open, the other way round. A pilot for a
 * pneumatic valve's actuator, as a pneumatics panel has them.
 */
export const valve32: Kind = {
    id: "valve32",
    name: "3/2 solenoid valve",
    box: () => [-50, TOP, 53, FOOT],
    ports: () => [dcvPort("1", 10, false), dcvPort("2", 10, true), dcvPort("3", 30, false)],
    fields: [NORMAL_32, SIZE, CV, MAWP, MODEL, CHANNEL, NOTES],
    state: true,
    reads: "state",
    tag: "beside",
    tagX: -20,
    through: true,
    draw: (part, context) => {
        const normallyOpen = part.props.normal === "NO";
        return (
            <DirectionalValve
                worked={normallyOpen ? EXHAUSTS_32 : FEEDS_32}
                rest={normallyOpen ? FEEDS_32 : EXHAUSTS_32}
                open={normallyOpen ? "rest" : "worked"}
                context={context}
            />
        );
    },
};

/**
 * A 5/2 solenoid valve: five ports, two positions. At rest it feeds 2 from its supply (1) and exhausts 4 by 5; worked,
 * it feeds 4 and exhausts 2 by 3: a double-acting actuator's two sides, one filled as the other's let out. It has no
 * normal state; a test's open (its solenoid on) is the position it's worked to.
 */
export const valve52: Kind = {
    id: "valve52",
    name: "5/2 solenoid valve",
    box: () => [-50, TOP, 53, FOOT],
    ports: () => [
        dcvPort("1", 20, false),
        dcvPort("2", 30, true),
        dcvPort("3", 30, false),
        dcvPort("4", 10, true),
        dcvPort("5", 10, false),
    ],
    fields: [SIZE, CV, MAWP, MODEL, CHANNEL, NOTES],
    reads: "state",
    tag: "beside",
    tagX: -20,
    through: true,
    draw: (_part, context) => (
        <DirectionalValve
            worked={{
                arrows: [
                    [
                        [20, FOOT],
                        [10, TOP],
                    ],
                    [
                        [30, TOP],
                        [30, FOOT],
                    ],
                ],
                shut: [[10, FOOT]],
            }}
            rest={{
                arrows: [
                    [
                        [20, FOOT],
                        [30, TOP],
                    ],
                    [
                        [10, TOP],
                        [10, FOOT],
                    ],
                ],
                shut: [[30, FOOT]],
            }}
            open="worked"
            context={context}
        />
    ),
};

export const VALVE_KINDS: Kind[] = [valve, check, relief, regulator, burst, valve3, angle, qd, valve32, valve52];
