import { beforeAll, expect, test } from "vitest";
import { documentOf, emptyDrawing, type Document, type Drawing, type Part } from "../src/piper/drawing";
import { addPart, connect, updateLine, updatePart } from "../src/piper/edit";
import { presetOf } from "../src/piper/library/index";
import type { Catalog, ModelPart } from "../src/piper/sim/api";
import { coldFlow, pressurizedFlow, vespula } from "../src/piper/sim/examples";
import { simLive } from "../src/piper/sim/live";
import { buildModel, readChoices, roleChoices, type Built } from "../src/piper/sim/model";
import { applyKnobs, comparisons, knobsOf, withModelSetting, withPartSim } from "../src/piper/sim/settings";
import { ATMOSPHERE, PSI } from "../src/piper/sim/units";
import type { TestChannel, TestDetail } from "../src/piper/testdata";
import { Team } from "./team";

// A P&ID as a simulation's model (Simulation mode): what each part and line is in it, what flows where, what it's
// linked to in a test, and its settings, kept on the P&ID. The parts a model can have are the server's (Yorg's
// catalog).

let catalog: Catalog;

beforeAll(async () => {
    catalog = await (await Team.create()).simCatalog();
});

/** A test with these channels (a state's, one whose name says so). */
function testWith(...names: string[]): TestDetail {
    const channel = (name: string): TestChannel => ({
        name,
        unit: "",
        kind: /switch|valve|mov|sv-/i.test(name) ? "state" : "number",
        labels: [],
        decimals: null,
        min: 0,
        max: 5,
        time: "t.f64",
        values: `${name}.f64`,
    });
    return {
        id: 1,
        name: "Hotfire 3",
        status: "ready",
        created_at: "2026-10-26T00:00:00Z",
        t_min: 0,
        t_max: 10,
        deleted_at: null,
        data_version: "1",
        channels: names.map(channel),
        events: [],
    };
}

const nodeOf = (built: Built, id: string): ModelPart | undefined =>
    built.model.nodes.find((one) => one.id === built.placed.get(id)?.ids[0]);
const edgeOf = (built: Built, id: string): ModelPart | undefined =>
    built.model.edges.find((one) => one.id === built.placed.get(id)?.ids[0]);
const problems = (built: Built) => built.findings.filter((one) => one.problem).map((one) => one.text);
const notes = (built: Built) => built.findings.filter((one) => !one.problem).map((one) => one.text);
const partTagged = (document: Document, tag: string): Part =>
    document.pages.flatMap((page) => page.parts).find((part) => part.tag === tag)!;

/** A drawing built a part and a line at a time, as the examples are. */
function sketch() {
    let drawing = emptyDrawing();
    return {
        place(preset: string, x: number, y: number, change: Partial<Part> = {}): string {
            const added = addPart(drawing, presetOf(preset)!, { x, y });
            drawing = updatePart(added.drawing, added.id, (part) => ({
                ...part,
                ...change,
                props: { ...part.props, ...change.props },
            }));
            return added.id;
        },
        join(from: [string, string], to: [string, string], fluid = ""): string {
            const made = connect(drawing, { part: from[0], port: from[1] }, { part: to[0], port: to[1] })!;
            drawing = updateLine(made.drawing, made.id, (line) => ({ ...line, fluid }));
            return made.id;
        },
        get drawing(): Drawing {
            return drawing;
        },
    };
}

