import { describe, expect, test } from "vitest";
import type { Catalog, Display } from "../src/yorg/dev/api";
import {
    addEdge,
    addNode,
    channelPlacement,
    comparisons,
    connectProblem,
    EMPTY_MODEL,
    exampleModel,
    modelPlacement,
    setLink,
    setSetting,
} from "../src/yorg/dev/model";
import { ATMOSPHERE, fromDisplay, PSI, toDisplay, unitOf } from "../src/yorg/dev/units";

// System models' units and rules, without a server: the catalog here is the few parts the tests use.

const catalog: Catalog = {
    liquids: ["Water"],
    gases: ["Nitrogen"],
    parts: [
        {
            type: "tank",
            label: "Tank",
            kind: "node",
            phase: "liquid",
            help: "",
            outputs: [],
            settings: [
                {
                    key: "mode",
                    label: "Pressure",
                    quantity: "choice",
                    default: "fixed",
                    minimum: null,
                    maximum: null,
                    tunable: false,
                    choices: ["fixed", "ullage"],
                    only_when: null,
                    help: "",
                },
            ],
            links: [{ key: "pressure", label: "Pressure", quantity: "pressure", role: "boundary", help: "" }],
        },
        {
            type: "source",
            label: "Gas supply",
            kind: "node",
            phase: "gas",
            help: "",
            outputs: [],
            settings: [],
            links: [],
        },
        {
            type: "junction",
            label: "Junction",
            kind: "node",
            phase: "liquid",
            help: "",
            outputs: [],
            settings: [],
            links: [{ key: "pressure", label: "Pressure transducer", quantity: "pressure", role: "sensor", help: "" }],
        },
        {
            type: "outlet",
            label: "Outlet",
            kind: "node",
            phase: "liquid",
            help: "",
            outputs: [],
            settings: [],
            links: [],
        },
        {
            type: "line",
            label: "Line",
            kind: "edge",
            phase: "liquid",
            help: "",
            outputs: [],
            settings: [],
            links: [{ key: "flow", label: "Flow meter", quantity: "mass_flow", role: "sensor", help: "" }],
        },
        {
            type: "valve",
            label: "Valve",
            kind: "edge",
            phase: "liquid",
            help: "",
            outputs: [],
            settings: [],
            links: [],
        },
        {
            type: "orifice",
            label: "Orifice",
            kind: "edge",
            phase: "liquid",
            help: "",
            outputs: [],
            settings: [],
            links: [],
        },
        {
            type: "gas_line",
            label: "Press line",
            kind: "edge",
            phase: "gas",
            help: "",
            outputs: [],
            settings: [],
            links: [],
        },
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
        let tank: string, supply: string, tee: string;
        [model, tank] = addNode(model, catalog, "tank", 100, 100);
        [model, supply] = addNode(model, catalog, "source", 100, 300);
        [model, tee] = addNode(model, catalog, "junction", 300, 100);
        expect(model.nodes.map((node) => [node.id, node.name])).toEqual([
            ["n1", "Tank 1"],
            ["n2", "Gas supply 1"],
            ["n3", "Junction 1"],
        ]);
        expect(connectProblem(model, catalog, "line", tank, tee)).toBeNull();
        expect(connectProblem(model, catalog, "line", supply, tank)).toBe(
            "A line carries liquid: a gas supply connects to a tank with a press line.",
        );
        expect(connectProblem(model, catalog, "gas_line", supply, tank)).toBeNull();
        expect(connectProblem(model, catalog, "gas_line", tank, tee)).toBe(
            "A press line goes from a gas supply into a tank.",
        );
        [model] = addEdge(model, catalog, "line", tank, tee);
        expect(model.edges[0]).toMatchObject({ id: "e1", name: "Line 1", source: tank, target: tee });
    });

    test("channels compared after a run: sensors, and an ullage tank's pressure", () => {
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
        expect(comparisons(model, catalog).map((one) => one.channel)).toEqual(["PT-TANK", "PT-01", "FM-01"]);
        model = setLink(model, inlet!.id, "pressure", "");
        expect(comparisons(model, catalog).map((one) => one.channel)).toEqual(["PT-TANK", "FM-01"]);
    });
});
