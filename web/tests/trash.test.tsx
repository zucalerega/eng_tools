import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fileUrl, folderUrl } from "../src/vault/paths";
import { renderApp, table, Team } from "./team";

// Deleting files and folders from the web app, and bringing them back from the trash.

test("files and folders go to the trash, and come back from it", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, {
        "Motor/Grain.SLDPRT": "grain",
        "Motor/Case.SLDPRT": "case",
        "Notes.txt": "notes",
    });
    renderApp(team.chief, folderUrl(team.folder));

    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Motor" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/The 2 files in the folder go too/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Motor" })).toBeNull());

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Notes.txt" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Notes.txt" })).toBeNull());

    await userEvent.click(screen.getByRole("link", { name: "Trash" }));
    await userEvent.click(await screen.findByRole("button", { name: "Restore Motor" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restore Motor" })).toBeNull());
    expect(screen.getByRole("link", { name: "Notes.txt" })).toBeTruthy(); // still in the trash
    await userEvent.click(screen.getByRole("link", { name: "Back to the folder" }));
    await userEvent.click(await (await table()).findByRole("link", { name: "Motor" }));
    expect(await screen.findByRole("link", { name: "Grain.SLDPRT" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Case.SLDPRT" })).toBeTruthy();
});

test("deleting a part an assembly uses takes a second yes", async () => {
    const team = await Team.create();
    await team.checkin(
        team.chief,
        { "Fin.SLDPRT": "fin", "Fin Can.SLDASM": "can" },
        { refs: { "Fin Can.SLDASM": ["Fin.SLDPRT"] } },
    );
    renderApp(team.chief, folderUrl(team.folder));

    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Fin.SLDPRT" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Fin.SLDPRT is used by .*Fin Can.SLDASM/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete anyway" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Fin.SLDPRT" })).toBeNull());
});

test("a file's page deletes it, and brings it back", async () => {
    const team = await Team.create();
    const [valve] = await team.checkin(team.chief, { "Valve.SLDPRT": "valve" });
    renderApp(team.chief, fileUrl(valve!.id));

    await userEvent.click(await screen.findByRole("button", { name: "Delete…" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/This file was deleted from the vault/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.queryByText(/This file was deleted/)).toBeNull());
    expect((await team.file(valve!.id)).deleted_at).toBeNull();
});
