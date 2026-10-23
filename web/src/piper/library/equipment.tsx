import { ink, Letters } from "./draw";
import { MODEL, NOTES, type Kind } from "./kinds";

// Equipment: what a system is for (an engine), or what moves its fluids (a pump), and where they leave it (a vent).

export const engine: Kind = {
    id: "engine",
    name: "Engine",
    box: () => [-24, -50, 24, 60],
    ports: () => [
        { id: "fuel", x: -10, y: -50, dir: "up", inset: 10 },
        { id: "ox", x: 10, y: -50, dir: "up", inset: 10 },
        // The chamber's taps, out past its nozzle's widest, so a line from one starts clear of it.
        { id: "left", x: -30, y: -20, dir: "left", inset: 10 },
        { id: "right", x: 30, y: -20, dir: "right", inset: 10 },
    ],
    fields: [
        { key: "thrust", label: "Thrust", type: "text", placeholder: "1000 lbf" },
        { key: "pc", label: "Chamber pressure", type: "text", placeholder: "300 psi", prefix: "Pc " },
        { key: "of", label: "O/F", type: "text", placeholder: "2.1", prefix: "O/F " },
        { key: "propellants", label: "Propellants", type: "text", placeholder: "LOX/RP-1" },
        NOTES,
    ],
    tag: "beside",
    draw: (_part, context) => (
        <>
            <path
                d="M-20 -40 H20 V0 Q20 8 8 14 L24 60 H-24 L-8 14 Q-20 8 -20 0 Z"
                fill={context.paper}
                {...ink(context)}
            />
            <path d="M-20 -32 H20" {...ink(context, 1.2)} />
        </>
    ),
};

export const pump: Kind = {
    id: "pump",
    name: "Pump",
    box: () => [-20, -20, 20, 20],
    ports: () => [
        { id: "in", x: -20, y: 0, dir: "left", inset: 0 },
        { id: "out", x: 20, y: -20, dir: "right", inset: 0 },
    ],
    fields: [
        { key: "flow", label: "Flow", type: "text", placeholder: "2 gpm" },
        { key: "rise", label: "Pressure rise", type: "text", placeholder: "500 psi" },
        MODEL,
        NOTES,
    ],
    tag: "beside",
    through: true,
    draw: (_part, context) => (
        <>
            <circle r={20} fill={context.paper} {...ink(context)} />
            <path d="M0 -20 H20" {...ink(context)} />
            <path d="M-8 -10 L12 0 L-8 10 Z" fill="none" {...ink(context, 1.2)} />
        </>
    ),
};

export const igniter: Kind = {
    id: "igniter",
    name: "Igniter",
    box: () => [-20, -10, 20, 20],
    ports: () => [
        { id: "a", x: -20, y: 0, dir: "left", inset: 5 },
        { id: "b", x: 20, y: 0, dir: "right", inset: 5 },
        { id: "out", x: 0, y: 20, dir: "down", inset: 10 },
    ],
    fields: [{ key: "type", label: "Type", type: "text", placeholder: "Spark torch" }, MODEL, NOTES],
    tag: "beside",
    draw: (_part, context) => (
        <>
            <rect x={-15} y={-10} width={30} height={20} fill={context.paper} {...ink(context)} />
            <path d="M-6 5 L-1 -5 L1 2 L6 -7" fill="none" {...ink(context, 1.4)} />
        </>
    ),
};

/** A heat exchanger: the tube's coil through a shell, each with its own two ports. */
export const exchanger: Kind = {
    id: "exchanger",
    name: "Heat exchanger",
    box: () => [-20, -20, 20, 20],
    ports: () => [
        { id: "tube-in", x: -20, y: 0, dir: "left", inset: 0 },
        { id: "tube-out", x: 20, y: 0, dir: "right", inset: 0 },
        { id: "shell-in", x: 0, y: -20, dir: "up", inset: 0 },
        { id: "shell-out", x: 0, y: 20, dir: "down", inset: 0 },
    ],
    fields: [{ key: "duty", label: "Duty", type: "text", placeholder: "5 kW" }, MODEL, NOTES],
    tag: "beside",
    draw: (_part, context) => (
        <>
            <circle r={20} fill={context.paper} {...ink(context)} />
            <path d="M-20 0 H-12 L-6 -8 L0 8 L6 -8 L12 0 H20" fill="none" {...ink(context, 1.4)} />
        </>
    ),
};

/** Where a line leaves to the air: an arrow out. */
export const vent: Kind = {
    id: "vent",
    name: "Vent",
    box: () => [-20, -8, 15, 8],
    ports: () => [{ id: "in", x: -20, y: 0, dir: "left", inset: 0 }],
    fields: [{ key: "to", label: "To", type: "text", placeholder: "Atmosphere" }, NOTES],
    tag: "beside",
    draw: (part, context) => (
        <>
            <path d="M-20 0 H0" {...ink(context, 2)} />
            <path d="M0 -7 L14 0 L0 7 Z" fill={context.ink} {...ink(context, 1)} />
            {!part.tag && (
                <Letters part={part} x={-3} y={-14} size={8} fill={context.muted}>
                    VENT
                </Letters>
            )}
        </>
    ),
};

/**
 * A box for what the library has no symbol for (a DAQ, a test stand, a shape from Visio it doesn't know): its words in
 * it, and a port in the middle of each side. It's sized in steps of 20, so those stay on the grid.
 */
export const block: Kind = {
    id: "block",
    name: "Box",
    box: (part) => [-part.w / 2, -part.h / 2, part.w / 2, part.h / 2],
    ports: (part) => [
        { id: "top", x: 0, y: -part.h / 2, dir: "up", inset: 0 },
        { id: "right", x: part.w / 2, y: 0, dir: "right", inset: 0 },
        { id: "bottom", x: 0, y: part.h / 2, dir: "down", inset: 0 },
        { id: "left", x: -part.w / 2, y: 0, dir: "left", inset: 0 },
    ],
    fields: [MODEL, NOTES],
    tag: "beside",
    text: "Says",
    resizable: true,
    resize: { step: 20, least: [40, 40] },
    draw: (part, context) => {
        const lines = part.text ? part.text.split("\n") : [];
        return (
            <>
                <rect
                    x={-part.w / 2}
                    y={-part.h / 2}
                    width={part.w}
                    height={part.h}
                    rx={4}
                    fill={context.paper}
                    {...ink(context)}
                />
                {lines.map((line, index) => (
                    <Letters
                        key={index}
                        part={part}
                        x={0}
                        y={(index - (lines.length - 1) / 2) * 12}
                        size={10}
                        fill={context.ink}
                    >
                        {line}
                    </Letters>
                ))}
            </>
        );
    },
};

export const EQUIPMENT_KINDS: Kind[] = [engine, pump, igniter, exchanger, vent, block];
