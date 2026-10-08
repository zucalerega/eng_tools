import type { Placement } from "../samples";
import type {
    Catalog,
    Conditions,
    Display,
    Edge,
    Link,
    Part,
    PartKind,
    Quantity,
    Role,
    Setting,
    SystemModel,
} from "./api";
import { ATMOSPHERE, channelToSiLinear, PSI, siToDisplayLinear } from "./units";

// Editing a system model: parts added, connected, moved, changed, and deleted, each change a new model (the page
// keeps the old one to undo). Settings are kept in SI units, as the server wants them. The rules for what connects to
// what are the server's (server/src/yjsp_server/yorg/system/spec.py), said here as you draw.

export const EMPTY_MODEL: SystemModel = {
    version: 1,
    nodes: [],
    edges: [],
    display: { units: "us", gauge: true, ambient: ATMOSPHERE },
};

/** Builds a model part by part, each named, placed, set up, and linked to channels. */
function builder(catalog: Catalog) {
    let model: SystemModel = EMPTY_MODEL;
    const setUp = (id: string, settings: Record<string, number | string>, links: Record<string, string>) => {
        model = Object.entries(settings).reduce((at, [key, value]) => setSetting(at, id, key, value), model);
        model = Object.entries(links).reduce((at, [key, channel]) => setLink(at, id, key, channel), model);
    };
    return {
        place(
            type: string,
            x: number,
            y: number,
            name: string,
            settings: Record<string, number | string> = {},
            links: Record<string, string> = {},
        ) {
            const [next, id] = addNode(model, catalog, type, x, y);
            model = changePart(next, id, { name });
            setUp(id, settings, links);
            return id;
        },
        connect(
            type: string,
            from: string,
            to: string,
            name: string,
            settings: Record<string, number | string> = {},
            links: Record<string, string> = {},
        ) {
            const [next, id] = addEdge(model, catalog, type, from, to);
            model = changePart(next, id, { name });
            setUp(id, settings, links);
            return id;
        },
        get model() {
            return model;
        },
    };
}

/**
 * A cold flow to start from: a water tank at a fixed pressure, a feed line, the main valve, the manifold, and an
 * injector into the atmosphere. Link its channels, then tune its CdAs and line loss.
 */
export function exampleModel(catalog: Catalog): SystemModel {
    const draw = builder(catalog);
    const tank = draw.place("tank", 110, 250, "Fuel tank");
    const inlet = draw.place("junction", 380, 250, "Valve inlet");
    const manifold = draw.place("junction", 620, 250, "Manifold");
    const outlet = draw.place("outlet", 880, 250, "Atmosphere");
    draw.connect("line", tank, inlet, "Feed line");
    draw.connect("valve", inlet, manifold, "Main valve");
    draw.connect("orifice", manifold, outlet, "Injector");
    return draw.model;
}

/**
 * A pressurized flow: a nitrogen bottle, a regulator, the press manifold and press valve into the fuel tank's ullage
 * (heated by its wall), the main valve, a cavitating venturi into the chamber, and a vent off the tank.
 */
export function pressurizedExample(catalog: Catalog): SystemModel {
    const draw = builder(catalog);
    const setpoint = 300 * PSI + ATMOSPHERE;
    const bottle = draw.place("source", 110, 110, "Nitrogen bottle", { pressure: 2000 * PSI + ATMOSPHERE });
    const manifold = draw.place("gas_junction", 400, 110, "Press manifold", { pressure: setpoint });
    const tank = draw.place("tank", 400, 340, "Fuel tank", { mode: "ullage", pressure: setpoint });
    const inlet = draw.place("junction", 640, 340, "Venturi inlet");
    const chamber = draw.place("outlet", 890, 340, "Chamber");
    const stack = draw.place("outlet", 130, 340, "Vent stack");
    draw.connect("regulator", bottle, manifold, "Regulator", { setpoint, cda: 4e-6 });
    draw.connect("gas_valve", manifold, tank, "Press valve", { cda: 2e-5 });
    draw.connect("valve", tank, inlet, "Main valve", { cda: 8e-5 });
    draw.connect("venturi", inlet, chamber, "Venturi");
    draw.connect("gas_valve", tank, stack, "Vent", { cda: 5e-6, check: "no", position: 0 });
    return draw.model;
}

