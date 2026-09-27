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

test("people who aren't admins or leads don't get the admin pages", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    renderApp(bob, "/");
    await (await table()).findByRole("link", { name: team.folder });
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
});
