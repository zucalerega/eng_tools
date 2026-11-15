import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import { formatDate } from "../src/format";
import { renderApp, Team } from "./team";

// Piper picks from folders as Yorg does (the site's FolderBrowser): a test from Yorg's tests in Yorg's folders, read
// through Yorg's API, opened in the folder of the test chosen; and a diagram's folder from the diagrams' folders,
// opened where it is, with a new one made there.

// Piper's pages load when one's first opened: loaded here first, the editor's code is compiled before the tests.
beforeAll(async () => {
    await import("../src/piper/Editor");
});

const DATA = ["Time (s),PT-1 (psi)", "0,300", "0.1,310", "0.2,320"].join("\n");

const names = (list: HTMLElement) =>
    within(list)
        .getAllByRole("button")
        .map((one) => one.querySelector(".folder-browser-name")?.firstChild?.textContent);

test("a test is picked from Yorg's folders, starting in the chosen test's, each saying when it was added", async () => {
    const team = await Team.create();
    const campaign = await team.dataFolder(team.chief, "Campaign");
    const day = await team.dataFolder(team.chief, "Day 2", campaign.id);
    const first = await team.data(team.chief, "Cold flow 1", DATA, campaign.id);
    const second = await team.data(team.chief, "Cold flow 2", DATA, campaign.id);
    const deeper = await team.data(team.chief, "Long run", DATA, day.id);
    const made = await team.diagram(team.chief, "Feed system");
    const user = userEvent.setup();

    // Without a test, it opens at Yorg's top.
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    await screen.findByRole("application", { name: "Drawing" });
    await user.click(screen.getByRole("button", { name: "Test data" }));
    const panel = within(await screen.findByRole("region", { name: "Test data" }));
    await user.click(panel.getByRole("button", { name: "Test: Choose a test from Yorg" }));
    let picker = within(await screen.findByRole("dialog", { name: "Test" }));
    const top = within(await picker.findByRole("navigation", { name: "Test: where" }));
    expect(top.getByText("Yorg")).toBeTruthy();
    await user.click(await picker.findByRole("button", { name: `${campaign.name}: folder` }));
    // The folder's folders, then its tests, the newest first, each with when it was added.
    expect(names(picker.getByRole("list"))).toEqual([day.name, second.name, first.name]);
    const row = picker.getByRole("button", { name: new RegExp(`^${first.name}`) });
    expect(row.querySelector(".folder-browser-note")?.textContent).toBe(formatDate(first.created_at));
    await user.click(row);
    expect(await panel.findByRole("button", { name: `Test: ${first.name}` })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("test")).toBe(String(first.id));

    // Opened again, it's in that test's folder, the test marked; found in any folder by a few words.
    await user.click(panel.getByRole("button", { name: `Test: ${first.name}` }));
    picker = within(await screen.findByRole("dialog", { name: "Test" }));
    const where = within(await picker.findByRole("navigation", { name: "Test: where" }));
    expect(where.getByText(campaign.name)).toBeTruthy();
    await waitFor(() => expect(names(picker.getByRole("list"))).toEqual([day.name, second.name, first.name]));
    expect(picker.getByRole("button", { name: new RegExp(`^${first.name}`) }).getAttribute("aria-current")).toBe(
        "true",
    );
    await user.type(picker.getByLabelText("Find a test"), `long ${team.folder}`);
    expect(names(picker.getByRole("list"))).toEqual([deeper.name]);
    expect(within(picker.getByRole("list")).getByText(`in ${campaign.name} / ${day.name}`)).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(await panel.findByRole("button", { name: `Test: ${deeper.name}` })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("test")).toBe(String(deeper.id));
});

test("a diagram's folder is chosen from the diagrams' folders, opened where it is, or made there", async () => {
    const team = await Team.create();
    const stand = await team.piperFolder(team.chief, "Stand");
    const gse = await team.piperFolder(team.chief, "GSE", stand.id);
    const made = await team.diagram(team.chief, "Feed system", undefined, stand.path);
    const other = await team.diagram(team.chief, "Purge", undefined, gse.path);
    const user = userEvent.setup();
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    await screen.findByRole("application", { name: "Drawing" });

    // Renamed without its folder touched, it stays where it is.
    await user.click(screen.getByRole("button", { name: made.name }));
    let dialog = within(await screen.findByRole("dialog", { name: "Rename, move, or describe" }));
    await user.type(dialog.getByRole("textbox", { name: "Description" }), "The feed system");
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename, move, or describe" })).toBeNull());
    expect(await team.piperDiagram(team.chief, made.id)).toMatchObject({
        folder_id: stand.id,
        description: "The feed system",
    });

    // Its folder's chooser opens where it is: that folder's folders, and its diagrams, to see.
    await user.click(screen.getByRole("button", { name: made.name }));
    dialog = within(await screen.findByRole("dialog", { name: "Rename, move, or describe" }));
    await user.click(await dialog.findByRole("button", { name: `Folder: ${stand.name}` }));
    const chooser = within(await screen.findByRole("dialog", { name: "Folder" }));
    expect(within(chooser.getByRole("navigation", { name: "Folder: where" })).getByText(stand.name)).toBeTruthy();
    const count = chooser.getByRole("button", { name: `${gse.name}: folder` }).querySelector(".folder-browser-note");
    expect(count?.textContent).toBe("1"); // Purge's in it
    expect(within(chooser.getByRole("list")).getByText(made.name)).toBeTruthy();

    // Into GSE, where Purge is, and a new folder made there: it's chosen, and the diagram moves into it.
    await user.click(chooser.getByRole("button", { name: `${gse.name}: folder` }));
    expect(within(chooser.getByRole("list")).getByText(other.name)).toBeTruthy();
    await user.click(chooser.getByRole("button", { name: "New folder" }));
    await user.type(chooser.getByLabelText("The new folder's name"), "Valves{Enter}");
    expect(await dialog.findByRole("button", { name: `Folder: ${stand.name} / ${gse.name} / Valves` })).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename, move, or describe" })).toBeNull());
    const moved = await team.piperDiagram(team.chief, made.id);
    expect(moved.folder).toBe(`${stand.name}/${gse.name}/Valves`);
    const where = within(screen.getByRole("navigation", { name: "Where" }));
    expect(where.getByText(/Valves/)).toBeTruthy();
});
