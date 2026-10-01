import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { inPreview, previewPath, sitePath } from "../src/preview";
import { renderApp, Team } from "./team";

// Yorg's preview (/yorg/dev/...): the site as it will be with what's new in it (system models), for admins; everyone
// else's Yorg stays as it is. Scripts and Python beside the plots were in it, and now are everyone's.

describe("preview paths", () => {
    test("Yorg's pages have preview ones; the vault's don't", () => {
        expect(previewPath("/yorg")).toBe("/yorg/dev");
        expect(previewPath("/yorg/datasets/5")).toBe("/yorg/dev/datasets/5");
        expect(previewPath("/yorg/models?dataset=5")).toBe("/yorg/dev/models?dataset=5");
        expect(previewPath("/yorg/dev/views")).toBe("/yorg/dev/views");
        expect(previewPath("/files/Structures")).toBe("/files/Structures");
        expect(previewPath("/yorgx")).toBe("/yorgx");
        expect(sitePath("/yorg/dev")).toBe("/yorg");
        expect(sitePath("/yorg/dev/datasets/5")).toBe("/yorg/datasets/5");
        expect(sitePath("/yorg/views")).toBe("/yorg/views");
        expect(inPreview("/yorg/dev?x=1")).toBe(true);
        expect(inPreview("/yorg/devices")).toBe(false);
    });
});

const DATA = ["Time (s),PT-TANK (psig)", "0,300", "1,301", "2,299"].join("\n");

test("admins see what's new in the preview, where it will be; the site stays as it is", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", DATA);
    renderApp(team.chief, "/yorg");
    const nav = within(await screen.findByRole("navigation", { name: "Main" }));
    const tabs = () => nav.getAllByRole("link").map((link) => link.textContent);
    await nav.findByRole("link", { name: "Preview" }); // once it knows the chief is an admin
    expect(tabs()).toEqual(["Datasets", "Views", "Scripts", "Help", "Preview"]);

    // In the preview: Models in the top bar too, and the preview says so.
    await userEvent.click(nav.getByRole("link", { name: "Preview" }));
    expect(await screen.findByRole("heading", { name: "Test data" })).toBeTruthy();
    expect(window.location.pathname).toBe("/yorg/dev");
    expect(tabs()).toEqual(["Datasets", "Views", "Models", "Scripts", "Help"]);
    expect(screen.getByText(/^Preview: Yorg as it will be/)).toBeTruthy();

    // Links stay in the preview: Views, then Help with what's new in it.
    await userEvent.click(nav.getByRole("link", { name: "Views" }));
    await waitFor(() => expect(window.location.pathname).toBe("/yorg/dev/views"));
    expect(nav.getByRole("link", { name: "Views" }).getAttribute("aria-current")).toBe("page");
    await userEvent.click(nav.getByRole("link", { name: "Help" }));
    expect(await screen.findByRole("region", { name: "System models" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Scripts" })).toBeTruthy();

    // A dataset's page runs a model on it: the models page opens with the test picked, and a way back to it.
    await userEvent.click(nav.getByRole("link", { name: "Datasets" }));
    await userEvent.click(await screen.findByRole("link", { name: data.name }));
    await userEvent.click(await screen.findByRole("link", { name: "Model" }));
    expect(await screen.findByRole("heading", { name: "System models" })).toBeTruthy();
    expect(window.location.pathname).toBe("/yorg/dev/models");
    await waitFor(() =>
        expect((screen.getByLabelText("Test") as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(data.name),
    );
    expect(screen.getByRole("link", { name: "Open the test ↗" }).getAttribute("href")).toBe(
        `/yorg/dev/datasets/${data.id}`,
    );

    // Out of the preview, to the same page on the site: what's new isn't there.
    await userEvent.click(screen.getByRole("link", { name: "Leave the preview" }));
    expect(await screen.findByText(/There's no page here/)).toBeTruthy();
    expect(window.location.pathname).toBe("/yorg/models");
    expect(tabs()).toEqual(["Datasets", "Views", "Scripts", "Help", "Preview"]);
});

test("the preview is for admins", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    renderApp(bob, "/yorg/dev/views");
    expect(await screen.findByText(/There's no page here/)).toBeTruthy();
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    expect(nav.getAllByRole("link").map((link) => link.textContent)).toEqual(["Datasets", "Views", "Scripts", "Help"]);
    expect(screen.queryByRole("link", { name: "Preview" })).toBeNull(); // no way in
    expect(screen.queryByText(/Preview: Yorg as it will be/)).toBeNull();
    // The way back goes to the site, not the preview.
    await userEvent.click(screen.getByRole("link", { name: "Go to the test data" }));
    expect(await screen.findByRole("heading", { name: "Test data" })).toBeTruthy();
    expect(window.location.pathname).toBe("/yorg");
});
