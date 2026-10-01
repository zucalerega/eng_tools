import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { cell, codeOf, press, setCode } from "./notebook";
import { fakePython } from "./python";
import { renderApp, Team } from "./team";

// A dataset's or view's own Python (in the preview): a notebook docked beside its plots, on what it plots, run with the
// page's time in view, T0, and shifts; its plots go on the page's, on its time axis. Python is a stand-in
// (tests/python.ts).

const DATA = ["Time (s),PT-TANK (psig)", "0,300", "1,301", "2,299"].join("\n");

const floats = (values: number[]) => new Uint8Array(new Float64Array(values).buffer);

/** A dataset's page, with its PT-TANK plotted and its Python open. */
async function datasetWithPython() {
    const pythons = fakePython();
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    renderApp(team.chief, `/yorg/dev/datasets/${data.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await userEvent.click(await channels.findByRole("button", { name: /PT-TANK/ }));
    await userEvent.click(screen.getByRole("button", { name: "Python" }));
    const dock = within(await screen.findByRole("complementary", { name: "Python" }));
    return { pythons, team, data, dock };
}

test("a dataset's page has its own Python beside its plots: a notebook on what it plots, run with its time in view", async () => {
    const { pythons, data, dock } = await datasetWithPython();
    expect(await dock.findByRole("region", { name: "Cell 2: Load the channels" })).toBeTruthy();
    expect(await codeOf(2)).toContain('pt_tank = yorg.channel("PT-TANK")');
    expect(await codeOf(3)).toContain("start, end = yorg.window");

    const fake = pythons.latest();
    fake.say({ type: "ready", version: "3.14.2" });
    await userEvent.click(dock.getByRole("button", { name: "Run cell 2" }));
    const sent = await fake.next("run");
    expect(JSON.parse(sent.context).view).toEqual({ window: [0, 2], t0: null, shifts: { [data.id]: 0 } });
    expect(sent.namespace).toBe(`page-dataset-${data.id}`);

    // What it plots goes on the page's plots, on their time axis, and the cell says so.
    fake.say({
        type: "plot",
        run: sent.run,
        title: "Smoothed",
        name: "PT-TANK smoothed",
        unit: "psig",
        x: floats([0, 1, 2]),
        y: floats([300, 300.5, 300]),
        dataset: data.id,
    });
    fake.say({ type: "done", run: sent.run, elapsed: 0.01, timings: [] });
    const plots = within(screen.getByRole("region", { name: "Plots" }));
    expect(await plots.findByRole("region", { name: "From Python: Smoothed" })).toBeTruthy();
    expect(await dock.findByText("On the page's plots: Smoothed")).toBeTruthy();

    // Taken off the page with its ×; and Python closed, its plots go with it.
    await userEvent.click(plots.getByRole("button", { name: "Take Smoothed off the page" }));
    expect(plots.queryByRole("region", { name: "From Python: Smoothed" })).toBeNull();
    await userEvent.click(dock.getByRole("button", { name: "Close Python" }));
    expect(screen.queryByRole("complementary", { name: "Python" })).toBeNull();
});

test("on the site, anyone has a page's Python, which opens in the site's Scripts; Models stay in the preview", async () => {
    fakePython();
    const team = await Team.create();
    const bob = await team.member("Bob");
    const data = await team.data(team.chief, "Cold flow", DATA);
    renderApp(bob, `/yorg/datasets/${data.id}`);
    await userEvent.click(await screen.findByRole("button", { name: "Python" }));
    const dock = within(await screen.findByRole("complementary", { name: "Python" }));
    expect(screen.queryByRole("link", { name: "Model" })).toBeNull();
    await userEvent.click(dock.getByRole("button", { name: "Open in Scripts" }));
    expect(await screen.findByRole("heading", { name: "Scripts" })).toBeTruthy();
    expect(window.location.pathname).toBe("/yorg/scripts");
});

test("keys in a page's Python are its notebook's, not the plots'", async () => {
    await datasetWithPython();
    await press(2, "Escape");
    await waitFor(() => expect(document.activeElement).toBe(cell(2)));
    fireEvent.keyDown(cell(2), { key: "m" }); // the notebook's: make it text (the plots' would add a marker)
    await waitFor(() => expect(within(cell(2)).getByText("Text")).toBeTruthy());
    expect(screen.queryByText("Marker 1")).toBeNull();
});

test("a page's Python opens in Scripts, its cells and tests going along", async () => {
    const { data, dock } = await datasetWithPython();
    await setCode(2, 'pt_tank = yorg.channel("PT-TANK")\nprint("from the page")');
    await userEvent.click(dock.getByRole("button", { name: "Open in Scripts" }));
    expect(await screen.findByRole("heading", { name: "Scripts" })).toBeTruthy();
    expect(window.location.pathname).toBe("/yorg/dev/scripts");
    await waitFor(async () => expect(await codeOf(2)).toContain('print("from the page")'));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(`From ${data.name}`);
    expect(
        await within(screen.getByRole("complementary", { name: "Data" })).findByRole("region", { name: data.name }),
    ).toBeTruthy();
});

test("a view's Python stays as it was when the view is saved (and its page made again)", async () => {
    const pythons = fakePython();
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    const view = await team.view(team.chief, "Tank view", data.id, "PT-TANK");
    renderApp(team.chief, `/yorg/dev/views/${view.id}`);
    await userEvent.click(await screen.findByRole("button", { name: "Python" }));
    await setCode(2, 'print("kept")');
    expect(pythons.all.length).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true));
    expect(await screen.findByRole("complementary", { name: "Python" })).toBeTruthy();
    await waitFor(async () => expect(await codeOf(2)).toBe('print("kept")'));
    expect(pythons.all.length).toBe(1); // the same Python
});
