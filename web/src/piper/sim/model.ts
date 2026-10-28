import {
    isPortEnd,
    pageOf,
    STANDARD_SIM_UNITS,
    type Document,
    type Drawing,
    type Line,
    type LineKind,
    type Part,
    type SimValues,
} from "../drawing";
import { isGas } from "../fluids";
import { figureOf } from "../library/figures";
import { kindOf, titleOf } from "../library/index";
import { channelNames, findChannel, type TestChannel, type TestDetail } from "../testdata";
import type { Catalog, Conditions, Link, ModelEdge, ModelPart, PartKind, Role, Setting, SystemModel } from "./api";

// The diagram's simulation, built from its P&ID (Simulation mode, docs/piper.md): the model Yorg runs with FullFlow.
// Its nodes are points with a pressure (tanks, gas supplies and vessels, outlets, and the points between parts, where
// lines and tees join), and its edges what carries flow between them (valves, regulators, orifices, venturis, flow
// meters, and liquid lines modeled as lines). What a part is in it comes from its kind (a ball valve is a valve, a tee
// joins its lines into one point), unless it's set otherwise (a bottle: a gas supply, or a vessel that blows down);
// whether it carries liquid or gas, from its lines' fluids; and what drives it and what it's compared with, from the
// channels its P&ID names (a valve's command is its Test channel, or its tag; a transducer's pressure, that of where it
// taps). Its settings are kept on the parts (PartSim) and lines (LineSim), in SI units, at the catalog's defaults where
// they aren't set. The rules for what can connect to what are Yorg's (server/src/yjsp_server/yorg/system/spec.py);
// those that are the P&ID's to fix are found here first, to say which of its parts.

/** What a part (or a line) is in the model. */
export type SimRole =
    | "tank" // a tank of liquid, at a fixed pressure or under a gas ullage
    | "supply" // a gas supply at a fixed pressure, or one measured
    | "vessel" // a vessel of gas that blows down: a COPV, a bottle
    | "outlet" // where flow leaves: an engine's chamber, the atmosphere
    | "valve"
    | "check" // a valve gas flows through only the way it points
    | "regulator"
    | "orifice"
    | "venturi" // a cavitating venturi
    | "meter" // a flow meter: what flows through what it's in line with, compared with its channel; it adds no loss
    | "line" // a liquid line, with its friction and its liquid's inertia
    | "sensor" // an instrument: what its channel measures, where it taps
    | "through" // what flows in flows out, with nothing lost: its ports are one point (a tee, a hose)
    | "none"; // not in the model: its ports are ends (a pump, a three-way valve, a note)

export const ROLE_NAMES: Record<SimRole, string> = {
    tank: "A tank",
    supply: "A gas supply, at a pressure",
    vessel: "A vessel that blows down",
    outlet: "An outlet",
    valve: "A valve",
    check: "A check valve",
    regulator: "A regulator",
    orifice: "An orifice",
    venturi: "A cavitating venturi",
    meter: "A flow meter, with no loss",
    line: "A line, with its friction and inertia",
    sensor: "A sensor",
    through: "A plain connection, with no loss",
    none: "Left out: nothing flows past it",
};

const NODE_ROLES = new Set<SimRole>(["tank", "supply", "vessel", "outlet"]);
const EDGE_ROLES = new Set<SimRole>(["valve", "check", "regulator", "orifice", "venturi"]);

/** What each kind can be in the model, the first what it is unless it's set otherwise. A kind not here is a plain
 * connection if what flows in flows out of it, and isn't in the model if not. */
const ROLES: Record<string, SimRole[]> = {
    tank: ["tank"],
    sphere: ["tank"],
    dewar: ["tank"],
    bottle: ["supply", "vessel"],
    valve: ["valve", "through", "none"],
    angle: ["valve", "through", "none"],
    check: ["check", "through", "none"],
    relief: ["valve", "none"],
    burst: ["none", "valve"],
    qd: ["through", "valve", "none"],
    regulator: ["regulator", "through", "none"],
    orifice: ["orifice", "through", "none"],
    venturi: ["venturi", "orifice", "through", "none"],
    flowmeter: ["meter", "orifice", "none"],
    filter: ["through", "orifice", "none"],
    diffuser: ["through", "orifice", "none"],
    instrument: ["sensor"],
    engine: ["outlet"],
    vent: ["outlet"],
    valve3: ["none"],
    valve32: ["none"],
    valve52: ["none"],
    pump: ["none"],
    cap: ["none"],
};

/** Kinds that do what the model can't to their flow, so lines end at them: a pump adds pressure, and a three-way or
 * directional valve switches it between lines. Said of each, unlike a note's or a cap's ends. */
export const NOT_SIMULATED = new Set(["pump", "valve3", "valve32", "valve52"]);

/** Kinds that hold a fluid: a tank of liquid, or of a gas, a supply or a vessel. */
const VESSELS = new Set(["tank", "sphere", "dewar"]);

/** What a part can be in the model, the first what it is unless it's set otherwise: a tank of a gas is a supply or a
 * vessel, and a venturi that doesn't cavitate an orifice. */
export function roleChoices(part: Part, fluids: Drawing): SimRole[] {
    if (VESSELS.has(part.kind) && part.props.fluid && isGas(fluids, part.props.fluid)) {
        return ["supply", "vessel"];
    }
    if (part.kind === "venturi" && part.props.cavitating !== "yes") {
        return ["orifice", "venturi", "through", "none"];
    }
    return ROLES[part.kind] ?? (kindOf(part.kind).through ? ["through"] : ["none"]);
}

