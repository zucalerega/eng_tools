import { describe, expect, test } from "vitest";
import type { Catalog, Display, Link, PartKind, Setting } from "../src/yorg/models/api";
import {
    addEdge,
    addNode,
    channelPlacement,
    comparisons,
    connectProblem,
    EMPTY_MODEL,
    exampleModel,
    exportModel,
    importModel,
    knobsOf,
    modelPlacement,
    pressurizedExample,
    setLink,
    setSetting,
    shownLinks,
    shownSettings,
} from "../src/yorg/models/model";
import { ATMOSPHERE, fromDisplay, PSI, toDisplay, unitOf } from "../src/yorg/models/units";

// System models' units and rules, without a server: the catalog here is the parts the tests use, cut down to what
// they need.

const setting = (key: string, extra: Partial<Setting> = {}): Setting => ({
    key,
    label: key,
    quantity: "number",
    default: 0,
    minimum: null,
    maximum: null,
    tunable: false,
    choices: [],
    choice_labels: [],
    only_when: [],
    help: "",
    ...extra,
});

const link = (key: string, extra: Partial<Link> = {}): Link => ({
    key,
    label: key,
    quantity: "pressure",
    role: "sensor",
    help: "",
    only_when: [],
    start_when: null,
    ...extra,
});

const part = (type: string, kind: "node" | "edge", phase: PartKind["phase"], extra: Partial<PartKind> = {}) => ({
    type,
    label: type[0]!.toUpperCase() + type.slice(1).replace("_", " "),
    kind,
    phase,
    help: "",
    outputs: [],
    settings: [],
    links: [],
    ...extra,
});

const ULLAGE: [string, string][] = [["mode", "ullage"]];
const WALL: [string, string][] = [
    ["mode", "ullage"],
    ["ullage_model", "wall"],
];

const catalog: Catalog = {
    liquids: ["Water"],
    gases: ["Nitrogen"],
    parts: [
        part("tank", "node", "liquid", {
            label: "Tank",
            settings: [
                setting("mode", { quantity: "choice", default: "fixed", choices: ["fixed", "ullage"] }),
                setting("pressure", { quantity: "pressure", default: 300 * PSI }),
                setting("ullage_model", {
                    quantity: "choice",
                    default: "polytropic",
                    choices: ["polytropic", "wall"],
                    only_when: ULLAGE,
                }),
                setting("polytropic_exponent", {
                    default: 1.2,
                    tunable: true,
                    only_when: [...ULLAGE, ["ullage_model", "polytropic"]],
                }),
                setting("heat_transfer", { quantity: "conductance", default: 20, tunable: true, only_when: WALL }),
                setting("wall_mass", { quantity: "mass", default: 5, only_when: WALL }),
            ],
            links: [
                link("pressure", { role: "boundary", start_when: ULLAGE }),
                link("gas_temperature", { quantity: "temperature", role: "start", only_when: ULLAGE }),
                link("wall_temperature", { quantity: "temperature", role: "start", only_when: WALL }),
            ],
        }),
        part("source", "node", "gas", { label: "Gas supply" }),
        part("junction", "node", "liquid", { label: "Junction", links: [link("pressure")] }),
        part("gas_junction", "node", "gas", { label: "Gas junction", links: [link("pressure", { role: "start" })] }),
        part("outlet", "node", "any", { label: "Outlet" }),
        part("line", "edge", "liquid", {
            label: "Line",
            settings: [setting("friction_factor", { default: 0.02, tunable: true })],
            links: [link("flow", { quantity: "mass_flow" })],
        }),
        part("valve", "edge", "liquid", {
            label: "Valve",
            settings: [setting("cda", { quantity: "area", default: 5e-5, tunable: true })],
        }),
        part("orifice", "edge", "liquid", { label: "Orifice" }),
        part("venturi", "edge", "liquid", { label: "Cavitating venturi" }),
        part("gas_valve", "edge", "gas", { label: "Gas valve" }),
        part("regulator", "edge", "gas", { label: "Regulator" }),
    ],
};

const US_GAUGE: Display = { units: "us", gauge: true, ambient: ATMOSPHERE };
const SI_ABSOLUTE: Display = { units: "si", gauge: false, ambient: ATMOSPHERE };

