import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { Handover } from "../src/yorg/scripts/inputs";
import { python } from "../src/yorg/scripts/python";
import { fakePython } from "./python";
import { renderApp, Team } from "./team";

// The tab's Python, as the Python window uses it: one that stays open as you come and go, gets a script's slow imports
// ready while it's open, hands it the channels it names (their times once), and says what it's doing at every step,
// and where a run's time went. Python here is a stand-in (tests/python.ts): what's tested is the page's side of it.

const TANK = ["Time (s),PT-TANK (psig),FM-OX (lbm/s)", "0,300,0", "1,301,2.5", "2,299,2.5"].join("\n");

const output = () => within(screen.getByRole("region", { name: "Output" }));

async function type(code: string) {
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: code } });
}

test("a run waits for Python to start and says so, then says each step, and where its time went", async () => {
    const pythons = fakePython();
    const team = await Team.create();
    const tank = await team.data(team.chief, "Tank test", TANK);
    renderApp(team.chief, `/yorg/dev/scripts?dataset=${tank.id}`);
    expect(await screen.findByText(/^Starting Python · \d+ s$/)).toBeTruthy();
    await type('pt = yorg.channel("PT-TANK")\nflow = yorg.channel("FM-OX")\nfrom CoolProp.CoolProp import PropsSI\n');

    // Run while Python starts: the run waits, and says for what, and why that takes a while.
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await output().findByText(/^Waiting for Python: starting Python · \d+ s$/)).toBeTruthy();
    expect(output().getByText(/Python starts once while this tab is open/)).toBeTruthy();

    // Once it's up, the run goes, naming the channels it wants by key.
    const fake = pythons.latest();
    expect(fake.received[0]).toMatchObject({ type: "init" });
    fake.say({ type: "ready", version: "3.14.2" });
    const sent = await fake.next("run");
    const key = (name: string) =>
        `${tank.id}/${tank.data_version}/${tank.channels.find((one) => one.name === name)!.values}`;
    expect(sent.keys).toEqual([key("PT-TANK"), key("FM-OX")]);
    expect(JSON.parse(sent.context).datasets[0]).toMatchObject({ id: tank.id, name: tank.name });

    // Each step, as it goes, with why the slow ones are slow.
    fake.say({ type: "progress", run: sent.run, phase: "import", module: "CoolProp.CoolProp" });
    expect(await output().findByText(/^Importing CoolProp.CoolProp · \d+ s$/)).toBeTruthy();
    expect(output().getByText(/CoolProp reads its whole fluid library/)).toBeTruthy();
    expect(output().getByText(/^Running · \d+ s$/)).toBeTruthy();

    // Python asks for the channels it hasn't got: the server's samples, the test's times once.
    fake.say({ type: "request", id: 1, run: sent.run, what: "channels", args: { keys: sent.keys, times: [] } });
    const response = await fake.next("response");
    const handed = response.value as Handover[];
    expect(handed.map((one) => JSON.parse(one.meta).name)).toEqual(["PT-TANK", "FM-OX"]);
    expect(JSON.parse(handed[0]!.meta)).toMatchObject({ unit: "psig", dataset: tank.name, dataset_id: tank.id });
    expect([...new Float64Array(handed[0]!.t!.buffer)]).toEqual([0, 1, 2]);
    expect(handed[1]!.t).toBeNull(); // the same times: PT-TANK brought them
    expect([...new Float64Array(handed[0]!.v.buffer)]).toEqual([300, 301, 299]);
    expect([...new Float64Array(handed[1]!.v.buffer)]).toEqual([0, 2.5, 2.5]);

    // Done: what it printed, how long it took, and where the time went.
    fake.say({ type: "stdout", run: sent.run, text: "3 samples" });
    fake.say({
        type: "done",
        run: sent.run,
        elapsed: 21.3,
        timings: [{ kind: "import", module: "CoolProp.CoolProp", seconds: 20.8 }],
    });
    expect(await output().findByText(/^Done in /)).toBeTruthy();
    expect(output().getByText(/^importing CoolProp.CoolProp 21 s · .*your code/)).toBeTruthy();
    expect(output().getByText("3 samples")).toBeTruthy();
});

test("a failed run shows its traceback, and the line it failed on", async () => {
    const pythons = fakePython();
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/scripts");
    await type("x = 1\ny = x / 0\n");
    pythons.latest().say({ type: "ready", version: "3.14.2" });
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    const sent = await pythons.latest().next("run");
    const traceback = 'Traceback (most recent call last):\n  File "script.py", line 2, in <module>\nZeroDivisionError';
    pythons.latest().say({ type: "error", run: sent.run, text: traceback, line: 2, elapsed: 0.1, timings: [] });
    expect(await output().findByText(/^Failed in /)).toBeTruthy();
    expect(output().getByText(/ZeroDivisionError/)).toBeTruthy();
    const gutter = document.querySelector(".scripts-gutter-error");
    expect(gutter?.textContent).toBe("2");
});

