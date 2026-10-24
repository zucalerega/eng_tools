import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { folderUrl } from "../src/vault/paths";
import { breadcrumbs, dialogClosed, renderApp, table, Team } from "./team";
import { makeZip } from "./zips";

// New folders, uploads, moving, and renaming, from the web app, against the real server.

/** Open a folder from the folder page's table (the folder tree beside it names it too). */
const openFolder = async (name: string) => userEvent.click(await (await table()).findByRole("link", { name }));

const file = (name: string, text: string, relative?: string) => {
    const made = new File([text], name);
    if (relative) {
        Object.defineProperty(made, "webkitRelativePath", { value: relative }); // as a picked folder gives them
    }
    return made;
};

test("a new folder, then files and a whole folder uploaded into it", async () => {
    const team = await Team.create();
    renderApp(team.chief, folderUrl(team.folder));

    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Folder…" }));
    await userEvent.type(within(screen.getByRole("dialog")).getByRole("textbox", { name: "Name" }), "Recovery");
    await userEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await openFolder("Recovery");

    fireEvent.change(await screen.findByLabelText("Upload files"), {
        target: {
            files: [
                file("Chute.SLDPRT", "chute"),
                file("Harness.SLDASM", "harness"),
                file("Chute.SLDDRW", "drawing"), // drawings come from SolidWorks
                file("~$Chute.SLDPRT", "lock file"), // never uploaded
            ],
        },
    });
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/1 file left out/)).toBeTruthy();
    expect(within(dialog).getByText(/can't read which parts an assembly uses/)).toBeTruthy();
    await userEvent.type(within(dialog).getByRole("textbox"), "the recovery bay");
    await userEvent.click(within(dialog).getByRole("button", { name: "Upload 2 files" }));
    const chute = (await screen.findByRole("link", { name: "Chute.SLDPRT" })).closest("tr")!;
    expect(within(chute).getByText("v1")).toBeTruthy();
    await dialogClosed();

    fireEvent.change(screen.getByLabelText("Upload a folder"), {
        target: { files: [file("Board.STEP", "board", "Avionics/Boards/Board.STEP")] },
    });
    dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Upload 1 file" }));
    await openFolder("Avionics");
    await openFolder("Boards");
    expect(await screen.findByRole("link", { name: "Board.STEP" })).toBeTruthy();
});

test("parts uploaded can be vendors', which keep their vendors' names", async () => {
    const team = await Team.create();
    renderApp(team.chief, folderUrl(team.folder));
    fireEvent.change(await screen.findByLabelText("Upload files"), {
        target: { files: [file("Bearing 6203.SLDPRT", "bearing"), file("Bearing 6203.PDF", "data sheet")] },
    });
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /vendors' \(McMaster, say\)/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Upload 2 files" }));
    await userEvent.click(await screen.findByRole("link", { name: "Bearing 6203.SLDPRT" }));
    expect(await screen.findByText("Vendor's part")).toBeTruthy();
});

