import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { dataTransfer, drag } from "./drag";
import { renderApp, Team } from "./team";

// Saved views and scripts in folders of their own: a folder picked as they're saved, browsed as the pages browse them
// (the site's FolderBrowser), or made where it's open. Views' folders are pages, as the datasets' are: made, renamed, moved, and deleted once they're empty,
// with views moved into them by dragging or by choosing them, and deleted together. Scripts drag onto a folder, or out
// of one, on their list.

const DATA = ["Time (s),PT-TANK (psig)", "0,300", "1,301", "2,299"].join("\n");

/** What a views' folder's row says it has: "2 views". */
const counted = (row: HTMLElement) => within(row).getByText(/^\d+ views?$/).textContent;

const EMPTY = "This folder is empty: drag views onto it, or pick it when you save a view.";

test("a view's folder is picked as the Views page browses them, or made where it's open, as it's saved", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    const hotfires = await team.viewFolder(team.chief, "Hotfires");
    const inner = await team.viewFolder(team.chief, "HF-3", hotfires.id);
    const tank = `Tank ${team.folder}`;
    await team.view(team.chief, tank, data.id, "PT-TANK", hotfires.name);
    const user = userEvent.setup();
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    await user.click(await screen.findByRole("button", { name: "Save view" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Save this view" }));
    await user.type(dialog.getByLabelText("Name"), `Manifold ${team.folder}`);

    // At the top to start with; into a folder, which lists its folders, and the views in it to see where things are.
    await user.click(await dialog.findByRole("button", { name: "Folder: Views" }));
    const chooser = within(await screen.findByRole("dialog", { name: "Folder" }));
    await user.click(chooser.getByRole("button", { name: `${hotfires.name}: folder` }));
    expect(chooser.getByRole("button", { name: `${inner.name}: folder` })).toBeTruthy();
    expect(chooser.getByText(tank)).toBeTruthy();
    expect(chooser.queryByRole("button", { name: tank })).toBeNull(); // only folders are picked

    // A new folder, made where it's open, and chosen.
    await user.click(chooser.getByRole("button", { name: "New folder" }));
    await user.type(chooser.getByLabelText("The new folder's name"), "Day 2{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Folder" })).toBeNull());
    expect(dialog.getByRole("button", { name: `Folder: ${hotfires.name} / Day 2` })).toBeTruthy();
    expect((await team.viewFolders(team.chief)).some((one) => one.path === `${hotfires.name}/Day 2`)).toBe(true);

    // Or one there is, found by a few words, and chosen.
    await user.click(dialog.getByRole("button", { name: `Folder: ${hotfires.name} / Day 2` }));
    const again = within(await screen.findByRole("dialog", { name: "Folder" }));
    await user.type(again.getByLabelText("Find a folder"), `hf-3 ${team.folder}`);
    await user.click(again.getByRole("button", { name: `${hotfires.name} / ${inner.name}: folder` }));
    await user.click(again.getByRole("button", { name: `Choose ${inner.name}` }));
    expect(dialog.getByRole("button", { name: `Folder: ${hotfires.name} / ${inner.name}` })).toBeTruthy();

    await user.click(dialog.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(new RegExp(`saved view in ${hotfires.name}/${inner.name}`))).toBeTruthy();
});

test("views' folders: made, moved into by choosing or dragging, opened, and kept while they hold something", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    const first = await team.view(team.chief, `Tank ${team.folder}`, data.id, "PT-TANK");
    const second = await team.view(team.chief, `Manifold ${team.folder}`, data.id, "PT-TANK");
    renderApp(team.chief, "/yorg/views");
    const table = within(await screen.findByRole("table", { name: "Saved views" }));
    const row = (name: string) => table.getByRole("link", { name }).closest("tr")!;
    await table.findByRole("link", { name: first.name });

    const folder = team.named("Hotfires");
    await userEvent.click(screen.getByRole("button", { name: "New folder" }));
    const made = within(await screen.findByRole("dialog", { name: "New folder" }));
    await userEvent.type(made.getByLabelText("Name"), folder);
    await userEvent.click(made.getByRole("button", { name: "Make it" }));
    const folderRow = async () => (await table.findByRole("link", { name: folder })).closest("tr")!;
    expect(counted(await folderRow())).toBe("0 views");

    // One chosen and moved there; another dragged onto it.
    await userEvent.click(within(row(first.name)).getByRole("checkbox", { name: `Choose ${first.name}` }));
    expect(screen.getByText("1 view chosen")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    const move = within(await screen.findByRole("dialog", { name: "Move a view" }));
    await userEvent.click(move.getByRole("radio", { name: folder }));
    await userEvent.click(move.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(table.queryByRole("link", { name: first.name })).toBeNull());
    drag(row(second.name), () => table.getByRole("link", { name: folder }).closest("tr")!);
    await waitFor(() => expect(table.queryByRole("link", { name: second.name })).toBeNull());
    await waitFor(async () => expect(counted(await folderRow())).toBe("2 views"));
    expect((await team.views(team.chief)).find((one) => one.id === second.id)?.folder).toBe(folder);

    // A folder with views in it isn't deleted: the server says why.
    await userEvent.click(within(await folderRow()).getByRole("button", { name: `Delete ${folder}` }));
    await userEvent.click(
        within(await screen.findByRole("dialog", { name: `Delete ${folder}?` })).getByRole("button", {
            name: "Delete",
        }),
    );
    expect(await screen.findByText(`${folder} isn't empty: move what's in it out first`)).toBeTruthy();

    // In it: its views, the most recently changed first, and the way back up.
    await userEvent.click(within(await folderRow()).getByRole("link", { name: folder }));
    expect(await screen.findByRole("heading", { name: folder })).toBeTruthy();
    expect(window.location.pathname).toMatch(/^\/yorg\/views\/folders\/\d+$/);
    const inside = within(await screen.findByRole("table", { name: "Saved views" }));
    await inside.findByRole("link", { name: first.name });
    expect(inside.getAllByRole("link").map((link) => link.textContent)).toEqual([second.name, first.name]);
    const crumbs = within(screen.getByRole("navigation", { name: "Folders" }));
    expect(crumbs.getByRole("link", { name: "Views" }).getAttribute("href")).toBe("/yorg/views");
});

