import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { folderUrl } from "../src/paths";
import { renderApp, Team } from "./team";
import { makeZip } from "./zips";

// New folders, uploads, moving, and renaming, from the web app, against the real server.

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
    await userEvent.click(await screen.findByRole("link", { name: "Recovery" }));

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
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.change(screen.getByLabelText("Upload a folder"), {
        target: { files: [file("Board.STEP", "board", "Avionics/Boards/Board.STEP")] },
    });
    dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Upload 1 file" }));
    await userEvent.click(await screen.findByRole("link", { name: "Avionics" }));
    await userEvent.click(await screen.findByRole("link", { name: "Boards" }));
    expect(await screen.findByRole("link", { name: "Board.STEP" })).toBeTruthy();
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
    await userEvent.click(await screen.findByRole("link", { name: "Recovery" }));
    expect(await screen.findByRole("link", { name: "Chute.SLDPRT" })).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "Harness" }));
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

    await userEvent.click(screen.getByRole("link", { name: team.folder })); // up, in the breadcrumbs
    await userEvent.click(await screen.findByRole("link", { name: "Rocket" }));
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
    await userEvent.click(screen.getByRole("link", { name: "Fins" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Fin.SLDPRT" }));
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    await userEvent.click(screen.getByRole("radio", { name: team.folder }));
    await userEvent.click(screen.getByRole("button", { name: `Move to ${team.folder}` }));
    expect((await screen.findByRole("alert")).textContent).toContain("wouldn't find it");
});
