import { ink, Letters } from "./draw";
import {
    HOLDS,
    MATERIAL,
    MAWP,
    MEOP,
    MODEL,
    NOTES,
    VOLUME,
    type DrawContext,
    type Field,
    type Kind,
    type Port,
} from "./kinds";
import type { Part } from "../drawing";

// Vessels: what holds a fluid. Each shows what it holds in that fluid's color: a tank's liquid in its lower part, a gas
// filling it, with the fluid's label inside.

/** Ports around a vessel: top and bottom, and two on each side. */
function around(halfWidth: number, halfHeight: number, side: number): Port[] {
    return [
        { id: "top", x: 0, y: -halfHeight, dir: "up", inset: 0 },
        { id: "bottom", x: 0, y: halfHeight, dir: "down", inset: 0 },
        { id: "left-upper", x: -halfWidth, y: -side, dir: "left", inset: 0 },
        { id: "right-upper", x: halfWidth, y: -side, dir: "right", inset: 0 },
        { id: "left-lower", x: -halfWidth, y: side, dir: "left", inset: 0 },
        { id: "right-lower", x: halfWidth, y: side, dir: "right", inset: 0 },
    ];
}

/** A tank's outline: a cylinder with elliptical heads. */
const capsule = (w: number, h: number, head: number) =>
    `M${-w} ${-h + head} A${w} ${head} 0 0 1 ${w} ${-h + head} V${h - head} A${w} ${head} 0 0 1 ${-w} ${h - head} Z`;

/** What a vessel holds: its fluid's color over what it fills (a liquid up to its level), and its label in it. */
function Contents({
    part,
    context,
    liquid,
    level,
    gas,
    labelAt,
}: {
    part: Part;
    context: DrawContext;
    liquid: string;
    level: string;
    gas: string;
    labelAt: number;
}) {
    if (!context.fluid) {
        return null;
    }
    return (
        <>
            <path d={context.gas ? gas : liquid} fill={context.fluid} fillOpacity={0.2} stroke="none" />
            {!context.gas && <path d={level} stroke={context.fluid} strokeWidth={1} />}
            <Letters part={part} x={0} y={labelAt} size={9} fill={context.fluid} bold>
                {context.fluidLabel}
            </Letters>
        </>
    );
}

/** A tank's ports on its top or its bottom: 1 to 5, 1 until it's said. */
function endPorts(part: Part, key: "topPorts" | "bottomPorts"): number {
    const count = Number(part.props[key]);
    return Number.isInteger(count) && count >= 1 && count <= 5 ? count : 1;
}

/** Where a tank's ports on an end sit across it, as many as it has: on the grid, spread over its head, symmetric. */
const ACROSS: Record<number, number[]> = {
    1: [0],
    2: [-10, 10],
    3: [-20, 0, 20],
    4: [-20, -10, 10, 20],
    5: [-20, -10, 0, 10, 20],
};

/**
 * A tank's ports on one end, named "top" (or "bottom"), then "top-2" to "top-5": the first is the one nearest the
 * middle, the rest outward from it, left before right. So a tank from before, with one, keeps its "top" where it was,
 * and a port taken away is the last one added.
 */
function endPortsOf(part: Part, end: "top" | "bottom"): Port[] {
    const xs = [...ACROSS[endPorts(part, end === "top" ? "topPorts" : "bottomPorts")]!].sort(
        (a, b) => Math.abs(a) - Math.abs(b) || a - b,
    );
    return xs.map((x, index) => ({
        id: index === 0 ? end : `${end}-${index + 1}`,
        x,
        y: end === "top" ? -60 : 60,
        dir: end === "top" ? ("up" as const) : ("down" as const),
        inset: 0,
    }));
}

/** A port on a tank's top (its first, or another set there): above its liquid, its ullage. */
export const isTopPort = (port: string): boolean => port === "top" || /^top-\d$/.test(port);

const portCount = (key: string, label: string): Field => ({
    key,
    label,
    type: "select",
    options: ["", "2", "3", "4", "5"].map((value) => ({ value, label: value || "1" })),
});

const TOP_PORTS = portCount("topPorts", "Top ports");
const BOTTOM_PORTS = portCount("bottomPorts", "Bottom ports");

/**
 * The nozzles to a tank's ports off its middle: from its head out to the end of its box, where the port is, so each
 * stays on the grid however the head curves under it.
 */
function nozzles(part: Part): string {
    const head = (x: number) => Math.round(100 * (45 + 15 * Math.sqrt(1 - (x / 30) ** 2))) / 100;
    return [...endPortsOf(part, "top"), ...endPortsOf(part, "bottom")]
        .filter((port) => port.x !== 0)
        .map((port) => `M${port.x} ${Math.sign(port.y) * head(port.x)} V${port.y}`)
        .join(" ");
}

