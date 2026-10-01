import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import type { ToPython } from "../src/yorg/scripts/sandbox";
import { cell, cellCount, codeOf, editorOf, press, setCode, typeIn } from "./notebook";
import { fakePython, type FakePython } from "./python";
import { renderApp, Team } from "./team";

// The Python window's notebook: cells that run one at a time in the notebook's variables, numbered as they run; run
// all, which stops at a cell that fails; Jupyter's keys; cells kept as "# %%" marks in the script; and the editor's
// suggestions and syntax errors from the notebook's Python. Python is a stand-in (tests/python.ts).

const runs = (fake: FakePython) =>
    fake.received.filter((one): one is Extract<ToPython, { type: "run" }> => one.type === "run");

const bar = () => within(screen.getByRole("toolbar", { name: "Notebook" }));

/** The Scripts page, its first cell holding code, and its Python ready. */
async function notebookWith(code: string): Promise<FakePython> {
    const pythons = fakePython();
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/scripts");
    await setCode(1, code);
    const fake = pythons.latest();
    fake.say({ type: "ready", version: "3.14.2" });
    return fake;
}

test("a notebook's cells run one at a time in its variables, numbered as they run", async () => {
    const fake = await notebookWith("x = 2");
    await userEvent.click(bar().getByRole("button", { name: "+ Code" }));
    await setCode(2, "print(x * 21)");

    await userEvent.click(bar().getByRole("button", { name: "Run all" }));
    await fake.next("run");
    const [first] = runs(fake);
    expect(first).toMatchObject({ code: "x = 2", filename: "<In [1]>" });
    expect(first!.namespace).toBeTruthy();
    expect(runs(fake).length).toBe(1); // one at a time
    fake.say({ type: "done", run: first!.run, elapsed: 0.01, timings: [] });

    await waitFor(() => expect(runs(fake).length).toBe(2));
    const second = runs(fake)[1]!;
    expect(second).toMatchObject({ code: "print(x * 21)", filename: "<In [2]>", namespace: first!.namespace });
    fake.say({ type: "stdout", run: second.run, text: "42" });
    fake.say({ type: "done", run: second.run, elapsed: 0.01, timings: [] });
    expect(await within(cell(2)).findByText("[2]")).toBeTruthy();
    expect(within(cell(1)).getByText("[1]")).toBeTruthy();
    expect(within(cell(2)).getByText("42")).toBeTruthy();
});

test("run all stops at a cell that fails: those after it don't run", async () => {
    const fake = await notebookWith("a = 1");
    await userEvent.click(bar().getByRole("button", { name: "+ Code" }));
    await setCode(2, "b = a / 0");
    await userEvent.click(bar().getByRole("button", { name: "+ Code" }));
    await setCode(3, "print(b)");

    await userEvent.click(bar().getByRole("button", { name: "Run all" }));
    await fake.next("run");
    fake.say({ type: "done", run: runs(fake)[0]!.run, elapsed: 0.01, timings: [] });
    await waitFor(() => expect(runs(fake).length).toBe(2));
    fake.say({
        type: "error",
        run: runs(fake)[1]!.run,
        text: 'Traceback (most recent call last):\n  File "<In [2]>", line 1, in <module>\nZeroDivisionError',
        line: 1,
        elapsed: 0.01,
        timings: [],
    });
    expect(await within(cell(3)).findByText("A cell run before it failed, so it wasn't run.")).toBeTruthy();
    expect(within(cell(3)).getAllByText("Not run").length).toBeGreaterThan(0);
    expect(runs(fake).length).toBe(2);
});

