import type { Drawing, Part } from "../drawing";
import { worldBox, type Box } from "../geometry";
import { ink } from "./draw";
import { EQUIPMENT_KINDS } from "./equipment";
import { FITTING_KINDS } from "./fittings";
import { FLOW_KINDS } from "./flow";
import { INSTRUMENT_KINDS } from "./instruments";
import { CATEGORIES, NOTES, type Category, type Kind, type Preset } from "./kinds";
import { NOTE_KINDS } from "./notes";
import { VALVE_KINDS } from "./valves";
import { VESSEL_KINDS } from "./vessels";

// The library: every kind of part, and the presets the library panel offers (a kind set up as the team's parts are).

export { CATEGORIES };

const ALL: Kind[] = [
    ...VALVE_KINDS,
    ...VESSEL_KINDS,
    ...FLOW_KINDS,
    ...INSTRUMENT_KINDS,
    ...EQUIPMENT_KINDS,
    ...FITTING_KINDS,
    ...NOTE_KINDS,
];

const KINDS = new Map(ALL.map((kind) => [kind.id, kind]));

/**
 * A kind this web app doesn't know (a drawing saved by a newer one, say): a dashed box, kept as it is, so nothing in
 * the drawing is lost by opening it here.
 */
const UNKNOWN: Kind = {
    id: "unknown",
    name: "Unknown part",
    box: () => [-20, -20, 20, 20],
    ports: () => [],
    fields: [NOTES],
    tag: "beside",
    draw: (_part, context) => (
        <rect x={-20} y={-20} width={40} height={40} fill="none" strokeDasharray="4 3" {...ink(context)} />
    ),
};

export const kindOf = (id: string): Kind => KINDS.get(id) ?? UNKNOWN;

export const ALL_KINDS: readonly Kind[] = ALL;

const VALVE = (body: string, actuation: string, normal = "") => ({ body, actuation, normal });

