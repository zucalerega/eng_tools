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
    label: "Top ports",
    type: "select",
    options: ["2", "3", "", "5", "6", "7", "8"].map((value) => ({ value, label: value || "4" })),
};

/** A choice of 0 to 5 ports on one of a manifold's other sides, `first` until it's said. */
const sidePorts = (key: string, label: string, first: number): Field => ({
    key,
    label,
    type: "select",
    options: ["0", "1", "2", "3", "4", "5"].map((value) => ({
        value: Number(value) === first ? "" : value,
        label: value,
    })),
});

const BOTTOM_PORTS = sidePorts("bottomPorts", "Bottom ports", 0);
const LEFT_PORTS = sidePorts("leftPorts", "Left ports", 1);
const RIGHT_PORTS = sidePorts("rightPorts", "Right ports", 1);

/** How many outlets a manifold has on its top: 2 to 8, 4 until it's said. */
function outletsOf(part: Part): number {
    const count = Number(part.props.outlets);
    return Number.isInteger(count) && count >= 2 && count <= 8 ? count : 4;
}

/** How many ports a manifold has on one of its other sides: 0 to 5, `first` until it's said. */
function sideCount(part: Part, key: "bottomPorts" | "leftPorts" | "rightPorts", first: number): number {
    const value = part.props[key];
    const count = Number(value);
    return value !== undefined && value !== "" && Number.isInteger(count) && count >= 0 && count <= 5 ? count : first;
}

/** How many ports a manifold has on each side: its top's at least 2, so it always has outlets to give out to. */
function sidesOf(part: Part): { top: number; bottom: number; left: number; right: number } {
    return {
        top: outletsOf(part),
        bottom: sideCount(part, "bottomPorts", 0),
        left: sideCount(part, "leftPorts", 1),
        right: sideCount(part, "rightPorts", 1),
    };
}

/**
 * A manifold's half width and half height: room for its top's and its bottom's ports 20 apart with 10 to spare at each
 * end, and for its ends' ports 20 apart with 10 to spare at each corner. One with one port on each end is as tall as a
 * manifold always was.
 */
function halvesOf(part: Part): { half: number; tall: number } {
    const sides = sidesOf(part);
    return { half: 10 * Math.max(sides.top, sides.bottom) + 10, tall: 10 * Math.max(1, sides.left, sides.right) };
}

/** Where `count` ports sit along a side, 20 apart, centered, on the grid. */
const along = (count: number): number[] => Array.from({ length: count }, (_, index) => (2 * index - count + 1) * 10);

/**
 * A manifold's ports on one end, named "in" (or "end"), then "in-2" to "in-5": the first is the one nearest the
 * middle, the rest outward from it, upper before lower. So a manifold from before, with one on each end, keeps its
 * "in" and "end" where they were, and a port taken away is the last one added.
 */
function endPortsOf(part: Part, side: "left" | "right"): Port[] {
    const { half } = halvesOf(part);
    const ys = along(sidesOf(part)[side]).sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
    const name = side === "left" ? "in" : "end";
    return ys.map((y, index) => ({
        id: index === 0 ? name : `${name}-${index + 1}`,
        x: side === "left" ? -half : half,
        y,
        dir: side,
        inset: 0,
    }));
}

/**
 * A manifold's ports: its supply's end (its left), its far end (its right), its outlets along its top ("1" to "8", left
 * to right), and any along its bottom ("bottom-1" to "bottom-5"), each on the grid.
 */
function manifoldPorts(part: Part): Port[] {
    const sides = sidesOf(part);
    const { tall } = halvesOf(part);
    return [
        ...endPortsOf(part, "left"),
        ...endPortsOf(part, "right"),
        ...along(sides.top).map((x, index) => ({ id: String(index + 1), x, y: -tall, dir: "up" as const, inset: 0 })),
        ...along(sides.bottom).map((x, index) => ({
            id: `bottom-${index + 1}`,
            x,
            y: tall,
            dir: "down" as const,
            inset: 0,
        })),
    ];
}

/**
 * A manifold: a block that takes one supply and gives it out to several lines (a press manifold, a pneumatics panel's
 * block), its bore drawn through it to each port. It has ports on all four sides: its supply's end and its far end
 * (for a manifold that goes on, or a plug) 0 to 5 each, its outlets along its top 2 to 8, and 0 to 5 along its bottom.
 */
export const manifold: Kind = {
    id: "manifold",
    name: "Manifold",
    box: (part) => {
        const { half, tall } = halvesOf(part);
        return [-half, -tall, half, tall];
    },
    ports: manifoldPorts,
    fields: [OUTLETS, BOTTOM_PORTS, LEFT_PORTS, RIGHT_PORTS, SIZE, MAWP, MATERIAL, MODEL, NOTES],
    tag: "beside",
    through: true,
    draw: (part, context) => {
        const { half, tall } = halvesOf(part);
        const ports = manifoldPorts(part);
        // Its bore: along its middle, out to each port on its top and its bottom, and on each end with more than one
        // port, up and down a gallery inside the end to each of them.
        const bore = [`M${-half + 3} 0 H${half - 3}`];
        for (const port of ports) {
            if (port.dir === "up" || port.dir === "down") {
                bore.push(`M${port.x} 0 V${port.dir === "up" ? -tall + 2 : tall - 2}`);
            }
        }
        for (const side of ["left", "right"] as const) {
            const ys = ports.filter((port) => port.dir === side).map((port) => port.y);
            if (ys.length > 1) {
                const wall = side === "left" ? -half + 3 : half - 3;
                const gallery = side === "left" ? -half + 10 : half - 10;
                bore.push(`M${gallery} ${Math.min(...ys)} V${Math.max(...ys)}`);
                bore.push(...ys.filter((y) => y !== 0).map((y) => `M${wall} ${y} H${gallery}`));
            }
        }
        return (
            <>
                <rect
                    x={-half}
                    y={-tall}
                    width={2 * half}
                    height={2 * tall}
                    rx={2}
                    fill={context.paper}
                    {...ink(context)}
                />
                <path d={bore.join(" ")} fill="none" stroke={context.muted} strokeWidth={1.2} strokeDasharray="3 2" />
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
