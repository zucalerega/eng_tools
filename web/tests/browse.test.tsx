import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { folderUrl } from "../src/paths";
import { renderApp, Team } from "./team";

test("browsing shows folders, files, and whether each is checked in", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin", "Nosecone.SLDASM": "nosecone" }, { comment: "first" });
    await team.checkout(alice, "Fins/Fin.SLDPRT", "ALICE-PC");

    renderApp(team.chief, folderUrl(team.folder));
    const nosecone = (await screen.findByRole("link", { name: "Nosecone.SLDASM" })).closest("tr")!;
    expect(within(nosecone).getByText("Checked in")).toBeTruthy();
    const fins = screen.getByRole("link", { name: "Fins" }).closest("tr")!;
    expect(within(fins).getByText("1 checked out")).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "Fins" }));

    const row = (await screen.findByRole("link", { name: "Fin.SLDPRT" })).closest("tr")!;
    expect(within(row).getByText("v1")).toBeTruthy();
    expect(within(row).getByText("Checked out by Alice on ALICE-PC")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Open in SolidWorks" }).getAttribute("href")).toContain(
        encodeURIComponent(`${team.folder}/Fins/Fin.SLDPRT`),
    );
    expect(screen.getByRole("navigation", { name: "Folders" }).textContent).toContain(team.folder);
});

test("assemblies open up to show their sub-assemblies and parts, checked in or not", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin", "Motor/Grain.SLDPRT": "grain" });
    await team.checkin(
        team.chief,
        { "Rocket.SLDASM": "rocket", "Fins/Fin Can.SLDASM": "can", "Fins/Fin.SLDDRW": "drawing" },
        {
            refs: {
                "Rocket.SLDASM": ["Fins/Fin Can.SLDASM", "Motor/Grain.SLDPRT"],
                "Fins/Fin Can.SLDASM": ["Fins/Fin.SLDPRT"],
                "Fins/Fin.SLDDRW": ["Fins/Fin.SLDPRT"],
            },
        },
    );
    await team.checkout(alice, "Motor/Grain.SLDPRT", "ALICE-PC");

    renderApp(team.chief, folderUrl(team.folder));
    await userEvent.click(await screen.findByRole("button", { name: "Show what Rocket.SLDASM uses" }));
    const grain = screen.getByRole("link", { name: "Grain.SLDPRT" }).closest("tr")!;
    expect(within(grain).getByText("Checked out by Alice on ALICE-PC")).toBeTruthy();
    expect(within(grain).getByText(`in ${team.folder}/Motor`)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Show what Fin Can.SLDASM uses" }));
    const fin = screen.getByRole("link", { name: "Fin.SLDPRT" }).closest("tr")!;
    expect(within(fin).getByText("Checked in")).toBeTruthy();
    expect(within(fin).getByRole("link", { name: "Drawing" }).getAttribute("title")).toBe(
        `${team.folder}/Fins/Fin.SLDDRW`,
    );

    await userEvent.click(screen.getByRole("button", { name: "Hide what Rocket.SLDASM uses" }));
    expect(screen.queryByRole("link", { name: "Grain.SLDPRT" })).toBeNull();
});

test("the assemblies page starts from the top-level assemblies", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin" });
    await team.checkin(
        team.chief,
        { "Rocket.SLDASM": "rocket", "Fins/Fin Can.SLDASM": "can" },
        { refs: { "Rocket.SLDASM": ["Fins/Fin Can.SLDASM"], "Fins/Fin Can.SLDASM": ["Fins/Fin.SLDPRT"] } },
    );

    renderApp(team.chief, "/assemblies");
    expect(await screen.findByRole("link", { name: `${team.folder}/Rocket.SLDASM` })).toBeTruthy();
    expect(screen.queryByRole("link", { name: `${team.folder}/Fins/Fin Can.SLDASM` })).toBeNull(); // Rocket uses it
    await userEvent.click(screen.getByRole("button", { name: `Show what ${team.folder}/Rocket.SLDASM uses` }));
    expect(screen.getByRole("link", { name: "Fin Can.SLDASM" })).toBeTruthy();
});

test("a new part is named here, then started in SolidWorks", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin" });

    renderApp(team.chief, folderUrl(`${team.folder}/Fins`));
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Part…" }));
    const dialog = screen.getByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await userEvent.type(name, "Fin");
    expect(within(dialog).getByRole("alert").textContent).toContain("already in the vault");
    await userEvent.clear(name);
    await userEvent.type(name, "Fin: Bracket");
    expect(within(dialog).getByRole("alert").textContent).toContain("can't contain");
    expect(within(dialog).getByRole("button", { name: "Start it in SolidWorks" })).toHaveProperty("disabled", true);

    await userEvent.clear(name);
    await userEvent.type(name, "Fin Bracket");
    const start = within(dialog).getByRole("link", { name: "Start it in SolidWorks" });
    const link = new URL(start.getAttribute("href")!);
    expect([link.protocol, link.host]).toEqual(["cvc:", "new"]);
    expect(link.searchParams.get("path")).toBe(`${team.folder}/Fins/Fin Bracket.SLDPRT`);
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
