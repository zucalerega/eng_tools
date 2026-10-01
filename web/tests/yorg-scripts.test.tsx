import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { acceptSuggestion, cell, codeOf, setCode, typeIn } from "./notebook";
import { renderApp, Team } from "./team";

// Yorg's Python window (Scripts, everyone's): scripts kept on the server in folders, uploaded as .py files, and the
// examples to start from; each a notebook of cells. The scripts run in the browser with Pyodide, which
// jsdom can't: here, Python never gets ready unless a test says so (tests/python.ts; running is in
// yorg-scripts-python.test.tsx and yorg-notebook.test.tsx).

test("everyone has the Python window: a script is changed by whoever saved it, another's saved as a copy", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const alice = await team.member("Alice");
    const name = `Bob's ${team.folder}`;

    // Bob, on the site: Scripts is in the top bar, and Python starts with the page.
    const asBob = renderApp(bob, "/yorg");
    await screen.findByRole("heading", { name: "Test data" });
    await userEvent.click(
        within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Scripts" }),
    );
    expect(await screen.findByRole("heading", { name: "Scripts" })).toBeTruthy();
    expect(window.location.pathname).toBe("/yorg/scripts");
    expect(await screen.findByText(/^Starting Python · \d+ s$/)).toBeTruthy();

    // He saves one of his own, his to delete.
    await setCode(1, 'print("Bob\'s")');
    await userEvent.click(screen.getByRole("button", { name: "Save" })); // a new one: Save asks for its name
    let dialog = within(screen.getByRole("dialog"));
    await userEvent.clear(dialog.getByLabelText("Name"));
    await userEvent.type(dialog.getByLabelText("Name"), name);
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    const bobs = within(screen.getByRole("complementary", { name: "Scripts" }));
    await waitFor(() => expect(bobs.getByRole("button", { name })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Delete…" })).toBeTruthy();
    asBob.unmount();

    // Alice opens it, to run and change: saving keeps a copy of her own, and Bob's isn't hers to delete.
    renderApp(alice, "/yorg/scripts");
    const alices = within(await screen.findByRole("complementary", { name: "Scripts" }));
    await userEvent.click(await alices.findByRole("button", { name }));
    expect(await screen.findByText("Someone else's")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();
    await setCode(1, 'print("Alice\'s")');
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    dialog = within(screen.getByRole("dialog"));
    expect((dialog.getByLabelText("Name") as HTMLInputElement).value).toBe(`${name} copy`);
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(alices.getByRole("button", { name: `${name} copy` })).toBeTruthy());
    expect(screen.queryByText("Someone else's")).toBeNull();
    expect((await team.script(bob, name)).code).toContain('print("Bob\'s")'); // as Bob saved it
    expect((await team.script(alice, `${name} copy`)).code).toContain('print("Alice\'s")');
});

test("scripts are opened from the examples, saved in folders, uploaded, changed, and deleted", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/scripts");
    const list = within(await screen.findByRole("complementary", { name: "Scripts" }));

    // An example: a notebook, its text first, then its cells of code.
    await userEvent.click(await list.findByRole("button", { name: "Start here: plot a channel" }));
    expect(await within(cell(1)).findByRole("heading", { name: "Start here" })).toBeTruthy();
    expect(cell(2).getAttribute("aria-label")).toBe("Cell 2: Load the data");
    expect(await codeOf(2)).toContain('pt = yorg.channel("PT-TANK")');

    // Saved as a script of the team's own, in a folder.
    await userEvent.click(screen.getByRole("button", { name: "Save as…" }));
    let dialog = within(screen.getByRole("dialog"));
    await userEvent.clear(dialog.getByLabelText("Name"));
    await userEvent.type(dialog.getByLabelText("Name"), "Tank peak");
    await userEvent.type(dialog.getByLabelText("Folder"), "Hotfires / Tanks");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(list.getByRole("button", { name: "Tank peak" })).toBeTruthy());
    expect(list.getByRole("button", { name: "▾ Hotfires" })).toBeTruthy();
    expect(list.getByRole("button", { name: "▾ Tanks" })).toBeTruthy();
    expect((screen.getByLabelText("Folder") as HTMLInputElement).value).toBe("Hotfires/Tanks");

    // Changed and saved again.
    await setCode(2, "print(1)");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true));

    // A .py file uploads as a script, into the folder open: a notebook of one cell, without marks.
    const file = new File(["import numpy as np\nprint(np.pi)\n"], "pi check.py", { type: "text/x-python" });
    await userEvent.upload(screen.getByLabelText("Python files"), file);
    await waitFor(() => expect(list.getByRole("button", { name: "pi check" })).toBeTruthy());
    await waitFor(async () => expect(await codeOf(1)).toBe("import numpy as np\nprint(np.pi)"));
    expect(screen.queryByRole("region", { name: /^Cell 2/ })).toBeNull();

    // The first one, opened again, has its change, in its cells; then deleted.
    await userEvent.click(list.getByRole("button", { name: "Tank peak" }));
    await waitFor(async () => expect(await codeOf(2)).toBe("print(1)"));
    expect(cell(3).getAttribute("aria-label")).toBe("Cell 3: Its peak");
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    dialog = within(screen.getByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(list.queryByRole("button", { name: "Tank peak" })).toBeNull());
    expect(list.getByRole("button", { name: "pi check" })).toBeTruthy();
});