export function roleOf(part: Part, fluids: Drawing): SimRole {
    const choices = roleChoices(part, fluids);
    const asked = part.sim?.as as SimRole | undefined;
    return asked && choices.includes(asked) ? asked : choices[0]!;
}

/** Lines that carry signals, not fluid: not in the model. */
const SIGNALS = new Set<LineKind>(["pneumatic", "electric", "signal"]);

/** ThermoProp's liquid for each of Piper's standard liquids it has; any other is Custom, of a density and vapor
 * pressure it's given. */
export const LIQUIDS: Record<string, string> = {
    water: "Water",
    ethanol: "Ethanol",
    rp1: "RP1",
    lox: "Oxygen",
    n2o: "NitrousOxide",
    methane: "Methane",
};
export const GASES: Record<string, string> = { gn2: "Nitrogen", ghe: "Helium", air: "Air" };

/** What an instrument measures, as the model's links have it: a pressure, or a temperature. */
const MEASURED: Record<string, "pressure" | "temperature"> = {
    pressure: "pressure",
    temperature: "temperature",
    rtd: "temperature",
};

/** A tank's ports above its liquid: a temperature sensor there reads its ullage. */
const UPPER = new Set(["top", "left-upper", "right-upper"]);

export type Phase = "liquid" | "gas";

/** Where a model's node or edge comes from on the P&ID. */
export interface Origin {
    part: string | null; // the part it is (null: a point between parts, which lines make)
    lines: string[]; // the lines that make that point (or a line modeled as one: itself)
}

/** What a part or a line is in the model. */
export interface Placed {
    role: SimRole;
    ids: string[]; // its node or edge (an outlet: one for each of its ports with lines; none: not in the model)
    phase: Phase | null; // what flows through it (an edge, a point between parts), if anything says
    reads: string | null; // an instrument's: the key of the link its channel's in, on the node it taps
}

/** A channel the model's linked to: on which of its parts, and from which part of the P&ID (its own, or the
 * instrument's that taps it). */
export interface LinkUse {
    model: string;
    key: string;
    channel: string; // as the test has it (or, with no test, as the P&ID names it)
    from: string;
}

/**
 * Something the model can't do as the P&ID is (a problem: it can't run until it's fixed), or does differently than it
 * might seem: about which of the P&ID's parts and lines, to go to.
 */
export interface Finding {
    text: string;
    items: string[];
    problem: boolean;
}

export interface Built {
    model: SystemModel;
    origins: Map<string, Origin>; // by the model's ids
    placed: Map<string, Placed>; // by the P&ID's parts' and lines' ids
    links: LinkUse[];
    left: LinkUse[]; // the links a part's channel would make, left out as it's set to be (sim.unlinked)
    findings: Finding[];
}

/** Points joined into nets: what one point between parts is in the model. */
class Joins {
    private readonly parent = new Map<string, string>();

    add(point: string): void {
        if (!this.parent.has(point)) {
            this.parent.set(point, point);
        }
    }

    find(point: string): string {
        this.add(point);
        let root = point;
        while (this.parent.get(root) !== root) {
            root = this.parent.get(root)!;
        }
        for (let at = point; at !== root;) {
            const next = this.parent.get(at)!;
            this.parent.set(at, root);
            at = next;
        }
        return root;
    }

    union(a: string, b: string): void {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra !== rb) {
            this.parent.set(ra, rb);
        }
    }

    points(): string[] {
        return [...this.parent.keys()];
    }
}

const portPoint = (part: string, port: string) => `p\u0000${part}\u0000${port}`;
const freePoint = (line: string, end: "from" | "to") => `l\u0000${line}\u0000${end}`;
const endPoint = (line: Line, end: "from" | "to") => {
    const at = line[end];
    return isPortEnd(at) ? portPoint(at.part, at.port) : freePoint(line.id, end);
};

/** A part's two ends in the model, flow going from the first to the second: its inline ports, else its first two (a
 * relief valve's in and out, an angle valve's). */
function endsOf(part: Part): [string, string] | null {
    const kind = kindOf(part.kind);
    if (kind.inline) {
        return [kind.inline[0], kind.inline[1]];
    }
    const ports = kind.ports(part);
    return ports.length >= 2 ? [ports[0]!.id, ports[1]!.id] : null;
}

/** A part's name in the model: its tag, or what it is (at most 80 characters, as Yorg takes them). */
export const nameOf = (part: Part): string => (part.tag.trim() || titleOf(part)).slice(0, 80);

/** A figure's name: its tag, else its first words (DAQ, LOX Tank), as its title says only that it's a figure. */
const figureName = (part: Part): string =>
    (
        part.tag.trim() ||
        figureOf(part)
            .texts.flatMap((text) => text.lines)
            .find((line) => line.trim())
            ?.trim() ||
        ""
    ).slice(0, 80);

/** What the model says of the figures lines end at, all in one, as an imported drawing may have dozens. */
function drawnNote(figures: Part[]): string {
    const names = [...new Set(figures.map(figureName).filter(Boolean))];
    if (figures.length === 1) {
        return `${names[0] ? `${names[0]} is a figure,` : "A figure is"} only drawn, so it isn't simulated: the lines at it end there.`;
    }
    const named =
        names.length > 0
            ? ` (${names.slice(0, 8).join(", ")}${names.length > 8 ? `, and ${names.length - 8} more` : ""})`
            : "";
    return `${figures.length} figures${named} are only drawn, so they aren't simulated: the lines at them end there.`;
}

