import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp, table, Team } from "./team";

test("the activity feed says what each check-in was for", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    await team.checkin(alice, { "Avionics/Sled.SLDASM": "sled" }, { comment: "sled for the flight computer" });

    renderApp(team.chief, "/activity");
    const comment = await screen.findByText("sled for the flight computer");
    expect(comment.closest("li")!.textContent).toContain(`Alice added ${team.folder}/Avionics/Sled.SLDASM`);
});

test("admins approve people waiting for it", async () => {
    const team = await Team.create();
    const newbie = await team.stranger();

    renderApp(team.chief, "/admin");
    const row = (await screen.findByText(newbie.user.email)).closest("tr")!;
    expect(within(row).getByText("waiting for approval")).toBeTruthy();
    await userEvent.click(within(row).getByRole("button", { name: "Approve" }));
    await waitFor(async () => expect((await team.account(newbie.user.email))?.status).toBe("active"));
});

test("admins turn the whitelist off, which approves everyone waiting, and on again", async () => {
    const team = await Team.create();
    const newbie = await team.stranger(); // with the whitelist on

    renderApp(team.chief, "/admin");
    const whitelist = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Whitelist" });
    expect(whitelist.checked).toBe(true);
    await userEvent.click(whitelist);
    const dialog = within(await screen.findByRole("dialog", { name: "Turn the whitelist off?" }));
    expect(dialog.getByText(/waiting for approval will be approved now/)).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Turn it off" }));
    await waitFor(async () => expect((await team.account(newbie.user.email))?.status).toBe("active"));
    expect((await team.settings()).whitelist).toBe(false);
    await screen.findByText(/Off: anyone who signs in with Google joins right away/);

    await userEvent.click(whitelist); // on again: nothing to ask
    await waitFor(async () => expect((await team.settings()).whitelist).toBe(true));
    await waitFor(() => expect(whitelist.checked).toBe(true));
});

test("the activity feed says who turned the whitelist on", async () => {
    const team = await Team.create();
    await team.whitelist(true);

    renderApp(team.chief, "/activity");
    expect(await screen.findAllByText("chief turned the whitelist on")).not.toHaveLength(0);
});

test("people who aren't admins or leads don't get the admin pages", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    renderApp(bob, "/");
    await (await table()).findByRole("link", { name: team.folder });
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
});
