import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { folderUrl } from "../src/vault/paths";
import { breadcrumbs, folderTree, renderApp, table, Team } from "./team";

test("browsing shows folders, files, and whether each is checked in", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin", "Nosecone.SLDASM": "nosecone" }, { comment: "first" });
    await team.checkout(alice, "Fins/Fin.SLDPRT", "ALICE-PC");

    renderApp(team.chief, folderUrl(team.folder));
    const nosecone = (await screen.findByRole("link", { name: "Nosecone.SLDASM" })).closest("tr")!;
    expect(within(nosecone).getByText("Checked in")).toBeTruthy();
    const fins = (await table()).getByRole("link", { name: "Fins" });
    expect(within(fins.closest("tr")!).getByText("1 checked out")).toBeTruthy();
    await userEvent.click(fins);

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

    renderApp(team.chief, "/vault/assemblies");
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
    expect([link.protocol, link.host]).toEqual(["vault:", "new"]);
    expect(link.searchParams.get("path")).toBe(`${team.folder}/Fins/Fin Bracket.SLDPRT`);
});

test("search finds files anywhere in the vault", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, { "Recovery/Drogue/Chute.SLDPRT": "chute", "Recovery/Harness.SLDPRT": "harness" });

    renderApp(team.chief, "/vault");
    await userEvent.type(await screen.findByRole("searchbox", { name: "Search files" }), "drogue/chu");
    expect(await screen.findByRole("link", { name: `${team.folder}/Recovery/Drogue/Chute.SLDPRT` })).toBeTruthy();
    expect(screen.queryByText(/Harness/)).toBeNull();
});

test("a file given a number shows its title with it, and search finds it by its title or the name it had", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, { "Fins/Fin Bracket.SLDPRT": "bracket", "Fins/Rail.SLDPRT": "rail" });
    const number = await team.partNumber(team.chief);
    await team.rename(team.chief, "Fins/Fin Bracket.SLDPRT", `${number}.SLDPRT`);

    renderApp(team.chief, folderUrl(team.path("Fins")));
    const bracket = (await screen.findByRole("link", { name: `${number}.SLDPRT` })).closest("tr")!;
    expect(within(bracket).getByText("Fin Bracket")).toBeTruthy();
    // A title that says no more than the name isn't said twice.
    const rail = screen.getByRole("link", { name: "Rail.SLDPRT" }).closest("tr")!;
    expect(within(rail).queryByText("Rail")).toBeNull();

    const search = screen.getByRole("searchbox", { name: "Search files" });
    const numbered = `${team.folder}/Fins/${number}.SLDPRT`;
    await userEvent.type(search, "bracket");
    expect(await screen.findByRole("link", { name: numbered })).toBeTruthy();
    expect(screen.queryByRole("link", { name: `${team.folder}/Fins/Rail.SLDPRT` })).toBeNull();
    await userEvent.clear(search);
    await userEvent.type(search, "fin bracket.sldprt"); // its name before it was numbered
    expect(await screen.findByRole("link", { name: numbered })).toBeTruthy();
});

test("the folder tree beside the files opens the way to where you are", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, {
        "Fins/Fin.SLDPRT": "fin",
        "Fins/Tabs/Tab.SLDPRT": "tab",
        "Motor/Grain.SLDPRT": "grain",
    });

    renderApp(team.chief, folderUrl(`${team.folder}/Fins/Tabs`));
    let tree = await folderTree();
    expect(tree.getByRole("link", { name: "Tabs" }).getAttribute("aria-current")).toBe("page");
    expect(tree.getByRole("link", { name: "Motor" })).toBeTruthy(); // the way down opened, and what's next to it

    await userEvent.click(tree.getByRole("link", { name: "Fins" }));
    expect(await (await table()).findByRole("link", { name: "Fin.SLDPRT" })).toBeTruthy();
    tree = await folderTree();
    await userEvent.click(tree.getByRole("button", { name: "Hide the folders in Fins" }));
    expect(tree.queryByRole("link", { name: "Tabs" })).toBeNull();
    await userEvent.click(tree.getByRole("button", { name: "Show the folders in Fins" }));
    expect(tree.getByRole("link", { name: "Tabs" })).toBeTruthy();
    // The page's title is the folder's name, with the way there above it.
    expect(await screen.findByRole("heading", { level: 1, name: "Fins" })).toBeTruthy();
    expect((await breadcrumbs()).getByRole("link", { name: team.folder })).toBeTruthy();
});

