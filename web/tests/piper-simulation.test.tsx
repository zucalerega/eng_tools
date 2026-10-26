import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import type { Document, Part } from "../src/piper/drawing";
import { LIGHT } from "../src/piper/colors";
import { coldFlow } from "../src/piper/sim/examples";
import { renderApp, Team } from "./team";

// Piper's Simulation mode, through the app: the P&ID as a model, for admins, shown only while it's on; a part set up in
// the inspector and kept in the drawing, once it's yours to edit; what keeps it from running; and a run against a test
// on the test server, compared with what was measured, then fitted, and what the fit found applied to the P&ID.

beforeAll(async () => {
    await Promise.all([import("../src/piper/Diagrams"), import("../src/piper/Editor")]);
});

// 2 s at 100 Hz: the tank at 300 psig, the main valve open from 0.5 s to 1.5 s, and what the manifold read.
const COLD_FLOW = [
    "Time (s),MOV-01,PT-TANK (psig),PT-MANIFOLD (psig)",
    ...Array.from({ length: 201 }, (_, i) => {
        const open = i >= 50 && i < 150;
        return [(i / 100).toFixed(2), open ? "OPEN" : "CLOSED", "300", open ? "185" : "0"].join(",");
    }),
].join("\n");

const drawingArea = () => screen.getByRole("application", { name: "Drawing" });

/** A point of the drawing, as the pointer's there (as piper.test.tsx has it: jsdom lays nothing out). */
function at(x: number, y: number) {
    const [vx, vy, vw] = drawingArea().getAttribute("viewBox")!.split(" ").map(Number) as [number, number, number];
    const zoom = 1 / vw;
    return { clientX: (x - vx) * zoom, clientY: (y - vy) * zoom, pointerId: 1, button: 0 };
}

/** A part of the drawing selected, by its tag, where it is. */
function select(tag: string, x: number, y: number) {
    fireEvent.pointerDown(within(drawingArea()).getByRole("button", { name: tag }), at(x, y));
    fireEvent.pointerUp(drawingArea(), at(x, y));
}

const inspector = () => within(screen.getByRole("complementary", { name: "Inspector" }));

/** Edit, on a diagram opened to be looked at: it's yours to change. */
async function startEditing() {
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Done editing" });
}

/** A part of a saved drawing, by its tag. */
const tagged = (document: Document, tag: string): Part =>
    document.pages.flatMap((page) => page.parts).find((part) => part.tag === tag)!;

test("Simulation mode is admins', and what it adds shows only while it's on", async () => {
    const team = await Team.create();
    const made = await team.diagram(team.chief, "Cold flow", undefined);
    const bob = await team.member("Bob");
    const asBob = renderApp(bob, `/piper/diagrams/${made.id}?sim=1`);
    const tools = within(await screen.findByRole("toolbar", { name: "Tools" }));
    expect(tools.getByRole("button", { name: "History" })).toBeTruthy();
    expect(tools.queryByRole("button", { name: "Simulation" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Simulation" })).toBeNull(); // the address isn't enough
    asBob.unmount();

    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const bar = within(await screen.findByRole("toolbar", { name: "Tools" }));
    expect(inspector().queryByRole("region", { name: "Simulation settings" })).toBeNull();
    await userEvent.click(bar.getByRole("button", { name: "Simulation" }));
    expect(bar.getByRole("button", { name: "Simulation" }).getAttribute("aria-pressed")).toBe("true");
    expect(window.location.search).toBe("?sim=1");
    const panel = within(await screen.findByRole("region", { name: "Simulation" }));
    expect(panel.getByRole("combobox", { name: "Test" })).toBeTruthy();
    expect(bar.queryByRole("button", { name: "Test data" })).toBeNull(); // its panel has the test
    // Nothing selected: the diagram's units, for the whole model.
    const box = within(await inspector().findByRole("region", { name: "Simulation settings" }));
    expect((box.getByLabelText("Units") as HTMLSelectElement).value).toBe("us");
    expect(await panel.findByText(/^Draw the system first/)).toBeTruthy();

    await userEvent.click(panel.getByRole("button", { name: "Leave Simulation mode" }));
    expect(screen.queryByRole("region", { name: "Simulation" })).toBeNull();
    expect(window.location.search).toBe("");
    expect(bar.getByRole("button", { name: "Test data" })).toBeTruthy();
});

test("a part's settings in the model are set in the inspector, in the diagram's units, and kept in the drawing", async () => {
    const team = await Team.create();
    const made = await team.diagram(team.chief, "Cold flow", coldFlow());
    renderApp(team.chief, `/piper/diagrams/${made.id}?sim=1`);
    await screen.findByRole("region", { name: "Simulation" });
    select("MOV-01", 0, 60);
    const box = within(await inspector().findByRole("region", { name: "Simulation settings" }));
    expect((box.getByLabelText("In the model") as HTMLSelectElement).value).toBe("valve");
    expect(box.getByText("In the model: a valve, from MOV-01 inlet to PT-MANIFOLD.")).toBeTruthy();
    const cda = box.getByLabelText("CdA when open") as HTMLInputElement;
    expect(cda.value).toBe("0.0775002"); // 5e-5 m², in in²
    expect(cda.matches(":disabled")).toBe(true); // only looked at: read, not changed

    await startEditing();
    expect(cda.matches(":disabled")).toBe(false);
    await userEvent.clear(cda);
    await userEvent.type(cda, "0.1{Enter}");
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).document;
        expect(tagged(saved, "MOV-01").sim?.settings.cda).toBeCloseTo(0.1 * 0.00064516, 12);
    });

    // Left out of the model, the lines on either side of it are one point.
    await userEvent.selectOptions(box.getByLabelText("In the model"), "through");
    expect(await box.findByText(/^In the model: a plain connection/)).toBeTruthy();
});

