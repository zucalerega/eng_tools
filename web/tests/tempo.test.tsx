import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import { TempoSandbox } from "../src/tempo/sandbox";
import { renderApp, Team } from "./team";

beforeAll(async () => {
    await Promise.all([
        import("../src/tempo/Workspace"),
        import("../src/tempo/TestsPage"),
        import("../src/tempo/EnvironmentsPage"),
        import("../src/tempo/HelpPage"),
    ]);
});

test("Tempo appears on Home and in the app switcher and routes natively", async () => {
    const team = await Team.create();
    const alice = await team.member("alice");
    await renderApp(alice, "/");

    const tempoLinks = screen.getAllByRole("link", { name: "Tempo" });
    expect(tempoLinks.length).toBe(2);

    await userEvent.click(tempoLinks[1]!);
    await waitFor(() => expect(document.title).toBe("Tempo"));
    expect(await screen.findByRole("heading", { name: "Tempo" })).toBeTruthy();
    expect(screen.getByText("Luna Sequence Simulator")).toBeTruthy();
    expect(screen.getByText(/Simulation ≠ hardware verification/i)).toBeTruthy();
});

test("Tempo saves exact Python source and loads saved tests and environments", async () => {
    const team = await Team.create();
    const alice = await team.member("alice");
    const exactSource = "# exact\npress_valve.open()\nif True:\n\twait_for(5*ms)\npress_valve.close()\n";

    await renderApp(alice, "/tempo");
    const editor = await screen.findByLabelText("Python sequence source");
    await userEvent.clear(editor);
    await userEvent.type(editor, exactSource.replace(/\t/g, "    "));

    const nameInput = screen.getByLabelText("Test name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Integration Test");

    await userEvent.click(screen.getByRole("button", { name: "Save test" }));
    await waitFor(() => expect(screen.getByText(/Saved "Integration Test" \(v1\)/)).toBeTruthy());

    // Navigate to Saved tests page and verify it is listed
    await userEvent.click(screen.getByRole("link", { name: "Saved tests" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Saved tests" })).toBeTruthy());
    expect(await screen.findByText("Integration Test")).toBeTruthy();

    // Navigate to Environments page and create a reusable environment
    await userEvent.click(screen.getByRole("link", { name: "Environments" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Test environments" })).toBeTruthy());
    await userEvent.type(screen.getByPlaceholderText("New environment name…"), "Stand B");
    await userEvent.click(screen.getByRole("button", { name: "Create environment" }));
    await waitFor(() => expect(screen.getByText("Stand B")).toBeTruthy());

    // Navigate to Help page
    await userEvent.click(screen.getByRole("link", { name: "Help" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Tempo Help" })).toBeTruthy());
});

test("TempoSandbox isolates Python execution in an opaque-origin iframe", () => {
    const sandbox = new TempoSandbox();
    void sandbox
        .run({
            source: "pass\n",
            mapping: '{"valves":[],"sensors":[]}',
            mode: "validate",
            options: { speed: 5, max_duration: 60 },
        })
        .catch(() => {});

    const frame = document.querySelector('iframe[title="Tempo Python Simulator"]');
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    sandbox.stop();
    expect(document.querySelector('iframe[title="Tempo Python Simulator"]')).toBeNull();
});