export const PRESETS: Preset[] = [
    // Valves
    {
        id: "ball-valve",
        kind: "valve",
        name: "Ball valve",
        category: "valves",
        prefix: "BV",
        keywords: "quarter turn manual",
        props: VALVE("ball", "manual"),
    },
    {
        id: "solenoid-valve",
        kind: "valve",
        name: "Solenoid valve",
        category: "valves",
        prefix: "SV",
        keywords: "electric sv ncs nos actuated",
        props: VALVE("globe", "solenoid", "NC"),
    },
    {
        id: "pneumatic-valve",
        kind: "valve",
        name: "Pneumatic ball valve",
        category: "valves",
        prefix: "PV",
        keywords: "actuated air operated main propellant mpv",
        props: VALVE("ball", "pneumatic", "NC"),
    },
    {
        id: "motor-valve",
        kind: "valve",
        name: "Motorized ball valve",
        category: "valves",
        prefix: "MV",
        keywords: "mov motor operated servo actuated electric",
        props: VALVE("ball", "motor", "NC"),
    },
    {
        id: "needle-valve",
        kind: "valve",
        name: "Needle valve",
        category: "valves",
        prefix: "NV",
        keywords: "metering throttle bleed",
        props: VALVE("needle", "manual"),
    },
    {
        id: "gate-valve",
        kind: "valve",
        name: "Gate valve",
        category: "valves",
        prefix: "GV",
        keywords: "isolation",
        props: VALVE("gate", ""),
    },
    {
        id: "globe-valve",
        kind: "valve",
        name: "Globe valve",
        category: "valves",
        prefix: "GLV",
        keywords: "throttling",
        props: VALVE("globe", ""),
    },
    {
        id: "butterfly-valve",
        kind: "valve",
        name: "Butterfly valve",
        category: "valves",
        prefix: "BFV",
        keywords: "disc",
        props: VALVE("butterfly", ""),
    },
    {
        id: "plug-valve",
        kind: "valve",
        name: "Plug valve",
        category: "valves",
        prefix: "PLV",
        keywords: "cock",
        props: VALVE("plug", ""),
    },
    {
        id: "check-valve",
        kind: "check",
        name: "Check valve",
        category: "valves",
        prefix: "CV",
        keywords: "non-return one way backflow",
    },
    {
        id: "relief-valve",
        kind: "relief",
        name: "Relief valve",
        category: "valves",
        prefix: "RV",
        keywords: "prv psv safety pressure relief overpressure",
        shown: ["set"],
    },
    {
        id: "regulator",
        kind: "regulator",
        name: "Pressure regulator",
        category: "valves",
        prefix: "REG",
        keywords: "pressure reducing dome loaded tescom",
        shown: ["set"],
    },
    {
        id: "burst-disc",
        kind: "burst",
        name: "Burst disc",
        category: "valves",
        prefix: "BD",
        keywords: "rupture disk overpressure",
        shown: ["burst"],
    },
    {
        id: "three-way-valve",
        kind: "valve3",
        name: "Three-way valve",
        category: "valves",
        prefix: "V3",
        keywords: "3-way diverter selector",
        props: { actuation: "manual" },
    },
    {
        id: "angle-valve",
        kind: "angle",
        name: "Angle valve",
        category: "valves",
        prefix: "AV",
        keywords: "right angle",
    },
    {
        id: "quick-disconnect",
        kind: "qd",
        name: "Quick disconnect",
        category: "valves",
        prefix: "QD",
        keywords: "coupling qdc fill drain umbilical",
    },
    // Vessels
    {
        id: "tank",
        kind: "tank",
        name: "Tank",
        category: "vessels",
        prefix: "TK",
        keywords: "propellant run tank vessel",
    },
    {
        id: "bottle",
        kind: "bottle",
        name: "Gas bottle",
        category: "vessels",
        prefix: "B",
        keywords: "cylinder k-bottle pressurant supply",
        props: { fluid: "gn2" },
    },
    {
        id: "copv",
        kind: "bottle",
        name: "COPV",
        category: "vessels",
        prefix: "COPV",
        keywords: "composite overwrapped pressure vessel pressurant",
        props: { fluid: "ghe", wrap: "composite" },
    },
    {
        id: "sphere",
        kind: "sphere",
        name: "Spherical tank",
        category: "vessels",
        prefix: "TK",
        keywords: "sphere ball",
    },
    {
        id: "dewar",
        kind: "dewar",
        name: "Dewar",
        category: "vessels",
        prefix: "DW",
        keywords: "cryogenic vacuum jacketed lox ln2",
        props: { fluid: "lox" },
    },
    // Flow elements
    {
        id: "orifice",
        kind: "orifice",
        name: "Orifice",
        category: "flow",
        prefix: "OR",
        keywords: "restriction restrictor plate cda",
        shown: ["diameter"],
    },
    {
        id: "venturi",
        kind: "venturi",
        name: "Venturi",
        category: "flow",
        prefix: "VEN",
        keywords: "converging diverging",
        shown: ["throat"],
    },
    {
        id: "cavitating-venturi",
        kind: "venturi",
        name: "Cavitating venturi",
        category: "flow",
        prefix: "CAV",
        keywords: "cav flow control choked",
        props: { cavitating: "yes" },
        shown: ["throat"],
    },
    {
        id: "flow-meter",
        kind: "flowmeter",
        name: "Flow meter",
        category: "flow",
        prefix: "FM",
        keywords: "turbine coriolis mass flow",
        shown: [],
    },
    {
        id: "filter",
        kind: "filter",
        name: "Filter",
        category: "flow",
        prefix: "FLT",
        keywords: "strainer micron",
        shown: ["rating"],
    },
    // Instruments
    {
        id: "pressure-transducer",
        kind: "instrument",
        name: "Pressure transducer",
        category: "instruments",
        prefix: "PT",
        keywords: "pressure sensor transmitter pt",
        props: { type: "pressure" },
    },
    {
        id: "pressure-transducer-2",
        kind: "instrument",
        name: "Duplicated pressure transducer",
        category: "instruments",
        prefix: "PT",
        keywords: "pressure sensor transmitter pt dual redundant two duplicated",
        props: { type: "pressure", count: "2" },
    },
    {
        id: "pressure-transducer-3",
        kind: "instrument",
        name: "Triplicated pressure transducer",
        category: "instruments",
        prefix: "PT",
        keywords: "pressure sensor transmitter pt triple redundant three triplicated",
        props: { type: "pressure", count: "3" },
    },
    {
        id: "thermocouple",
        kind: "instrument",
        name: "Thermocouple",
        category: "instruments",
        prefix: "TC",
        keywords: "temperature sensor tc type k",
        props: { type: "temperature" },
    },
    {
        id: "rtd",
        kind: "instrument",
        name: "RTD",
        category: "instruments",
        prefix: "RTD",
        keywords: "temperature resistance platinum",
        props: { type: "rtd" },
    },
    {
        id: "load-cell",
        kind: "instrument",
        name: "Load cell",
        category: "instruments",
        prefix: "LC",
        keywords: "thrust force weight mass",
        props: { type: "force" },
    },
    {
        id: "flow-transmitter",
        kind: "instrument",
        name: "Flow transmitter",
        category: "instruments",
        prefix: "FT",
        keywords: "flow sensor",
        props: { type: "flow" },
    },
    {
        id: "level-sensor",
        kind: "instrument",
        name: "Level sensor",
        category: "instruments",
        prefix: "LT",
        keywords: "liquid level capacitance",
        props: { type: "level" },
    },
    {
        id: "position-sensor",
        kind: "instrument",
        name: "Position sensor",
        category: "instruments",
        prefix: "ZT",
        keywords: "valve position limit switch feedback",
        props: { type: "position" },
    },
    {
        id: "pressure-switch",
        kind: "instrument",
        name: "Pressure switch",
        category: "instruments",
        prefix: "PS",
        keywords: "switch",
        props: { type: "switch" },
    },
    {
        id: "dp-transducer",
        kind: "instrument",
        name: "Differential pressure transducer",
        category: "instruments",
        prefix: "DPT",
        keywords: "delta p dp",
        props: { type: "dp" },
    },
    {
        id: "pressure-gauge",
        kind: "gauge",
        name: "Pressure gauge",
        category: "instruments",
        prefix: "PG",
        keywords: "dial analog",
    },
    {
        id: "instrument",
        kind: "instrument",
        name: "Instrument",
        category: "instruments",
        prefix: "I",
        keywords: "sensor bubble generic",
        props: { type: "other" },
    },
    // Equipment
    {
        id: "engine",
        kind: "engine",
        name: "Engine",
        category: "equipment",
        prefix: "ENG",
        keywords: "thrust chamber combustion chamber nozzle injector motor",
    },
    { id: "pump", kind: "pump", name: "Pump", category: "equipment", prefix: "P", keywords: "centrifugal turbopump" },
    {
        id: "igniter",
        kind: "igniter",
        name: "Igniter",
        category: "equipment",
        prefix: "IGN",
        keywords: "spark torch pyro",
    },
    {
        id: "heat-exchanger",
        kind: "exchanger",
        name: "Heat exchanger",
        category: "equipment",
        prefix: "HX",
        keywords: "cooler heater coil",
    },
    {
        id: "vent",
        kind: "vent",
        name: "Vent",
        category: "equipment",
        prefix: "",
        keywords: "atmosphere exhaust dump overboard",
    },
    {
        id: "box",
        kind: "block",
        name: "Box",
        category: "equipment",
        prefix: "",
        keywords: "block rectangle equipment custom daq stand",
        text: "Box",
        w: 80,
        h: 40,
    },
    // Fittings
    {
        id: "junction",
        kind: "junction",
        name: "Tee (junction)",
        category: "fittings",
        prefix: "",
        keywords: "tee cross branch node",
    },
    { id: "cap", kind: "cap", name: "Cap", category: "fittings", prefix: "", keywords: "plug end blind" },
    { id: "reducer", kind: "reducer", name: "Reducer", category: "fittings", prefix: "", keywords: "adapter expander" },
    {
        id: "hose",
        kind: "hose",
        name: "Flex hose",
        category: "fittings",
        prefix: "H",
        keywords: "flexible braided line",
    },
    // Notes
    {
        id: "text",
        kind: "text",
        name: "Text",
        category: "notes",
        prefix: "",
        keywords: "note label words",
        text: "Text",
    },
    {
        id: "region",
        kind: "region",
        name: "Region",
        category: "notes",
        prefix: "",
        keywords: "box group area boundary vehicle gse",
        text: "Region",
        w: 300,
        h: 200,
    },
    {
        id: "offpage",
        kind: "offpage",
        name: "Off-page connector",
        category: "notes",
        prefix: "",
        keywords: "continuation to from sheet",
        text: "TO GSE",
    },
    { id: "legend", kind: "legend", name: "Legend", category: "notes", prefix: "", keywords: "key colors" },
    {
        id: "title-block",
        kind: "titleblock",
        name: "Title block",
        category: "notes",
        prefix: "",
        keywords: "revision drawing number",
    },
];

const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

export const presetOf = (id: string): Preset | undefined => BY_ID.get(id);

/** The presets in the library's order, by category. */
export function presetsBy(category: Category): Preset[] {
    return PRESETS.filter((preset) => preset.category === category);
}

/** The presets whose names, keywords, or tag prefix have every word searched for. */
export function searchPresets(text: string): Preset[] {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return PRESETS;
    }
    return PRESETS.filter((preset) => {
        const category = CATEGORIES.find((entry) => entry.id === preset.category)?.name ?? "";
        const haystack = `${preset.name} ${preset.keywords} ${preset.prefix} ${category}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
    });
}

/** What a part is called: its preset's name where it's set up as one is (a solenoid valve), else its kind's. */
export function titleOf(part: Part): string {
    const kind = kindOf(part.kind);
    if (kind.title) {
        return kind.title(part);
    }
    return kind.name;
}

/** A part's box in the drawing. */
export const boxOf = (part: Part, drawing: Drawing): Box => worldBox(part, kindOf(part.kind).box(part, drawing));
