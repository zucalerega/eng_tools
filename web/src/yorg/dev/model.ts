import type { Placement } from "../samples";
import type { Catalog, Display, Edge, Part, PartKind, Quantity, Setting, SystemModel } from "./api";
import { ATMOSPHERE, channelToSiLinear, siToDisplayLinear } from "./units";

// Editing a system model: parts added, connected, moved, changed, and deleted, each change a new model (the page
// keeps the old one to undo). Settings are kept in SI units, as the server wants them.

export const EMPTY_MODEL: SystemModel = {
    version: 1,
    nodes: [],
    edges: [],
    display: { units: "us", gauge: true, ambient: ATMOSPHERE },
};

/**
 * A cold flow to start from: a water tank at a fixed pressure, a feed line, the main valve, the manifold, and an
 * injector into the atmosphere. Link its channels, then tune its CdAs and line loss.
 */
export function exampleModel(catalog: Catalog): SystemModel {
    let model: SystemModel = EMPTY_MODEL;
    const place = (type: string, x: number, y: number, name: string): string => {
        const [next, id] = addNode(model, catalog, type, x, y);
        model = changePart(next, id, { name });
        return id;
    };
    const tank = place("tank", 110, 250, "Fuel tank");
    const inlet = place("junction", 380, 250, "Valve inlet");
    const manifold = place("junction", 620, 250, "Manifold");
    const outlet = place("outlet", 880, 250, "Atmosphere");
    const connect = (type: string, from: string, to: string, name: string) => {
        const [next, id] = addEdge(model, catalog, type, from, to);
        model = changePart(next, id, { name });
    };
    connect("line", tank, inlet, "Feed line");
    connect("valve", inlet, manifold, "Main valve");
    connect("orifice", manifold, outlet, "Injector");
    return model;
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
    if (kind.phase === "gas") {
        return from.type === "source" && to.type === "tank" ? null : "A press line goes from a gas supply into a tank.";
    }
    return from.type === "source" || to.type === "source"
        ? `A ${kind.label.toLowerCase()} carries liquid: a gas supply connects to a tank with a press line.`
        : null;
}

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
    return [{ ...model, edges: [...model.edges, edge] }, edge.id];
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

/** The settings that matter for a part as it's set up (an ullage's only with an ullage). */
export function shownSettings(kind: PartKind, settings: Record<string, number | string>): Setting[] {
    return kind.settings.filter(
        (setting) => !setting.only_when || settings[setting.only_when[0]] === setting.only_when[1],
    );
}

/** A measured channel and the model's output it's compared with. */
export interface Comparison {
    part: string; // its id
    name: string; // "Manifold pressure"
    output: string; // "n2.pressure": its key in a run's series
    channel: string;
    quantity: Quantity;
}

/** What to compare after a run: each sensor's channel with its part's output, and an ullage tank's pressure. */
export function comparisons(model: SystemModel, catalog: Catalog): Comparison[] {
    const found: Comparison[] = [];
    for (const part of [...model.nodes, ...model.edges]) {
        const kind = kindOf(catalog, part.type);
        for (const link of kind.links) {
            const channel = part.links[link.key];
            const compared =
                link.role === "sensor" ||
                (part.type === "tank" && part.settings.mode === "ullage" && link.key === "pressure");
            if (!channel || !compared) {
                continue;
            }
            const output = link.quantity === "mass_flow" ? "mass_flow" : link.key;
            found.push({
                part: part.id,
                name: `${part.name} ${link.label.toLowerCase()}`,
                output: `${part.id}.${output}`,
                channel,
                quantity: link.quantity,
            });
        }
    }
    return found;
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
