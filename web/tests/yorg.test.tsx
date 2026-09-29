import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { formatSize } from "../src/format";
import { renderApp, Team } from "./team";

// Yorg, through the app: upload test data, plot its channels, save views, and look after datasets.

const HOTFIRE = [
    "Time (s),PT-OX-01 (psi),PT-FU-01 (psi),TC-NOZ-01 (K),Valve",
    ...Array.from({ length: 50 }, (_, i) =>
        [i / 100, 300 + i, 280 + i / 2, 290 + i * 3, i < 20 ? "CLOSED" : "OPEN"].join(","),
    ),
].join("\n");

test("the app switcher goes between the vault and Yorg", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/");
    const apps = await screen.findByRole("navigation", { name: "Apps" });
    expect(within(apps).getByRole("link", { name: "Vault" }).getAttribute("aria-current")).toBe("page");

    await userEvent.click(within(apps).getByRole("link", { name: "Yorg" }));
    expect(await screen.findByRole("heading", { name: "Test data" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(
        within(nav)
            .getAllByRole("link")
            .map((link) => link.textContent),
    ).toEqual(["Datasets", "Views", "Help", "Preview"]); // Preview: the chief is an admin (yorg-preview.test.tsx)
});

test("Help says what Yorg does, and how", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/yorg");
    const nav = within(await screen.findByRole("navigation", { name: "Main" }));
    await userEvent.click(nav.getByRole("link", { name: "Help" }));
    expect(await screen.findByRole("heading", { name: "How Yorg works" })).toBeTruthy();
    expect(nav.getByRole("link", { name: "Help" }).getAttribute("aria-current")).toBe("page");
    for (const card of ["Getting data in", "Plotting", "Moving around", "Time and T0", "Calculated channels"]) {
        expect(screen.getByRole("region", { name: card })).toBeTruthy();
    }
});

test("uploading a file of test data opens its channels, ready to plot", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/yorg");
    const name = `Hotfire ${team.folder}`;
    fireEvent.change(await screen.findByLabelText("Files to upload"), {
        target: { files: [new File([HOTFIRE], `${name}.csv`, { type: "text/csv" })] },
    });
    const dialog = await screen.findByRole("dialog", { name: "Upload test data" });
    expect((within(dialog).getByLabelText(`Name for ${name}.csv`) as HTMLInputElement).value).toBe(name);
    await userEvent.click(within(dialog).getByRole("button", { name: "Upload" }));

    // It opens on its plots, with its channels on the left: a unit for each, and the valve as a state.
    expect(await screen.findByRole("heading", { name })).toBeTruthy();
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    const pt = await channels.findByRole("button", { name: /PT-OX-01\s*psi/ });
    expect(channels.getByRole("button", { name: /Valve\s*state/ })).toBeTruthy();
    expect(screen.getByText(/Pick channels on the left/)).toBeTruthy();

    await userEvent.click(pt);
    const legend = within(await screen.findByRole("group", { name: "Plot 1: channels" }));
    expect(legend.getByRole("button", { name: "PT-OX-01" })).toBeTruthy();
    expect(legend.getByText("psi")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Plot 1: PT-OX-01" })).toBeTruthy();

    // Shift-click: a plot of its own.
    fireEvent.click(channels.getByRole("button", { name: /TC-NOZ-01\s*K/ }), { shiftKey: true });
    expect(await screen.findByRole("group", { name: "Plot 2: channels" })).toBeTruthy();
});

test("clicking a plotted channel takes it off the plots", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Toggle", HOTFIRE);
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    const pt = await channels.findByRole("button", { name: /PT-OX-01/ });
    expect(pt.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(pt);
    const legend = within(await screen.findByRole("group", { name: "Plot 1: channels" }));
    expect(legend.getByRole("button", { name: "PT-OX-01" })).toBeTruthy();
    expect(pt.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(pt); // plotted: off it comes, rather than a second copy
    expect(await screen.findByText(/No channels yet/)).toBeTruthy();
    expect(pt.getAttribute("aria-pressed")).toBe("false");

    // Shift-click is still how to plot one again, on a plot of its own.
    await userEvent.click(pt);
    fireEvent.click(pt, { shiftKey: true });
    expect(await screen.findByRole("group", { name: "Plot 2: channels" })).toBeTruthy();
    await userEvent.click(pt); // and a click takes it off every plot
    expect(await screen.findAllByText(/No channels yet/)).toHaveLength(2);
});

/** What a drag carries, as a browser would (jsdom has none). */
function dataTransfer() {
    const data: Record<string, string> = {};
    const types: string[] = [];
    return {
        types,
        dropEffect: "none",
        effectAllowed: "all",
        setData(type: string, value: string) {
            data[type] = value;
            types.push(type);
        },
        getData: (type: string) => data[type] ?? "",
    };
}

test("each unit gets an axis of its own, and channels move between axes", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Axes", HOTFIRE);
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await userEvent.click(await channels.findByRole("button", { name: /PT-OX-01/ }));
    const legend = within(await screen.findByRole("group", { name: "Plot 1: channels" }));
    expect(legend.queryByText("psi · left")).toBeNull(); // one axis: one list

    // Another unit, and a valve: an axis each, on alternate sides; the same unit joins its axis.
    await userEvent.click(channels.getByRole("button", { name: /TC-NOZ-01/ }));
    await userEvent.click(channels.getByRole("button", { name: /PT-FU-01/ }));
    await userEvent.click(channels.getByRole("button", { name: /Valve/ }));
    const on = (axis: string) =>
        within(legend.getByRole("list", { name: axis }))
            .getAllByRole("button", { name: /^(PT|TC|Valve)/ })
            .map((button) => button.textContent);
    expect(on("psi · left")).toEqual(["PT-OX-01", "PT-FU-01"]);
    expect(on("K · right")).toEqual(["TC-NOZ-01"]);
    expect(on("States · left 2")).toEqual(["Valve"]);

    // A legend's row onto an axis of its own, and back with its settings; the axis left empty goes.
    const panel = screen.getByRole("region", { name: "Plot 1" });
    let transfer = dataTransfer();
    fireEvent.dragStart(legend.getByRole("button", { name: "PT-FU-01" }).closest("li")!, { dataTransfer: transfer });
    fireEvent.dragOver(panel, { dataTransfer: transfer });
    fireEvent.drop(await legend.findByText("Drop here for an axis of its own"), { dataTransfer: transfer });
    await waitFor(() => expect(on("psi · right 2")).toEqual(["PT-FU-01"]));
    await userEvent.click(legend.getByRole("button", { name: "PT-FU-01" }));
    const settings = within(await screen.findByRole("dialog", { name: "PT-FU-01: settings" }));
    await userEvent.selectOptions(settings.getByLabelText("Axis"), "psi · left");
    await waitFor(() => expect(on("psi · left")).toEqual(["PT-OX-01", "PT-FU-01"]));
    expect(legend.queryByRole("list", { name: "psi · right 2" })).toBeNull();

    // A channel from the list, dropped anywhere on the plot: onto the axis for its unit.
    transfer = dataTransfer();
    fireEvent.dragStart(channels.getByRole("button", { name: /TC-NOZ-01/ }), { dataTransfer: transfer });
    fireEvent.dragOver(panel, { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("img", { name: /^Plot 1:/ }), { dataTransfer: transfer });
    await waitFor(() => expect(on("K · right")).toEqual(["TC-NOZ-01", "TC-NOZ-01"]));
});

test("a calculated channel, made from the dataset's channels, plots like one", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Calculated", HOTFIRE);
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await userEvent.click(await channels.findByRole("button", { name: "New calculated channel" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New calculated channel" }));
    const name = `Tanks ${team.folder}`;
    await userEvent.type(dialog.getByLabelText("Name"), name);
    await userEvent.type(dialog.getByLabelText("Unit"), "psi");
    const expression = dialog.getByLabelText("Expression") as HTMLTextAreaElement;
    await userEvent.click(dialog.getByRole("button", { name: "PT-OX-01" }));
    await userEvent.type(expression, " + ");
    await userEvent.click(dialog.getByRole("button", { name: "PT-FU-01" }));
    expect(expression.value).toBe("[PT-OX-01] + [PT-FU-01]");
    // Tried out on the dataset as it's written.
    expect(await dialog.findByText(`In ${data.name}: 580 to 653.5 psi`)).toBeTruthy();

    await userEvent.type(expression, " +");
    expect(await dialog.findByText("Expected a value at the end (at character 26)")).toBeTruthy();
    expect((dialog.getByRole("button", { name: "Save and plot" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(expression, " 1");
    await userEvent.click(dialog.getByRole("button", { name: "Save and plot" }));

    // Plotted on the selected plot, and in the list of calculated channels.
    const legend = within(await screen.findByRole("group", { name: "Plot 1: channels" }));
    expect(await legend.findByRole("button", { name })).toBeTruthy();
    expect(legend.getByText("psi")).toBeTruthy();
    const calculated = await channels.findByRole("button", { name: `Change ${name}` });

    // Changing it changes it everywhere it's plotted.
    await userEvent.click(calculated);
    const change = within(await screen.findByRole("dialog", { name: `Change ${name}` }));
    await userEvent.clear(change.getByLabelText("Name"));
    await userEvent.type(change.getByLabelText("Name"), `Both tanks ${team.folder}`);
    await userEvent.click(change.getByRole("button", { name: "Save" }));
    expect(await legend.findByRole("button", { name: `Both tanks ${team.folder}` })).toBeTruthy();
});

test("a channel's settings rename it, scale it, and remove it", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", HOTFIRE);
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await userEvent.click(await channels.findByRole("button", { name: /PT-FU-01/ }));
    const legend = within(await screen.findByRole("group", { name: "Plot 1: channels" }));

    await userEvent.click(legend.getByRole("button", { name: "PT-FU-01" }));
    const settings = within(await screen.findByRole("dialog", { name: "PT-FU-01: settings" }));
    expect(settings.getByText(/50 samples, 280 to 304.5 psi/)).toBeTruthy();
    const scale = settings.getByLabelText("Scale (×)");
    await userEvent.clear(scale);
    await userEvent.type(scale, "0.0689476");
    await userEvent.clear(settings.getByLabelText("Unit"));
    await userEvent.type(settings.getByLabelText("Unit"), "bar");
    await userEvent.type(settings.getByLabelText("Name"), "Fuel tank{Enter}");
    expect(await legend.findByRole("button", { name: /^Fuel tank/ })).toBeTruthy();
    expect(legend.getByText("bar")).toBeTruthy();

    // Hide it, then take it away.
    await userEvent.click(legend.getByRole("button", { name: "Show Fuel tank" }));
    expect(legend.getByRole("button", { name: "Show Fuel tank" }).getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(legend.getByRole("button", { name: /^Fuel tank/ }));
    await userEvent.click(
        within(await screen.findByRole("dialog", { name: "Fuel tank: settings" })).getByRole("button", {
            name: "Remove",
        }),
    );
    expect(await screen.findByText(/No channels yet/)).toBeTruthy();
});

test("the time window can be typed, and T0 set", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Window", HOTFIRE);
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    const start = (await screen.findByLabelText("Window start")) as HTMLInputElement;
    const end = screen.getByLabelText("Window end") as HTMLInputElement;
    expect([start.value, end.value]).toEqual(["0", "0.49"]);

    await userEvent.clear(start);
    await userEvent.type(start, "0.1");
    await userEvent.clear(end);
    await userEvent.type(end, "0.3{Enter}");
    await waitFor(() => expect([start.value, end.value]).toEqual(["0.1", "0.3"]));
    expect(screen.getByText(/200 ms in view/)).toBeTruthy();

    // With T0, times read from it: T-, T0, T+.
    await userEvent.click(screen.getByRole("button", { name: "T0" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Set T0 at the start of the window" }));
    await waitFor(() => expect([start.value, end.value]).toEqual(["T0", "T+0.2"]));
    const markers = within(screen.getByRole("region", { name: "Markers" }));
    expect(markers.getByText("0.1 s in the file")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect([start.value, end.value]).toEqual(["T-0.1", "T+0.39"])); // the whole file again

    // T0 typed: seconds in the file; the window's inputs take times from T0.
    await userEvent.click(screen.getByRole("button", { name: "T0" }));
    await userEvent.type(screen.getByLabelText("T0 at"), "0.25{Enter}");
    expect(await markers.findByText("0.25 s in the file")).toBeTruthy();
    await userEvent.clear(start);
    await userEvent.type(start, "T-0.05");
    await userEvent.clear(end);
    await userEvent.type(end, "T+0.05{Enter}");
    await waitFor(() => expect([start.value, end.value]).toEqual(["T-0.05", "T+0.05"]));
    expect(screen.getByText(/100 ms in view/)).toBeTruthy();
});

test("a saved view opens for everyone, and works with another test's data", async () => {
    const team = await Team.create();
    const first = await team.data(team.chief, "Test 1", HOTFIRE);
    const second = await team.data(team.chief, "Test 2", HOTFIRE);
    renderApp(team.chief, `/yorg/datasets/${first.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await userEvent.click(await channels.findByRole("button", { name: /PT-OX-01/ }));

    await userEvent.click(screen.getByRole("button", { name: "Save view" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Save this view" }));
    await userEvent.type(dialog.getByLabelText("Name"), `Tanks ${team.folder}`);
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: `Tanks ${team.folder}` })).toBeTruthy();
    expect(
        within(await screen.findByRole("group", { name: "Plot 1: channels" })).getByRole("button", {
            name: "PT-OX-01",
        }),
    ).toBeTruthy();
    expect(window.location.pathname).toMatch(/^\/yorg\/views\/\d+$/);

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Use with another dataset…" }));
    const other = within(await screen.findByRole("dialog", { name: "Use this view with another dataset" }));
    await userEvent.selectOptions(
        await other.findByRole("combobox"),
        await other.findByRole("option", { name: second.name }),
    );
    await userEvent.click(other.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("heading", { name: second.name })).toBeTruthy();
    expect(
        within(await screen.findByRole("group", { name: "Plot 1: channels" })).getByRole("button", {
            name: "PT-OX-01",
        }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(`/yorg/datasets/${second.id}`);
});

test("a dataset's page says how it was read, and it can be read another way", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "No time", "A,B\n5,1\n3,2\n4,3\n");
    renderApp(team.chief, `/yorg/datasets/${data.id}/about`);
    expect(await screen.findByText(/No column looks like time, so time is the row number/)).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Channels" })).getByText("A")).toBeTruthy();

    const settings = () => within(screen.getByRole("form", { name: "Read settings" }));
    await userEvent.selectOptions(settings().getByLabelText("Time column"), "B");
    await userEvent.click(settings().getByRole("button", { name: "Read it again" }));
    expect(await screen.findByText("B: Seconds")).toBeTruthy();
    expect(screen.queryByText(/No column looks like time/)).toBeNull();
    expect(within(screen.getByRole("table", { name: "Channels" })).queryByText("B")).toBeNull(); // it's time now

    // A way that doesn't work says why, and leaves the last read as it was.
    await userEvent.selectOptions(settings().getByLabelText("Time is in"), "Dates and times");
    await userEvent.click(settings().getByRole("button", { name: "Read it again" }));
    expect(await screen.findByText(/That didn't work: Couldn't read the dates in B/)).toBeTruthy();
    expect(screen.getByText("B: Seconds")).toBeTruthy();
});

test("renaming, deleting, and restoring a dataset", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Leak check", HOTFIRE);
    renderApp(team.chief, "/yorg");
    const table = within(await screen.findByRole("table", { name: "Datasets" }));
    const row = (await table.findByRole("link", { name: data.name })).closest("tr")!;
    expect(within(row).getByText("4")).toBeTruthy(); // channels: every column but time
    expect(within(row).getByText("490 ms")).toBeTruthy();
    expect(within(row).getByText("100 Hz")).toBeTruthy();

    await userEvent.click(within(row).getByRole("link", { name: "About" }));
    const name = await screen.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, `Leak check 2 ${team.folder}`);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: `Leak check 2 ${team.folder}` })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("heading", { name: "Test data" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("link", { name: `Leak check 2 ${team.folder}` })).toBeNull());

    await userEvent.click(screen.getByRole("link", { name: "Deleted datasets" }));
    const deleted = within(await screen.findByRole("table", { name: "Deleted datasets" }));
    const gone = (await deleted.findByText(`Leak check 2 ${team.folder}`)).closest("tr")!;
    await userEvent.click(within(gone).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.queryByText(`Leak check 2 ${team.folder}`)).toBeNull());
});

test("only whoever added a dataset, or an admin, can change it", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    const data = await team.data(team.chief, "Chief's", HOTFIRE);
    renderApp(alice, `/yorg/datasets/${data.id}/about`);
    expect(await screen.findByRole("heading", { name: data.name })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Plot it" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Read settings" })).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
});

test("folders: made, moved into, browsed, and searched across; and each dataset's size", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Foldered", HOTFIRE);
    renderApp(team.chief, "/yorg");
    let table = within(await screen.findByRole("table", { name: "Datasets" }));
    const row = (await table.findByRole("link", { name: data.name })).closest("tr")!;
    expect(within(row).getByText(formatSize(data.size))).toBeTruthy();

    const folder = `Campaign ${team.folder}`;
    await userEvent.click(screen.getByRole("button", { name: "New folder" }));
    const made = within(await screen.findByRole("dialog", { name: "New folder" }));
    await userEvent.type(made.getByLabelText("Name"), folder);
    await userEvent.click(made.getByRole("button", { name: "Make it" }));
    expect(await table.findByRole("link", { name: folder })).toBeTruthy();

    // Chosen, and moved to the folder.
    await userEvent.click(within(row).getByRole("checkbox", { name: `Choose ${data.name}` }));
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    const move = within(await screen.findByRole("dialog", { name: "Move a dataset" }));
    await userEvent.click(move.getByRole("radio", { name: folder }));
    await userEvent.click(move.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(table.queryByRole("link", { name: data.name })).toBeNull());
    const folderRow = table.getByRole("link", { name: folder }).closest("tr")!;
    expect(within(folderRow).getByText("1 dataset")).toBeTruthy();

    // In the folder: the dataset, and the way back up.
    await userEvent.click(within(folderRow).getByRole("link", { name: folder }));
    expect(await screen.findByRole("heading", { name: folder })).toBeTruthy();
    table = within(await screen.findByRole("table", { name: "Datasets" }));
    expect(await table.findByRole("link", { name: data.name })).toBeTruthy();
    await userEvent.click(
        within(screen.getByRole("navigation", { name: "Folders" })).getByRole("link", { name: "Test data" }),
    );

    // A search looks in every folder, and says where each dataset is.
    await userEvent.type(await screen.findByLabelText("Find datasets"), data.name);
    expect(await screen.findByText(`in ${folder}`)).toBeTruthy();
});

test("a saved view shows on its dataset's pages for everyone, and anyone can save it as their own", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    const data = await team.data(team.chief, "Viewed", HOTFIRE);
    const view = await team.view(team.chief, `Tanks ${team.folder}`, data.id, "PT-OX-01");
    renderApp(alice, `/yorg/datasets/${data.id}`);

    await userEvent.click(await screen.findByRole("button", { name: "Saved views (1)" }));
    await userEvent.click(screen.getByRole("menuitem", { name: `${view.name}, by chief` }));
    expect(await screen.findByRole("heading", { name: view.name })).toBeTruthy();
    expect(
        within(await screen.findByRole("group", { name: "Plot 1: channels" })).getByRole("button", {
            name: "PT-OX-01",
        }),
    ).toBeTruthy();
    // It's the chief's: Alice keeps hers as a new view.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save as a new view" }));
    expect(await screen.findByRole("dialog", { name: "Save this view" })).toBeTruthy();
});

test("a mask holds where a valve's open, and splits a file of two tests into two datasets", async () => {
    const team = await Team.create();
    // Two cold flows in one file: the valve opens at 1 s, and again at 3.5 s, for a second each time.
    const open = (i: number) => (i >= 10 && i < 20) || (i >= 35 && i < 45);
    const csv = [
        "Time (s),PT-OX-01 (psi),Valve",
        ...Array.from({ length: 60 }, (_, i) => [i / 10, 300 + i, open(i) ? "OPEN" : "CLOSED"].join(",")),
    ].join("\n");
    const data = await team.data(team.chief, "Cold flows", csv);
    renderApp(team.chief, `/yorg/datasets/${data.id}`);

    // Put together from the valve and its state's name, and tried on the dataset.
    await userEvent.click(await screen.findByRole("button", { name: "Mask" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New mask" }));
    await userEvent.selectOptions(dialog.getByLabelText("Channel"), "Valve");
    await userEvent.selectOptions(dialog.getByLabelText("Comparison"), "is");
    await userEvent.selectOptions(dialog.getByLabelText("Value"), "OPEN");
    await userEvent.click(dialog.getByRole("button", { name: "Add" }));
    expect((dialog.getByLabelText("Test") as HTMLTextAreaElement).value).toBe("[Valve] == 1");
    expect((dialog.getByLabelText("Name") as HTMLInputElement).value).toBe("Valve is OPEN");
    expect(await dialog.findByText(`In ${data.name}, it holds 2 times: 1.8 s in all of 5.9 s.`)).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Add the mask" }));

    const masks = within(await screen.findByRole("region", { name: "Masks" }));
    expect(await masks.findByText("Holds 2 times, 1.8 s in all")).toBeTruthy();
    const shade = masks.getByRole("button", { name: "Shade where Valve is OPEN holds" });
    expect(shade.getAttribute("aria-pressed")).toBe("true");
    const hide = masks.getByRole("button", { name: "Hide data where Valve is OPEN doesn't hold" });
    await userEvent.click(hide);
    expect(hide.getAttribute("aria-pressed")).toBe("true");

    // Split where it holds: from a second before each opening to two seconds after it (inside the file).
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    const split = within(await screen.findByRole("dialog", { name: `Split ${data.name} into tests` }));
    const tests = within(await split.findByRole("table", { name: "Tests" }));
    expect(
        tests
            .getAllByRole("row")
            .slice(1)
            .map((row) => [...row.querySelectorAll("td")].slice(1).map((cell) => cell.textContent)),
    ).toEqual([
        [`${data.name} test 1`, "0 s", "3.9 s", "3.9 s"],
        [`${data.name} test 2`, "2.5 s", "5.9 s", "3.4 s"],
    ]);
    await userEvent.click(split.getByRole("button", { name: "Make 2 datasets" }));
    const done = within(await screen.findByRole("dialog", { name: "Made 2 datasets" }));
    await userEvent.click(done.getByRole("button", { name: "Open the folder" }));

    // In a new folder beside it, each timed from its valve's opening.
    expect(await screen.findByRole("heading", { name: `${data.name} tests` })).toBeTruthy();
    const table = within(await screen.findByRole("table", { name: "Datasets" }));
    const first = (await table.findByRole("link", { name: `${data.name} test 1` })).closest("tr")!;
    expect(first.textContent).toContain("3.9 s");
    expect(table.getByRole("link", { name: `${data.name} test 2` })).toBeTruthy();
    await userEvent.click(within(first).getByRole("link", { name: "About" }));
    expect(await screen.findByText("Split from")).toBeTruthy();
    expect(screen.getByRole("link", { name: data.name })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Download/ })).toBeNull();
});
