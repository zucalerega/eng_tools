import { ink } from "./draw";
import { CHANNEL, DAQ, inlinePorts, MODEL, NOTES, RANGE, SIZE, type Field, type Kind } from "./kinds";

// What's put into a line to measure or shape its flow: orifices, venturis, flow meters, filters.

const CD: Field = { key: "cd", label: "Discharge coefficient", type: "text", placeholder: "0.61", prefix: "Cd " };

export const orifice: Kind = {
    id: "orifice",
    name: "Orifice",
    box: () => [-20, -10, 20, 10],
    ports: () => inlinePorts(17),
    fields: [
        { key: "diameter", label: "Diameter", type: "text", placeholder: "0.062 in", prefix: "Ø " },
        CD,
        MODEL,
        NOTES,
    ],
    tag: "beside",
    inline: ["a", "b"],
    through: true,
    draw: (_part, context) => <path d="M-3 -10 V10 M3 -10 V10" {...ink(context, 2)} />,
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
    fields: [{ key: "rating", label: "Rating", type: "text", placeholder: "10 µm" }, SIZE, MODEL, NOTES],
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

export const FLOW_KINDS: Kind[] = [orifice, venturi, flowmeter, filter];
