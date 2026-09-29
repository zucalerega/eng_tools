import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp, Team } from "./team";

// Yorg's dev page (admins): a system model drawn, linked to a test's channels, saved, and run with FullFlow on the
// test server.

// 2 s at 100 Hz: the tank at 300 psig, the main valve open from 0.5 s to 1.5 s, and what the manifold read.
const COLD_FLOW = [
    "Time (s),MOV-OX,PT-TANK (psig),PT-MANIFOLD (psig)",
    ...Array.from({ length: 201 }, (_, i) => {
        const open = i >= 50 && i < 150;
        return [(i / 100).toFixed(2), open ? "OPEN" : "CLOSED", "300", open ? "185" : "0"].join(",");
    }),
].join("\n");

test("the dev page is for admins", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const asBob = renderApp(bob, "/yorg/dev");
    expect(await screen.findByText(/There's no page here/)).toBeTruthy();
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    expect(nav.queryByRole("link", { name: "Dev" })).toBeNull();
    asBob.unmount();

    renderApp(team.chief, "/yorg");
    const main = within(await screen.findByRole("navigation", { name: "Main" }));
    await userEvent.click(await main.findByRole("link", { name: "Dev" }));
    expect(await screen.findByRole("heading", { name: "System models" })).toBeTruthy();
});

test("a model is drawn, linked to a test, saved, and run against it", { timeout: 180_000 }, async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", COLD_FLOW);
    renderApp(team.chief, "/yorg/dev");

    await userEvent.click(await screen.findByRole("button", { name: "Start from an example" }));
    const diagram = within(screen.getByRole("application", { name: "P&ID" }));
    expect(diagram.getByRole("button", { name: "Fuel tank" })).toBeTruthy();
    expect(diagram.getByRole("button", { name: "Main valve" })).toBeTruthy();

    // The test first: its channels are what the parts link to.
    await userEvent.selectOptions(screen.getByLabelText("Test"), data.name);
    const pick = async (part: string, link: string, channel: string) => {
        fireEvent.pointerDown(diagram.getByRole("button", { name: part }));
        const settings = within(await screen.findByRole("region", { name: `${part} settings` }));
        await waitFor(() =>
            expect(settings.getAllByRole("option", { name: new RegExp(`^${channel}`) }).length).toBeGreaterThan(0),
        );
        await userEvent.selectOptions(settings.getByLabelText(link), channel);
    };
    await pick("Fuel tank", "Pressure (it follows)", "PT-TANK");
    await pick("Main valve", "Command (drives it)", "MOV-OX");
    await pick("Manifold", "Pressure transducer (compared)", "PT-MANIFOLD");
    expect(diagram.getAllByText("PT")).toHaveLength(2);
    expect(diagram.getByText("CMD")).toBeTruthy();

    // Saved for the team, by name.
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.clear(dialog.getByLabelText("Name"));
    await userEvent.type(dialog.getByLabelText("Name"), "Stand A cold flow");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Stand A cold flow" })).toBeTruthy());

    // Run: the manifold's pressure, measured and modeled, and how far apart they are.
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(/^Done in/, {}, { timeout: 150_000 })).toBeTruthy();
    const results = within(screen.getByRole("region", { name: "Results" }));
    expect(results.getByText("Manifold pressure transducer")).toBeTruthy();
    expect(results.getByText(/PT-MANIFOLD \(measured\)/)).toBeTruthy();
    expect(await results.findByText(/^RMS .* psig · bias/)).toBeTruthy(); // once the measured channel has loaded
    expect(results.getByText(/Fuel tank: Water at 293\.15 K/)).toBeTruthy();
});
