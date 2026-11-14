import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp, Team } from "./team";

// Bug reports and feature requests: sent from Help, looked at by Claude (the test server's stand-in, claude.ts, which
// recommends approving every one), and approved by the chief, the test server's owner, which starts the stand-in for
// Claude Code's routine. The server is shared, so each test's requests have titles of their own.

async function openRequests() {
    await userEvent.click(await screen.findByRole("button", { name: "Help" }));
    const help = within(await screen.findByRole("complementary", { name: "Help" }));
    await userEvent.click(help.getByRole("button", { name: "Report a bug or idea" }));
    return help;
}

async function sendRequest(help: ReturnType<typeof within>, kind: string, title: string, body: string) {
    await userEvent.click(help.getByRole("button", { name: kind }));
    await userEvent.type(help.getByRole("textbox", { name: "Title" }), title);
    const what = help.getByRole("textbox", { name: /^What (happened|you'd like)/ });
    await userEvent.type(what, body);
    await userEvent.click(help.getByRole("button", { name: "Send" }));
    await help.findByText("Sent. You'll see what becomes of it here.");
}

const unique = () => Math.random().toString(36).slice(2, 8);

test("a member sends a bug report from Help, and sees what becomes of it", async () => {
    const team = await Team.create();
    const faye = await team.member("Faye");
    renderApp(faye, "/vault/locks");
    const help = await openRequests();
    const title = `Locks page is empty ${unique()}`;
    await sendRequest(help, "Bug report", title, "I have two files checked out, and Locks shows none.");
    const mine = within(help.getByRole("region", { name: "Your requests" }));
    const item = mine.getByText(title).closest("li")!;
    expect(within(item as HTMLElement).getByText(/Waiting for the owner/)).toBeTruthy();
    // Back to asking Claude, as it was.
    await userEvent.click(help.getByRole("button", { name: "Ask Claude" }));
    expect(help.getByRole("textbox", { name: "Ask Claude" })).toBeTruthy();
    cleanup();

    // The chief sees it on Admin > Requests, from the page it was sent from, with Claude's look at it.
    renderApp(team.chief, "/vault/admin/requests");
    const request = within(await screen.findByRole("article", { name: new RegExp(title) }));
    // Who sent it, when, and from where, across the time's own element.
    const from = (_: string, element: Element | null) =>
        element?.tagName === "P" && /^Faye · .+ · from \/vault\/locks$/.test(element.textContent ?? "");
    expect(request.getByText(from)).toBeTruthy();
    expect(await request.findByText(/It's small, and clear\./, {}, { timeout: 10_000 })).toBeTruthy();

    // Approving starts Claude Code, with a note, and links to its session.
    await userEvent.click(request.getByRole("button", { name: "Approve…" }));
    await userEvent.type(
        request.getByRole("textbox", { name: "A note for Claude Code (optional)" }),
        "Check the add-in too.",
    );
    await userEvent.click(request.getByRole("button", { name: "Start Claude Code" }));
    const session = await request.findByRole("link", { name: "Claude Code's session" });
    expect(session.getAttribute("href")).toMatch(/^https:\/\/claude\.ai\/code\/session_test\d+$/);
    expect(request.getByText("Approved: Claude Code is building it")).toBeTruthy();
    expect(request.getByText(/Your note: Check the add-in too\./)).toBeTruthy();

    // Once it's built, done, with a word for Faye.
    await userEvent.type(request.getByRole("textbox", { name: "Reply to Faye" }), "Fixed: update the add-in.");
    await userEvent.click(request.getByRole("button", { name: "Mark done" }));
    await userEvent.click(screen.getByRole("button", { name: /^All/ }));
    const done = within(await screen.findByRole("article", { name: new RegExp(title) }));
    const decided = (_: string, element: Element | null) =>
        element?.tagName === "P" &&
        /^Done by chief, .+: “Fixed: update the add-in\.”$/i.test(element.textContent ?? "");
    expect(await done.findByText(decided)).toBeTruthy();
    cleanup();

    renderApp(faye, "/vault");
    const again = within((await (await openRequests()).findByRole("region", { name: "Your requests" })) as HTMLElement);
    await waitFor(() => expect(again.getByText(title)).toBeTruthy());
    const mine2 = again.getByText(title).closest("li") as HTMLElement;
    expect(within(mine2).getByText(/Done/)).toBeTruthy();
    expect(within(mine2).getByText("Fixed: update the add-in.")).toBeTruthy();
});

test("only the owner approves; any admin can decline, saying why", async () => {
    const team = await Team.create();
    const gus = await team.member("Gus");
    const lead = await team.admin("Lead");
    renderApp(gus, "/yorg");
    const title = `Sort tests by date ${unique()}`;
    await sendRequest(await openRequests(), "Feature request", title, "The newest test should come first.");
    cleanup();

    renderApp(lead, "/vault/admin/requests");
    expect(await screen.findByText(/Only the site's owner can approve requests/)).toBeTruthy();
    const request = within(await screen.findByRole("article", { name: new RegExp(title) }));
    expect(request.queryByRole("button", { name: "Approve…" })).toBeNull();
    const decline = request.getByRole("button", { name: "Decline" }) as HTMLButtonElement;
    expect(decline.disabled).toBe(true); // until there's a reason
    await userEvent.type(request.getByRole("textbox", { name: "Reply to Gus" }), "Yorg already sorts by date.");
    await userEvent.click(decline);
    await waitFor(() => expect(screen.queryByRole("article", { name: new RegExp(title) })).toBeNull()); // not open
    cleanup();

    renderApp(gus, "/yorg");
    const mine = within((await (await openRequests()).findByRole("region", { name: "Your requests" })) as HTMLElement);
    await waitFor(() => expect(mine.getByText(title)).toBeTruthy());
    const item = mine.getByText(title).closest("li") as HTMLElement;
    expect(within(item).getByText(/Declined/)).toBeTruthy();
    expect(within(item).getByText("Yorg already sorts by date.")).toBeTruthy();
});

test("members don't see Admin > Requests", async () => {
    const team = await Team.create();
    renderApp(await team.member("Hal"), "/vault/admin/requests");
    expect(await screen.findByRole("heading", { name: "Admin" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Requests" })).toBeNull();
});