test("the cold flow: a tank it follows, a line, a valve its channel drives, and the manifold it's compared with", () => {
    const document = documentOf(coldFlow());
    const built = buildModel(document, catalog, testWith("PT-TANK", "MOV-01", "PT-MANIFOLD"));
    expect(problems(built)).toEqual([]);
    expect(built.model.nodes.map((node) => [node.type, node.name])).toEqual([
        ["tank", "TK-1"],
        ["outlet", "Vent"],
        ["junction", "MOV-01 inlet"],
        ["junction", "PT-MANIFOLD"],
    ]);
    expect(built.model.edges.map((edge) => [edge.type, edge.name])).toEqual([
        ["valve", "MOV-01"],
        ["orifice", "INJ"],
        ["line", "Line from TK-1 to MOV-01"],
    ]);
    // The P&ID's ids are the model's, so what's picked to tune survives other changes.
    const valve = partTagged(document, "MOV-01");
    expect(edgeOf(built, valve.id)!.id).toBe(valve.id);
    // Its valve's command is its tag, a state: shut at 0, open at 1. The tank follows its transducer; the manifold's
    // is what the model's compared with.
    expect(edgeOf(built, valve.id)!.links).toEqual({ command: "MOV-01" });
    expect(edgeOf(built, valve.id)!.settings).toMatchObject({ cda: 5e-5, closed_value: 0, open_value: 1 });
    expect(nodeOf(built, partTagged(document, "TK-1").id)!.links).toEqual({ pressure: "PT-TANK" });
    expect(comparisons(built.model, catalog).map((one) => [one.name, one.channel])).toEqual([
        ["PT-MANIFOLD pressure", "PT-MANIFOLD"],
    ]);
    expect(knobsOf(built.model, catalog).map(({ part, setting }) => `${part.name} ${setting.key}`)).toEqual([
        "MOV-01 cda",
        "MOV-01 opening_time",
        "INJ cda",
        "Line from TK-1 to MOV-01 friction_factor",
        "Line from TK-1 to MOV-01 loss_coefficient",
    ]);
});

test("a test without a part's channel: a valve stays where its settings have it, a sensor isn't compared", () => {
    const built = buildModel(documentOf(coldFlow()), catalog, testWith("PT-TANK"));
    expect(problems(built)).toEqual([]);
    expect(notes(built)).toEqual([
        "Hotfire 3 has no channel for MOV-01, so it stays where its settings have it.",
        "Hotfire 3 has no channel for PT-MANIFOLD, so the model isn't compared with it.",
    ]);
    expect(built.links.map((one) => one.channel)).toEqual(["PT-TANK"]);
    // A normally closed valve, without a command, is shut.
    const valve = built.model.edges.find((edge) => edge.name === "MOV-01")!;
    expect([valve.links, valve.settings.position]).toEqual([{}, 0]);
});

test("the pressurized flow: a regulator into tubing at its set pressure, and a tank under a gas ullage", () => {
    const document = documentOf(pressurizedFlow());
    const built = buildModel(document, catalog, null);
    expect(problems(built)).toEqual([]);
    const setpoint = 300 * PSI + ATMOSPHERE;
    expect(nodeOf(built, partTagged(document, "B-1").id)).toMatchObject({
        type: "source",
        settings: { gas: "Nitrogen", pressure: 2000 * PSI + ATMOSPHERE },
    });
    // The press manifold: the point its lines make, gas tubing, with the settings its lines keep.
    expect(nodeOf(built, partTagged(document, "PT-PRESS").id)).toMatchObject({
        type: "gas_junction",
        name: "PT-PRESS",
        settings: { pressure: setpoint, wall: "tubing" },
    });
    // Gas reaches the tank, so it's under an ullage, of the gas its lines carry.
    expect(nodeOf(built, partTagged(document, "TK-1").id)).toMatchObject({
        type: "tank",
        settings: { mode: "ullage", gas: "Nitrogen", fluid: "Water" },
    });
    expect(built.model.edges.map((edge) => [edge.type, edge.name])).toEqual([
        ["regulator", "REG-1"],
        ["gas_valve", "SV-PRESS"],
        ["gas_valve", "SV-VENT"],
        ["valve", "MOV-01"],
        ["venturi", "CAV-1"],
    ]);
    expect(built.model.edges[2]!.settings).toMatchObject({ check: "no", position: 0, cda: 5e-6 });
    // Without a test, channels are as the P&ID names them: the tank's transducer starts the ullage's pressure.
    expect(nodeOf(built, partTagged(document, "TK-1").id)!.links).toEqual({ pressure: "PT-TANK" });
});

