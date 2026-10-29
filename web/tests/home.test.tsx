import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test, vi } from "vitest";
import { renderApp, Team } from "./team";

test("the site's address shows its apps, and each goes to its own pages", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/");

    const home = within(await screen.findByRole("main"));
    expect(home.getByRole("heading", { name: "YJSP Engineering Tools Repository" })).toBeTruthy();
    const vault = home.getByRole("link", { name: /^Vault/ });
    expect(vault.getAttribute("href")).toBe("/vault");
    expect(home.getByRole("link", { name: /^Yorg/ }).getAttribute("href")).toBe("/yorg");
    expect(home.getByRole("link", { name: /^Piper/ }).getAttribute("href")).toBe("/piper");
    expect(document.title).toBe("YJSP");
    // No app's pages are open, so the top bar has no section of any.
    expect(screen.queryByRole("navigation", { name: "Main" })?.textContent ?? "").toBe("");

    await userEvent.click(vault);
    expect(await screen.findByRole("navigation", { name: "Folder tree" })).toBeTruthy();
    expect(window.location.pathname).toBe("/vault");
    expect(document.title).toBe("Vault");
});

test("the home page shows everyone how full the server's disk is, and how much of it each app takes", async () => {
    const team = await Team.create();
    const member = await team.member("Storage");
    renderApp(member, "/");
    const storage = within(await screen.findByRole("region", { name: "Storage" }));
    expect(storage.getByRole("heading", { name: "Storage" })).toBeTruthy();
    expect(storage.getByText(/^[\d.]+ (KB|MB|GB) of [\d.]+ GB used \(\d+%\)$/)).toBeTruthy();
    expect(storage.getAllByRole("listitem").map((part) => part.textContent)).toEqual([
        expect.stringMatching(/^Vault [\d.]+ (bytes|KB|MB|GB)$/),
        expect.stringMatching(/^Yorg [\d.]+ (bytes|KB|MB|GB)$/),
        expect.stringMatching(/^Piper [\d.]+ (bytes|KB|MB|GB)$/),
        expect.stringMatching(/^Other [\d.]+ (bytes|KB|MB|GB)$/),
        expect.stringMatching(/^Free [\d.]+ (bytes|KB|MB|GB)$/),
    ]);
    expect(storage.queryByText(/copied off the server/)).toBeNull(); // the backups are the admins' to see
});

test("the mark at the top left goes to the site's front page, from any app", async () => {
    const team = await Team.create();
    for (const app of ["/vault", "/yorg", "/piper"]) {
        renderApp(team.chief, app);
        const home = await screen.findByRole("link", { name: "YJSP home" });
        expect(home.getAttribute("href")).toBe("/");
        await userEvent.click(home);
        expect(await screen.findByRole("heading", { name: "YJSP Engineering Tools Repository" })).toBeTruthy();
        expect(window.location.pathname).toBe("/");
        cleanup();
    }
});

test("the site's own page leaves the vault's index alone", async () => {
    const team = await Team.create();
    const fetched = vi.spyOn(globalThis, "fetch");
    onTestFinished(() => fetched.mockRestore());
    renderApp(team.chief, "/");
    // You're known (the account menu has your name): the vault's index, had it started, would have been asked for.
    await screen.findByRole("button", { name: /^Account: ./ });
    expect(fetched.mock.calls.filter(([url]) => String(url).includes("/api/sync")).length).toBe(0);
});

test("links from before Vault moved under /vault go on to the same page there", async () => {
    const team = await Team.create();
    const [fin] = await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin" }, { comment: "first fin" });

    renderApp(team.chief, `/file/${fin!.id}?tab=history`);
    expect(await screen.findByText("first fin")).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe(`/vault/file/${fin!.id}?tab=history`);
});

test("an old link to a page of the vault's that isn't a file goes there too", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/locks");
    await waitFor(() => expect(window.location.pathname).toBe("/vault/locks"));
    expect(await screen.findByRole("link", { name: "Checked out", current: "page" })).toBeTruthy();
});

test("an address that's no page says so, and offers the apps", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/nowhere");
    expect(await screen.findByText("There's no page here.")).toBeTruthy();
    expect(within(screen.getByRole("main")).getByRole("link", { name: /^Vault/ })).toBeTruthy();
});
