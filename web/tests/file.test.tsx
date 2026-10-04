import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fileUrl } from "../src/vault/paths";
import { renderApp, Team } from "./team";

test("a file's page shows its history and what it uses, and follows check-outs live", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    await team.checkin(team.chief, { "Motor/Grain.SLDPRT": "grain v1" }, { comment: "first grain" });
    const [can] = await team.checkin(
        team.chief,
        { "Motor/Case.SLDASM": "case" },
        { comment: "case with its grain", refs: { "Motor/Case.SLDASM": ["Motor/Grain.SLDPRT"] } },
    );
    await team.checkout(team.chief, "Motor/Grain.SLDPRT", "CHIEF-PC");
    await team.checkin(team.chief, { "Motor/Grain.SLDPRT": "grain v2" }, { comment: "longer grain", host: "CHIEF-PC" });

    renderApp(team.chief, fileUrl(can!.id));
    expect(await screen.findByText("case with its grain")).toBeTruthy();
    const contains = screen.getByRole("heading", { name: "Contains" }).parentElement!;
    const grain = within(contains).getByRole("link", { name: "Grain.SLDPRT" }).closest("li")!;
    expect(grain.textContent).toContain("v1 (now v2)");
    expect(within(grain).getByText("Checked in")).toBeTruthy();

    // Someone checks it out on their PC: the page shows it without a reload.
    await team.checkout(alice, "Motor/Case.SLDASM", "ALICE-PC");
    expect(await screen.findByText(/Checked out by Alice on ALICE-PC/)).toBeTruthy();
});

test("a part's page shows where it's used, up to the top-level assembly, and its drawings", async () => {
    const team = await Team.create();
    const [fin] = await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin" });
    await team.checkin(
        team.chief,
        { "Fins/Fin Can.SLDASM": "can", "Rocket.SLDASM": "rocket", "Fins/Fin.SLDDRW": "drawing" },
        {
            refs: {
                "Fins/Fin Can.SLDASM": ["Fins/Fin.SLDPRT"],
                "Rocket.SLDASM": ["Fins/Fin Can.SLDASM"],
                "Fins/Fin.SLDDRW": ["Fins/Fin.SLDPRT"],
            },
        },
    );

    renderApp(team.chief, fileUrl(fin!.id));
    const usedIn = (await screen.findByRole("heading", { name: "Used in" })).parentElement!;
    expect(within(usedIn).getByRole("link", { name: "Fin Can.SLDASM" })).toBeTruthy();
    expect(within(usedIn).getByRole("link", { name: "Rocket.SLDASM" })).toBeTruthy(); // open up to the top
    const drawings = screen.getByRole("region", { name: "Drawings" });
    expect(within(drawings).getByRole("link", { name: "Fin.SLDDRW" })).toBeTruthy();
    expect(within(drawings).getByRole("button", { name: "New drawing" })).toBeTruthy();
});

test("editors can revert a file nobody else has checked out", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const [valve] = await team.checkin(team.chief, { "Valve.SLDPRT": "valve v1" }, { comment: "first valve" });
    await team.checkout(team.chief, "Valve.SLDPRT", "CHIEF-PC");
    await team.checkin(team.chief, { "Valve.SLDPRT": "valve v2" }, { comment: "leaks", host: "CHIEF-PC" });

    renderApp(bob, fileUrl(valve!.id));
    await userEvent.click(await screen.findByRole("button", { name: "Revert to v1" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox"), "v2 leaks");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revert to v1" }));

    expect(await screen.findByText("Reverted to v1: v2 leaks")).toBeTruthy();
    expect((await team.file(valve!.id)).version).toBe(3);
});

