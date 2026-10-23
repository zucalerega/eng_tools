import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { renderApp, table, Team } from "./team";

test("the activity feed says what each check-in was for", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    await team.checkin(alice, { "Avionics/Sled.SLDASM": "sled" }, { comment: "sled for the flight computer" });

    renderApp(team.chief, "/vault/activity");
    const comment = await screen.findByText("sled for the flight computer");
    expect(comment.closest("li")!.textContent).toContain(`Alice added ${team.folder}/Avionics/Sled.SLDASM`);
});

test("admins see how many people used the site each day for the last month, and for how long, on the web app and in SolidWorks", async () => {
    const team = await Team.create();
    await team.member(`Usage-${team.folder}`); // signed in just now
    renderApp(team.chief, "/vault/admin");
    const tracker = within((await screen.findByRole("heading", { name: "Activity" })).closest("section")!);
    expect(Number(tracker.getByText("Active today").nextElementSibling!.textContent)).toBeGreaterThanOrEqual(2);
    expect(tracker.getByText("Time on the site, in all")).toBeTruthy();

    // Each of the last 30 days, today last, in a table for screen readers; the chart says the same on hover.
    expect(tracker.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
        "Day",
        "Active people",
        "Time on the web app",
        "Time in SolidWorks",
    ]);
    const days = tracker.getAllByRole("row").slice(1);
    expect(days).toHaveLength(30);
    const today = new Date().toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });
    expect(days.at(-1)!.textContent).toMatch(new RegExp(`^${today}\\d+`));
    await userEvent.hover([...document.querySelectorAll(".bars-slot")].at(-1)!);
    expect(tracker.getByRole("status").textContent).toMatch(/^Today\d+ people.* on the site/);
    expect(tracker.queryAllByRole("listitem")).toEqual([]); // one measure: no legend

    // Time on the site is the web app's and SolidWorks', each its own color, as the legend says.
    await userEvent.click(tracker.getByRole("button", { name: "Time on the site" }));
    expect(tracker.getByRole("button", { name: "Time on the site" }).getAttribute("aria-pressed")).toBe("true");
    expect(tracker.getByRole("button", { name: "Active people" }).getAttribute("aria-pressed")).toBe("false");
    expect(tracker.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Web app", "SolidWorks"]);
    expect(
        tracker.getByText(/SolidWorks in front, with someone at the computer, and the add-in signed in/),
    ).toBeTruthy();
});

test("the activity counts go up as people come on, while the page stays open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // the page's timers only: the server's real
    try {
        const team = await Team.create();
        renderApp(team.chief, "/vault/admin");
        const tracker = within((await screen.findByRole("heading", { name: "Activity" })).closest("section")!);
        const activeToday = () => Number(tracker.getByText("Active today").nextElementSibling!.textContent);
        const before = activeToday();
        // The measure chosen, and the day hovered, stay as the counts change.
        await userEvent.click(tracker.getByRole("button", { name: "Time on the site" }));
        await userEvent.hover([...document.querySelectorAll(".bars-slot")].at(-1)!);

        // Someone checks a part in after the page opened, as the add-in or the command line does.
        await team.checkin(await team.member(`Late-${team.folder}`), { "Engine/Injector.SLDPRT": "injector" });
        vi.advanceTimersByTime(30_000);
        await waitFor(() => expect(activeToday()).toBeGreaterThan(before));
        expect(tracker.getByRole("status").textContent).toMatch(new RegExp(`^Today${activeToday()} people`));
        expect(tracker.getByRole("button", { name: "Time on the site" }).getAttribute("aria-pressed")).toBe("true");
    } finally {
        vi.useRealTimers();
    }
});

test("admins see how hard the server is working, over a day or a week", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/vault/admin");
    const card = within((await screen.findByRole("heading", { name: "Server load" })).closest("section")!);
    expect(card.getByText("CPU now")).toBeTruthy();
    expect(card.getByText("Busiest, last 24 hours")).toBeTruthy();
    // The server samples each minute: this one may not have yet.
    expect(card.queryByText(/^No samples yet/) ?? card.getByText("Memory")).toBeTruthy();
    expect(card.getByText(/^\d+ CPU cores?/)).toBeTruthy();

    await userEvent.click(card.getByRole("button", { name: "7 days" }));
    expect(card.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed")).toBe("true");
    expect(await card.findByText("Busiest, last 7 days")).toBeTruthy();
});

