import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp, Team } from "./team";

// Yorg's Python window (Scripts, in the preview for admins): scripts kept on the server in folders, uploaded as .py files, and the
// examples to start from. The scripts run in the browser with Pyodide, which jsdom can't: here, Python never gets
// ready unless a test says so (tests/python.ts; running is in yorg-scripts-python.test.tsx).

test("the Python window is for admins", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const asBob = renderApp(bob, "/yorg/dev/scripts");
    expect(await screen.findByText(/There's no page here/)).toBeTruthy();
    asBob.unmount();

    renderApp(team.chief, "/yorg/dev");
    await screen.findByRole("heading", { name: "Test data" });
    await userEvent.click(
        within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Scripts" }),
    );
    expect(await screen.findByRole("heading", { name: "Scripts" })).toBeTruthy();
    expect(await screen.findByText(/^Starting Python · \d+ s$/)).toBeTruthy(); // it starts with the page
});

test("scripts are opened from the examples, saved in folders, uploaded, changed, and deleted", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/scripts");
    const list = within(await screen.findByRole("complementary", { name: "Scripts" }));

    // An example, saved as a script of the team's own, in a folder.
    await userEvent.click(await list.findByRole("button", { name: "Start here: plot a channel" }));
    expect((screen.getByLabelText("Code") as HTMLTextAreaElement).value).toContain('yorg.channel("PT-TANK")');
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
    const code = screen.getByLabelText("Code") as HTMLTextAreaElement;
    await userEvent.clear(code);
    await userEvent.type(code, "print(1)");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true));

    // A .py file uploads as a script, into the folder open.
    const file = new File(["import numpy as np\nprint(np.pi)\n"], "pi check.py", { type: "text/x-python" });
    await userEvent.upload(screen.getByLabelText("Python files"), file);
    await waitFor(() => expect(list.getByRole("button", { name: "pi check" })).toBeTruthy());
    expect((screen.getByLabelText("Code") as HTMLTextAreaElement).value).toBe("import numpy as np\nprint(np.pi)\n");

    // The first one, opened again, has its change; then deleted.
    await userEvent.click(list.getByRole("button", { name: "Tank peak" }));
    await waitFor(() => expect((screen.getByLabelText("Code") as HTMLTextAreaElement).value).toBe("print(1)"));
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
    const code = screen.getByLabelText("Code") as HTMLTextAreaElement;
    await userEvent.clear(code);
    await userEvent.click(await first.findByRole("button", { name: /^FM-OX/ }));
    expect(code.value).toBe('yorg.channel("FM-OX")');
    await userEvent.type(code, "{End}\n");
    await userEvent.click(await second.findByRole("button", { name: /^PT-CHAMBER/ }));
    expect(code.value).toBe(`yorg.channel("FM-OX")\nyorg.channel("PT-CHAMBER", dataset="${chamber.name}")`);

    // In quotes, a few letters offer the channels that have them.
    await userEvent.type(code, '{End}\nt = yorg.channel("cham');
    const suggestions = within(await screen.findByRole("listbox", { name: "Suggestions" }));
    expect(suggestions.getAllByRole("option").map((option) => option.textContent)).toEqual([
        `PT-CHAMBERpsia · ${chamber.name}`,
    ]);
    await userEvent.keyboard("{Enter}");
    expect(code.value.endsWith('t = yorg.channel("PT-CHAMBER"')).toBe(true);

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
    const code = screen.getByLabelText("Code") as HTMLTextAreaElement;
    await userEvent.clear(code);
    await userEvent.click(await second.findByRole("button", { name: /^FM-OX/ }));
    expect(code.value).toBe(`yorg.channel("FM-OX", dataset=${other.id})`);
});