/** The Vespula run's data: the name it's uploaded to Yorg under, and its end (s). */
export const VESPULA_RUN = { dataset: "Vespula prop system (FullFlow run)", end: 21.3 };

const IN2 = 0.00064516; // m²
const CM2 = 1e-4; // m²

/**
 * Vespula's propulsion system, as Saaketh Ramoju's FullFlow model has it (github.com/saakethramoju/Vespula,
 * VESPULA_PROP_SYSTEM.py and VESPULA_DATA.py): a 40 L nitrogen COPV pressurizing the LOX and fuel tanks through
 * lo-flow orifices, and through hi-flow valves once it's below 2500 psia; each tank's relief valve; and each side's
 * system CdA, manifold, and injector into the chamber. It's linked to the channels of that model's run (vespula-run.csv,
 * the run its repository's prop curves came from, made again with FullFlow 2.0.3 to have every channel): the hi-flow
 * switches and relief valves drive their valves, the chamber's pressure is the injectors' outlets', and the rest is
 * compared. The chamber is two outlets because a model carries one liquid in each connected set of lines.
 *
 * Built of the same FullFlow components with the same ThermoProp properties (real nitrogen, LOX, and RP-1), a
 * transient run of it at 0.1 s steps is that run again: every pressure, temperature, and flow to a few parts in a
 * million.
 */
export function vespulaExample(catalog: Catalog): SystemModel {
    const draw = builder(catalog);
    const tank = (side: "LOX" | "Fuel", x: number, settings: Record<string, number | string>) =>
        draw.place(
            "tank",
            x,
            250,
            `${side} tank`,
            {
                mode: "ullage",
                gas: "Nitrogen",
                gas_model: "real",
                gas_temperature: 298.15,
                heat_transfer: 0, // Vespula's ullages trade no heat with their walls
                collapse_factor: 1.2,
                ...settings,
            },
            { pressure: `${side} Tank Pressure`, gas_temperature: `${side} Ullage Temperature` },
        );
    const copv = draw.place(
        "gas_junction",
        500,
        80,
        "COPV",
        { volume: 0.04, pressure: 4200 * PSI, temperature: 298.15 },
        { pressure: "COPV Pressure", temperature: "COPV Temperature" },
    );
    const lox = tank("LOX", 260, {
        fluid: "Oxygen",
        temperature: 100,
        pressure: 357 * PSI,
        volume: 0.08582,
        liquid_volume: 0.07697,
    });
    const fuel = tank("Fuel", 740, {
        fluid: "RP1", // ThermoProp's RP-1 propellant, as Vespula's
        temperature: 298.15,
        pressure: 416 * PSI,
        volume: 0.05976,
        liquid_volume: 0.05211,
    });
    const loxVent = draw.place("outlet", 70, 250, "LOX vent");
    const fuelVent = draw.place("outlet", 930, 250, "Fuel vent");
    const loxManifold = draw.place("junction", 260, 410, "LOX manifold", {}, { pressure: "LOX Manifold Pressure" });
    const fuelManifold = draw.place("junction", 740, 410, "Fuel manifold", {}, { pressure: "Fuel Manifold Pressure" });
    const chamber = { pressure: 285 * PSI };
    const loxChamber = draw.place("outlet", 410, 510, "Chamber (LOX)", chamber, { pressure: "Chamber Pressure" });
    const fuelChamber = draw.place("outlet", 590, 510, "Chamber (fuel)", chamber, { pressure: "Chamber Pressure" });
    // Switched by a channel, at once: the hi-flow valves (COPV below 2500 psia) and the reliefs.
    const switched = (cda: number, command: string) =>
        [{ cda, opening_time: 0.001, position: 0 }, { command }] as const;
    draw.connect("gas_orifice", copv, lox, "LOX lo-flow orifice", { cda: 0.005460362 * IN2 });
    draw.connect("gas_valve", copv, lox, "LOX hi-flow valve", ...switched(0.006515668 * IN2, "LOX Hi Flow Switch"));
    draw.connect("gas_orifice", copv, fuel, "Fuel lo-flow orifice", { cda: 0.002507537 * IN2 });
    draw.connect("gas_valve", copv, fuel, "Fuel hi-flow valve", ...switched(0.003124906 * IN2, "Fuel Hi Flow Switch"));
    draw.connect("gas_valve", lox, loxVent, "LOX relief valve", ...switched(0.08942 * IN2, "LOX Relief Valve"));
    draw.connect("gas_valve", fuel, fuelVent, "Fuel relief valve", ...switched(0.0769 * IN2, "Fuel Relief Valve"));
    draw.connect("orifice", lox, loxManifold, "LOX system", { cda: 1.51 * CM2 });
    draw.connect(
        "orifice",
        loxManifold,
        loxChamber,
        "LOX injector",
        { cda: 1.25 * CM2 },
        { flow: "LOX Injector Mass Flow" },
    );
    draw.connect("orifice", fuel, fuelManifold, "Fuel system", { cda: 0.633 * CM2 });
    draw.connect(
        "orifice",
        fuelManifold,
        fuelChamber,
        "Fuel injector",
        { cda: 0.555 * CM2 },
        { flow: "Fuel Injector Mass Flow" },
    );
    return draw.model;
}

