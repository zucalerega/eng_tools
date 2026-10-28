import type { Part } from "../drawing";
import { ink } from "./draw";
import { inlinePorts, MATERIAL, MAWP, MODEL, NOTES, SIZE, type Field, type Kind, type Port } from "./kinds";

// What joins lines, ends them, and changes them: junctions (tees), manifolds, caps, reducers, and flexible hoses.

/** Where lines meet: one port that takes any number of them, shown as a dot once three or more do. */
export const junction: Kind = {
    id: "junction",
    name: "Junction",
    box: () => [-5, -5, 5, 5],
    ports: () => [{ id: "c", x: 0, y: 0, dir: null, inset: 0, many: true }],
    fields: [NOTES],
    tag: "none",
    through: true,
    draw: (_part, context) => (context.lines >= 3 ? <circle r={3.5} fill={context.pipe ?? context.ink} /> : null),
};

const OUTLETS: Field = {
    key: "outlets",
    label: "Outlets",
    type: "select",
    options: ["2", "3", "", "5", "6", "7", "8"].map((value) => ({ value, label: value || "4" })),
};

/** How many outlets a manifold has: 2 to 8, 4 until it's said. */
function outletsOf(part: Part): number {
    const count = Number(part.props.outlets);
    return Number.isInteger(count) && count >= 2 && count <= 8 ? count : 4;
}

/** A manifold's ports: its inlet at one end, its far end, and its outlets along its top, 20 apart, on the grid. */
function manifoldPorts(part: Part): Port[] {
    const count = outletsOf(part);
    const half = 10 * count + 10;
    return [
        { id: "in", x: -half, y: 0, dir: "left", inset: 0 },
        { id: "end", x: half, y: 0, dir: "right", inset: 0 },
        ...Array.from({ length: count }, (_, index) => ({
            id: String(index + 1),
            x: (2 * index - count + 1) * 10,
            y: -10,
            dir: "up" as const,
            inset: 0,
        })),
    ];
}

/**
 * A manifold: a block that takes one supply and gives it out to several lines (a press manifold, a pneumatics panel's
 * block), its bore drawn through it to each outlet. Its far end is a port too, for a manifold that goes on (or a plug).
 */
export const manifold: Kind = {
    id: "manifold",
    name: "Manifold",
    box: (part) => [-(10 * outletsOf(part) + 10), -10, 10 * outletsOf(part) + 10, 10],
    ports: manifoldPorts,
    fields: [OUTLETS, SIZE, MAWP, MATERIAL, MODEL, NOTES],
    tag: "beside",
    through: true,
    draw: (part, context) => {
        const half = 10 * outletsOf(part) + 10;
        const outlets = manifoldPorts(part).filter((port) => port.dir === "up");
        return (
            <>
                <rect x={-half} y={-10} width={2 * half} height={20} rx={2} fill={context.paper} {...ink(context)} />
                <path
                    d={`M${-half + 3} 0 H${half - 3} ${outlets.map((port) => `M${port.x} 0 V-8`).join(" ")}`}
                    fill="none"
                    stroke={context.muted}
                    strokeWidth={1.2}
                    strokeDasharray="3 2"
                />
            </>
        );
    },
};

export const cap: Kind = {
    id: "cap",
    name: "Cap",
    box: () => [-20, -8, 0, 8],
    ports: () => [{ id: "in", x: -20, y: 0, dir: "left", inset: 0 }],
    fields: [SIZE, MAWP, NOTES],
    tag: "beside",
    draw: (_part, context) => (
        <>
            <path d="M-20 0 H-2" stroke={context.pipe ?? context.ink} strokeWidth={2.5} />
            <path d="M-2 -8 V8" {...ink(context, 3)} />
        </>
    ),
};

export const reducer: Kind = {
    id: "reducer",
    name: "Reducer",
    box: () => [-20, -10, 20, 10],
    ports: () => inlinePorts(10),
    fields: [{ key: "sizes", label: "Sizes", type: "text", placeholder: "1/2 in × 1/4 in" }, MAWP, MODEL, NOTES],
    tag: "none",
    inline: ["a", "b"],
    through: true,
    draw: (_part, context) => <path d="M-10 -10 L10 -5 V5 L-10 10 Z" fill={context.paper} {...ink(context)} />,
};

/** A flexible hose, drawn as the line it is, waved. */
export const hose: Kind = {
    id: "hose",
    name: "Flex hose",
    box: () => [-20, -6, 20, 6],
    ports: () => inlinePorts(0),
    fields: [
        SIZE,
        { key: "length", label: "Length", type: "text", placeholder: "24 in" },
        MATERIAL,
        MAWP,
        MODEL,
        NOTES,
    ],
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (_part, context) => (
        <path
            d="M-20 0 Q-17.5 -6 -15 0 T-10 0 T-5 0 T0 0 T5 0 T10 0 T15 0 T20 0"
            fill="none"
            stroke={context.pipe ?? context.ink}
            strokeWidth={2.2}
            strokeLinecap="round"
        />
    ),
};

export const FITTING_KINDS: Kind[] = [junction, manifold, cap, reducer, hose];