// Two tests, each a few channels.
const TANK = ["Time (s),PT-TANK (psig),FM-OX (lbm/s)", "0,300,0", "1,301,2.5", "2,299,2.5"].join("\n");
const CHAMBER = ["Time (s),PT-TANK (psig),PT-CHAMBER (psia)", "0,300,14.7", "1,280,250", "2,290,14.7"].join("\n");

test("a script works on the tests attached to it: their channels go in the code by a click or a few letters", async () => {
    const team = await Team.create();
    const tank = await team.data(team.chief, "Tank test", TANK);
    const chamber = await team.data(team.chief, "Chamber test", CHAMBER);
    renderApp(team.chief, "/yorg/dev/scripts");
    const data = within(await screen.findByRole("complementary", { name: "Data" }));
    expect(data.getByText("No test attached yet.")).toBeTruthy();

    // Two tests attached: the first is the one yorg.channel() takes from.
    await waitFor(() => expect(data.getAllByRole("option", { name: tank.name }).length).toBeGreaterThan(0));
    await userEvent.selectOptions(data.getByLabelText("Attach a test"), tank.name);
    await userEvent.selectOptions(data.getByLabelText("Attach a test"), chamber.name);
    const first = within(await data.findByRole("region", { name: tank.name }));
    const second = within(data.getByRole("region", { name: chamber.name }));
    expect(first.getByText("first")).toBeTruthy();
    expect(first.getByRole("link", { name: `${tank.name} ↗` }).getAttribute("href")).toBe(
        `/yorg/dev/datasets/${tank.id}`,
    );

    // A click puts a channel in at the cursor: the first test's as it is, another's with its name.
    await setCode(1, "");
    await userEvent.click(await first.findByRole("button", { name: /^FM-OX/ }));
    expect(await codeOf(1)).toBe('yorg.channel("FM-OX")');
    await typeIn(1, "\n");
    await userEvent.click(await second.findByRole("button", { name: /^PT-CHAMBER/ }));
    expect(await codeOf(1)).toBe(`yorg.channel("FM-OX")\nyorg.channel("PT-CHAMBER", dataset="${chamber.name}")`);

    // In quotes, a few letters offer the channels that have them; Enter takes one.
    await typeIn(1, '\nt = yorg.channel("cham');
    const suggestions = within(await screen.findByRole("listbox"));
    await waitFor(() =>
        expect(suggestions.getAllByRole("option").map((option) => option.textContent)).toEqual([
            `PT-CHAMBERpsia · ${chamber.name}`,
        ]),
    );
    await acceptSuggestion(1);
    await waitFor(async () => expect((await codeOf(1)).endsWith('t = yorg.channel("PT-CHAMBER"')).toBe(true));

    // Saved, the script keeps its tests.
    await userEvent.click(screen.getByRole("button", { name: "Save as…" }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.clear(dialog.getByLabelText("Name"));
    await userEvent.type(dialog.getByLabelText("Name"), "Two tests");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    const list = within(screen.getByRole("complementary", { name: "Scripts" }));
    await waitFor(() => expect(list.getByRole("button", { name: "Two tests" })).toBeTruthy());
    await userEvent.click(data.getByRole("button", { name: `Detach ${chamber.name}` }));
    expect(data.queryByRole("region", { name: chamber.name })).toBeNull();
    await userEvent.click(list.getByRole("button", { name: "Start here: plot a channel" }));
    await userEvent.click(screen.getByRole("button", { name: "Leave them" })); // detaching was a change
    await userEvent.click(list.getByRole("button", { name: "Two tests" }));
    expect(await data.findByRole("region", { name: chamber.name })).toBeTruthy();
});

test("two tests with one name (in two folders): each shows its id, and the code names the other by it", async () => {
    const team = await Team.create();
    const one = await team.data(team.chief, "Twin", TANK);
    const other = await team.data(team.chief, "Twin", TANK);
    expect(other.name).toBe(one.name);
    renderApp(team.chief, "/yorg/dev/scripts");
    const data = within(await screen.findByRole("complementary", { name: "Data" }));
    const label = (id: number) => `${one.name} (${id})`;
    await waitFor(() => expect(data.getAllByRole("option", { name: label(other.id) }).length).toBe(1));
    await userEvent.selectOptions(data.getByLabelText("Attach a test"), label(one.id));
    await userEvent.selectOptions(data.getByLabelText("Attach a test"), label(other.id));
    const second = within(await data.findByRole("region", { name: label(other.id) }));
    await setCode(1, "");
    await userEvent.click(await second.findByRole("button", { name: /^FM-OX/ }));
    expect(await codeOf(1)).toBe(`yorg.channel("FM-OX", dataset=${other.id})`);
});