test("Stop: a run that's waiting doesn't start; one that's running stops Python, which starts again", async () => {
    const pythons = fakePython();
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/scripts");
    await type("print(1)\n");

    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await output().findByText(/^Waiting · \d+ s$/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await output().findByText("It hadn't started.")).toBeTruthy();

    const first = pythons.latest();
    first.say({ type: "ready", version: "3.14.2" });
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await first.next("run");
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await output().findByText(/Python is starting again without what it had/)).toBeTruthy();
    expect(first.stopped).toBe(true);
    expect(first.count("run")).toBe(1);
    expect(pythons.all.length).toBe(2);
    expect(await screen.findByText(/^Starting Python · \d+ s$/)).toBeTruthy();
});

test("Python stays open while you're elsewhere: back on Scripts, the script and its last run are as they were", async () => {
    const pythons = fakePython();
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/scripts");
    await type('print("hello")\n');
    pythons.latest().say({ type: "ready", version: "3.14.2" });
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    const sent = await pythons.latest().next("run");
    pythons.latest().say({ type: "stdout", run: sent.run, text: "hello" });
    pythons.latest().say({ type: "done", run: sent.run, elapsed: 0.1, timings: [] });
    expect(await output().findByText(/^Done in /)).toBeTruthy();

    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    await userEvent.click(nav.getByRole("link", { name: "Datasets" }));
    expect(await screen.findByRole("heading", { name: "Test data" })).toBeTruthy();
    await userEvent.click(nav.getByRole("link", { name: "Scripts" }));
    expect(await screen.findByLabelText("Code")).toHaveProperty("value", 'print("hello")\n');
    expect(output().getByText("hello")).toBeTruthy();
    expect(screen.getByText("Python 3.14.2 ready")).toBeTruthy();
    expect(pythons.all.length).toBe(1); // it never stopped
});

test("while a script's open, Python gets its slow imports ready; a run waits for that, and says so", async () => {
    const pythons = fakePython();
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/scripts");
    await screen.findByLabelText("Code");
    const fake = pythons.latest();
    fake.say({ type: "ready", version: "3.14.2" });
    await type("from CoolProp.CoolProp import PropsSI\nprint(PropsSI)\n");
    expect((await fake.next("prepare")).code).toContain("from CoolProp.CoolProp import PropsSI");
    fake.say({ type: "progress", run: null, phase: "packages", packages: ["Pillow", "coolprop", "cycler"] });
    expect(
        await screen.findByText(
            /^Getting the script's imports ready: loading CoolProp and 2 packages it needs · \d+ s$/,
        ),
    ).toBeTruthy();
    fake.say({ type: "progress", run: null, phase: "import", module: "CoolProp.CoolProp" });
    expect(
        await screen.findByText(/^Getting the script's imports ready: importing CoolProp.CoolProp · \d+ s$/),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await output().findByText(/^Waiting for Python: importing CoolProp.CoolProp · \d+ s$/)).toBeTruthy();
    expect(output().getByText(/CoolProp reads its whole fluid library/)).toBeTruthy();
    expect(fake.count("run")).toBe(0);
    fake.say({ type: "prepared" });
    await fake.next("run");
});

test("Python that doesn't start says why, and starts again for a run, or when asked; the run waits for it", async () => {
    const pythons = fakePython();
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/scripts");
    await screen.findByLabelText("Code");
    const failed = "Python didn't start: Failed to fetch dynamically imported module";
    pythons.latest().say({ type: "failed", error: "Failed to fetch dynamically imported module" });
    expect(await screen.findByText(failed)).toBeTruthy();

    // A run tries again.
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(pythons.all.length).toBe(2);
    expect(await output().findByText(/^Waiting for Python: starting Python · \d+ s$/)).toBeTruthy();

    // It didn't start again either: the run waits for it to be started again.
    pythons.latest().say({ type: "failed", error: "Failed to fetch dynamically imported module" });
    expect(await output().findByText(failed)).toBeTruthy();
    expect(output().getByText("Start it again above, and the run goes on.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Start Python again" }));
    expect(pythons.all.length).toBe(3);
    pythons.latest().say({ type: "ready", version: "3.14.2" });
    await pythons.latest().next("run");
});

test("Python nothing's used for half an hour stops, to give its memory back, and starts when it's wanted", () => {
    vi.useFakeTimers();
    try {
        const pythons = fakePython();
        const release = python.acquire();
        expect(pythons.all.length).toBe(1);
        pythons.latest().say({ type: "ready", version: "3.14.2" });
        release();
        vi.advanceTimersByTime(29 * 60_000);
        expect(python.snapshot().status).toBe("ready");
        vi.advanceTimersByTime(60_000);
        expect(python.snapshot()).toMatchObject({ status: "off", idle: true });
        expect(pythons.latest().stopped).toBe(true);
        python.acquire()();
        expect(pythons.all.length).toBe(2);
    } finally {
        vi.useRealTimers();
    }
});