test("admins see who has the SolidWorks add-in, on how many computers, and with which version", async () => {
    const team = await Team.create();
    const computer = `PC-${team.folder}`;
    await team.addInOn(`drafter-${team.folder.toLowerCase()}@rocketry.test`, computer);
    renderApp(team.chief, "/vault/admin");
    const card = within((await screen.findByRole("heading", { name: "SolidWorks add-in" })).closest("section")!);
    expect(Number(card.getByText("Have it").nextElementSibling!.textContent)).toBeGreaterThanOrEqual(1);
    expect(Number(card.getByText("Used it this week").nextElementSibling!.textContent)).toBeGreaterThanOrEqual(1);
    // Their name, as dev sign-in gives it, and how many computers they have it on, but not the computer's name.
    const row = (await card.findByText(`drafter-${team.folder.toLowerCase()}`)).closest("tr")!;
    expect(row.cells[1]!.textContent).toBe("1");
    expect(card.queryByText(computer)).toBeNull();
    // The installer offered is 0.5.0 (tests/server.ts): this one's newer, so it's on the newest, not old.
    expect(within(row).getByText("0.5.2").className).not.toContain("status-pending");
    expect(Number(card.getByText("On the newest (0.5.0)").nextElementSibling!.textContent)).toBeGreaterThanOrEqual(1);
    expect(card.getByText(/^Have it: signed in with the add-in on a computer/)).toBeTruthy();
});

test("admins can have the vault take changes only from add-ins as new as a version they set, and from any again", async () => {
    const team = await Team.create();
    await team.oldestClient(null); // any, as a server starts, and again once the test is done
    renderApp(team.chief, "/vault/admin");
    const card = within((await screen.findByRole("heading", { name: "SolidWorks add-in" })).closest("section")!);
    const field = await card.findByLabelText("Oldest version that can make changes");
    expect(card.getByText(/^Any version can change the vault\./)).toBeTruthy();

    // The installer offered is 0.5.0 (tests/server.ts): no add-in could update to a newer one, so it's refused.
    await userEvent.type(field, "0.6.0");
    await userEvent.click(card.getByRole("button", { name: "Save" }));
    expect((await card.findByRole("alert")).textContent).toMatch(/^No add-in could update to 0\.6\.0/);
    expect((await team.settings()).min_client_version).toBeNull();

    await userEvent.clear(field);
    await userEvent.type(field, "0.5.0");
    await userEvent.click(card.getByRole("button", { name: "Save" }));
    expect(await card.findByText(/^Only 0\.5\.0 and newer can check files out and in/)).toBeTruthy();
    expect(card.queryByRole("alert")).toBeNull();
    expect((await team.settings()).min_client_version).toBe("0.5.0");
    expect(card.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true); // nothing new to save

    await userEvent.click(card.getByRole("button", { name: "Allow any version" }));
    expect(await card.findByText(/^Any version can change the vault\./)).toBeTruthy();
    expect((await team.settings()).min_client_version).toBeNull();
    expect(card.queryByRole("button", { name: "Allow any version" })).toBeNull();
});