/** A line's name: its tag, else what it joins. */
function lineName(line: Line, parts: Map<string, Part>): string {
    if (line.tag.trim()) {
        return line.tag.trim().slice(0, 80);
    }
    const end = (at: Line["from"]) => {
        const part = isPortEnd(at) ? parts.get(at.part) : undefined;
        return part ? nameOf(part) : "";
    };
    const named = [end(line.from), end(line.to)].filter(Boolean);
    return named.length === 2 ? `Line from ${named[0]} to ${named[1]}`.slice(0, 80) : "A line";
}

/** Whether a line is modeled as a line: one set to be, whose fluid isn't a gas (gas lines are a point's tubing). */
export const modeledLine = (line: Line, fluids: Drawing): boolean =>
    !!line.sim?.line && !(line.fluid && isGas(fluids, line.fluid));

/** An id Yorg takes (up to 40 letters, digits, dashes, and underscores), from a P&ID's, not one taken already. */
function idFrom(raw: string, taken: Set<string>): string {
    const base = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 36) || "x";
    let id = base;
    for (let count = 2; taken.has(id); count += 1) {
        id = `${base}_${count}`;
    }
    taken.add(id);
    return id;
}

const kindsOf = (catalog: Catalog) => new Map(catalog.parts.map((kind) => [kind.type, kind]));

/** Settings for a kind: those it has, of the kind it has them (a setting kept from what the part was before is left
 * out). */
function keep(kind: PartKind, values: SimValues): SimValues {
    const found: SimValues = {};
    for (const setting of kind.settings) {
        const value = values[setting.key];
        if (setting.quantity === "choice" ? setting.choices.includes(String(value)) : typeof value === "number") {
            found[setting.key] = value!;
        }
    }
    return found;
}

interface Net {
    root: string;
    owners: Set<string>; // the tanks, supplies, vessels, and outlets it's at
    ends: { item: string; end: 0 | 1 }[]; // the ends of what carries flow (parts, and lines modeled) that are on it
    sensors: { part: string; at: string | null }[]; // the instruments on it, and the tank's port they tap
    lines: string[];
    ports: { part: string; port: string }[];
}

/**
 * The model of a diagram's P&ID, all its pages (joined by their off-page connectors), linked to what a test has: each
 * channel the P&ID names that the test has, by its name there. With no test, channels as the P&ID names them (to show,
 * and for its script).
 */