test("after Python starts again, a cell's output from before says so", async () => {
    const fake = await notebookWith("x = 1");
    await userEvent.click(screen.getByRole("button", { name: "Run cell 1" }));
    await fake.next("run");
    fake.say({ type: "done", run: runs(fake)[0]!.run, elapsed: 0.01, timings: [] });
    expect(await within(cell(1)).findByText(/^Done in /)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Restart Python" }));
    expect(await within(cell(1)).findByText(/· before Python started again$/)).toBeTruthy();
});

test("Shift+Enter runs a cell and goes on, to a new one at the end", async () => {
    const fake = await notebookWith("print(1)");
    await press(1, "Enter", { shiftKey: true });
    expect((await fake.next("run")).code).toBe("print(1)");
    await waitFor(() => expect(cellCount()).toBe(2));
    await waitFor(() => expect(cell(2).contains(document.activeElement)).toBe(true));
    expect(await codeOf(1)).toBe("print(1)"); // no new line in it
});

test("Escape leaves a cell's code for the notebook's keys: B adds a cell, M makes it text, D D deletes it", async () => {
    await notebookWith("a = 1");
    await press(1, "Escape");
    await waitFor(() => expect(document.activeElement).toBe(cell(1)));

    fireEvent.keyDown(cell(1), { key: "b" });
    await waitFor(() => expect(cellCount()).toBe(2));
    await editorOf(2);
    await press(2, "Escape");
    await waitFor(() => expect(document.activeElement).toBe(cell(2)));
    fireEvent.keyDown(cell(2), { key: "m" });
    await setCode(2, "# Notes\nThe tank's **pressure**.");
    await press(2, "Escape");
    expect(await within(cell(2)).findByRole("heading", { name: "Notes" })).toBeTruthy();
    expect(within(cell(2)).getByText("pressure").tagName).toBe("STRONG");

    await waitFor(() => expect(document.activeElement).toBe(cell(2)));
    fireEvent.keyDown(cell(2), { key: "d" });
    fireEvent.keyDown(cell(2), { key: "d" });
    await waitFor(() => expect(cellCount()).toBe(1));
    expect(await codeOf(1)).toBe("a = 1");
});

test("a notebook is saved as a script with a # %% mark for each cell, and opens again as its cells", async () => {
    const pythons = fakePython();
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/scripts");
    await setCode(1, "pt = 1");
    pythons.latest().say({ type: "ready", version: "3.14.2" });
    await userEvent.type(screen.getByLabelText("Cell 1's title"), "Load");
    await userEvent.click(bar().getByRole("button", { name: "+ Text" }));
    await setCode(2, "# Notes\nWhat it's for.");

    await userEvent.click(screen.getByRole("button", { name: "Save as…" }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.clear(dialog.getByLabelText("Name"));
    await userEvent.type(dialog.getByLabelText("Name"), "Cells");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    const list = within(screen.getByRole("complementary", { name: "Scripts" }));
    await waitFor(() => expect(list.getByRole("button", { name: "Cells" })).toBeTruthy());
    expect((await team.script(team.chief, "Cells")).code).toBe(
        "# %% Load\npt = 1\n\n# %% [markdown]\n# # Notes\n# What it's for.\n",
    );

    await userEvent.click(list.getByRole("button", { name: "New script" }));
    await waitFor(() => expect(cellCount()).toBe(1));
    await userEvent.click(list.getByRole("button", { name: "Cells" }));
    await waitFor(() => expect(cell(1).getAttribute("aria-label")).toBe("Cell 1: Load"));
    expect(await codeOf(1)).toBe("pt = 1");
    expect(await within(cell(2)).findByRole("heading", { name: "Notes" })).toBeTruthy();
});

test("the editor suggests what Python's variables have, and underlines a syntax error as Python reads it", async () => {
    const fake = await notebookWith("");
    fake.services = (question) =>
        question.what === "complete"
            ? [
                  { label: "values", type: "instance" },
                  { label: "si", type: "function" },
              ]
            : question.what === "check" && question.code.includes("1 2")
              ? { line: 1, column: 8, end_line: 1, end_column: 9, message: "invalid syntax" }
              : null;

    await typeIn(1, "pt.");
    const suggestions = within(await screen.findByRole("listbox"));
    await waitFor(() =>
        expect(suggestions.getAllByRole("option").map((option) => option.textContent)).toEqual(["si", "values"]),
    );
    const asked = fake.received.find(
        (one): one is Extract<ToPython, { type: "service" }> => one.type === "service" && one.what === "complete",
    );
    expect(asked).toMatchObject({ code: "pt.", line: 1, column: 3 });
    expect(asked!.namespace).toBeTruthy();

    await setCode(1, "print(1 2)");
    await waitFor(() => expect(cell(1).querySelector(".cm-lintRange-error")?.textContent).toBe("2"));
});