test("Vespula: a COPV pressing two tanks, the chamber an outlet for each, and flow meters on the injectors", () => {
    const document = documentOf(vespula());
    const channels = [
        "COPV Pressure",
        "COPV Temperature",
        "LOX Tank Pressure",
        "LOX Ullage Temperature",
        "LOX Manifold Pressure",
        "LOX Injector Mass Flow",
        "LOX Hi Flow Switch",
        "LOX Relief Valve",
        "Fuel Tank Pressure",
        "Fuel Ullage Temperature",
        "Fuel Manifold Pressure",
        "Fuel Injector Mass Flow",
        "Fuel Hi Flow Switch",
        "Fuel Relief Valve",
        "Chamber Pressure",
    ];
    const built = buildModel(document, catalog, testWith(...channels));
    expect(problems(built)).toEqual([]);
    expect(notes(built)).toEqual([]);
    const copv = nodeOf(built, partTagged(document, "COPV").id)!;
    expect(copv).toMatchObject({
        type: "gas_junction",
        settings: { wall: "vessel", heat_transfer: 0, volume: 0.04, pressure: 4200 * PSI },
        links: { pressure: "COPV Pressure", temperature: "COPV Temperature" },
    });
    const lox = nodeOf(built, partTagged(document, "TK-LOX").id)!;
    expect(lox).toMatchObject({
        type: "tank",
        settings: { fluid: "Oxygen", mode: "ullage", gas: "Nitrogen", collapse_factor: 1.2, liquid_volume: 0.07697 },
        // Its thermocouple taps it above its liquid: its ullage's.
        links: { pressure: "LOX Tank Pressure", gas_temperature: "LOX Ullage Temperature" },
    });
    // Its thermocouple could read its liquid's temperature instead; its transducer reads its pressure, with no choice.
    const reads = (tag: string) => readChoices(built, catalog, partTagged(document, tag).id).map((one) => one.key);
    expect(reads("TC-LOX-ULLAGE")).toContain("temperature");
    expect(reads("PT-LOX-TANK")).toEqual([]);
    // The chamber is an outlet for each of the engine's inlets, as a model carries one liquid in each connected set
    // of lines; its transducer sets both.
    const chamber = built.model.nodes.filter((node) => node.type === "outlet" && node.name.startsWith("ENG-1"));
    expect(chamber.map((node) => [node.name, node.links])).toEqual([
        ["ENG-1 (fuel)", { pressure: "Chamber Pressure" }],
        ["ENG-1 (ox)", { pressure: "Chamber Pressure" }],
    ]);
    // A flow meter with no loss of its own: its channel is the injector's flow.
    expect(edgeOf(built, partTagged(document, "INJ-LOX").id)!.links).toEqual({ flow: "LOX Injector Mass Flow" });
    expect(edgeOf(built, partTagged(document, "FM-LOX").id)!.name).toBe("INJ-LOX");
    expect(built.model.edges.map((edge) => edge.type).sort()).toEqual(
        [
            ...Array(2).fill("gas_orifice"), // the lo-flow orifices
            ...Array(4).fill("gas_valve"), // the hi-flow valves and the reliefs, which their channels drive
            ...Array(4).fill("orifice"), // each side's system and injector
        ].sort(),
    );
    expect(edgeOf(built, partTagged(document, "SV-LOX-HF").id)).toMatchObject({
        links: { command: "LOX Hi Flow Switch" },
        settings: { opening_time: 0.001, position: 0, closed_value: 0, open_value: 1 },
    });
    expect(comparisons(built.model, catalog).map((one) => one.channel)).toEqual(
        expect.arrayContaining([
            "COPV Pressure",
            "LOX Tank Pressure",
            "Fuel Injector Mass Flow",
            "LOX Manifold Pressure",
        ]),
    );
});

