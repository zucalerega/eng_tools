import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
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
