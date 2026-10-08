import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { VESPULA_RUN } from "../src/yorg/models/model";
import { fakePython } from "./python";
import { renderApp, Team } from "./team";

// Yorg's dev page (admins): a system model drawn, linked to a test's channels, saved, and run with FullFlow on the
// test server.

// 2 s at 100 Hz: the tank at 300 psig, the main valve open from 0.5 s to 1.5 s, and what the manifold read.
const COLD_FLOW = [
    "Time (s),MOV-OX,PT-TANK (psig),PT-MANIFOLD (psig)",
    ...Array.from({ length: 201 }, (_, i) => {
        const open = i >= 50 && i < 150;
        return [(i / 100).toFixed(2), open ? "OPEN" : "CLOSED", "300", open ? "185" : "0"].join(",");
    }),
].join("\n");

/** The cold flow example, against the test: its tank, main valve, and manifold linked to the test's channels. */
async function coldFlow(dataset: string) {
    await userEvent.click(await screen.findByRole("button", { name: "Start from an example" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Cold flow" }));
    const diagram = within(screen.getByRole("application", { name: "P&ID" }));
    expect(diagram.getByRole("button", { name: "Fuel tank" })).toBeTruthy();
    expect(diagram.getByRole("button", { name: "Main valve" })).toBeTruthy();

    // The test first: its channels are what the parts link to.
    await userEvent.selectOptions(screen.getByLabelText("Test"), dataset);
    const pick = async (part: string, link: string, channel: string) => {
        fireEvent.pointerDown(diagram.getByRole("button", { name: part }));
        const settings = within(await screen.findByRole("region", { name: `${part} settings` }));
        await waitFor(() =>
            expect(settings.getAllByRole("option", { name: new RegExp(`^${channel}`) }).length).toBeGreaterThan(0),
        );
        await userEvent.selectOptions(settings.getByLabelText(link), channel);
    };
    await pick("Fuel tank", "Pressure (it follows)", "PT-TANK");
    await pick("Main valve", "Command (drives it)", "MOV-OX");
    await pick("Manifold", "Pressure transducer (compared)", "PT-MANIFOLD");
    return diagram;
}

test("system models are in the preview, for admins", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const asBob = renderApp(bob, "/yorg/dev/models");
    expect(await screen.findByText(/There's no page here/)).toBeTruthy();
    asBob.unmount();

    renderApp(team.chief, "/yorg");
    const main = within(await screen.findByRole("navigation", { name: "Main" }));
    await userEvent.click(await main.findByRole("link", { name: "Preview" }));
    await userEvent.click(await main.findByRole("link", { name: "Models" }));
    expect(await screen.findByRole("heading", { name: "Models" })).toBeTruthy();
    expect(window.location.pathname).toBe("/yorg/dev/models");
});

test("a model is drawn, linked to a test, saved, run against it, and fitted to it", { timeout: 360_000 }, async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", COLD_FLOW);
    renderApp(team.chief, "/yorg/dev/models");

    expect((await screen.findByRole("link", { name: "FullFlow" })).getAttribute("href")).toBe(
        "https://github.com/saakethramoju/FullFlow",
    );
    const diagram = await coldFlow(data.name);
    expect(diagram.getAllByText("PT")).toHaveLength(2);
    expect(diagram.getByText("CMD")).toBeTruthy();

    // Saved for the team, by name.
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.clear(dialog.getByLabelText("Name"));
    await userEvent.type(dialog.getByLabelText("Name"), "Stand A cold flow");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Stand A cold flow" })).toBeTruthy());

    // Run: the manifold's pressure, measured and modeled, and how far apart they are.
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(/^Done in/, {}, { timeout: 150_000 })).toBeTruthy();
    const results = within(screen.getByRole("region", { name: "Results" }));
    expect(results.getByText("Manifold pressure transducer")).toBeTruthy();
    expect(results.getByText(/PT-MANIFOLD \(measured\)/)).toBeTruthy();
    expect(await results.findByText(/^RMS .* psig · bias/)).toBeTruthy(); // once the measured channel has loaded
    expect(results.getByText(/Fuel tank: Water at 293\.15 K/)).toBeTruthy();

    // A fit: the injector's CdA turned until the manifold reads what was measured, then applied to the model.
    await userEvent.clear(screen.getByLabelText("Time step (s)"));
    await userEvent.type(screen.getByLabelText("Time step (s)"), "0.02");
    await userEvent.click(screen.getByRole("button", { name: "Fit…" }));
    const fitting = within(screen.getByRole("dialog"));
    expect(fitting.getByText("PT-MANIFOLD")).toBeTruthy();
    await userEvent.click(fitting.getByRole("checkbox", { name: /^Injector: CdA/ }));
    await userEvent.click(fitting.getByRole("button", { name: "Fit" }));
    const fit = within(await screen.findByRole("region", { name: "Fit" }, { timeout: 170_000 }));
    expect(fit.getByText(/^Done: \d+ runs, the error/)).toBeTruthy();
    expect(fit.getByText("Injector: CdA")).toBeTruthy();
    fireEvent.pointerDown(diagram.getByRole("button", { name: "Injector" }));
    const injector = within(await screen.findByRole("region", { name: "Injector settings" }));
    const before = (injector.getByLabelText(/^CdA/) as HTMLInputElement).value;
    await userEvent.click(fit.getByRole("button", { name: "Apply to the model" }));
    await waitFor(() => expect((injector.getByLabelText(/^CdA/) as HTMLInputElement).value).not.toBe(before));
    expect(screen.getByRole("option", { name: "Stand A cold flow (changed)" })).toBeTruthy();
});

test("a model's knob is anchored to a test in one steady run, and applied", { timeout: 240_000 }, async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", COLD_FLOW);
    renderApp(team.chief, "/yorg/dev/models");
    const diagram = await coldFlow(data.name);

    // The injector's CdA, moved in each time step until the manifold reads what was measured: while the main valve
    // is open, since nothing flows to tell it while it's shut.
    await userEvent.selectOptions(screen.getByLabelText("Solver"), "Steady");
    await userEvent.click(screen.getByRole("button", { name: "Anchor…" }));
    const anchoring = within(screen.getByRole("dialog"));
    expect(anchoring.queryByRole("option", { name: /^Fuel tank/ })).toBeNull(); // steady: tanks hold their pressure
    await userEvent.selectOptions(anchoring.getByLabelText(/^Manifold pressure transducer/), "Injector: CdA");
    await userEvent.type(anchoring.getByLabelText("From (s)"), "0.6");
    await userEvent.type(anchoring.getByLabelText("To (s)"), "1.4");
    // Its one sensor anchors the injector, so there's nothing left to fit the line's friction to.
    const fitToo = anchoring.getByRole("checkbox", { name: "Feed line: Friction factor f" });
    await userEvent.click(fitToo);
    expect(anchoring.getByText(/^Every sensor anchors a knob/)).toBeTruthy();
    expect((anchoring.getByRole("button", { name: "Anchor" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(fitToo);
    expect(
        (anchoring.getByRole("checkbox", { name: /^Fit any knob FullFlow can't anchor/ }) as HTMLInputElement).checked,
    ).toBe(true);
    await userEvent.click(anchoring.getByRole("button", { name: "Anchor" }));

    const anchored = within(await screen.findByRole("region", { name: "Anchored" }, { timeout: 150_000 }));
    expect(anchored.getByText(/^Done in one run: each knob's median/)).toBeTruthy();
    expect(anchored.getByText("Injector: CdA")).toBeTruthy();
    expect(anchored.getByRole("columnheader", { name: "10–90%" })).toBeTruthy();
    const results = within(screen.getByRole("region", { name: "Results" }));
    expect(results.getByText("Injector: CdA, anchored to Manifold pressure transducer")).toBeTruthy();

    fireEvent.pointerDown(diagram.getByRole("button", { name: "Injector" }));
    const injector = within(await screen.findByRole("region", { name: "Injector settings" }));
    const before = (injector.getByLabelText(/^CdA/) as HTMLInputElement).value;
    await userEvent.click(anchored.getByRole("button", { name: "Apply to the model" }));
    await waitFor(() => expect((injector.getByLabelText(/^CdA/) as HTMLInputElement).value).not.toBe(before));
});

test("the Vespula example comes with its run's data, uploaded once", { timeout: 240_000 }, async () => {
    const team = await Team.create();
    const before = (await team.datasets(team.chief)).filter((one) => one.name === VESPULA_RUN.dataset);
    renderApp(team.chief, "/yorg/dev/models");
    const pick = async () => {
        await userEvent.click(await screen.findByRole("button", { name: "Start from an example" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Vespula prop system, with its run's data" }));
    };
    await pick();
    const diagram = within(screen.getByRole("application", { name: "P&ID" }));
    for (const part of ["COPV", "LOX tank", "Fuel tank", "LOX hi-flow valve", "LOX lo-flow orifice", "Fuel injector"]) {
        expect(diagram.getByRole("button", { name: part })).toBeTruthy();
    }
    // Its data, picked as the test, over the whole run.
    await waitFor(() =>
        expect((screen.getByLabelText("Test") as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
            VESPULA_RUN.dataset,
        ),
    );
    expect((screen.getByLabelText("To (s)") as HTMLInputElement).value).toBe("21.3");
    expect((screen.getByLabelText("Time step (s)") as HTMLInputElement).value).toBe("0.1");

    // Steady, its tanks and its COPV hold their pressures, so they can't anchor a knob; its manifolds can.
    await userEvent.selectOptions(screen.getByLabelText("Solver"), "Steady");
    await userEvent.click(screen.getByRole("button", { name: "Anchor…" }));
    const anchoring = within(screen.getByRole("dialog"));
    expect(anchoring.getByLabelText(/^LOX manifold pressure transducer/)).toBeTruthy();
    for (const held of [/^COPV/, /^LOX tank/, /^Fuel tank/]) {
        expect(anchoring.queryByLabelText(held)).toBeNull();
    }
    await userEvent.click(anchoring.getByRole("button", { name: "Cancel" }));

    // And its liquid side reads what Vespula's run did: built of the same FullFlow components with the same ThermoProp
    // properties, to a part in a million.
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(/^Done in/, {}, { timeout: 150_000 })).toBeTruthy();
    const results = within(screen.getByRole("region", { name: "Results" }));
    const manifold = results.getByText("LOX manifold pressure transducer").closest(".dev-plot") as HTMLElement;
    const rms = Number((await within(manifold).findByText(/^RMS /)).textContent!.match(/^RMS ([\d.e+-]+)/)![1]);
    expect(rms).toBeLessThan(0.001); // psi, of 330 to 400

    // Picked again, it finds its data rather than uploading it twice.
    await pick();
    await waitFor(async () =>
        expect((await team.datasets(team.chief)).filter((one) => one.name === VESPULA_RUN.dataset)).toHaveLength(
            Math.max(before.length, 1),
        ),
    );
});

test("a gas junction can hold its gas in a vessel, whose wall's hA is a knob", { timeout: 120_000 }, async () => {
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/models");
    await userEvent.click(await screen.findByRole("button", { name: "Start from an example" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Vespula prop system, with its run's data" }));
    await waitFor(() => expect((screen.getByLabelText("Test") as HTMLSelectElement).value).not.toBe(""));

    // Its COPV holds its gas in tubing, with no wall, until it's a vessel.
    fireEvent.pointerDown(
        within(screen.getByRole("application", { name: "P&ID" })).getByRole("button", { name: "COPV" }),
    );
    const copv = within(await screen.findByRole("region", { name: "COPV settings" }));
    expect(copv.queryByText("Wall hA")).toBeNull();
    await userEvent.selectOptions(copv.getByLabelText("Holds its gas in"), "A vessel, with a wall that trades heat");
    expect(copv.getByText("Wall hA")).toBeTruthy();

    const anchorable = async () => {
        await userEvent.click(screen.getByRole("button", { name: "Anchor…" }));
        const anchoring = within(screen.getByRole("dialog"));
        const knobs = anchoring.getAllByRole("option").map((option) => option.textContent);
        await userEvent.click(anchoring.getByRole("button", { name: "Cancel" }));
        return knobs;
    };
    expect(await anchorable()).toContain("COPV: Wall hA");
    // Steady, the COPV holds what its transducer measured, so its wall doesn't matter.
    await userEvent.selectOptions(screen.getByLabelText("Solver"), "Steady");
    expect(await anchorable()).not.toContain("COPV: Wall hA");
});

/** The Script view's editor for a file (model.py, or one of yorg_models'), once it's on the page. */
async function editorFor(file: string): Promise<EditorView> {
    const script = await screen.findByRole("region", { name: "Script" });
    const content = await within(script).findByRole("textbox", { name: file }, { timeout: 30_000 });
    return EditorView.findFromDOM(content)!;
}

const PSIG_300 = 300 * 6894.757 + 101325; // Pa

test("a model's script is shown, changed, and run in the browser", { timeout: 120_000 }, async () => {
    const pythons = fakePython();
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", COLD_FLOW);
    renderApp(team.chief, "/yorg/dev/models");
    await coldFlow(data.name);

    // The model as the FullFlow script the server runs: written from the P&ID, with what it imports beside it.
    await userEvent.click(screen.getByRole("button", { name: "Script" }));
    const model = await editorFor("model.py");
    await waitFor(() => expect(model.state.doc.toString()).toContain("from fullflow import *"));
    const written = model.state.doc.toString();
    expect(written).toContain("main_valve = DischargeCoefficient(");
    expect(written).toContain("run.following('n1.pressure', otherwise=");
    expect(written).toContain("'n1.pressure': ('PT-TANK', 'pressure'),");
    const script = within(screen.getByRole("region", { name: "Script" }));
    expect(script.getByText("Written from the P&ID: Run runs it on the server")).toBeTruthy();
    await userEvent.click(script.getByRole("button", { name: "yorg_models/__init__.py" }));
    const library = await editorFor("yorg_models/__init__.py");
    expect(library.state.doc.toString()).toContain("class Run:");
    expect(library.state.readOnly).toBe(true);
    await userEvent.click(script.getByRole("button", { name: "model.py" }));

    // Changed, it runs in the browser: Fit and Anchor stay with the P&ID's model, on the server.
    const changed = written.replace("result = run.solve()", "print('mine')\nresult = run.solve()");
    const view = await editorFor("model.py");
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: changed } }));
    expect(await script.findByText("Changed: Run runs it in your browser")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Fit…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Anchor…" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Run in browser" }));

    // The tab's Python gets the script as model.py, FullFlow and ThermoProp to install at the server's versions,
    // yorg_models, and the run's data from the server, in SI units.
    const fake = pythons.latest();
    fake.say({ type: "ready", version: "3.14.2" });
    const sent = await fake.next("run");
    expect(sent.code).toBe(changed);
    expect(sent.filename).toBe("model.py");
    expect(sent.install).toEqual([expect.stringMatching(/^fullflow==/), expect.stringMatching(/^thermoprop==/)]);
    const files = new Map((sent.files ?? []).map((file) => [file.path, file.data]));
    const text = (path: string) => new TextDecoder().decode(files.get(path));
    expect(text("/tmp/yorg-model/yorg_models/__init__.py")).toContain("class Run:");
    expect(text("/tmp/yorg-model/yorg_models/components.py")).toContain("class Anchor(Sensor):");
    expect(JSON.parse(text("/tmp/yorg-model/inputs/keys.json"))).toEqual(["n1.pressure", "n3.pressure", "e2.command"]);
    const tank = new Float64Array(files.get("/tmp/yorg-model/inputs/n1.pressure.v.f64")!.slice().buffer);
    expect(tank[0]).toBeCloseTo(PSIG_300, 3);
    expect(sent.setup).toContain("data = _yorg_model_setup()");
    expect(sent.finish).toContain('"result"');

    // It says how far it's got, then what it printed, and its result shows as a run's on the server does.
    fake.say({ type: "progress", run: sent.run, phase: "install", packages: sent.install });
    expect(await screen.findByText(/^Installing FullFlow and ThermoProp from PyPI · \d+ s$/)).toBeTruthy();
    fake.say({ type: "report", run: sent.run, key: "progress", value: "0.5" });
    expect(await screen.findByText(/^Running in your browser: 0\.5 of 2 s, \d+ s so far$/)).toBeTruthy();
    const result = {
        times: [0, 0.5, 1.5],
        series: { "n3.pressure": [101325, PSIG_300, 101325] },
        liquids: {},
        initial: [],
        notes: ["Solved in the browser"],
        steps: 3,
        elapsed: 1,
    };
    fake.say({ type: "stdout", run: sent.run, text: "mine" });
    fake.say({ type: "report", run: sent.run, key: "result", value: JSON.stringify(result) });
    fake.say({ type: "done", run: sent.run, elapsed: 2, timings: [] });
    expect(await screen.findByText(/^Done in your browser in/)).toBeTruthy();
    const results = within(await screen.findByRole("region", { name: "Results" }));
    expect(results.getByText("Solved in the browser")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Run in the browser" })).getByText("mine")).toBeTruthy();

    // Back to the P&ID's script, Run runs it on the server again.
    await userEvent.click(script.getByRole("button", { name: "Back to the P&ID's" }));
    expect(await script.findByText("Written from the P&ID: Run runs it on the server")).toBeTruthy();
    expect((await editorFor("model.py")).state.doc.toString()).toBe(written);
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
});

test("the Reference says how FullFlow models a system", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/models");
    await userEvent.click(await screen.findByRole("button", { name: "Reference" }));
    const reference = within(await screen.findByRole("complementary", { name: "Reference" }));
    expect(reference.getByRole("heading", { name: "A network of states" })).toBeTruthy();
    expect(reference.getByRole("heading", { name: "Solving over time" })).toBeTruthy();
    expect(await reference.findByText(/Yorg runs it, version \d+\.\d+\.\d+, on the server/)).toBeTruthy();
    expect(
        reference.getByRole("cell", { name: "DarcyWeisbach: friction, and the inertia of the liquid in it" }),
    ).toBeTruthy();
    await userEvent.click(reference.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Reference" })).toBeNull();
});
