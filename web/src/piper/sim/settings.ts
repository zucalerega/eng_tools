import type { Document, Line, LineSim, Part, PartSim, SimValues } from "../drawing";
import type { Catalog, FitKnob, ModelPart, Quantity, Setting, SystemModel } from "./api";
import {
    kindOfType,
    linkRole,
    linkWords,
    outputOf,
    shownLinks,
    shownSettings,
    withDefaults,
    type Built,
} from "./model";

// A simulation's settings on the P&ID: changed one at a time from the inspector, or many at once by what a fit or an
// anchored run found; and what a run is compared with, and which knobs it can turn.

const NO_PART_SIM: PartSim = { as: "", settings: {} };
const NO_LINE_SIM: LineSim = { line: null, node: {} };

/** A document with a part's simulation changed, on whichever page it's on. */
export function withPartSim(document: Document, partId: string, change: (sim: PartSim) => PartSim): Document {
    const update = (part: Part): Part =>
        part.id === partId ? { ...part, sim: change(part.sim ?? NO_PART_SIM) } : part;
    return { ...document, pages: document.pages.map((page) => ({ ...page, parts: page.parts.map(update) })) };
}

/** A document with some lines' simulation changed (a point's lines, each keeping its settings), wherever they are. */
export function withLineSim(document: Document, lineIds: string[], change: (sim: LineSim) => LineSim): Document {
    const ids = new Set(lineIds);
    const update = (line: Line): Line => (ids.has(line.id) ? { ...line, sim: change(line.sim ?? NO_LINE_SIM) } : line);
    return { ...document, pages: document.pages.map((page) => ({ ...page, lines: page.lines.map(update) })) };
}

/** Settings with one set, or (undefined) back to what it'd be if it weren't. */
export function withValue(values: SimValues, key: string, value: number | string | undefined): SimValues {
    const next = { ...values };
    if (value === undefined) {
        delete next[key];
    } else {
        next[key] = value;
    }
    return next;
}

/** A document with a model's part's setting changed, where the P&ID keeps it: on the part it is, on the line it is, or
 * on each of the lines of the point it is. */
export function withModelSetting(
    document: Document,
    built: Built,
    modelId: string,
    key: string,
    value: number | string | undefined,
): Document {
    const origin = built.origins.get(modelId);
    if (!origin) {
        return document;
    }
    if (origin.part !== null) {
        return withPartSim(document, origin.part, (sim) => ({ ...sim, settings: withValue(sim.settings, key, value) }));
    }
    const edge = built.model.edges.some((one) => one.id === modelId);
    return withLineSim(document, origin.lines, (sim) =>
        edge
            ? { ...sim, line: withValue(sim.line ?? {}, key, value) }
            : { ...sim, node: withValue(sim.node, key, value) },
    );
}

export const partOf = (model: SystemModel, id: string): ModelPart | undefined =>
    model.nodes.find((one) => one.id === id) ?? model.edges.find((one) => one.id === id);

/** A setting of a model's part, as the catalog has it. */
export function settingOf(
    model: SystemModel,
    catalog: Catalog,
    knob: { part: string; key: string },
): Setting | undefined {
    const part = partOf(model, knob.part);
    return part ? kindOfType(catalog, part.type)?.settings.find((one) => one.key === knob.key) : undefined;
}

/** Whether a value is within its setting's limits: an anchor can take a knob past them, which no part can have. */
export function withinLimits(setting: Setting | undefined, value: number): boolean {
    return (setting?.minimum ?? -Infinity) <= value && value <= (setting?.maximum ?? Infinity);
}

/** The P&ID with what a fit (or an anchored run) found, where it's within its settings' limits. */
export function applyKnobs(document: Document, built: Built, catalog: Catalog, found: FitKnob[]): Document {
    return found
        .filter((knob) => withinLimits(settingOf(built.model, catalog, knob), knob.value))
        .reduce((next, knob) => withModelSetting(next, built, knob.part, knob.key, knob.value), document);
}

/** A measured channel and the model's output it's compared with. */
export interface Comparison {
    part: string; // the model's part's id
    link: string; // the link's key: "pressure"
    name: string; // "PT-101 pressure"
    output: string; // "n2.pressure": its key in a run's series
    channel: string;
    quantity: Quantity;
}

/** What a run's compared with: each sensor's channel with its part's output, and each value that starts the model from
 * a channel (an ullage's pressure, a gas vessel's) with where the model took it. */
export function comparisons(model: SystemModel, catalog: Catalog): Comparison[] {
    const found: Comparison[] = [];
    for (const part of [...model.nodes, ...model.edges]) {
        const kind = kindOfType(catalog, part.type);
        if (!kind) {
            continue;
        }
        const settings = withDefaults(kind, part.settings);
        for (const link of shownLinks(kind, part.settings)) {
            const channel = part.links[link.key];
            const role = linkRole(link, settings);
            if (!channel || (role !== "sensor" && role !== "start")) {
                continue;
            }
            found.push({
                part: part.id,
                link: link.key,
                name: `${part.name} ${linkWords(link)}`, // "PT-101 pressure", "TK-LOX ullage temperature", "INJ-1 flow"
                output: `${part.id}.${outputOf(link)}`,
                channel,
                quantity: link.quantity,
            });
        }
    }
    return found;
}

/**
 * The parts that hold what was measured in a steady run (Yorg's api._held): tanks, and gas vessels and points a
 * transducer reads, since a bottle draining has no steady state. There, their knobs don't matter, and their sensors are
 * what they follow.
 */
export function heldInSteady(model: SystemModel): Set<string> {
    return new Set(
        model.nodes
            .filter((node) => node.type === "tank" || (node.type === "gas_junction" && node.links.pressure))
            .map((node) => node.id),
    );
}

/** The knobs a fit or an anchor can turn: each part's tunable settings, as it's set up. */
export function knobsOf(model: SystemModel, catalog: Catalog): { part: ModelPart; setting: Setting }[] {
    return [...model.nodes, ...model.edges].flatMap((part) => {
        const kind = kindOfType(catalog, part.type);
        return kind
            ? shownSettings(kind, part.settings)
                  .filter((setting) => setting.tunable)
                  .map((setting) => ({ part, setting }))
            : [];
    });
}