export function buildModel(document: Document, catalog: Catalog, test: TestDetail | null): Built {
    const fluids = pageOf(document, 0); // the diagram's fluids, which isGas reads
    const kinds = kindsOf(catalog);
    const parts = document.pages.flatMap((page) => page.parts);
    const byId = new Map(parts.map((part) => [part.id, part]));
    const lines = document.pages.flatMap((page) => page.lines).filter((line) => !SIGNALS.has(line.kind));
    const lineById = new Map(lines.map((line) => [line.id, line]));
    const roles = new Map(parts.map((part) => [part.id, roleOf(part, fluids)]));
    const role = (id: string): SimRole => roles.get(id) ?? "none";
    const findings: Finding[] = [];
    const problem = (text: string, items: string[]) => findings.push({ text, items, problem: true });
    const note = (text: string, items: string[]) => findings.push({ text, items, problem: false });

    // --- the points between parts: ports joined by lines, and by what's a plain connection ---
    const joins = new Joins();
    const ports = new Map<string, { part: string; port: string }>();
    for (const part of parts) {
        for (const port of kindOf(part.kind).ports(part)) {
            const point = portPoint(part.id, port.id);
            joins.add(point);
            ports.set(point, { part: part.id, port: port.id });
        }
    }
    const lineEdges = lines.filter((line) => modeledLine(line, fluids));
    const asEdge = new Set(lineEdges.map((line) => line.id));
    for (const line of lines) {
        if (asEdge.has(line.id)) {
            joins.add(endPoint(line, "from"));
            joins.add(endPoint(line, "to"));
        } else {
            joins.union(endPoint(line, "from"), endPoint(line, "to"));
        }
    }
    for (const part of parts) {
        if (role(part.id) === "through" || role(part.id) === "sensor" || role(part.id) === "meter") {
            const [first, ...rest] = kindOf(part.kind).ports(part);
            for (const port of rest) {
                joins.union(portPoint(part.id, first!.id), portPoint(part.id, port.id));
            }
        }
    }
    // An off-page connector is where it goes: the connector back, or the tank or outlet it names.
    for (const part of parts.filter((one) => one.kind === "offpage")) {
        const target = byId.get(part.props.part ?? "");
        const port = target && kindOf(target.kind).ports(target)[0];
        if (!target || !port) {
            continue;
        }
        if (target.kind === "offpage" || NODE_ROLES.has(role(target.id))) {
            joins.union(portPoint(part.id, "in"), portPoint(target.id, port.id));
        } else {
            note(
                `${part.text || "An off-page connector"} goes to ${nameOf(target)}, which has more than one side: the model doesn't follow it there. Point it at the connector on that page.`,
                [part.id],
            );
        }
    }

    // --- each net: what's on it ---
    const nets = new Map<string, Net>();
    const netAt = (point: string): Net => {
        const root = joins.find(point);
        let net = nets.get(root);
        if (!net) {
            net = { root, owners: new Set(), ends: [], sensors: [], lines: [], ports: [] };
            nets.set(root, net);
        }
        return net;
    };
    for (const point of joins.points()) {
        const net = netAt(point);
        const port = ports.get(point);
        if (port) {
            net.ports.push(port);
            if (NODE_ROLES.has(role(port.part))) {
                net.owners.add(port.part);
            }
        }
    }
    for (const line of lines) {
        if (!asEdge.has(line.id)) {
            netAt(endPoint(line, "from")).lines.push(line.id);
        }
    }
    const edgeParts = parts.filter((part) => EDGE_ROLES.has(role(part.id)) && endsOf(part));
    const ends = new Map<string, [Net, Net]>(); // what carries flow (a part's id, or a line's): its two ends' nets
    const addEnds = (item: string, from: string, to: string) => {
        const found: [Net, Net] = [netAt(from), netAt(to)];
        ends.set(item, found);
        found[0].ends.push({ item, end: 0 });
        found[1].ends.push({ item, end: 1 });
    };
    for (const part of edgeParts) {
        const [a, b] = endsOf(part)!;
        addEnds(part.id, portPoint(part.id, a), portPoint(part.id, b));
    }
    for (const line of lineEdges) {
        addEnds(line.id, endPoint(line, "from"), endPoint(line, "to"));
    }
    for (const part of parts.filter((one) => role(one.id) === "sensor")) {
        const first = kindOf(part.kind).ports(part)[0];
        if (first) {
            const net = netAt(portPoint(part.id, first.id));
            const tapped = net.ports.find((port) => VESSELS.has(byId.get(port.part)?.kind ?? ""));
            net.sensors.push({ part: part.id, at: tapped?.port ?? null });
        }
    }

    // --- what flows where, liquid or gas: as the lines' fluids say, through what carries flow from point to point ---
    const groups = new Joins();
    for (const [a, b] of ends.values()) {
        groups.union(a.root, b.root);
    }
    const said = new Map<string, Set<Phase>>(); // by group: what its lines' fluids say
    const implied = new Map<string, Set<Phase>>(); // and what's on it does (a regulator is gas's)
    const gasSaid = new Map<string, string>(); // and the gas its lines say they carry (Nitrogen)
    const say = (into: Map<string, Set<Phase>>, root: string, phase: Phase) => {
        const group = groups.find(root);
        into.set(group, new Set([...(into.get(group) ?? []), phase]));
    };
    for (const net of nets.values()) {
        for (const id of net.lines) {
            const fluid = lineById.get(id)?.fluid ?? "";
            if (fluid) {
                const gas = isGas(fluids, fluid);
                say(said, net.root, gas ? "gas" : "liquid");
                if (gas && GASES[fluid] && !gasSaid.has(groups.find(net.root))) {
                    gasSaid.set(groups.find(net.root), GASES[fluid]);
                }
            }
        }
        for (const owner of net.owners) {
            if (role(owner) === "supply" || role(owner) === "vessel") {
                say(implied, net.root, "gas");
            }
        }
    }
    for (const line of lineEdges) {
        say(line.fluid ? said : implied, ends.get(line.id)![0].root, "liquid");
    }
    for (const part of edgeParts) {
        if (role(part.id) === "regulator") {
            say(implied, ends.get(part.id)![0].root, "gas");
        } else if (role(part.id) === "venturi") {
            say(implied, ends.get(part.id)![0].root, "liquid");
        }
    }
    const evidence = (net: Net): Set<Phase> => {
        const group = groups.find(net.root);
        return said.get(group)?.size ? said.get(group)! : (implied.get(group) ?? new Set());
    };
    const phaseOf = (net: Net): Phase | null => {
        const found = evidence(net);
        return found.size === 1 ? [...found][0]! : null;
    };

    // --- the model's nodes: tanks, supplies, vessels, and outlets, and the points between parts that flow meets at ---
    const taken = new Set<string>();
    const placed = new Map<string, Placed>();
    const origins = new Map<string, Origin>();
    const nodeOfNet = new Map<string, string>(); // a net's root: its node's id
    const nodeOfPart = new Map<string, string>(); // a tank's, supply's, or vessel's node's id
    const outletNets = new Map<string, Net[]>(); // an outlet's nets with flow, each a node of its own
    const outletOf = new Map<string, string>(); // a net at an outlet: the outlet
    const reported = new Set<string>();
    for (const net of nets.values()) {
        const owners = [...net.owners];
        if (owners.length > 1) {
            const key = [...owners].sort().join(" ");
            if (!reported.has(key)) {
                reported.add(key);
                const names = owners.map((id) => nameOf(byId.get(id)!));
                problem(
                    `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are joined with nothing between them that the model has: put a valve or an orifice between them, or model a line between them as a line.`,
                    owners,
                );
            }
            continue;
        }
        const owner = owners[0];
        if (owner !== undefined && role(owner) === "outlet") {
            outletOf.set(net.root, owner);
            if (net.ends.length > 0) {
                outletNets.set(owner, [...(outletNets.get(owner) ?? []), net]);
            }
            continue;
        }
        if (owner !== undefined) {
            let id = nodeOfPart.get(owner);
            if (id === undefined) {
                id = idFrom(owner, taken);
                nodeOfPart.set(owner, id);
                origins.set(id, { part: owner, lines: [] });
            }
            origins.get(id)!.lines.push(...net.lines);
            nodeOfNet.set(net.root, id);
            for (const lineId of net.lines) {
                placed.set(lineId, { role: "through", ids: [id], phase: phaseOf(net), reads: null });
            }
        } else if (net.ends.length > 0) {
            const id = idFrom(`at-${net.lines[0] ?? `${net.ports[0]?.part}-${net.ports[0]?.port}`}`, taken);
            nodeOfNet.set(net.root, id);
            origins.set(id, { part: null, lines: [...net.lines] });
        }
    }
    for (const [owner, found] of outletNets) {
        const ids = found.map((net) => {
            const port = net.ports.find((one) => one.part === owner)?.port ?? "";
            const id = idFrom(found.length > 1 ? `${owner}-${port}` : owner, taken);
            nodeOfNet.set(net.root, id);
            origins.set(id, { part: owner, lines: [...net.lines] });
            for (const lineId of net.lines) {
                placed.set(lineId, { role: "through", ids: [id], phase: phaseOf(net), reads: null });
            }
            return id;
        });
        placed.set(owner, { role: "outlet", ids, phase: null, reads: null });
    }

    // --- the edges: what carries flow, from the point at its first end to the point at its second ---
    const edges: ModelEdge[] = [];
    const gasAt = new Map<string, string | null>(); // a tank's node: the gas its gas lines say they carry, if any
    const liquidAt = new Set<string>(); // nodes liquid lines reach
    const edgeOf = new Map<string, string>(); // a part's or a line's id: its edge's
    const items = [...edgeParts.map((part) => part.id), ...lineEdges.map((line) => line.id)];
    for (const item of items) {
        const [from, to] = ends.get(item)!;
        const part = byId.get(item);
        const line = part ? undefined : lineById.get(item)!;
        const itemRole: SimRole = part ? role(item) : "line";
        const name = part ? nameOf(part) : lineName(line!, byId);
        const phase = phaseOf(from);
        placed.set(item, { role: itemRole, ids: [], phase, reads: null });
        if (evidence(from).size > 1) {
            problem(`${name} is in lines that carry gas and liquid: give each line the fluid it carries.`, [item]);
            continue;
        }
        if (phase === null) {
            problem(
                `Say what ${name} carries: give one of its lines a fluid (Carry along its run gives it to the rest).`,
                [item],
            );
            continue;
        }
        if (itemRole === "line" && phase === "gas") {
            problem(`${name} is in gas lines: gas tubing is the volume of the point it's in, not a line.`, [item]);
            continue;
        }
        const source = nodeOfNet.get(from.root);
        const target = nodeOfNet.get(to.root);
        if (source === undefined || target === undefined) {
            continue; // at a point joined to two tanks: said above
        }
        if (source === target) {
            note(`Nothing flows through ${name}: both its sides are one point in the model.`, [item]);
            continue;
        }
        for (const [net, side] of [
            [from, "inlet"],
            [to, "outlet"],
        ] as const) {
            if (net.owners.size === 0 && net.ends.length === 1 && net.ports.every((port) => port.part === item)) {
                note(
                    `${name}'s ${side} goes nowhere, so the model has it capped: draw its line on to where it goes (a vent, for the atmosphere).`,
                    [item],
                );
            }
        }
        const type =
            itemRole === "line"
                ? "line"
                : itemRole === "regulator"
                  ? phase === "gas"
                      ? "regulator"
                      : null
                  : itemRole === "venturi"
                    ? phase === "liquid"
                        ? "venturi"
                        : null
                    : itemRole === "valve" || itemRole === "check"
                      ? phase === "gas"
                          ? "gas_valve"
                          : "valve"
                      : phase === "gas"
                        ? "gas_orifice"
                        : "orifice";
        const kind = type === null ? undefined : kinds.get(type);
        if (type === null || !kind) {
            problem(
                itemRole === "regulator"
                    ? `${name} is a regulator in liquid lines: the model's regulators are gas's.`
                    : `${name} is a cavitating venturi in gas lines: make it an orifice.`,
                [item],
            );
            continue;
        }
        const id = idFrom(item, taken);
        edgeOf.set(item, id);
        placed.set(item, { role: itemRole, ids: [id], phase, reads: null });
        origins.set(id, { part: part ? item : null, lines: line ? [item] : [] });
        const settings = keep(kind, part ? (part.sim?.settings ?? {}) : (line!.sim?.line ?? {}));
        if (part && (type === "valve" || type === "gas_valve") && settings.position === undefined) {
            // Without a command, where it normally is: a normally closed valve, a relief valve, a burst disc, shut.
            settings.position = part.props.normal === "NC" || ["relief", "burst"].includes(part.kind) ? 0 : 1;
        }
        if (itemRole === "check" && type === "gas_valve") {
            settings.check = "yes";
        } else if (itemRole === "check") {
            note(
                `${name} is a check valve in liquid lines, which the model has as a valve: it doesn't stop flow back.`,
                [item],
            );
        }
        if (part?.kind === "flowmeter" && settings.cda === undefined) {
            settings.cda = METER_CDA; // a flow meter as an orifice: its loss, which is small
        }
        edges.push({ id, type, name, source, target, settings, links: {} });
        for (const node of [source, target]) {
            if (phase === "liquid") {
                liquidAt.add(node);
            } else if (!gasAt.get(node)) {
                gasAt.set(node, gasSaid.get(groups.find(from.root)) ?? null);
            }
        }
    }

    // --- the nodes, set up ---
    const nodes: ModelPart[] = [];
    for (const [partId, id] of nodeOfPart) {
        const part = byId.get(partId)!;
        const partRole = role(partId);
        const type = partRole === "tank" ? "tank" : partRole === "supply" ? "source" : "gas_junction";
        const settings = keep(kinds.get(type)!, part.sim?.settings ?? {});
        const holds = part.props.fluid ?? "";
        if (type === "tank") {
            settings.fluid ??= LIQUIDS[holds] ?? (holds && !isGas(fluids, holds) ? "Custom" : "Water");
            if (gasAt.has(id)) {
                settings.mode = "ullage"; // pressurant goes into it, or a vent lets it out: it's under a gas ullage
                settings.gas ??= gasAt.get(id) ?? "Nitrogen";
            }
        } else if (type === "source") {
            if (GASES[holds]) {
                settings.gas ??= GASES[holds];
            }
        } else {
            settings.wall = "vessel";
        }
        if (type !== "tank" && liquidAt.has(id)) {
            problem(`${nameOf(part)} holds gas, but liquid lines reach it: give its lines the gas they carry.`, [
                partId,
            ]);
        }
        nodes.push({ id, type, name: nameOf(part), settings, links: {} });
        placed.set(partId, { role: partRole, ids: [id], phase: type === "tank" ? null : "gas", reads: null });
    }
    for (const [owner, found] of outletNets) {
        const part = byId.get(owner)!;
        const settings = keep(kinds.get("outlet")!, part.sim?.settings ?? {});
        for (const net of found) {
            const port = net.ports.find((one) => one.part === owner)?.port ?? "";
            const name = found.length > 1 ? `${nameOf(part)} (${port})`.slice(0, 80) : nameOf(part);
            nodes.push({ id: nodeOfNet.get(net.root)!, type: "outlet", name, settings: { ...settings }, links: {} });
        }
    }
    const pointNames = new Set<string>();
    for (const net of nets.values()) {
        const id = nodeOfNet.get(net.root);
        if (id === undefined || net.owners.size > 0) {
            continue;
        }
        const phase = phaseOf(net) ?? "liquid";
        const type = phase === "gas" ? "gas_junction" : "junction";
        const kind = kinds.get(type)!;
        // A gas point's settings are kept on each of its lines: the first that has each one.
        const settings: SimValues = {};
        for (const lineId of net.lines) {
            for (const [key, value] of Object.entries(keep(kind, lineById.get(lineId)?.sim?.node ?? {}))) {
                settings[key] ??= value;
            }
        }
        if (type === "gas_junction") {
            settings.wall = "tubing";
        }
        nodes.push({ id, type, name: pointName(net, byId, pointNames), settings, links: {} });
        for (const lineId of net.lines) {
            placed.set(lineId, { role: "through", ids: [id], phase: phaseOf(net), reads: null });
        }
    }

    // --- what it's linked to: a valve's command, and a flow meter's flow, its own channel; an instrument's, the value
    // where it taps ---
    const links: LinkUse[] = [];
    const left: LinkUse[] = [];
    const modelParts = new Map<string, ModelPart>([...nodes, ...edges].map((one) => [one.id, one]));
    const channelOf = (name: string): string | null => (test ? (findChannel(test, name)?.name ?? null) : name || null);
    const channelFor = (part: Part): string | null =>
        channelNames(part)
            .map(channelOf)
            .find((one) => one !== null) ?? null;
    const unlinked = { valves: [] as string[], sensors: [] as string[] };
    for (const part of edgeParts) {
        const id = edgeOf.get(part.id);
        const edge = id ? modelParts.get(id) : undefined;
        const key = part.kind === "flowmeter" ? "flow" : edge?.type.endsWith("valve") ? "command" : null;
        if (!edge || !key) {
            continue;
        }
        const channel = channelFor(part);
        if (channel === null) {
            if (test && channelNames(part).length > 0) {
                (key === "command" ? unlinked.valves : unlinked.sensors).push(part.id);
            }
            continue;
        }
        if (part.sim?.unlinked) {
            left.push({ model: edge.id, key, channel, from: part.id });
            continue;
        }
        edge.links[key] = channel;
        links.push({ model: edge.id, key, channel, from: part.id });
        if (key === "command") {
            commandRange(edge, test?.channels.find((one) => one.name === channel) ?? null, part.sim?.settings ?? {});
        }
    }
    for (const net of nets.values()) {
        const outlet = outletOf.get(net.root);
        const targets = outlet
            ? (placed.get(outlet)?.ids ?? [])
            : nodeOfNet.has(net.root)
              ? [nodeOfNet.get(net.root)!]
              : [];
        for (const sensor of net.sensors) {
            const part = byId.get(sensor.part)!;
            const measured = MEASURED[part.props.type ?? ""];
            const first = modelParts.get(targets[0] ?? "");
            const reads = first && measured ? readsOf(part, first, measured, sensor.at, kinds) : null;
            placed.set(part.id, { role: "sensor", ids: targets, phase: null, reads });
            if (!first || !reads) {
                if (measured || part.props.type === "flow") {
                    note(
                        !first
                            ? `${nameOf(part)} taps nothing in the model: draw its line to what it measures.`
                            : part.props.type === "flow"
                              ? `${nameOf(part)} isn't compared: the model's flows are in its lines, so put a flow meter in the line.`
                              : `${nameOf(part)} measures what the model doesn't have at ${first.name}.`,
                        [part.id],
                    );
                }
                continue;
            }
            const channel = channelFor(part);
            if (channel === null) {
                if (channelNames(part).length > 0) {
                    unlinked.sensors.push(part.id);
                }
                continue;
            }
            if (part.sim?.unlinked) {
                left.push(...targets.map((target) => ({ model: target, key: reads, channel, from: part.id })));
                continue;
            }
            const already = links.find((one) => one.model === first.id && one.key === reads);
            if (already) {
                const by = byId.get(already.from);
                note(
                    `${nameOf(part)} reads what ${by ? nameOf(by) : "another sensor"} does: the model's compared with ${by ? nameOf(by) : "that one"} alone.`,
                    [part.id],
                );
                continue;
            }
            for (const target of targets) {
                modelParts.get(target)!.links[reads] = channel;
                links.push({ model: target, key: reads, channel, from: part.id });
            }
        }
    }
    for (const part of parts.filter((one) => role(one.id) === "meter")) {
        const first = kindOf(part.kind).ports(part)[0];
        const net = first ? nets.get(joins.find(portPoint(part.id, first.id))) : undefined;
        const at = (net?.ends ?? []).filter((one) => edgeOf.has(one.item));
        // In line with one part, or between two, one flowing in and one out (what flows through both): its flow.
        const into = at.find((one) => one.end === 1);
        const through =
            at.length === 1 ? at[0] : at.length === 2 && into && at.some((one) => one.end === 0) ? into : null;
        const edge = through ? modelParts.get(edgeOf.get(through.item)!) : undefined;
        placed.set(part.id, { role: "meter", ids: edge ? [edge.id] : [], phase: null, reads: edge ? "flow" : null });
        if (!edge) {
            note(
                at.length === 0
                    ? `${nameOf(part)} is in line with nothing the model has: draw it next to what it measures the flow of.`
                    : `${nameOf(part)} is where flow from more than one part meets, so the model can't tell whose it reads: put it in line with one.`,
                [part.id],
            );
            continue;
        }
        const channel = channelFor(part);
        if (channel === null) {
            if (test && channelNames(part).length > 0) {
                unlinked.sensors.push(part.id);
            }
            continue;
        }
        if (part.sim?.unlinked) {
            left.push({ model: edge.id, key: "flow", channel, from: part.id });
            continue;
        }
        if (edge.links.flow !== undefined) {
            const already = links.find((one) => one.model === edge.id && one.key === "flow");
            const by = already ? byId.get(already.from) : undefined;
            note(
                `${nameOf(part)} reads what ${by ? nameOf(by) : "another flow meter"} does: the model's compared with ${by ? nameOf(by) : "that one"} alone.`,
                [part.id],
            );
            continue;
        }
        edge.links.flow = channel;
        links.push({ model: edge.id, key: "flow", channel, from: part.id });
    }
    if (test) {
        const list = (ids: string[]) => {
            const names = ids.map((id) => nameOf(byId.get(id)!));
            return `${names.slice(0, 8).join(", ")}${names.length > 8 ? `, and ${names.length - 8} more` : ""}`;
        };
        if (unlinked.valves.length > 0) {
            note(
                `${test.name} has no channel for ${list(unlinked.valves)}, so ${unlinked.valves.length === 1 ? "it stays" : "they stay"} where ${unlinked.valves.length === 1 ? "its" : "their"} settings have ${unlinked.valves.length === 1 ? "it" : "them"}.`,
                unlinked.valves,
            );
        }
        if (unlinked.sensors.length > 0) {
            note(
                `${test.name} has no channel for ${list(unlinked.sensors)}, so the model isn't compared with ${unlinked.sensors.length === 1 ? "it" : "them"}.`,
                unlinked.sensors,
            );
        }
    }

    // A figure (a shape imported from Visio, drawn as it was: a drawing's tanks may be) is only drawn, which is said
    // of those lines end at, as a drawing has many that none do.
    const met = new Set(
        lines.flatMap((line) => [line.from, line.to].flatMap((end) => (isPortEnd(end) ? [end.part] : []))),
    );
    const drawn: Part[] = [];
    for (const part of parts) {
        if (!placed.has(part.id)) {
            placed.set(part.id, { role: role(part.id), ids: [], phase: null, reads: null });
        }
        if (NOT_SIMULATED.has(part.kind)) {
            note(`${nameOf(part)} isn't simulated: the lines at it end there.`, [part.id]);
        } else if (part.kind === "figure" && met.has(part.id)) {
            drawn.push(part);
        }
    }
    if (drawn.length > 0) {
        note(
            drawnNote(drawn),
            drawn.map((part) => part.id),
        );
    }
    for (const line of lines) {
        if (!placed.has(line.id)) {
            placed.set(line.id, { role: "through", ids: [], phase: null, reads: null });
        }
    }
    if (nodes.length === 0) {
        problem("Draw the system first: its tanks, the valves and lines from them, and where they lead.", []);
    }
    return {
        model: { version: 1, nodes, edges, display: document.sim ?? STANDARD_SIM_UNITS },
        origins,
        placed,
        links,
        left,
        findings,
    };
}