test("a part's channel can be left out of the model, for the value set in the P&ID instead", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", COLD_FLOW);
    const made = await team.diagram(team.chief, "Cold flow", coldFlow());
    renderApp(team.chief, `/piper/diagrams/${made.id}?sim=1&test=${data.id}`);
    await screen.findByRole("region", { name: "Simulation" });
    await startEditing();
    select("PT-TANK", 80, -170);
    const box = within(await inspector().findByRole("region", { name: "Simulation settings" }));
    expect(box.getByText("Reads TK-1's pressure.")).toBeTruthy();
    const used = (await box.findByRole("checkbox", { name: "PT-TANK (it follows)" })) as HTMLInputElement;
    expect(used.checked).toBe(true);
    await userEvent.click(used);
    expect(
        await box.findByRole("checkbox", { name: "PT-TANK (left out: TK-1's value is set there instead)" }),
    ).toBeTruthy();
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).document;
        expect(tagged(saved, "PT-TANK").sim?.unlinked).toBe(true);
    });

    // The tank then holds the pressure set on it, and its channel can be put back from there too.
    select("TK-1", 0, -140);
    const tank = within(await inspector().findByRole("region", { name: "Simulation settings" }));
    expect(tank.queryByText("Follows PT-TANK")).toBeNull();
    const left = tank.getByRole("checkbox", { name: "PT-TANK (left out: its value's set here instead)" });
    expect((left as HTMLInputElement).checked).toBe(false);
    await userEvent.click(left);
    expect(await tank.findByText("Follows PT-TANK")).toBeTruthy();
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).document;
        expect(tagged(saved, "PT-TANK").sim?.unlinked).toBeUndefined();
    });
});

test("what keeps the model from running is listed, each with Go to, and Run waits for it", async () => {
    const team = await Team.create();
    // The cold flow, but nothing says what its lines carry (its feed line, modeled as one, would say it's liquid).
    const drawing = coldFlow();
    const made = await team.diagram(team.chief, "Cold flow", {
        ...drawing,
        lines: drawing.lines.map((line) => ({ ...line, fluid: "", sim: { line: null, node: {} } })),
    });
    const data = await team.data(team.chief, "Cold flow", COLD_FLOW);
    renderApp(team.chief, `/piper/diagrams/${made.id}?sim=1&test=${data.id}`);
    const panel = within(await screen.findByRole("region", { name: "Simulation" }));
    const findings = within(await panel.findByRole("list", { name: "What the model says of the P&ID" }));
    const problem = await findings.findByText(/^Say what MOV-01 carries/);
    expect((panel.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(problem.closest("li")!).getByRole("button", { name: "Go to" }));
    expect(await inspector().findByRole("heading", { name: "Pneumatic ball valve" })).toBeTruthy();
});

test("Tune puts fitting and anchoring side by side, each saying what it does", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", COLD_FLOW);
    const made = await team.diagram(team.chief, "Cold flow", coldFlow());
    renderApp(team.chief, `/piper/diagrams/${made.id}?sim=1&test=${data.id}`);
    const panel = within(await screen.findByRole("region", { name: "Simulation" }));
    await waitFor(() =>
        expect((panel.getByRole("button", { name: "Tune…" }) as HTMLButtonElement).disabled).toBe(false),
    );
    await userEvent.click(panel.getByRole("button", { name: "Tune…" }));
    const tuning = within(screen.getByRole("dialog", { name: "Tune the model to the test" }));
    expect((tuning.getByRole("radio", { name: "Fit" }) as HTMLInputElement).checked).toBe(true);
    expect(tuning.getByText(/^Runs the model again and again/)).toBeTruthy();
    expect(tuning.getByText("PT-MANIFOLD")).toBeTruthy(); // what it's matched to
    expect(tuning.getByRole("checkbox", { name: /^INJ: CdA/ })).toBeTruthy();

    await userEvent.click(tuning.getByRole("radio", { name: "Anchor" }));
    expect(tuning.getByRole("columnheader", { name: "Knob it moves" })).toBeTruthy();
    expect((tuning.getByRole("button", { name: "Anchor" }) as HTMLButtonElement).disabled).toBe(true); // none picked
    await userEvent.selectOptions(tuning.getByLabelText(/^PT-MANIFOLD pressure/), "INJ: CdA");
    expect((tuning.getByRole("button", { name: "Anchor" }) as HTMLButtonElement).disabled).toBe(false);
});