test("a view drags out of a folder onto the way back up, and a folder drags into another, never itself", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    const hotfires = await team.viewFolder(team.chief, "Hotfires");
    const hf3 = await team.viewFolder(team.chief, "HF-3", hotfires.id);
    const spare = await team.viewFolder(team.chief, "Spare");
    const view = await team.view(team.chief, `Tank ${team.folder}`, data.id, "PT-TANK", hf3.id);
    renderApp(team.chief, `/yorg/views/folders/${hf3.id}`);
    const table = within(await screen.findByRole("table", { name: "Saved views" }));
    const row = (await table.findByRole("link", { name: view.name })).closest("tr")!;
    const crumbs = () => within(screen.getByRole("navigation", { name: "Folders" }));
    drag(row, () => crumbs().getByRole("link", { name: hotfires.name }));
    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect((await team.views(team.chief)).find((one) => one.id === view.id)?.folder_id).toBe(hotfires.id);

    // At the top, Spare dragged into Hotfires; Hotfires can't go into itself.
    await userEvent.click(crumbs().getByRole("link", { name: "Views" }));
    const top = within(await screen.findByRole("table", { name: "Saved views" }));
    const folderRow = async (name: string) => (await top.findByRole("link", { name })).closest("tr")!;
    drag(await folderRow(spare.name), () => top.getByRole("link", { name: hotfires.name }).closest("tr")!);
    await waitFor(() => expect(top.queryByRole("link", { name: spare.name })).toBeNull());
    drag(await folderRow(hotfires.name), () => top.getByRole("link", { name: hotfires.name }).closest("tr")!);
    expect(await screen.findByText("A folder can't go inside itself")).toBeTruthy();

    // In Hotfires: its folders, and its view, which is dragged onto the top.
    await userEvent.click(top.getByRole("link", { name: hotfires.name }));
    const inside = within(await screen.findByRole("table", { name: "Saved views" }));
    expect(await inside.findByRole("link", { name: spare.name })).toBeTruthy();
    expect(inside.getByRole("link", { name: hf3.name })).toBeTruthy();
    drag(inside.getByRole("link", { name: view.name }).closest("tr")!, () =>
        crumbs().getByRole("link", { name: "Views" }),
    );
    await waitFor(() => expect(inside.queryByRole("link", { name: view.name })).toBeNull());
    expect((await team.views(team.chief)).find((one) => one.id === view.id)?.folder).toBe("");
});

