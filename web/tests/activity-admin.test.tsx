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

test("admins see when each person was last on, and who's on now", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice"); // signed in just now
    renderApp(team.chief, "/admin");
    expect(await screen.findByRole("columnheader", { name: "Last active" })).toBeTruthy();
    const lastActive = (email: string) => {
        const row = screen.getAllByText(email)[0]!.closest("tr")!; // its name is its email, until it has one
        const column = [...row.closest("table")!.querySelectorAll("th")].findIndex(
            (th) => th.textContent === "Last active",
        );
        return row.querySelectorAll("td")[column]!.textContent;
    };
    await waitFor(() => expect(lastActive(alice.user.email)).toBe("active now"));
    expect(lastActive(team.chief.user.email)).toBe("active now"); // on this page

    // Invited, and never on since.
    const email = `idle-${team.folder.toLowerCase()}@rocketry.test`;
    await userEvent.type(screen.getByLabelText("Invite by email"), email);
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(lastActive(email)).toBe("never"));

    // How many people there are, and how many are on now; and when each joined.
    const counts = (await screen.findByText(/people$/)).closest("p")!.textContent!;
    expect(counts).toMatch(/^\d+ people\d+ active now$/);
    expect(Number(/(\d+) active now/.exec(counts)![1])).toBeGreaterThanOrEqual(2); // Alice and the chief
    expect(screen.getByRole("columnheader", { name: "Joined" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Vault Access" })).toBeTruthy();
});

test("people change their own name from their account menu", async () => {
    const team = await Team.create();
    const member = await team.member(`Renamer-${team.folder}`);
    renderApp(member, "/");
    await userEvent.click(await screen.findByRole("button", { name: /^Account: / }));
    await userEvent.click(screen.getByRole("button", { name: "Change your name…" }));
    const dialog = within(screen.getByRole("dialog", { name: "Change your name" }));
    const box = dialog.getByLabelText("Name");
    await userEvent.clear(box);
    await userEvent.type(box, `Ally ${team.folder}`);
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: `Account: Ally ${team.folder}` })).toBeTruthy();
    expect((await team.account(member.user.email))?.name).toBe(`Ally ${team.folder}`);
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

test("admins open the admin pages from their account menu", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/");
    await (await table()).findByRole("link", { name: team.folder });
    expect(within(screen.getByRole("navigation", { name: "Main" })).queryByRole("link", { name: "Admin" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Account/ }));
    await userEvent.click(screen.getByRole("link", { name: "Admin" }));
    expect(await screen.findByRole("heading", { name: "Admin" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull(); // the menu closed
});

test("people who aren't admins or leads don't get the admin pages", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    renderApp(bob, "/");
    await (await table()).findByRole("link", { name: team.folder });
    await userEvent.click(screen.getByRole("button", { name: /^Account/ }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
});