/** A flow meter's CdA as an orifice, unless it's set: so big its loss is next to nothing, as a meter's is. */
export const METER_CDA = 1e-3; // m²

/** A command's values when its valve's shut and open, unless they're set: a state's off and on (0 and 1), else the
 * least and most the channel reads (a voltage, a percentage). */
function commandRange(edge: ModelPart, channel: TestChannel | null, stored: SimValues) {
    if (stored.closed_value !== undefined || stored.open_value !== undefined || !channel) {
        return;
    }
    const { min, max } = channel;
    const ranged = channel.kind === "number" && typeof min === "number" && typeof max === "number" && max > min;
    edge.settings.closed_value = ranged ? min : 0;
    edge.settings.open_value = ranged ? max : 1;
}

/**
 * Which of a node's values an instrument reads: a pressure transducer, its pressure; a temperature sensor, the
 * temperature there, which at a tank is its liquid's (or, tapping above the liquid, its ullage's), unless the instrument
 * says which (sim.as: the link's key, as the wall's).
 */
function readsOf(
    part: Part,
    node: ModelPart,
    measured: "pressure" | "temperature",
    at: string | null,
    kinds: Map<string, PartKind>,
): string | null {
    const kind = kinds.get(node.type);
    if (!kind) {
        return null;
    }
    const set = withDefaults(kind, node.settings);
    const choices = kind.links
        .filter((one) => one.quantity === measured && applies(one.only_when, set))
        .map((one) => one.key);
    if (measured === "pressure") {
        return choices.includes("pressure") ? "pressure" : null;
    }
    const asked = part.sim?.as ?? "";
    if (choices.includes(asked)) {
        return asked;
    }
    if (node.type === "tank" && at && UPPER.has(at) && choices.includes("gas_temperature")) {
        return "gas_temperature";
    }
    return choices.includes("temperature") ? "temperature" : (choices[0] ?? null);
}

