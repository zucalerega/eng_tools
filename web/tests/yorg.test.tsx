import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
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
    ).toEqual(["Datasets", "Views"]);
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
    const legend = within(await screen.findByRole("list", { name: "Plot 1: channels" }));
    expect(legend.getByRole("button", { name: "PT-OX-01" })).toBeTruthy();
    expect(legend.getByText("psi")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Plot 1: PT-OX-01" })).toBeTruthy();

    // Shift-click: a plot of its own.
    fireEvent.click(channels.getByRole("button", { name: /TC-NOZ-01\s*K/ }), { shiftKey: true });
    expect(await screen.findByRole("list", { name: "Plot 2: channels" })).toBeTruthy();
});

test("a channel's settings rename it, scale it, and remove it", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", HOTFIRE);
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await userEvent.click(await channels.findByRole("button", { name: /PT-FU-01/ }));
    const legend = within(await screen.findByRole("list", { name: "Plot 1: channels" }));

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
    const start = (await screen.findByLabelText("Window start (s)")) as HTMLInputElement;
    const end = screen.getByLabelText("Window end (s)") as HTMLInputElement;
    expect([start.value, end.value]).toEqual(["0", "0.49"]);

    await userEvent.clear(start);
    await userEvent.type(start, "0.1");
    await userEvent.clear(end);
    await userEvent.type(end, "0.3{Enter}");
    await waitFor(() => expect([start.value, end.value]).toEqual(["0.1", "0.3"]));
    expect(screen.getByText(/200 ms in view/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "T0" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Set T0 at the start of the window" }));
    await waitFor(() => expect([start.value, end.value]).toEqual(["0", "0.2"]));
    expect(within(screen.getByRole("region", { name: "Markers" })).getByText(/T0/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(end.value).toBe("0.39")); // the whole file again, from T0 at 0.1
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
        within(await screen.findByRole("list", { name: "Plot 1: channels" })).getByRole("button", { name: "PT-OX-01" }),
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
        within(await screen.findByRole("list", { name: "Plot 1: channels" })).getByRole("button", { name: "PT-OX-01" }),
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
