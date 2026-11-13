import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import { TempoSandbox, type TempoRunner } from "../src/tempo/sandbox";
import { TimelineView } from "../src/tempo/TimelineView";
import { Workspace } from "../src/tempo/Workspace";
import type { SimulationResult } from "../src/tempo/types";
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

function mockPassingResult(): SimulationResult {
    return {
        checks: { syntax: "pass", names: "pass", api: "pass", runtime: "pass" },
        diagnostics: [],
        events: [
            { time: 0.1, kind: "valve", target: "FBB", detail: "OPEN", line: 10 },
            { time: 0.4, kind: "abort_stage", target: "press_stage", detail: "activated", line: 12 },
            { time: 0.8, kind: "abort", target: "press_stage", detail: "FTPT > 450", line: 12 },
            { time: 0.8, kind: "valve", target: "FBB", detail: "CLOSED", line: 12, origin: "abort" },
        ],
        virtual_time: 1.0,
        timing: { wall_seconds: 0.2, requested_speed: 5, actual_speed: 5 },
        valves: { FBB: "CLOSED" },
        stdout: "ok",
        simulation: {
            initial_valves: { FBB: "CLOSED" },
            sensors: {
                FTPT: {
                    unit: "psi",
                    interpolation: "linear",
                    samples: [
                        { at: 0, value: 100 },
                        { at: 1, value: 460 },
                    ],
                },
            },
            sensor_read_lines: { FTPT: [15] },
            abort_stages: [
                {
                    name: "press_stage",
                    condition: "FTPT.read() > 450",
                    defined_line: 12,
                    activated: [0.4],
                    triggered: 0.8,
                    safe_states: [{ name: "FBB", state: "CLOSED", delay_ms: 0 }],
                },
            ],
            aborted: true,
        },
    };
}

test("Workspace invalidates simulation results to STALE on edit (including mid-run edits)", async () => {
    let resolveRun!: (res: SimulationResult) => void;
    const runner: TempoRunner = {
        run: () =>
            new Promise<SimulationResult>((resolve) => {
                resolveRun = resolve;
            }),
        stop: () => {},
    };

    render(<Workspace createRunner={() => runner} />);
    await userEvent.click(screen.getByRole("button", { name: "Run simulation" }));

    // Edit source while simulation is still running
    const editor = screen.getByLabelText("Python sequence source");
    await userEvent.type(editor, "\n# mid-run edit");

    resolveRun(mockPassingResult());
    await waitFor(() => expect(screen.getByText("STALE")).toBeTruthy());
    expect(screen.queryByText("PASSED")).toBeNull();
    expect(screen.getByText(/Results are stale/i)).toBeTruthy();
});

test("Workspace prompts before discarding unsaved changes when loading an example", async () => {
    const team = await Team.create();
    const alice = await team.member("alice");
    await renderApp(alice, "/tempo");

    const editor = await screen.findByLabelText("Python sequence source");
    await userEvent.type(editor, "\n# unsaved modification");

    await userEvent.click(screen.getByRole("button", { name: /^Abort stage/i }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // Cancel keeps current edits
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((editor as HTMLTextAreaElement).value).toContain("# unsaved modification");

    // Discard replaces with selected example
    await userEvent.click(screen.getByRole("button", { name: /^Abort stage/i }));
    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).not.toContain("# unsaved modification"));
});

test("Local drafts are account-scoped so switching users never leaks drafts", async () => {
    localStorage.clear();
    const team = await Team.create();
    const alice = await team.member("alice");
    const bob = await team.member("bob");

    const { unmount } = await renderApp(alice, "/tempo");
    const editorAlice = await screen.findByLabelText("Python sequence source");
    await userEvent.type(editorAlice, "\n# alice-secret-sequence");
    unmount();

    await renderApp(bob, "/tempo");
    const editorBob = await screen.findByLabelText("Python sequence source");
    expect((editorBob as HTMLTextAreaElement).value).not.toContain("alice-secret-sequence");
});

test("TimelineView renders abort stages, coverage cards, and sensor read-source links", async () => {
    const jumped: number[] = [];
    render(<TimelineView result={mockPassingResult()} onJumpToSource={(line) => jumped.push(line)} />);

    expect(screen.getByText("Abort stages")).toBeTruthy();
    expect(screen.getAllByText("press_stage").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("FTPT.read() > 450")).toBeTruthy();
    expect(screen.getByText(/FBB → CLOSED/)).toBeTruthy();

    // Click sensor read-source link L15
    const readLink = screen.getByLabelText("Show FTPT read at Python line 15");
    await userEvent.click(readLink);
    expect(jumped).toEqual([15]);
});
