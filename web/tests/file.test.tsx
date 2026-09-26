import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fileUrl } from "../src/paths";
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
    const uses = screen.getByRole("heading", { name: "Uses" }).parentElement!;
    expect(within(uses).getByRole("link", { name: `${team.folder}/Motor/Grain.SLDPRT` })).toBeTruthy();
    expect(within(uses).getByText(/v1 \(now v2\)/)).toBeTruthy();

    // Someone checks it out on their PC: the page shows it without a reload.
    await team.checkout(alice, "Motor/Case.SLDASM", "ALICE-PC");
    expect(await screen.findByText(/Checked out by Alice on ALICE-PC/)).toBeTruthy();
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
    expect(screen.queryByRole("checkbox", { name: /Admin mode/ })).toBeNull();
    asBob.unmount();

    renderApp(team.chief, fileUrl(tank!.id));
    expect(await screen.findByText(/Checked out by Alice on ALICE-PC/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Release check-out" })).toBeNull(); // only in admin mode
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
