import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { fromPreview } from "../src/yorg";
import { renderApp, Team } from "./team";

// Yorg's preview (/yorg/dev/...), where admins tried what was new, has gone with nothing new left in it: a link to one
// of its pages goes on to the page it previewed, and to its system models, to Piper, whose Simulation mode they're in.

test("a preview's path is the page it previewed's; its Models, Piper", () => {
    expect(fromPreview("/yorg/dev")).toBe("/yorg");
    expect(fromPreview("/yorg/dev/datasets/5")).toBe("/yorg/datasets/5");
    expect(fromPreview("/yorg/dev/models")).toBe("/piper");
    expect(fromPreview("/yorg/devices")).toBeNull();
    expect(fromPreview("/yorg/views")).toBeNull();
});

test("a link to the preview goes on to the page it previewed, and Yorg's top bar has no Preview or Models", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/views");
    await waitFor(() => expect(window.location.pathname).toBe("/yorg/views"));
    const nav = within(await screen.findByRole("navigation", { name: "Main" }));
    expect(nav.getByRole("link", { name: "Views" }).getAttribute("aria-current")).toBe("page");
    expect(nav.getAllByRole("link").map((link) => link.textContent)).toEqual(["Datasets", "Views", "Scripts", "Help"]);
});

test("a link to the preview's Models goes to Piper", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/models?dataset=5");
    await waitFor(() => expect(window.location.pathname).toBe("/piper"));
    expect(await screen.findByRole("heading", { name: "Diagrams" })).toBeTruthy();
});
