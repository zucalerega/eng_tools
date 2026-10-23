import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp, Team } from "./team";

// Help, in the top bar: the help's links, and Claude to ask. The test server's assistant asks a stand-in for
// Anthropic's API (claude.ts), which answers by saying back the question.

async function openHelp() {
    await userEvent.click(await screen.findByRole("button", { name: "Help" }));
    return within(await screen.findByRole("complementary", { name: "Help" }));
}

/**
 * Ask Claude, and wait for the answer to end (unless told not to): an answer still coming when a test ends would
 * write the conversation into the next test's tab.
 */
async function ask(help: ReturnType<typeof within>, question: string, { wait = true } = {}) {
    const box = help.getByRole("textbox", { name: "Ask Claude" });
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    // userEvent reads [ and { as the start of a key's name: [[ and {{ type them.
    await userEvent.type(box, `${question.replace(/[[{]/g, (bracket) => bracket + bracket)}{Enter}`);
    if (wait) {
        await answered(help, question);
    }
}

/** Until the conversation has the question, and its answer has ended, one way or another. */
async function answered(help: ReturnType<typeof within>, question: string) {
    await waitFor(() => {
        const log = help.getByRole("log", { name: "Conversation with Claude" });
        expect(within(log).getAllByText(question).length).toBeGreaterThan(0);
        expect(log.getAttribute("aria-busy")).toBe("false");
    });
}

test("Help opens beside the page, with the help and the app's own", async () => {
    const team = await Team.create();
    renderApp(await team.member("Ana"), "/vault");
    const help = await openHelp();
    expect(help.getByRole("link", { name: "The guide and troubleshooting" }).getAttribute("href")).toBe("/help");
    expect(help.getByRole("link", { name: "SolidWorks" }).getAttribute("href")).toBe("/vault/solidworks");
    expect(help.getByText(/how to do something in Vault or Yorg, or what an error means/)).toBeTruthy();
    // The page stays as it was, beside it.
    expect(await screen.findByRole("navigation", { name: "Folder tree" })).toBeTruthy();

    await userEvent.click(help.getByRole("button", { name: "Close help" }));
    expect(screen.queryByRole("complementary", { name: "Help" })).toBeNull();
    expect(screen.getByRole("button", { name: "Help" }).getAttribute("aria-expanded")).toBe("false");
});

test("Claude answers a question as it's written, with links into the help", async () => {
    const team = await Team.create();
    renderApp(await team.member("Ana"), "/vault");
    const help = await openHelp();
    await ask(help, "Why is my part read-only?");

    const conversation = within(help.getByRole("log", { name: "Conversation with Claude" }));
    expect(conversation.getByText("Why is my part read-only?")).toBeTruthy();
    const answer = await conversation.findByText(/You asked: "Why is my part read-only\?" \(question 1 here\)/);
    expect(answer).toBeTruthy();
    const link = await conversation.findByRole("link", { name: "Conflicts" });
    expect(link.getAttribute("href")).toBe("/help#solidworks-conflicts");
    expect(link.getAttribute("target")).toBe("_blank"); // the conversation stays where it is
    // Answered: the next question can go.
    expect(help.getByRole("button", { name: "Ask" })).toBeTruthy();
});

test("a conversation goes on until a new one starts", async () => {
    const team = await Team.create();
    renderApp(await team.member("Ana"), "/yorg");
    const help = await openHelp();
    expect(help.getByRole("link", { name: "Yorg's help" }).getAttribute("href")).toBe("/yorg/help");
    await ask(help, "How do I set T0?");
    await help.findByText(/\(question 1 here\)/);
    await ask(help, "And move it?");
    // Claude had the first question and its answer too.
    await help.findByText(/You asked: "And move it\?" \(question 2 here\)/);

    await userEvent.click(help.getByRole("button", { name: "New conversation" }));
    expect(help.queryByText("How do I set T0?")).toBeNull();
    await ask(help, "What's a mask?");
    await help.findByText(/You asked: "What's a mask\?" \(question 1 here\)/);
});

test("the conversation stays with the tab, through a reload", async () => {
    const team = await Team.create();
    const ana = await team.member("Ana");
    renderApp(ana, "/vault");
    await ask(await openHelp(), "Where's the trash?");
    await screen.findByText(/You asked: "Where's the trash\?" \(question 1 here\)/);
    cleanup();

    renderApp(ana, "/vault");
    const help = await openHelp();
    expect(help.getByText("Where's the trash?")).toBeTruthy();
    expect(help.getByText(/You asked: "Where's the trash\?"/)).toBeTruthy();
    cleanup();

    // Someone else signing in on the same tab, as on a lab computer, doesn't get it.
    renderApp(await team.member("Ben"), "/vault");
    const theirs = await openHelp();
    expect(await theirs.findByText(/how to do something in Vault or Yorg/)).toBeTruthy();
    expect(theirs.queryByText("Where's the trash?")).toBeNull();
});