test("files say who created them, who changed them last and when, and who has them", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    const bob = await team.member("Bob");
    await team.checkin(alice, { "Valve.SLDPRT": "valve v1" });
    await team.checkout(bob, "Valve.SLDPRT", "BOB-PC");
    await team.checkin(bob, { "Valve.SLDPRT": "valve v2" }, { host: "BOB-PC" });
    await team.checkout(alice, "Valve.SLDPRT", "ALICE-PC");

    renderApp(team.chief, folderUrl(team.folder));
    const row = (await screen.findByRole("link", { name: "Valve.SLDPRT" })).closest("tr")!;
    const [, , , status, created, changed] = [...row.querySelectorAll("td")].map((cell) => cell.textContent);
    expect(status).toBe("Checked out by Alice on ALICE-PC");
    expect(created).toMatch(/ by Alice$/);
    expect(changed).toMatch(/ by Bob$/);
});

test("filters narrow the files down, from every folder in this one, and columns sort them", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin", "Rocket.SLDASM": "a rocket, the biggest file" });
    await team.checkin(alice, { "Motor/Grain.SLDPRT": "grain", "Motor/Motor.SLDASM": "motor" });
    await team.checkout(team.chief, "Fins/Fin.SLDPRT", "CHIEF-PC");

    renderApp(team.chief, folderUrl(team.folder));
    // The files listed, by their paths (not the rows' Open in SolidWorks and Download links).
    const listed = (found: Awaited<ReturnType<typeof table>>) =>
        found
            .getAllByRole("link")
            .map((link) => link.textContent)
            .filter((text) => text?.startsWith(team.folder));
    const bar = within(await screen.findByRole("search", { name: "Find files" }));
    await userEvent.selectOptions(bar.getByRole("combobox", { name: "Status" }), "Checked out to you");
    expect(await (await table()).findByRole("link", { name: `${team.folder}/Fins/Fin.SLDPRT` })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(`1 file in ${team.folder} and the folders in it.`);

    await userEvent.selectOptions(bar.getByRole("combobox", { name: "Status" }), "Any status");
    await userEvent.selectOptions(bar.getByRole("combobox", { name: "Kind" }), "Assemblies");
    await userEvent.selectOptions(bar.getByRole("combobox", { name: "Changed by" }), "Changed by Alice");
    expect(listed(await table())).toEqual([`${team.folder}/Motor/Motor.SLDASM`]);

    await userEvent.selectOptions(bar.getByRole("combobox", { name: "Last changed" }), "Unchanged for a year");
    expect(await screen.findByText(`Nothing matches in ${team.folder} and the folders in it.`)).toBeTruthy();
    await userEvent.click(bar.getByRole("button", { name: "Clear" }));
    await userEvent.type(bar.getByRole("searchbox", { name: "Search files" }), "*.sldasm");
    const sized = await table();
    await userEvent.click(sized.getByRole("button", { name: "Size" })); // largest first
    expect(listed(sized)).toEqual([`${team.folder}/Rocket.SLDASM`, `${team.folder}/Motor/Motor.SLDASM`]);
    await userEvent.click(sized.getByRole("button", { name: "Size" })); // and turned around
    expect(listed(sized)).toEqual([`${team.folder}/Motor/Motor.SLDASM`, `${team.folder}/Rocket.SLDASM`]);
});

test("a folder that isn't there says so", async () => {
    const team = await Team.create();
    renderApp(team.chief, folderUrl(`${team.folder}/Nowhere`));
    expect(await screen.findByText(/There's no folder/)).toBeTruthy();
});