test("what flows through a part is what its lines carry: said, or mixed, or not said", () => {
    const draw = sketch();
    const tank = draw.place("tank", 0, -100, { tag: "TK-1", props: { fluid: "water" } });
    const valve = draw.place("ball-valve", 0, 60, { tag: "BV-1", rotation: 90 });
    const vent = draw.place("vent", 60, 160);
    const feed = draw.join([tank, "bottom"], [valve, "a"]);
    draw.join([valve, "b"], [vent, "in"]);
    expect(problems(buildModel(documentOf(draw.drawing), catalog, null))).toEqual([
        "Say what BV-1 carries: give one of its lines a fluid (Carry along its run gives it to the rest).",
    ]);
    const said = updateLine(draw.drawing, feed, (line) => ({ ...line, fluid: "water" }));
    expect(problems(buildModel(documentOf(said), catalog, null))).toEqual([]);
    const outlet = said.lines.find((line) => line.id !== feed)!.id;
    const mixed = updateLine(said, outlet, (line) => ({ ...line, fluid: "gn2" }));
    expect(problems(buildModel(documentOf(mixed), catalog, null))).toEqual([
        "BV-1 is in lines that carry gas and liquid: give each line the fluid it carries.",
    ]);
});

test("two tanks joined with nothing between them, and a regulator in liquid lines, are the P&ID's to fix", () => {
    const draw = sketch();
    const one = draw.place("tank", -100, 0, { tag: "TK-1", props: { fluid: "water" } });
    const two = draw.place("tank", 100, 0, { tag: "TK-2", props: { fluid: "water" } });
    draw.join([one, "right-lower"], [two, "left-lower"], "water");
    const regulator = draw.place("regulator", 0, 160, { tag: "REG-1" });
    const out = draw.place("vent", 120, 160);
    draw.join([one, "bottom"], [regulator, "a"], "water");
    draw.join([regulator, "b"], [out, "in"], "water");
    expect(problems(buildModel(documentOf(draw.drawing), catalog, null))).toEqual([
        "TK-1 and TK-2 are joined with nothing between them that the model has: put a valve or an orifice between them, or model a line between them as a line.",
        "REG-1 is a regulator in liquid lines: the model's regulators are gas's.",
    ]);
});

test("off-page connectors join the pages they go between into one model", () => {
    const first = sketch();
    const tank = first.place("tank", 0, -100, { tag: "TK-1", props: { fluid: "water" } });
    const valve = first.place("ball-valve", 0, 60, { tag: "BV-1", rotation: 90 });
    const there = first.place("offpage", 80, 160);
    first.join([tank, "bottom"], [valve, "a"], "water");
    first.join([valve, "b"], [there, "in"], "water");
    const second = sketch();
    const here = second.place("offpage", -80, 0);
    const injector = second.place("orifice", 0, 0, { tag: "INJ" });
    const out = second.place("vent", 100, 0);
    second.join([here, "in"], [injector, "a"], "water");
    second.join([injector, "b"], [out, "in"], "water");
    const two = documentOf(first.drawing);
    const pageTwo = documentOf(second.drawing, "Engine").pages[0]!;
    const document: Document = {
        ...two,
        pages: [
            {
                ...two.pages[0]!,
                parts: two.pages[0]!.parts.map((part) =>
                    part.id === there ? { ...part, props: { page: pageTwo.id, part: here } } : part,
                ),
            },
            pageTwo,
        ],
    };
    const built = buildModel(document, catalog, null);
    expect(problems(built)).toEqual([]);
    const valveEdge = built.model.edges.find((edge) => edge.name === "BV-1")!;
    const injectorEdge = built.model.edges.find((edge) => edge.name === "INJ")!;
    expect(valveEdge.target).toBe(injectorEdge.source); // one point, across the pages
});