test("Stop ends an answer, and the next question can go at once", async () => {
    const team = await Team.create();
    renderApp(await team.member("Ana"), "/vault");
    const help = await openHelp();
    await ask(help, "Tell me everything [slow]", { wait: false });
    await help.findByText(/You asked: "Tell me everything \[slow\]"/); // it's writing
    await userEvent.click(help.getByRole("button", { name: "Stop" }));
    expect(await help.findByText("Stopped.")).toBeTruthy();
    // Not "still answering" the one that was stopped.
    await ask(help, "Just this, then");
    expect(await help.findByText(/You asked: "Just this, then"/)).toBeTruthy();
});

test("a long answer goes back to Claude with the next question", async () => {
    const team = await Team.create();
    renderApp(await team.member("Ana"), "/vault");
    const help = await openHelp();
    await ask(help, "Explain it all [long]");
    await help.findByText(/You asked: "Explain it all \[long\]" \(question 1 here\)/);
    await ask(help, "And in short?");
    expect(await help.findByText(/You asked: "And in short\?" \(question 2 here\)/)).toBeTruthy();
});

test("a conversation asked from a long address goes on", async () => {
    const team = await Team.create();
    // A folder deep in the vault: its address is over 300 characters, more than a question keeps of it.
    renderApp(await team.member("Ana"), "/vault/files/" + "Deep%20Folder/".repeat(30));
    const help = await openHelp();
    await ask(help, "Where am I?");
    await help.findByText(/\(question 1 here\)/);
    await ask(help, "And now?");
    expect(await help.findByText(/You asked: "And now\?" \(question 2 here\)/)).toBeTruthy();
});

test("signing out forgets the tab's conversation", async () => {
    const team = await Team.create();
    renderApp(await team.member("Ana"), "/vault");
    await ask(await openHelp(), "Is this kept?");
    await screen.findByText(/You asked: "Is this kept\?"/);
    expect(sessionStorage.getItem("yjsp.chat")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Account: / }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(sessionStorage.getItem("yjsp.chat")).toBeNull();
});

test("an error on the page can be asked about in a click", async () => {
    const team = await Team.create();
    renderApp(await team.member("Ana"), "/vault/file/987654321");
    await screen.findByText("File 987654321 not found");
    const help = await openHelp();
    await userEvent.click(await help.findByRole("button", { name: /^Ask about “File 987654321 not found”/ }));
    const question = 'The page says: "File 987654321 not found". What does it mean, and what do I do?';
    expect((help.getByRole("textbox", { name: "Ask Claude" }) as HTMLTextAreaElement).value).toBe(question);
    await userEvent.click(help.getByRole("button", { name: "Ask" }));
    await answered(help, question);
    expect(help.getByText(/You asked: "The page says: \\?"File 987654321 not found/)).toBeTruthy();
});

test("a question Claude won't answer, or can't now, says so", async () => {
    const team = await Team.create();
    renderApp(await team.member("Ana"), "/");
    const help = await openHelp();
    await ask(help, "Write my essay [decline]");
    expect(await help.findByText(/Claude can't help with that one/)).toBeTruthy();

    await ask(help, "Is it there? [fail]");
    expect(await help.findByText("Claude is overloaded or down just now: try again in a few minutes")).toBeTruthy();
    // Asked again, in its place at the end: here it fails the same way, as the stand-in turns it away each time.
    await userEvent.click(help.getByRole("button", { name: "Ask again" }));
    await answered(help, "Is it there? [fail]");
    expect(help.getAllByText("Is it there? [fail]")).toHaveLength(1);
});

test("admins see what Claude's answers have cost, and on whose questions", async () => {
    const team = await Team.create();
    const ana = await team.member("Ana");
    renderApp(ana, "/vault");
    await ask(await openHelp(), "What's Caliper?");
    await screen.findByText(/You asked: "What's Caliper\?"/);
    cleanup();

    renderApp(team.chief, "/vault/admin");
    const card = within(await screen.findByRole("region", { name: "Claude" }));
    expect(card.getAllByText("Spent")).toHaveLength(2); // a tile's, and the list's column
    expect(card.getByRole("columnheader", { name: "Spent" })).toBeTruthy();
    expect(card.getByText("Left of $5.00")).toBeTruthy();
    expect(card.getByText("A person's daily limit")).toBeTruthy();
    expect(card.getByText(/claude-sonnet-5-5, at high effort/)).toBeTruthy();
    const row = card.getByRole("cell", { name: "Ana" }).closest("tr")!;
    expect(Number(within(row).getAllByRole("cell")[1]!.textContent)).toBeGreaterThanOrEqual(1);
});