describe("units", () => {
    test("settings show in the model's units, gauge or absolute, and go back to SI", () => {
        expect(unitOf("pressure", US_GAUGE)).toBe("psig");
        expect(unitOf("pressure", SI_ABSOLUTE)).toBe("bara");
        expect(toDisplay("pressure", 300 * PSI + ATMOSPHERE, US_GAUGE)).toBeCloseTo(300, 9);
        expect(fromDisplay("pressure", 300, US_GAUGE)).toBeCloseTo(300 * PSI + ATMOSPHERE, 6);
        expect(toDisplay("temperature", 273.15, US_GAUGE)).toBeCloseTo(32, 9);
        expect(fromDisplay("temperature", -297, US_GAUGE)).toBeCloseTo(90.372, 3);
        expect(toDisplay("area", 0.00064516, US_GAUGE)).toBeCloseTo(1, 9);
        expect(toDisplay("diameter", 0.0127, SI_ABSOLUTE)).toBeCloseTo(12.7, 9);
        expect(toDisplay("ratio", 1.2, US_GAUGE)).toBe(1.2);
    });

    test("a vapor pressure is always absolute, a droop never has the atmosphere in it", () => {
        expect(unitOf("pressure_abs", US_GAUGE)).toBe("psia");
        expect(toDisplay("pressure_abs", 2 * PSI, US_GAUGE)).toBeCloseTo(2, 9);
        expect(unitOf("pressure_drop", US_GAUGE)).toBe("psi");
        expect(toDisplay("pressure_drop", 20 * PSI, US_GAUGE)).toBeCloseTo(20, 9);
        expect(fromDisplay("pressure_drop", 20, US_GAUGE)).toBeCloseTo(20 * PSI, 6);
    });

    test("a wall's mass, specific heat, and hA", () => {
        expect(toDisplay("mass", 0.45359237, US_GAUGE)).toBeCloseTo(1, 9);
        expect(toDisplay("specific_heat", 900, US_GAUGE)).toBeCloseTo(0.215, 3); // aluminum, BTU/lbm·°F
        expect(unitOf("conductance", SI_ABSOLUTE)).toBe("W/K");
        expect(toDisplay("conductance", 20, US_GAUGE)).toBeCloseTo(37.91, 2); // BTU/hr·°F
    });

    test("a channel goes on a plot in the model's units, from its own", () => {
        const at = (placement: { scale: number; offset: number }, value: number) =>
            value * placement.scale + placement.offset;
        // psig in, psig shown: as it is.
        expect(at(channelPlacement("pressure", "psig", US_GAUGE), 250)).toBeCloseTo(250, 9);
        // psia in, psig shown.
        expect(at(channelPlacement("pressure", "psia", US_GAUGE), 250)).toBeCloseTo(250 - ATMOSPHERE / PSI, 9);
        // No unit: read in the model's (psi, gauge here).
        expect(at(channelPlacement("pressure", "", US_GAUGE), 250)).toBeCloseTo(250, 9);
        // bar gauge in, psig shown.
        expect(at(channelPlacement("pressure", "barg", US_GAUGE), 1)).toBeCloseTo(1e5 / PSI, 9);
        expect(at(channelPlacement("temperature", "degC", US_GAUGE), 100)).toBeCloseTo(212, 9);
        expect(at(channelPlacement("mass_flow", "kg/s", US_GAUGE), 1)).toBeCloseTo(1 / 0.45359237, 9);
        // A model's output (SI) on the same plot.
        expect(at(modelPlacement("pressure", US_GAUGE), 250 * PSI + ATMOSPHERE)).toBeCloseTo(250, 9);
    });
});