/** What a temperature sensor can read on the node it taps, for its choice: the node's temperatures, as it's set up. A
 * pressure transducer reads the pressure there, with no choice. */
export function readChoices(built: Built, catalog: Catalog, partId: string): Link[] {
    const placed = built.placed.get(partId);
    const node = built.model.nodes.find((one) => one.id === placed?.ids[0]);
    const kind = node && kindOfType(catalog, node.type);
    if (!node || !kind || !placed?.reads || placed.reads === "pressure") {
        return [];
    }
    const set = withDefaults(kind, node.settings);
    return kind.links.filter((one) => one.quantity === "temperature" && applies(one.only_when, set));
}

/** A name for a point between parts: the instrument on it, else the side of a part it's at ("MV-1 outlet"). */
function pointName(net: Net, parts: Map<string, Part>, taken: Set<string>): string {
    const sensor = net.sensors.map((one) => parts.get(one.part)).find((one) => one?.tag.trim());
    const end = net.ends.find((one) => parts.has(one.item));
    const base = sensor
        ? nameOf(sensor)
        : end
          ? `${nameOf(parts.get(end.item)!)} ${end.end === 0 ? "inlet" : "outlet"}`
          : "Lines between parts";
    let name = base.slice(0, 72);
    for (let count = 2; taken.has(name); count += 1) {
        name = `${base.slice(0, 72)} (${count})`;
    }
    taken.add(name);
    return name;
}