test(
    "the P&ID runs against a test, compared with what was measured, and a fit is applied to it",
    { timeout: 360_000 },
    async () => {
        const team = await Team.create();
        const data = await team.data(team.chief, "Cold flow", COLD_FLOW);
        const drawing = coldFlow();
        const made = await team.diagram(team.chief, "Cold flow", drawing);
        renderApp(team.chief, `/piper/diagrams/${made.id}?sim=1&test=${data.id}`);
        const panel = within(await screen.findByRole("region", { name: "Simulation" }));
        // The window starts as the test's first ten seconds: all of this one.
        await waitFor(() => expect((panel.getByLabelText("To (s)") as HTMLInputElement).value).toBe("2"));
        expect(panel.getByText(/^Powered by/)).toBeTruthy();

        await userEvent.click(panel.getByRole("button", { name: "Run" }));
        expect(await panel.findByText(/^Done in/, {}, { timeout: 150_000 })).toBeTruthy();
        const results = within(panel.getByRole("region", { name: "Results" }));
        expect(results.getByRole("img", { name: "PT-MANIFOLD pressure" })).toBeTruthy(); // its plot
        expect(results.getByText(/PT-MANIFOLD \(measured\)/)).toBeTruthy();
        expect(await results.findByText(/^RMS .* psig · bias/)).toBeTruthy(); // once the measured channel has loaded
        expect(results.getByText(/TK-1: Water at 293\.15 K/)).toBeTruthy();
        // The drawing shows what the test measured, then the model's value in gold, at the time on the timeline, in a
        // badge on a leader to its part.
        fireEvent.change(panel.getByRole("slider", { name: "Time" }), { target: { value: "1" } });
        const manifold = drawing.parts.find((part) => part.tag === "PT-MANIFOLD")!.id;
        await waitFor(() => {
            const badge = drawingArea().querySelector(`[data-live="${manifold}"]`);
            expect([...(badge?.querySelectorAll("text") ?? [])].map((text) => text.textContent)).toEqual([
                "185",
                expect.stringMatching(/^[\d.]+ psig$/),
            ]);
        });
        const [measured, modeled] = [...drawingArea().querySelectorAll(`[data-live="${manifold}"] text`)];
        expect([measured!.getAttribute("fill"), modeled!.getAttribute("fill")]).toEqual([LIGHT.ink, LIGHT.model]);
        expect(drawingArea().querySelector(`[data-leader="${manifold}"]`)).toBeTruthy();
        expect(panel.getByText(/what the test measured, then/)).toBeTruthy(); // what the badges say

        // A fit: the injector's CdA turned until the manifold reads what was measured, then applied to the P&ID.
        await userEvent.clear(panel.getByLabelText("Time step (s)"));
        await userEvent.type(panel.getByLabelText("Time step (s)"), "0.02");
        await userEvent.click(panel.getByRole("button", { name: "Tune…" }));
        const fitting = within(screen.getByRole("dialog"));
        await userEvent.click(fitting.getByRole("checkbox", { name: /^INJ: CdA/ }));
        await userEvent.click(fitting.getByRole("button", { name: "Fit" }));
        const fit = within(await panel.findByRole("region", { name: "Fit" }, { timeout: 170_000 }));
        expect(fit.getByText(/^Done: \d+ runs, the error/)).toBeTruthy();
        expect(fit.getByText("INJ: CdA")).toBeTruthy();
        // Run and fitted while only looked at: what it found goes on the P&ID once it's yours to change.
        const apply = fit.getByRole("button", { name: "Apply to the P&ID" }) as HTMLButtonElement;
        expect(apply.disabled).toBe(true);
        expect(fit.getByText("Edit the diagram to apply it.")).toBeTruthy();
        await startEditing();
        expect(apply.disabled).toBe(false);
        await userEvent.click(apply);
        await waitFor(async () => {
            const saved = (await team.piperDiagram(team.chief, made.id)).document;
            expect(tagged(saved, "INJ").sim?.settings.cda).not.toBe(3e-5);
        });
    },
);

test("New diagram offers admins the P&IDs to simulate, which open in Simulation mode", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const asBob = renderApp(bob, "/piper");
    await userEvent.click(await screen.findByRole("button", { name: "New diagram" }));
    expect(within(screen.getByRole("dialog")).queryByText(/^A cold flow to simulate/)).toBeNull();
    asBob.unmount();

    renderApp(team.chief, "/piper");
    await userEvent.click(await screen.findByRole("button", { name: "New diagram" }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.type(dialog.getByLabelText("Name"), team.named("Stand A"));
    await userEvent.click(dialog.getByText(/^A cold flow to simulate/));
    await userEvent.click(dialog.getByRole("button", { name: "Make it" }));
    expect(await screen.findByRole("region", { name: "Simulation" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Done editing" })).toBeTruthy(); // made just now: yours to edit
    await waitFor(() => expect(window.location.search).toBe("?sim=1"));
    expect(within(drawingArea()).getByRole("button", { name: "MOV-01" })).toBeTruthy();
});