test("the activity feed says when admins change the oldest version that can make changes", async () => {
    const team = await Team.create();
    await team.oldestClient("0.5.0");
    await team.oldestClient(null);
    renderApp(team.chief, "/vault/activity");
    const [newest] = await screen.findAllByText(/ let add-ins and vault commands of any version change the vault$/);
    const [before] = screen.getAllByText(/ let only add-ins and vault commands 0\.5\.0 and newer change the vault$/);
    // Newest first.
    expect(newest!.compareDocumentPosition(before!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("admins see how full the server's disk is, and how much of it Vault and Yorg take", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/vault/admin");
    const legend = (await screen.findByText("Everything else")).closest("ul")!;
    expect([...legend.querySelectorAll("li")].map((part) => part.textContent)).toEqual([
        expect.stringMatching(/^Vault [\d.]+ (bytes|KB|MB|GB)$/),
        expect.stringMatching(/^Yorg [\d.]+ (bytes|KB|MB|GB)$/),
        expect.stringMatching(/^Everything else [\d.]+ (bytes|KB|MB|GB)$/),
        expect.stringMatching(/^Free [\d.]+ (bytes|KB|MB|GB)$/),
    ]);
    expect(screen.getByText(/^[\d.]+ (KB|MB|GB) of [\d.]+ GB used \(\d+%\)$/)).toBeTruthy();
    // The test server has no off-site backup, and says so.
    expect(screen.getByText(/^Not copied off the server/)).toBeTruthy();
});

test("admins see when each person was last on, and who's on now", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice"); // signed in just now
    renderApp(team.chief, "/vault/admin");
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
    const counts = (await screen.findByText((_, element) => !!element?.classList.contains("people-counts")))
        .textContent!;
    expect(counts).toMatch(/^\d+ people\d+ active now$/);
    expect(Number(/(\d+) active now/.exec(counts)![1])).toBeGreaterThanOrEqual(2); // Alice and the chief
    expect(screen.getByRole("columnheader", { name: "Joined" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Vault Access" })).toBeTruthy();
});

test("admins sort people by when they joined, when they were last on, and their time on the site", async () => {
    const team = await Team.create();
    const first = await team.member(`First-${team.folder}`);
    const second = await team.member(`Second-${team.folder}`);
    renderApp(team.chief, "/vault/admin");
    await screen.findByText(second.user.email);
    const rowOf = (email: string) => {
        const rows = [...document.querySelectorAll("tbody tr")];
        return rows.findIndex((row) => row.textContent!.includes(email));
    };

    // Newest first, then oldest first.
    const joined = screen.getByRole("button", { name: "Joined" });
    await userEvent.click(joined);
    expect(screen.getByRole("columnheader", { name: "Joined" }).getAttribute("aria-sort")).toBe("descending");
    expect(rowOf(second.user.email)).toBeLessThan(rowOf(first.user.email));
    await userEvent.click(joined);
    expect(screen.getByRole("columnheader", { name: "Joined" }).getAttribute("aria-sort")).toBe("ascending");
    expect(rowOf(first.user.email)).toBeLessThan(rowOf(second.user.email));

    // Who's on now comes before someone invited and never on.
    const email = `idle-${team.folder.toLowerCase()}@rocketry.test`;
    await userEvent.type(screen.getByLabelText("Invite by email"), email);
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    await screen.findAllByText(email); // its name is its email, until it has one
    await userEvent.click(screen.getByRole("button", { name: "Last active" }));
    expect(rowOf(team.chief.user.email)).toBeLessThan(rowOf(email));

    // Nobody here has had the web app open, or worked in SolidWorks, for long yet.
    await userEvent.click(screen.getByRole("button", { name: "Time on site" }));
    expect(screen.getByRole("columnheader", { name: "Time on site" }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getAllByText("none").length).toBeGreaterThan(0);
    const row = screen.getAllByText(second.user.email)[0]!.closest("tr")!;
    const header = screen.getByRole("columnheader", { name: "Time on site" });
    const time = row.cells[[...row.closest("table")!.querySelectorAll("th")].findIndex((th) => th === header)]!;
    expect(time.getAttribute("title")).toBe("none on the web app, none in SolidWorks");
});

test("people change their own name from their account menu", async () => {
    const team = await Team.create();
    const member = await team.member(`Renamer-${team.folder}`);
    renderApp(member, "/vault");
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

test("the People tab warns while the whitelist is off", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/vault/admin");
    const warning = await screen.findByText(/^The whitelist is off: anyone with a Georgia Tech account/);
    expect(within(warning).getByRole("link", { name: "Whitelist" }).getAttribute("href")).toBe(
        "/vault/admin/whitelist",
    );
});

test("admins turn the whitelist off, after saying who could join then, and on again", async () => {
    const team = await Team.create();
    await team.whitelist(true);

    renderApp(team.chief, "/vault/admin");
    await userEvent.click(await screen.findByRole("link", { name: "Whitelist" }));
    const whitelist = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Whitelist" });
    expect(whitelist.checked).toBe(true);
    expect(screen.getByText(/On: only the emails below, and people invited on the People tab/)).toBeTruthy();
    await userEvent.click(whitelist);
    const dialog = within(await screen.findByRole("dialog", { name: "Turn the whitelist off?" }));
    expect(dialog.getByText(/Anyone with a Georgia Tech account will be able to join/)).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Turn it off" }));
    await waitFor(async () => expect((await team.settings()).whitelist).toBe(false));
    await screen.findByText(/Off: anyone with a Georgia Tech account can make one by signing in/);

    await userEvent.click(whitelist); // on again: nothing to ask
    await waitFor(async () => expect((await team.settings()).whitelist).toBe(true));
    await waitFor(() => expect(whitelist.checked).toBe(true));
});

test("admins put a roster's Georgia Tech emails on the whitelist, see who has joined, and take one off", async () => {
    const team = await Team.create();
    const tag = team.folder.toLowerCase();
    const [george, jane, mom] = [`gburdell3-${tag}@gatech.edu`, `jdoe7-${tag}@gatech.edu`, `mom-${tag}@gmail.com`];
    const roster = `Name,Email,Subteam\nGeorge Burdell,${george},Propulsion\n"Doe, Jane",${jane.toUpperCase()},Avionics\nMom,${mom},\n`;

    renderApp(team.chief, "/vault/admin/whitelist");
    await userEvent.upload(await screen.findByLabelText("File of emails"), new File([roster], "roster.csv"));
    const dialog = within(await screen.findByRole("dialog", { name: "Add the emails in roster.csv?" }));
    expect(dialog.getAllByRole("listitem").map((item) => item.textContent)).toEqual([george, jane, mom]);
    await userEvent.click(dialog.getByRole("button", { name: "Add all 3" }));
    expect(await screen.findByText("Added 2 emails.")).toBeTruthy();
    expect(screen.getByText(/which isn't a Georgia Tech address\. Only GT accounts/).textContent).toMatch(
        new RegExp(`^Left off ${mom.replace(/[.]/g, "\\.")}, `),
    );
    expect(await team.whitelisted()).toEqual(expect.arrayContaining([george, jane]));
    expect(await team.whitelisted()).not.toContain(mom);

    // Typed in again: on it already.
    await userEvent.type(screen.getByLabelText("Add a Georgia Tech email"), george);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(`${george} was on the whitelist already.`)).toBeTruthy();

    // George signs up; Jane comes off, and the list, fetched again, has George's account.
    await team.signUp(george);
    await userEvent.type(screen.getByLabelText("Find on the whitelist"), tag);
    await userEvent.click(screen.getByRole("button", { name: `Remove ${jane}` }));
    await waitFor(() => expect(screen.queryByRole("button", { name: `Remove ${jane}` })).toBeNull());
    expect(await team.whitelisted()).not.toContain(jane);
    const row = screen.getByText(george).closest("tr")!;
    expect(within(row).getByText(`gburdell3-${tag}`)).toBeTruthy(); // the name he signed up with
});

test("the activity feed says who turned the whitelist on, and who changed what's on it", async () => {
    const team = await Team.create();
    await team.whitelist(true);
    const email = `ta-${team.folder.toLowerCase()}@gatech.edu`;
    await team.addToWhitelist([email]);

    renderApp(team.chief, "/vault/activity");
    expect(await screen.findAllByText("chief turned the whitelist on")).not.toHaveLength(0);
    expect(await screen.findByText(`chief added ${email} to the whitelist`)).toBeTruthy();
});

test("admins open the admin pages from their account menu", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/vault");
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
    renderApp(bob, "/vault");
    await (await table()).findByRole("link", { name: team.folder });
    await userEvent.click(screen.getByRole("button", { name: /^Account/ }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
});