test("what the model leaves out, or does differently than it might seem, it says", () => {
    const draw = sketch();
    const tank = draw.place("tank", 0, -100, { tag: "TK-1", props: { fluid: "water" } });
    const check = draw.place("check-valve", 0, 60, { tag: "CV-1", rotation: 90 });
    const valve = draw.place("ball-valve", 0, 160, { tag: "BV-1", rotation: 90 });
    const pump = draw.place("pump", 160, 0, { tag: "P-1" });
    draw.join([tank, "bottom"], [check, "a"], "water");
    draw.join([check, "b"], [valve, "a"], "water");
    draw.join([tank, "right-lower"], [pump, "in"], "water");
    expect(notes(buildModel(documentOf(draw.drawing), catalog, null))).toEqual([
        "CV-1 is a check valve in liquid lines, which the model has as a valve: it doesn't stop flow back.",
        "BV-1's outlet goes nowhere, so the model has it capped: draw its line on to where it goes (a vent, for the atmosphere).",
        "P-1 isn't simulated: the lines at it end there.",
    ]);
});

test("a part's settings in the model go back onto it, and onto each line of a point; a fit's, where they fit", () => {
    let document = documentOf(pressurizedFlow());
    let built = buildModel(document, catalog, null);
    const valve = partTagged(document, "MOV-01");
    document = withModelSetting(document, built, valve.id, "cda", 9e-5);
    expect(partTagged(document, "MOV-01").sim).toEqual({ as: "", settings: { cda: 9e-5 } });
    // A gas point's settings are on each of its lines.
    const press = nodeOf(built, partTagged(document, "PT-PRESS").id)!;
    document = withModelSetting(document, built, press.id, "volume", 0.0005);
    const lines = built.origins.get(press.id)!.lines;
    expect(lines.length).toBe(3);
    for (const id of lines) {
        const line = document.pages[0]!.lines.find((one) => one.id === id)!;
        expect(line.sim?.node.volume).toBe(0.0005);
    }
    built = buildModel(document, catalog, null);
    expect(nodeOf(built, partTagged(document, "PT-PRESS").id)!.settings.volume).toBe(0.0005);
    // What a fit found is applied where it's within its setting's limits (an anchor can take one past them).
    const fitted = applyKnobs(document, built, catalog, [
        { part: valve.id, key: "cda", start: 9e-5, value: 7e-5 },
        { part: valve.id, key: "opening_time", start: 0.05, value: -1 },
    ]);
    expect(partTagged(fitted, "MOV-01").sim?.settings).toEqual({ cda: 7e-5 });
});

test("what a part can be in the model, as it's drawn and as it's set", () => {
    const part = (preset: string, props: Record<string, string> = {}): Part => {
        const added = addPart(emptyDrawing(), presetOf(preset)!, { x: 0, y: 0 });
        const found = added.drawing.parts[0]!;
        return { ...found, props: { ...found.props, ...props } };
    };
    const fluids = emptyDrawing();
    expect(roleChoices(part("bottle"), fluids)).toEqual(["supply", "vessel"]);
    expect(roleChoices(part("tank", { fluid: "ghe" }), fluids)).toEqual(["supply", "vessel"]);
    expect(roleChoices(part("tank", { fluid: "lox" }), fluids)).toEqual(["tank"]);
    expect(roleChoices(part("venturi"), fluids)).toEqual(["orifice", "venturi", "through", "none"]);
    expect(roleChoices(part("cavitating-venturi"), fluids)).toEqual(["venturi", "orifice", "through", "none"]);
    expect(roleChoices(part("flow-meter"), fluids)).toEqual(["meter", "orifice", "none"]);
    expect(roleChoices(part("filter"), fluids)).toEqual(["through", "orifice", "none"]);
    expect(roleChoices(part("junction"), fluids)).toEqual(["through"]);
    expect(roleChoices(part("text"), fluids)).toEqual(["none"]);
});