export function kindOf(catalog: Catalog, type: string): PartKind {
    const found = catalog.parts.find((part) => part.type === type);
    if (!found) {
        throw new Error(`No part type ${type}`);
    }
    return found;
}

export function partOf(model: SystemModel, id: string | null): Part | Edge | undefined {
    return model.nodes.find((node) => node.id === id) ?? model.edges.find((edge) => edge.id === id);
}

export const isEdge = (part: Part | Edge): part is Edge => "source" in part;

function newId(model: SystemModel, prefix: string): string {
    const taken = new Set([...model.nodes, ...model.edges].map((part) => part.id));
    let count = 1;
    while (taken.has(`${prefix}${count}`)) {
        count += 1;
    }
    return `${prefix}${count}`;
}

function newName(model: SystemModel, kind: PartKind): string {
    const taken = new Set([...model.nodes, ...model.edges].map((part) => part.name));
    let count = 1;
    while (taken.has(`${kind.label} ${count}`)) {
        count += 1;
    }
    return `${kind.label} ${count}`;
}

const defaults = (kind: PartKind) => Object.fromEntries(kind.settings.map((setting) => [setting.key, setting.default]));

export function addNode(
    model: SystemModel,
    catalog: Catalog,
    type: string,
    x: number,
    y: number,
): [SystemModel, string] {
    const kind = kindOf(catalog, type);
    const node: Part = {
        id: newId(model, "n"),
        type,
        name: newName(model, kind),
        x,
        y,
        settings: defaults(kind),
        links: {},
    };
    return [{ ...model, nodes: [...model.nodes, node] }, node.id];
}

// Where liquid and gas can go: an ullage tank holds both, an outlet takes either.
const LIQUID_ENDS = new Set(["tank", "junction", "outlet"]);
const GAS_ENDS = new Set(["source", "gas_junction", "tank", "outlet"]);