describe("editing", () => {
    test("parts get names and ids of their own, and edges go only where they can", () => {
        let model = EMPTY_MODEL;
        let tank: string, supply: string, tee: string, manifold: string, stack: string;
        [model, tank] = addNode(model, catalog, "tank", 100, 100);
        [model, supply] = addNode(model, catalog, "source", 100, 300);
        [model, tee] = addNode(model, catalog, "junction", 300, 100);
        [model, manifold] = addNode(model, catalog, "gas_junction", 300, 300);
        [model, stack] = addNode(model, catalog, "outlet", 500, 300);
        expect(model.nodes.map((node) => [node.id, node.name])).toEqual([
            ["n1", "Tank 1"],
            ["n2", "Gas supply 1"],
            ["n3", "Junction 1"],
            ["n4", "Gas junction 1"],
            ["n5", "Outlet 1"],
        ]);
        expect(connectProblem(model, catalog, "line", tank, tee)).toBeNull();
        expect(connectProblem(model, catalog, "line", supply, tank)).toBe(
            "A line carries liquid: Gas supply 1 is for gas, which gas valves, orifices, and regulators connect.",
        );
        expect(connectProblem(model, catalog, "gas_valve", supply, manifold)).toBeNull();
        expect(connectProblem(model, catalog, "gas_valve", manifold, tank)).toBeNull();
        expect(connectProblem(model, catalog, "gas_valve", tank, stack)).toBeNull(); // a vent
        expect(connectProblem(model, catalog, "gas_valve", tank, tee)).toBe(
            "A gas valve carries gas: connect it to gas supplies, gas junctions, tanks, and outlets, not Junction 1.",
        );
        expect(connectProblem(model, catalog, "regulator", supply, stack)).toBe(
            "A regulator holds the pressure where it flows to: connect it to a gas junction or a tank.",
        );
        [model] = addEdge(model, catalog, "line", tank, tee);
        expect(model.edges[0]).toMatchObject({ id: "e1", name: "Line 1", source: tank, target: tee });
        // Gas into a tank gives it an ullage.
        expect(model.nodes[0]!.settings.mode).toBe("fixed");
        [model] = addEdge(model, catalog, "gas_valve", manifold, tank);
        expect(model.nodes[0]!.settings.mode).toBe("ullage");
    });

    test("a part's settings and links show as it's set up", () => {
        const [first, tank] = addNode(EMPTY_MODEL, catalog, "tank", 100, 100);
        let model = first;
        const kind = catalog.parts[0]!;
        const keys = () => shownSettings(kind, model.nodes[0]!.settings).map((one) => one.key);
        const linkKeys = () => shownLinks(kind, model.nodes[0]!.settings).map((one) => one.key);
        expect(keys()).toEqual(["mode", "pressure"]);
        expect(linkKeys()).toEqual(["pressure"]);
        model = setSetting(model, tank, "mode", "ullage");
        expect(keys()).toEqual(["mode", "pressure", "ullage_model", "polytropic_exponent"]);
        expect(linkKeys()).toEqual(["pressure", "gas_temperature"]);
        model = setSetting(model, tank, "ullage_model", "wall");
        expect(keys()).toEqual(["mode", "pressure", "ullage_model", "heat_transfer", "wall_mass"]);
        expect(linkKeys()).toEqual(["pressure", "gas_temperature", "wall_temperature"]);
        // The knobs a fit can turn are the tunable ones that matter now.
        expect(knobsOf(model, catalog).map((one) => one.setting.key)).toEqual(["heat_transfer"]);
    });

    test("channels compared after a run: sensors, and values that start the model", () => {
        let model = exampleModel(catalog);
        const [tank, inlet] = model.nodes;
        const line = model.edges[0]!;
        model = setLink(model, tank!.id, "pressure", "PT-TANK"); // followed, at a fixed pressure: nothing to compare
        model = setLink(model, inlet!.id, "pressure", "PT-01");
        model = setLink(model, line.id, "flow", "FM-01");
        expect(comparisons(model, catalog).map((one) => [one.output, one.channel])).toEqual([
            [`${inlet!.id}.pressure`, "PT-01"],
            [`${line.id}.mass_flow`, "FM-01"],
        ]);
        model = setSetting(model, tank!.id, "mode", "ullage");
        model = setLink(model, tank!.id, "gas_temperature", "TC-ULLAGE");
        model = setLink(model, tank!.id, "wall_temperature", "TC-WALL"); // not with an exponent for its heat
        expect(comparisons(model, catalog).map((one) => one.channel)).toEqual([
            "PT-TANK",
            "TC-ULLAGE",
            "PT-01",
            "FM-01",
        ]);
        model = setLink(model, inlet!.id, "pressure", "");
        expect(comparisons(model, catalog).map((one) => one.channel)).toEqual(["PT-TANK", "TC-ULLAGE", "FM-01"]);
    });

    test("the pressurized example: a regulator into a press manifold, a press valve, a venturi, and a vent", () => {
        const model = pressurizedExample(catalog);
        expect(model.nodes.map((node) => node.name)).toEqual([
            "Nitrogen bottle",
            "Press manifold",
            "Fuel tank",
            "Venturi inlet",
            "Chamber",
            "Vent stack",
        ]);
        expect(model.edges.map((edge) => [edge.type, edge.name])).toEqual([
            ["regulator", "Regulator"],
            ["gas_valve", "Press valve"],
            ["valve", "Main valve"],
            ["venturi", "Venturi"],
            ["gas_valve", "Vent"],
        ]);
        expect(model.nodes[2]!.settings).toMatchObject({ mode: "ullage", ullage_model: "wall" });
    });

    test("a model goes to a file and comes back, an old press line as a gas valve", () => {
        const model = exampleModel(catalog);
        const back = importModel(exportModel("Stand A", model), "file");
        expect(back.name).toBe("Stand A");
        expect(back.model).toEqual(model);
        const older = JSON.stringify({
            nodes: [],
            edges: [{ ...model.edges[0]!, type: "gas_line" }],
            display: { units: "si" },
        });
        const opened = importModel(older, "Old model");
        expect(opened.name).toBe("Old model");
        expect(opened.model.edges[0]!.type).toBe("gas_valve");
        expect(opened.model.display).toEqual({ units: "si", gauge: true, ambient: ATMOSPHERE });
        expect(() => importModel("not json", "x")).toThrow("That file isn't a system model: it isn't JSON.");
        expect(() => importModel("{}", "x")).toThrow("That file isn't a system model: it has no parts.");
    });
});
