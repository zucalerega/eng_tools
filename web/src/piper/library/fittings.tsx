import { ink } from "./draw";
import { inlinePorts, MATERIAL, MODEL, NOTES, SIZE, type Kind } from "./kinds";

// What joins lines, ends them, and changes them: junctions (tees), caps, reducers, and flexible hoses.

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

export const cap: Kind = {
    id: "cap",
    name: "Cap",
    box: () => [-20, -8, 0, 8],
    ports: () => [{ id: "in", x: -20, y: 0, dir: "left", inset: 0 }],
    fields: [SIZE, NOTES],
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
    fields: [{ key: "sizes", label: "Sizes", type: "text", placeholder: "1/2 in × 1/4 in" }, MODEL, NOTES],
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
    fields: [SIZE, { key: "length", label: "Length", type: "text", placeholder: "24 in" }, MATERIAL, MODEL, NOTES],
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

export const FITTING_KINDS: Kind[] = [junction, cap, reducer, hose];