test("a part's channel can be left out of the model: what it would set is the part's own settings then", () => {
    let document = documentOf(coldFlow());
    const valve = partTagged(document, "MOV-01");
    const sensor = partTagged(document, "PT-TANK");
    for (const id of [valve.id, sensor.id]) {
        document = withPartSim(document, id, (sim) => ({ ...sim, unlinked: true }));
    }
    const built = buildModel(document, catalog, testWith("PT-TANK", "MOV-01", "PT-MANIFOLD"));
    expect(problems(built)).toEqual([]);
    expect(notes(built)).toEqual([]); // not missing from the test: left out on purpose
    // The valve holds where its settings have it (normally closed: shut), and the tank at its own pressure.
    expect([edgeOf(built, valve.id)!.links, edgeOf(built, valve.id)!.settings.position]).toEqual([{}, 0]);
    expect(nodeOf(built, partTagged(document, "TK-1").id)!.links).toEqual({});
    expect(built.left.map((one) => [one.key, one.channel])).toEqual([
        ["command", "MOV-01"],
        ["pressure", "PT-TANK"],
    ]);
    expect(built.links.map((one) => one.channel)).toEqual(["PT-MANIFOLD"]);
});

test("the drawing shows a run's values: an instrument's test and model values in the model's units, a flow while there is one", () => {
    const document = documentOf(coldFlow());
    const test = testWith("PT-TANK", "MOV-01", "PT-MANIFOLD");
    test.channels = test.channels.map((channel) =>
        channel.name === "PT-MANIFOLD" ? { ...channel, unit: "psia" } : channel,
    );
    const built = buildModel(document, catalog, test);
    const id = (tag: string) => partTagged(document, tag).id;
    const manifold = nodeOf(built, id("PT-MANIFOLD"))!.id;
    const tank = nodeOf(built, id("TK-1"))!.id;
    const valve = edgeOf(built, id("MOV-01"))!.id;
    const injector = edgeOf(built, id("INJ"))!.id;
    const psig = (value: number) => value * PSI + ATMOSPHERE;
    const shown = {
        result: {
            times: [0, 1, 2],
            series: {
                [`${manifold}.pressure`]: [psig(0), psig(185.04), psig(0)],
                [`${tank}.pressure`]: [psig(300), psig(300), psig(300)],
                [`${valve}.mass_flow`]: [0, 1.5, 0],
                [`${injector}.mass_flow`]: [0, 1.5, 0],
            },
            liquids: {},
            initial: [],
            notes: [],
            steps: 3,
            elapsed: 1,
        },
        model: built.model,
        built,
        testId: test.id,
    };
    // The manifold's transducer read 199.7 psia at 1 s: 185.0 psig, as the model has it.
    const samples = new Map([["PT-MANIFOLD", { t: new Float64Array([0, 1]), v: new Float64Array([14.7, 199.7]) }]]);
    const live = simLive(shown, 1.5, { detail: test, samples });
    expect(live.get(id("PT-MANIFOLD"))).toEqual({ measured: "185", model: "185 psig" });
    // Its channel left out of the model, what it measured is still shown beside the model's, to compare.
    const left = buildModel(
        withPartSim(document, id("PT-MANIFOLD"), (sim) => ({ ...sim, unlinked: true })),
        catalog,
        test,
    );
    expect(simLive({ ...shown, built: left }, 1.5, { detail: test, samples }).get(id("PT-MANIFOLD"))).toEqual({
        measured: "185",
        model: "185 psig",
    });
    // The tank's pressure is its transducer's to show; the outlet's is what it was given.
    expect(live.get(id("PT-TANK"))?.model).toBe("300 psig");
    expect(live.has(id("TK-1"))).toBe(false);
    expect(live.has(document.pages[0]!.parts.find((part) => part.kind === "vent")!.id)).toBe(false);
    expect(live.get(id("MOV-01"))).toEqual({ measured: null, model: "3.307 lbm/s" });
    // A shut valve shows nothing: no flow.
    expect(simLive(shown, 2, null).has(id("MOV-01"))).toBe(false);
});