// --- the catalog's rules: which settings and links matter, and what a link's channel does ------------------------

/** Whether every condition holds for a part set up as settings (none: yes; null: never). */
export function applies(conditions: Conditions | null, settings: SimValues): boolean {
    return conditions !== null && conditions.every(([key, value]) => settings[key] === value);
}

/** A part's settings with each one that isn't set at its default. */
export function withDefaults(kind: PartKind, settings: SimValues): SimValues {
    return Object.fromEntries(kind.settings.map((setting) => [setting.key, settings[setting.key] ?? setting.default]));
}

/** The settings that matter for a part as it's set up (an ullage's only with an ullage). */
export function shownSettings(kind: PartKind, settings: SimValues): Setting[] {
    const all = withDefaults(kind, settings);
    return kind.settings.filter((setting) => applies(setting.only_when, all));
}

/** The links that matter for a part as it's set up (a wall's temperature only with a wall). */
export function shownLinks(kind: PartKind, settings: SimValues): Link[] {
    const all = withDefaults(kind, settings);
    return kind.links.filter((link) => applies(link.only_when, all));
}

/** What a link does for a part set up as settings: an ullage tank's pressure starts the model, a fixed tank's is
 * followed. */
export function linkRole(link: Link, settings: SimValues): Role {
    return applies(link.start_when, settings) ? "start" : link.role;
}

/** What a link reads, in a few words: "pressure" (a junction's "pressure transducer"), "flow", "ullage temperature". */
export const linkWords = (link: Link): string =>
    link.quantity === "pressure" ? "pressure" : link.quantity === "mass_flow" ? "flow" : link.label.toLowerCase();

/** The output a link's channel is compared with: an edge's flow, or the node's value of the link's name. */
export const outputOf = (link: Link): string => (link.quantity === "mass_flow" ? "mass_flow" : link.key);

export const kindOfType = (catalog: Catalog, type: string): PartKind | undefined =>
    catalog.parts.find((part) => part.type === type);
