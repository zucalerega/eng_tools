import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { folderUrl } from "../src/paths";
import { renderApp, Team } from "./team";

test("browsing shows folders, files, and who has them checked out", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin", "Nosecone.SLDASM": "nosecone" }, { comment: "first" });
    await team.checkout(alice, "Fins/Fin.SLDPRT", "ALICE-PC");

    renderApp(team.chief, folderUrl(team.folder));
    expect(await screen.findByRole("link", { name: "Nosecone.SLDASM" })).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "Fins" }));

    const row = (await screen.findByRole("link", { name: "Fin.SLDPRT" })).closest("tr")!;
    expect(within(row).getByText("v1")).toBeTruthy();
    expect(within(row).getByText("Alice on ALICE-PC")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Open in SolidWorks" }).getAttribute("href")).toContain(
        encodeURIComponent(`${team.folder}/Fins/Fin.SLDPRT`),
    );
    expect(screen.getByRole("navigation", { name: "Folders" }).textContent).toContain(team.folder);
});

test("search finds files anywhere in the vault", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, { "Recovery/Drogue/Chute.SLDPRT": "chute", "Recovery/Harness.SLDPRT": "harness" });

    renderApp(team.chief, "/");
    await userEvent.type(await screen.findByRole("searchbox", { name: "Search all files" }), "drogue/chu");
    expect(await screen.findByRole("link", { name: `${team.folder}/Recovery/Drogue/Chute.SLDPRT` })).toBeTruthy();
    expect(screen.queryByText(/Harness/)).toBeNull();
});

test("a folder that isn't there says so", async () => {
    const team = await Team.create();
    renderApp(team.chief, folderUrl(`${team.folder}/Nowhere`));
    expect(await screen.findByText(/There's no folder/)).toBeTruthy();
});