export const tank: Kind = {
    id: "tank",
    name: "Tank",
    box: () => [-30, -60, 30, 60],
    // Its sides' ports as they always were, and its ends' as many as it's set to have.
    ports: (part) => [
        ...endPortsOf(part, "top"),
        ...endPortsOf(part, "bottom"),
        ...around(30, 60, 30).filter((port) => port.id !== "top" && port.id !== "bottom"),
    ],
    fields: [HOLDS, VOLUME, MEOP, MAWP, MATERIAL, TOP_PORTS, BOTTOM_PORTS, MODEL, NOTES],
    tag: "beside",
    draw: (part, context) => (
        <>
            <path d={capsule(30, 60, 15)} fill={context.paper} stroke="none" />
            <Contents
                part={part}
                context={context}
                liquid="M-30 0 H30 V45 A30 15 0 0 1 -30 45 Z"
                level="M-30 0 H30"
                gas={capsule(30, 60, 15)}
                labelAt={22}
            />
            <path d={capsule(30, 60, 15)} fill="none" {...ink(context)} />
            {nozzles(part) && <path d={nozzles(part)} fill="none" {...ink(context)} />}
        </>
    ),
};

export const dewar: Kind = {
    id: "dewar",
    name: "Dewar",
    box: () => [-30, -60, 30, 60],
    ports: () => around(30, 60, 30),
    fields: [HOLDS, VOLUME, MEOP, MAWP, MODEL, NOTES],
    tag: "beside",
    draw: (part, context) => (
        <>
            <path d={capsule(30, 60, 15)} fill={context.paper} stroke="none" />
            <Contents
                part={part}
                context={context}
                liquid="M-24 4 H24 V42 A24 12 0 0 1 -24 42 Z"
                level="M-24 4 H24"
                gas={capsule(24, 54, 12)}
                labelAt={24}
            />
            <path d={capsule(30, 60, 15)} fill="none" {...ink(context)} />
            <path d={capsule(24, 54, 12)} fill="none" strokeDasharray="4 3" {...ink(context, 1.2)} />
        </>
    ),
};

export const sphere: Kind = {
    id: "sphere",
    name: "Spherical tank",
    box: () => [-40, -40, 40, 40],
    ports: () => [
        { id: "top", x: 0, y: -40, dir: "up", inset: 0 },
        { id: "bottom", x: 0, y: 40, dir: "down", inset: 0 },
        { id: "left", x: -40, y: 0, dir: "left", inset: 0 },
        { id: "right", x: 40, y: 0, dir: "right", inset: 0 },
    ],
    fields: [HOLDS, VOLUME, MEOP, MAWP, MATERIAL, MODEL, NOTES],
    tag: "beside",
    draw: (part, context) => (
        <>
            <circle r={40} fill={context.paper} stroke="none" />
            <Contents
                part={part}
                context={context}
                liquid="M-40 0 H40 A40 40 0 0 1 -40 0 Z"
                level="M-40 0 H40"
                gas="M-40 0 A40 40 0 0 1 40 0 A40 40 0 0 1 -40 0 Z"
                labelAt={16}
            />
            <circle r={40} fill="none" {...ink(context)} />
        </>
    ),
};

/** A gas bottle's outline: a domed cylinder with its valve's neck on top. */
const BOTTLE = "M-20 -20 A20 20 0 0 1 20 -20 V50 A10 10 0 0 1 10 60 H-10 A10 10 0 0 1 -20 50 Z";

/** A bottle: a gas cylinder, or a COPV (composite-wrapped), whose wrap is drawn across it. */
export const bottle: Kind = {
    id: "bottle",
    name: "Gas bottle",
    box: () => [-20, -50, 20, 60],
    ports: () => [{ id: "top", x: 0, y: -50, dir: "up", inset: 0 }],
    fields: [
        HOLDS,
        VOLUME,
        MEOP,
        MAWP,
        {
            key: "wrap",
            label: "Construction",
            type: "select",
            options: [
                { value: "", label: "Metal cylinder" },
                { value: "composite", label: "Composite overwrapped (COPV)", short: "COPV" },
            ],
        },
        MODEL,
        NOTES,
    ],
    title: (part) => (part.props.wrap === "composite" ? "COPV" : "Gas bottle"),
    tag: "beside",
    draw: (part, context) => (
        <>
            <rect x={-5} y={-50} width={10} height={11} fill={context.paper} {...ink(context)} />
            <path d={BOTTLE} fill={context.paper} stroke="none" />
            {context.fluid && <path d={BOTTLE} fill={context.fluid} fillOpacity={0.2} stroke="none" />}
            {part.props.wrap === "composite" && (
                <path
                    d="M-20 -6 L20 -20 M-20 8 L20 -6 M-20 22 L20 8 M-20 36 L20 22 M-20 50 L20 36"
                    {...ink(context, 0.8)}
                />
            )}
            <path d={BOTTLE} fill="none" {...ink(context)} />
            {context.fluid && (
                <Letters part={part} x={0} y={14} size={8} fill={context.fluid} bold>
                    {context.fluidLabel}
                </Letters>
            )}
        </>
    ),
};

export const VESSEL_KINDS: Kind[] = [tank, dewar, sphere, bottle];