test("admin mode releases someone's check-out and forces a revert", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    const bob = await team.member("Bob");
    const [tank] = await team.checkin(team.chief, { "Tank.SLDPRT": "tank v1" });
    await team.checkout(team.chief, "Tank.SLDPRT", "CHIEF-PC");
    await team.checkin(team.chief, { "Tank.SLDPRT": "tank v2" }, { host: "CHIEF-PC" });
    await team.checkout(alice, "Tank.SLDPRT", "ALICE-PC");

    // An editor can't revert it while Alice has it, and gets no overrides.
    const asBob = renderApp(bob, fileUrl(tank!.id));
    expect(await screen.findByText(/Checked out by Alice on ALICE-PC/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revert to v1" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Account/ }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Admin mode/ })).toBeNull();
    asBob.unmount();

    renderApp(team.chief, fileUrl(tank!.id));
    expect(await screen.findByText(/Checked out by Alice on ALICE-PC/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Release check-out" })).toBeNull(); // only in admin mode
    await userEvent.click(screen.getByRole("button", { name: /^Account/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Admin mode/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Release check-out" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Release check-out" }));
    await waitFor(async () => expect((await team.file(tank!.id)).checked_out).toBeNull());
    await waitFor(() => expect(screen.queryByText(/Checked out by Alice/)).toBeNull());

    // Forcing a revert releases whoever has it.
    await team.checkout(alice, "Tank.SLDPRT", "ALICE-PC");
    await screen.findByText(/Checked out by Alice on ALICE-PC/);
    await userEvent.click(screen.getByRole("button", { name: "Revert to v1" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Reverting releases the check-out/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Revert to v1" }));
    expect(await screen.findByText("Reverted to v1")).toBeTruthy();
    const reverted = await team.file(tank!.id);
    expect([reverted.version, reverted.checked_out]).toEqual([3, null]);
});

test("a file checks out and in from the web app, and check-outs are undone", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    const [valve] = await team.checkin(team.chief, { "Valve.SLDPRT": "valve v1" }, { comment: "first valve" });

    renderApp(alice, fileUrl(valve!.id));
    await userEvent.click(await screen.findByRole("button", { name: "Check out" }));
    expect(await screen.findByText(/Checked out by you in the web app/)).toBeTruthy();
    expect((await team.file(valve!.id)).checked_out?.host).toBe("web");

    await userEvent.click(screen.getByRole("button", { name: "Check in…" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("The new version"), {
        target: { files: [new File(["valve v2"], "Valve.SLDPRT")] },
    });
    expect(await dialog.findByText(/It becomes v2 of Valve.SLDPRT/)).toBeTruthy();
    await userEvent.type(dialog.getByRole("textbox", { name: /What changed/ }), "thicker seat");
    await userEvent.click(dialog.getByRole("button", { name: "Check in" }));
    expect(await screen.findByText("thicker seat")).toBeTruthy();
    const checkedIn = await team.file(valve!.id);
    expect([checkedIn.version, checkedIn.checked_out]).toEqual([2, null]);

    // Undoing a check-out here asks nothing; undoing one on a computer says the changes there stay there.
    await userEvent.click(await screen.findByRole("button", { name: "Check out" }));
    await userEvent.click(await screen.findByRole("button", { name: "Undo check-out" }));
    await waitFor(async () => expect((await team.file(valve!.id)).checked_out).toBeNull());
    await team.checkout(alice, "Valve.SLDPRT", "ALICE-PC");
    await userEvent.click(await screen.findByRole("button", { name: "Undo check-out" }));
    const undo = within(screen.getByRole("dialog"));
    expect(undo.getByText(/Changes you made on ALICE-PC stay there/)).toBeTruthy();
    await userEvent.click(undo.getByRole("button", { name: "Undo check-out" }));
    await waitFor(async () => expect((await team.file(valve!.id)).checked_out).toBeNull());
});

test("a drawing checked in from the web app stays linked to what it shows", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin" });
    const [drawing] = await team.checkin(
        team.chief,
        { "Fins/Fin.SLDDRW": "drawing v1" },
        { refs: { "Fins/Fin.SLDDRW": ["Fins/Fin.SLDPRT"] } },
    );
    await team.checkout(team.chief, "Fins/Fin.SLDDRW", "web");

    renderApp(team.chief, fileUrl(drawing!.id));
    await userEvent.click(await screen.findByRole("button", { name: "Check in…" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("It stays linked to Fin.SLDPRT, as v1 is.")).toBeTruthy();
    fireEvent.change(dialog.getByLabelText("The new version"), {
        target: { files: [new File(["drawing v2"], "Fin.SLDDRW")] },
    });
    await dialog.findByText(/It becomes v2/);
    await userEvent.click(dialog.getByRole("button", { name: "Check in" }));
    await waitFor(async () => expect((await team.file(drawing!.id)).version).toBe(2));
    expect((await team.file(drawing!.id)).uses).toHaveLength(1);
});