/** A new edge from one node to another; or why it can't go there (null: it can). */
export function connectProblem(
    model: SystemModel,
    catalog: Catalog,
    type: string,
    source: string,
    target: string,
): string | null {
    const kind = kindOf(catalog, type);
    const from = model.nodes.find((node) => node.id === source);
    const to = model.nodes.find((node) => node.id === target);
    if (!from || !to || source === target) {
        return "Pick two different places to connect.";
    }
    const label = kind.label.toLowerCase();
    if (kind.phase === "gas") {
        const wrong = [from, to].find((end) => !GAS_ENDS.has(end.type));
        if (wrong) {
            return `A ${label} carries gas: connect it to gas supplies, gas junctions, tanks, and outlets, not ${wrong.name}.`;
        }
        if (type === "regulator" && to.type !== "gas_junction" && to.type !== "tank") {
            return "A regulator holds the pressure where it flows to: connect it to a gas junction or a tank.";
        }
        return null;
    }
    const wrong = [from, to].find((end) => !LIQUID_ENDS.has(end.type));
    return wrong
        ? `A ${label} carries liquid: ${wrong.name} is for gas, which gas valves, orifices, and regulators connect.`
        : null;
}

/** An edge from one node to another (connectProblem says if it can go there). Gas into or out of a tank gives it a
 * gas ullage. */
export function addEdge(
    model: SystemModel,
    catalog: Catalog,
    type: string,
    source: string,
    target: string,
): [SystemModel, string] {
    const kind = kindOf(catalog, type);
    const edge: Edge = {
        id: newId(model, "e"),
        type,
        name: newName(model, kind),
        x: 0,
        y: 0,
        settings: defaults(kind),
        links: {},
        source,
        target,
    };
    let next: SystemModel = { ...model, edges: [...model.edges, edge] };
    if (kind.phase === "gas") {
        for (const end of [source, target]) {
            const node = next.nodes.find((one) => one.id === end);
            if (node?.type === "tank" && node.settings.mode !== "ullage") {
                next = setSetting(next, end, "mode", "ullage");
            }
        }
    }
    return [next, edge.id];
}

/** A part gone: a node with the edges at it. */
export function removePart(model: SystemModel, id: string): SystemModel {
    return {
        ...model,
        nodes: model.nodes.filter((node) => node.id !== id),
        edges: model.edges.filter((edge) => edge.id !== id && edge.source !== id && edge.target !== id),
    };
}

export function changePart(model: SystemModel, id: string, change: Partial<Part>): SystemModel {
    return {
        ...model,
        nodes: model.nodes.map((node) => (node.id === id ? { ...node, ...change } : node)),
        edges: model.edges.map((edge) => (edge.id === id ? { ...edge, ...change } : edge)),
    };
}

/** An edge the other way round. */
export function reverse(model: SystemModel, id: string): SystemModel {
    return {
        ...model,
        edges: model.edges.map((edge) =>
            edge.id === id ? { ...edge, source: edge.target, target: edge.source } : edge,
        ),
    };
}

export function setSetting(model: SystemModel, id: string, key: string, value: number | string): SystemModel {
    const part = partOf(model, id);
    return part ? changePart(model, id, { settings: { ...part.settings, [key]: value } }) : model;
}

export function setLink(model: SystemModel, id: string, key: string, channel: string): SystemModel {
    const part = partOf(model, id);
    if (!part) {
        return model;
    }
    const links = { ...part.links };
    if (channel) {
        links[key] = channel;
    } else {
        delete links[key];
    }
    return changePart(model, id, { links });
}

/** Whether every condition holds for a part set up as settings (none: yes; null: never). */
export function applies(conditions: Conditions | null, settings: Record<string, number | string>): boolean {
    return conditions !== null && conditions.every(([key, value]) => settings[key] === value);
}

/** The settings that matter for a part as it's set up (an ullage's only with an ullage). */
export function shownSettings(kind: PartKind, settings: Record<string, number | string>): Setting[] {
    return kind.settings.filter((setting) => applies(setting.only_when, settings));
}

/** The links that matter for a part as it's set up (a wall's temperature only when its heat's modeled). */
export function shownLinks(kind: PartKind, settings: Record<string, number | string>): Link[] {
    return kind.links.filter((link) => applies(link.only_when, settings));
}

/** What a link does for a part set up as settings: an ullage tank's pressure starts the model, a fixed tank's is
 * followed. */