test("a zip goes up as what's in it, or as it is", async () => {
    const team = await Team.create();
    const zip = makeZip([
        { name: "Recovery/", contents: "" },
        { name: "Recovery/Chute.SLDPRT", contents: "chute", deflate: true },
        { name: "Recovery/Harness/Strap.SLDPRT", contents: "strap" },
    ]);
    renderApp(team.chief, folderUrl(team.folder));

    fireEvent.change(await screen.findByLabelText("Upload files"), {
        target: { files: [new File([zip], "Recovery.zip")] },
    });
    let dialog = screen.getByRole("dialog");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Upload 2 files" }));
    await openFolder("Recovery");
    expect(await screen.findByRole("link", { name: "Chute.SLDPRT" })).toBeTruthy();
    await openFolder("Harness");
    expect(await screen.findByRole("link", { name: "Strap.SLDPRT" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Upload files"), { target: { files: [new File([zip], "Spare.zip")] } });
    dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Unzip Spare.zip/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Upload 1 file" }));
    expect(await screen.findByRole("link", { name: "Spare.zip" })).toBeTruthy();
});

test("files and folders move and get new names, but not away from what uses them", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, { "Inbox/Notes.txt": "notes", "Inbox/Bracket.SLDPRT": "bracket" });
    await team.checkin(
        team.chief,
        { "Rocket/Fins/Fin.SLDPRT": "fin", "Rocket/Fin Can.SLDASM": "can" },
        { refs: { "Rocket/Fin Can.SLDASM": ["Rocket/Fins/Fin.SLDPRT"] } },
    );
    renderApp(team.chief, folderUrl(`${team.folder}/Inbox`));

    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Notes.txt" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Bracket.SLDPRT" }));
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find a folder" }), "rocket");
    await userEvent.click(screen.getByRole("radio", { name: `${team.folder}/Rocket` }));
    await userEvent.click(screen.getByRole("button", { name: `Move to ${team.folder}/Rocket` }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Notes.txt" })).toBeNull());

    await userEvent.click((await breadcrumbs()).getByRole("link", { name: team.folder })); // up
    await openFolder("Rocket");
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Notes.txt" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename…" }));
    const name = screen.getByRole("textbox", { name: "New name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Notes.md");
    expect(screen.getByRole("alert").textContent).toContain("Keep the .txt ending");
    await userEvent.clear(name);
    await userEvent.type(name, "Rocket notes.txt");
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByRole("link", { name: "Rocket notes.txt" })).toBeTruthy();

    // The fin can't leave its assembly behind: the server says why.
    await openFolder("Fins");
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Fin.SLDPRT" }));
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    await userEvent.click(screen.getByRole("radio", { name: team.folder }));
    await userEvent.click(screen.getByRole("button", { name: `Move to ${team.folder}` }));
    expect((await screen.findByRole("alert")).textContent).toContain("wouldn't find it");
});

test("uploading a file checked out here checks it in, and the rest say why they're left out", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    await team.checkin(team.chief, {
        "Tank.SLDPRT": "tank v1",
        "Nozzle.SLDPRT": "nozzle v1",
        "Valve.SLDPRT": "valve v1",
    });
    await team.checkout(team.chief, "Tank.SLDPRT", "web");
    await team.checkout(bob, "Valve.SLDPRT", "BOB-PC");
    renderApp(team.chief, folderUrl(team.folder));

    fireEvent.change(await screen.findByLabelText("Upload files"), {
        target: {
            files: [
                file("Tank.SLDPRT", "tank v2"),
                file("Nozzle.SLDPRT", "nozzle v2"),
                file("Valve.SLDPRT", "valve v2"),
            ],
        },
    });
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/^1 file you have checked out here, as its next version/)).toBeTruthy();
    expect(dialog.getByText(/To change it, check it out/)).toBeTruthy();
    expect(dialog.getByText("Bob has it checked out on BOB-PC.")).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Upload 1 file" }));
    await waitFor(async () => {
        const tank = (await (await table()).findByRole("link", { name: "Tank.SLDPRT" })).closest("tr")!;
        expect(within(tank).getByText("v2")).toBeTruthy();
        expect(within(tank).getByText("Checked in")).toBeTruthy();
    });
});

test("picked files check out here, and those check-outs are undone", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, { "Tank.SLDPRT": "tank", "Nozzle.SLDPRT": "nozzle" });
    renderApp(team.chief, folderUrl(team.folder));

    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Tank.SLDPRT" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Nozzle.SLDPRT" }));
    await userEvent.click(screen.getByRole("button", { name: "Check out" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Check out" }));
    expect(await screen.findAllByText("Checked out by you in the web app")).toHaveLength(2);
    await dialogClosed(); // it unpicks them as it closes

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Tank.SLDPRT" }));
    await userEvent.click(screen.getByRole("button", { name: "Undo check-out" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Undo check-out" }));
    await waitFor(() => expect(screen.getAllByText("Checked out by you in the web app")).toHaveLength(1));
});
