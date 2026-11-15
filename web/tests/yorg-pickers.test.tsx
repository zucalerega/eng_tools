import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp, Team } from "./team";

// Picking a dataset from the datasets' folders (the site's FolderBrowser), as the datasets page browses them: opened
// in the folder of the dataset it's picked to go with, into a folder and back up by the path, and found in any folder;
// and a folder chosen from them, for a split's tests.

const DATA = ["Time (s),PT-TANK (psig)", "0,300", "1,301", "2,299"].join("\n");

const names = (list: HTMLElement) =>
    within(list)
        .getAllByRole("button")
        .map((one) => one.querySelector(".folder-browser-name")?.firstChild?.textContent);

test("comparing picks a dataset from the folders, starting in the first dataset's", async () => {
    const team = await Team.create();
    const campaign = await team.dataFolder(team.chief, "Campaign");
    const day = await team.dataFolder(team.chief, "Day 2", campaign.id);
    const first = await team.data(team.chief, "LOG0001", DATA, campaign.id);
    const sibling = await team.data(team.chief, "LOG0002", DATA, campaign.id);
    const deeper = await team.data(team.chief, "LOG0003", DATA, day.id);
    const top = await team.data(team.chief, "Loose", DATA);
    const user = userEvent.setup();
    renderApp(team.chief, `/yorg/datasets/${first.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await channels.findByRole("button", { name: /PT-TANK/ });

    await user.click(channels.getByRole("button", { name: "Compare with another dataset" }));
    const picker = within(await screen.findByRole("dialog", { name: "Compare with" }));
    // Its folder: its folders, then its datasets, less the one already on the page.
    const where = within(await picker.findByRole("navigation", { name: "Compare with: where" }));
    expect(where.getByText(campaign.name)).toBeTruthy();
    const list = () => picker.getByRole("list");
    await waitFor(() => expect(names(list())).toEqual([day.name, sibling.name]));
    expect(picker.getByRole("button", { name: `${day.name}: folder` }).textContent).toContain("1"); // what's in it

    // Into a folder, and back up to the top by the path.
    await user.click(picker.getByRole("button", { name: `${day.name}: folder` }));
    expect(names(list())).toEqual([deeper.name]);
    await user.click(where.getByRole("button", { name: "Datasets" }));
    expect(names(list())).toContain(campaign.name);
    expect(names(list())).toContain(top.name);

    // Found in any folder by a few words, saying where it is; Enter takes the first.
    await user.type(picker.getByLabelText("Find a dataset"), `log0003 ${team.folder}`);
    expect(names(list())).toEqual([deeper.name]);
    expect(within(list()).getByText(`in ${campaign.name} / ${day.name}`)).toBeTruthy();
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog", { name: "Compare with" })).toBeNull();
    expect(await channels.findByText(deeper.name)).toBeTruthy();
    await waitFor(() => expect(channels.getAllByRole("button", { name: /PT-TANK/ })).toHaveLength(2));

    // Opened again, it's back in the first dataset's folder, without what's compared already.
    await user.click(channels.getByRole("button", { name: "Compare with another dataset" }));
    const again = within(await screen.findByRole("dialog", { name: "Compare with" }));
    await waitFor(() => expect(names(again.getByRole("list"))).toEqual([day.name, sibling.name]));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Compare with" })).toBeNull();
});

test("a view is used with another dataset picked from the folders, starting in the view's first dataset's", async () => {
    const team = await Team.create();
    const campaign = await team.dataFolder(team.chief, "Campaign");
    const day = await team.dataFolder(team.chief, "Day 2", campaign.id);
    const first = await team.data(team.chief, "LOG0001", DATA, campaign.id);
    const sibling = await team.data(team.chief, "LOG0002", DATA, campaign.id);
    const view = await team.view(team.chief, `Tank ${team.folder}`, first.id, "PT-TANK");
    const user = userEvent.setup();
    renderApp(team.chief, `/yorg/views/${view.id}`);
    expect(await screen.findByRole("heading", { name: view.name })).toBeTruthy();
    await screen.findByRole("group", { name: "Plot 1: channels" }); // its first dataset, in

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Use with another dataset…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Use this view with another dataset" }));
    expect(dialog.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(true);
    await user.click(dialog.getByRole("button", { name: "Dataset: Choose a dataset" }));
    const picker = within(await screen.findByRole("dialog", { name: "Dataset" }));
    const where = within(await picker.findByRole("navigation", { name: "Dataset: where" }));
    expect(where.getByText(campaign.name)).toBeTruthy();
    // Its folders, then its datasets, the newest first.
    await waitFor(() => expect(names(picker.getByRole("list"))).toEqual([day.name, sibling.name, first.name]));

    // Escape closes the dropdown, not the dialog; a dataset picked is the one the view opens with.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Dataset" })).toBeNull();
    await user.click(dialog.getByRole("button", { name: "Dataset: Choose a dataset" }));
    const again = within(await screen.findByRole("dialog", { name: "Dataset" }));
    await user.click(await again.findByRole("button", { name: new RegExp(`^${sibling.name}`) }));
    expect(dialog.getByRole("button", { name: `Dataset: ${sibling.name}` })).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("heading", { name: sibling.name })).toBeTruthy();
    expect(window.location.pathname).toBe(`/yorg/datasets/${sibling.id}`);
});

test("a script's tests are attached from the folders, starting in the first one's, without those attached", async () => {
    const team = await Team.create();
    const campaign = await team.dataFolder(team.chief, "Campaign");
    const day = await team.dataFolder(team.chief, "Day 2", campaign.id);
    const first = await team.data(team.chief, "LOG0001", DATA, campaign.id);
    const sibling = await team.data(team.chief, "LOG0002", DATA, campaign.id);
    const user = userEvent.setup();
    renderApp(team.chief, "/yorg/scripts");
    const data = within(await screen.findByRole("complementary", { name: "Data" }));
    expect(data.getByText("No test attached yet.")).toBeTruthy();

    // With none attached, it opens at the top.
    await user.click(data.getByRole("button", { name: "Attach a test" }));
    let picker = within(await screen.findByRole("dialog", { name: "Attach a test" }));
    const top = within(await picker.findByRole("navigation", { name: "Attach a test: where" }));
    expect(top.queryByRole("button")).toBeNull(); // nowhere to go up to
    expect(top.getByText("Datasets")).toBeTruthy();
    await user.click(await picker.findByRole("button", { name: `${campaign.name}: folder` }));
    await user.click(picker.getByRole("button", { name: new RegExp(`^${first.name}`) }));
    expect(await data.findByRole("region", { name: first.name })).toBeTruthy();

    // Then, in the first one's folder, without it.
    await user.click(data.getByRole("button", { name: "Attach a test" }));
    picker = within(await screen.findByRole("dialog", { name: "Attach a test" }));
    const where = within(await picker.findByRole("navigation", { name: "Attach a test: where" }));
    expect(where.getByText(campaign.name)).toBeTruthy();
    await waitFor(() => expect(names(picker.getByRole("list"))).toEqual([day.name, sibling.name]));
    await user.click(picker.getByRole("button", { name: new RegExp(`^${sibling.name}`) }));
    expect(await data.findByRole("region", { name: sibling.name })).toBeTruthy();
    expect(data.getByRole("region", { name: first.name }).textContent).toContain("first");
});

test("a split's tests go in a folder there is, chosen from the folders, starting where the file is", async () => {
    const team = await Team.create();
    const campaign = await team.dataFolder(team.chief, "Campaign");
    const day = await team.dataFolder(team.chief, "Day 2", campaign.id);
    const file = await team.data(team.chief, "LOG0001", DATA, campaign.id);
    const user = userEvent.setup();
    renderApp(team.chief, `/yorg/datasets/${file.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await channels.findByRole("button", { name: /PT-TANK/ });

    await user.click(screen.getByRole("button", { name: "Split" }));
    const split = within(await screen.findByRole("dialog", { name: `Split ${file.name} into tests` }));
    await user.type(split.getByLabelText("Cut at times (s)"), "1");
    // A new folder of their own, next to the file, unless a folder there is is chosen.
    expect((split.getByLabelText("The new folder's name") as HTMLInputElement).value).toBe(`${file.name} tests`);
    await user.click(split.getByRole("radio", { name: "A folder there is" }));
    expect(split.queryByLabelText("The new folder's name")).toBeNull();
    await user.click(await split.findByRole("button", { name: `Folder: ${campaign.name}` }));
    const chooser = within(await screen.findByRole("dialog", { name: "Folder" }));
    expect(within(chooser.getByRole("navigation", { name: "Folder: where" })).getByText(campaign.name)).toBeTruthy();
    expect(chooser.getByRole("button", { name: `${day.name}: folder` })).toBeTruthy();
    expect(within(chooser.getByRole("list")).getByText(file.name)).toBeTruthy(); // what's there already

    // Into Day 2, and a new folder made in it, which is chosen.
    await user.click(chooser.getByRole("button", { name: `${day.name}: folder` }));
    await user.click(chooser.getByRole("button", { name: "New folder" }));
    await user.type(chooser.getByLabelText("The new folder's name"), "Pieces");
    await user.click(chooser.getByRole("button", { name: "Make it" }));
    expect(await split.findByRole("button", { name: `Folder: ${campaign.name} / ${day.name} / Pieces` })).toBeTruthy();

    await user.click(split.getByRole("button", { name: "Make 2 datasets" }));
    const done = within(await screen.findByRole("dialog", { name: "Made 2 datasets" }));
    expect(done.getByText(new RegExp(`They're in ${campaign.name} / ${day.name} / Pieces`))).toBeTruthy();
    const pieces = (await team.datasets(team.chief)).filter((one) => one.name.startsWith(`${file.name} test`));
    expect(pieces).toHaveLength(2);
    const folder = pieces[0]!.folder_id;
    expect(folder).not.toBeNull();
    expect(pieces.every((one) => one.folder_id === folder)).toBe(true);
    await user.click(done.getByRole("button", { name: "Open the folder" }));
    expect(await screen.findByRole("heading", { name: "Pieces" })).toBeTruthy();
});