export function roleOf(link: Link, settings: Record<string, number | string>): Role {
    return applies(link.start_when, settings) ? "start" : link.role;
}

/** The output a link's channel is compared with: an edge's flow, or the node's value of the link's name. */
export const outputOf = (link: Link): string => (link.quantity === "mass_flow" ? "mass_flow" : link.key);

/** A measured channel and the model's output it's compared with. */
export interface Comparison {
    part: string; // its id
    link: string; // the link's key: "pressure"
    name: string; // "Manifold pressure"
    output: string; // "n2.pressure": its key in a run's series
    channel: string;
    quantity: Quantity;
}

/** What to compare after a run: each sensor's channel with its part's output, and each value that starts the model
 * from a channel (an ullage's pressure, a gas junction's) with where the model took it. */
export function comparisons(model: SystemModel, catalog: Catalog): Comparison[] {
    const found: Comparison[] = [];
    for (const part of [...model.nodes, ...model.edges]) {
        const kind = kindOf(catalog, part.type);
        for (const link of shownLinks(kind, part.settings)) {
            const channel = part.links[link.key];
            const role = roleOf(link, part.settings);
            if (!channel || (role !== "sensor" && role !== "start")) {
                continue;
            }
            found.push({
                part: part.id,
                link: link.key,
                name: `${part.name} ${link.label.toLowerCase()}`,
                output: `${part.id}.${outputOf(link)}`,
                channel,
                quantity: link.quantity,
            });
        }
    }
    return found;
}

/** The knobs a fit can turn: each part's tunable settings, as it's set up. */
export function knobsOf(model: SystemModel, catalog: Catalog): { part: Part; setting: Setting }[] {
    return [...model.nodes, ...model.edges].flatMap((part) =>
        shownSettings(kindOf(catalog, part.type), part.settings)
            .filter((setting) => setting.tunable)
            .map((setting) => ({ part, setting })),
    );
}

/** Where a model's output (SI) goes on a plot: in the model's units. */
export function modelPlacement(quantity: Quantity, display: Display): Placement {
    const { scale, offset } = siToDisplayLinear(quantity, display);
    return { shift: 0, scale, offset };
}

/** Where a channel's samples go on the same plot: from its unit, through SI, into the model's units. */
export function channelPlacement(quantity: Quantity, unit: string, display: Display): Placement {
    const toSi = channelToSiLinear(quantity, unit, display);
    const toDisplay = siToDisplayLinear(quantity, display);
    return { shift: 0, scale: toSi.scale * toDisplay.scale, offset: toSi.offset * toDisplay.scale + toDisplay.offset };
}

/** A model file as exported (Export on the dev page): its name and the model. */
export interface ModelFile {
    name: string;
    model: SystemModel;
}

export function exportModel(name: string, model: SystemModel): string {
    return JSON.stringify({ format: "yorg-system-model", name, model }, null, 2);
}

/** A model file read back, checked enough to open (the server checks the rest when it's saved or run). */
export function importModel(text: string, fallbackName: string): ModelFile {
    let found: unknown;
    try {
        found = JSON.parse(text);
    } catch {
        throw new Error("That file isn't a system model: it isn't JSON.");
    }
    const file = found as { name?: unknown; model?: unknown };
    const model = (file.model ?? found) as Partial<SystemModel>;
    if (!model || !Array.isArray(model.nodes) || !Array.isArray(model.edges)) {
        throw new Error("That file isn't a system model: it has no parts.");
    }
    const renamed = (part: Part): Part => (part.type === "gas_line" ? { ...part, type: "gas_valve" } : part);
    return {
        name: typeof file.name === "string" && file.name.trim() ? file.name.trim() : fallbackName,
        model: {
            version: 1,
            nodes: model.nodes.map(renamed),
            edges: model.edges.map((edge) => renamed(edge) as Edge),
            display: { ...EMPTY_MODEL.display, ...(model.display ?? {}) },
        },
    };
}