test("a views' folder renamed keeps its views; an empty one is deleted; only whoever made it, or an admin, changes it", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    const bob = await team.member("Bob");
    const kept = await team.viewFolder(bob, "Stand");
    const empty = await team.viewFolder(bob, "Spare");
    const theirs = await team.viewFolder(team.chief, "Chief's");
    const view = await team.view(bob, `Tank ${team.folder}`, data.id, "PT-TANK", kept.id);
    renderApp(bob, "/yorg/views");
    const table = within(await screen.findByRole("table", { name: "Saved views" }));
    const rowOf = async (name: string) => (await table.findByRole("link", { name })).closest("tr")!;

    // Someone else's folder can't be renamed, deleted, or dragged.
    const chiefs = await rowOf(theirs.name);
    expect(within(chiefs).queryByRole("button", { name: `Rename ${theirs.name}` })).toBeNull();
    expect(within(chiefs).queryByRole("button", { name: `Delete ${theirs.name}` })).toBeNull();
    expect(chiefs.getAttribute("draggable")).toBe("false");

    await userEvent.click(within(await rowOf(kept.name)).getByRole("button", { name: `Rename ${kept.name}` }));
    const rename = within(await screen.findByRole("dialog", { name: `Rename ${kept.name}` }));
    await userEvent.clear(rename.getByLabelText("Name"));
    await userEvent.type(rename.getByLabelText("Name"), team.named("Hotfire stand"));
    await userEvent.click(rename.getByRole("button", { name: "Rename" }));
    expect(counted(await rowOf(team.named("Hotfire stand")))).toBe("1 view");
    expect((await team.views(bob)).find((one) => one.id === view.id)?.folder).toBe(team.named("Hotfire stand"));

    await userEvent.click(within(await rowOf(empty.name)).getByRole("button", { name: `Delete ${empty.name}` }));
    await userEvent.click(
        within(await screen.findByRole("dialog", { name: `Delete ${empty.name}?` })).getByRole("button", {
            name: "Delete",
        }),
    );
    await waitFor(() => expect(table.queryByRole("link", { name: empty.name })).toBeNull());
});

test("someone else's view can't be chosen or dragged: only whoever saved it (or an admin) moves it", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    const view = await team.view(team.chief, `Chief's ${team.folder}`, data.id, "PT-TANK");
    renderApp(await team.member("Bob"), "/yorg/views");
    const table = within(await screen.findByRole("table", { name: "Saved views" }));
    const row = (await table.findByRole("link", { name: view.name })).closest("tr")!;
    expect(row.getAttribute("draggable")).toBe("false");
    expect(within(row).queryByRole("checkbox")).toBeNull();
});

test("chosen views are deleted together, for good", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    const folder = await team.viewFolder(team.chief, "Old");
    const first = await team.view(team.chief, `Tank ${team.folder}`, data.id, "PT-TANK", folder.id);
    const second = await team.view(team.chief, `Manifold ${team.folder}`, data.id, "PT-TANK", folder.id);
    renderApp(team.chief, `/yorg/views/folders/${folder.id}`);
    const table = within(await screen.findByRole("table", { name: "Saved views" }));
    await table.findByRole("link", { name: first.name });
    await userEvent.click(table.getByRole("checkbox", { name: "Choose every view here" }));
    expect(screen.getByText("2 views chosen")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete 2 views?" }));
    const listed = within(dialog.getByRole("list", { name: "Views to delete" }));
    expect(listed.getAllByRole("listitem").map((item) => item.textContent)).toEqual(
        expect.arrayContaining([first.name, second.name]),
    );
    await userEvent.click(dialog.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(screen.queryByText(/views? chosen/)).toBeNull();
    const left = (await team.views(team.chief)).map((one) => one.id);
    expect(left).not.toContain(first.id);
    expect(left).not.toContain(second.id);
});

test("a script's folder is picked from those there are, and scripts drag into folders and out", async () => {
    const team = await Team.create();
    const folder = `Injector ${team.folder}`;
    const loose = `Peak ${team.folder}`;
    await team.addScript(team.chief, `CdA ${team.folder}`, folder);
    await team.addScript(team.chief, loose);
    renderApp(team.chief, "/yorg/scripts");
    const side = within(await screen.findByRole("complementary", { name: "Scripts" }));
    const folderButton = () => side.getAllByRole("button").find((one) => one.textContent?.includes(folder))!;
    const inFolder = () => within(folderButton().closest("li")!).queryByRole("button", { name: loose });
    const item = () => side.getByRole("button", { name: loose }).closest("li")!;
    await side.findByRole("button", { name: loose });
    expect(inFolder()).toBeNull();

    drag(item(), folderButton);
    await waitFor(() => expect(inFolder()).toBeTruthy());

    const transfer = dataTransfer();
    fireEvent.dragStart(item(), { dataTransfer: transfer });
    const top = await side.findByText("Drop here: no folder");
    fireEvent.dragOver(top, { dataTransfer: transfer });
    fireEvent.drop(top, { dataTransfer: transfer });
    await waitFor(() => expect(inFolder()).toBeNull());

    // Open, its folder's picked from the list above it, to save it there.
    await userEvent.click(side.getByRole("button", { name: loose }));
    const box = (await screen.findByRole("combobox", { name: "Folder" })) as HTMLInputElement;
    await waitFor(() => expect(box.value).toBe(""));
    await userEvent.click(box);
    await userEvent.click(
        within(screen.getByRole("listbox", { name: "Folders" })).getByRole("option", { name: folder }),
    );
    expect(box.value).toBe(folder);
    expect(screen.getByRole("img", { name: "Changes not saved" })).toBeTruthy();
});
