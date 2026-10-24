import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { dataTransfer, drag } from "./drag";
import { renderApp, Team } from "./team";

// Saved views and scripts in folders of their own: a folder picked from those there are (or a new one typed) as
// they're saved, and dragged onto a folder, or out of one, on their lists.

const DATA = ["Time (s),PT-TANK (psig)", "0,300", "1,301", "2,299"].join("\n");

test("a view's folder is picked from those there are as it's saved", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    const folder = `Hotfires ${team.folder}`;
    await team.view(team.chief, `Tank ${team.folder}`, data.id, "PT-TANK", folder);
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    await userEvent.click(await screen.findByRole("button", { name: "Save view" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Save this view" }));
    await userEvent.type(dialog.getByLabelText("Name"), `Manifold ${team.folder}`);

    // Typed, the list keeps to the folders that have it; a path there isn't is a new folder.
    const box = dialog.getByRole("combobox", { name: "Folder" });
    await userEvent.type(box, "Nowhere/New");
    expect(screen.getByText("A new folder: Nowhere/New")).toBeTruthy();
    await userEvent.clear(box);
    await userEvent.type(box, folder.slice(0, 6).toLowerCase());
    await userEvent.click(screen.getByRole("option", { name: folder }));
    expect((box as HTMLInputElement).value).toBe(folder);
    expect(screen.queryByRole("listbox", { name: "Folders" })).toBeNull();

    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(new RegExp(`saved view in ${folder}`))).toBeTruthy();
});

test("views drag onto a folder, and out of it to the top", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    const folder = `Hotfires ${team.folder}`;
    const loose = `Loose ${team.folder}`;
    await team.view(team.chief, `Tank ${team.folder}`, data.id, "PT-TANK", folder);
    await team.view(team.chief, loose, data.id, "PT-TANK");
    renderApp(team.chief, "/yorg/views");
    const table = within(await screen.findByRole("table", { name: "Saved views" }));
    const folderRow = () =>
        table
            .getAllByRole("button")
            .find((one) => one.textContent?.includes(folder))!
            .closest("tr")!;
    const count = () => folderRow().querySelector(".muted")?.textContent;
    const row = () => table.getByRole("link", { name: loose }).closest("tr")!;
    await waitFor(() => expect(count()).toBe("1"));

    drag(row(), folderRow);
    await waitFor(() => expect(count()).toBe("2"));

    // While one's dragged, the top takes it out of its folder.
    const transfer = dataTransfer();
    fireEvent.dragStart(row(), { dataTransfer: transfer });
    const top = await screen.findByText("Drop here to take it out of its folder");
    fireEvent.dragOver(top, { dataTransfer: transfer });
    fireEvent.drop(top, { dataTransfer: transfer });
    await waitFor(() => expect(count()).toBe("1"));
    expect(screen.queryByText("Drop here to take it out of its folder")).toBeNull();
});

test("someone else's view doesn't drag: only its owner (or an admin) moves it", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    const view = await team.view(team.chief, `Chief's ${team.folder}`, data.id, "PT-TANK");
    renderApp(await team.member("Bob"), "/yorg/views");
    const table = within(await screen.findByRole("table", { name: "Saved views" }));
    const row = (await table.findByRole("link", { name: view.name })).closest("tr")!;
    expect(row.getAttribute("draggable")).toBe("false");
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
