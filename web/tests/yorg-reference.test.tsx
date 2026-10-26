import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ENTRIES } from "../src/yorg/scripts/docs";
import source from "../src/yorg/scripts/yorg.py?raw";
import { codeOf, setCode } from "./notebook";
import { fakePython } from "./python";
import { renderApp, Team } from "./team";

// The yorg module's Reference (docs.ts): what yorg.py has, each name as it's defined there; beside a script on the
// Scripts page, and in a page's docked Python in its notebook's place; found by a word, and opened for an example
// that goes into the code. Python is a stand-in (tests/python.ts).

/** What yorg.py defines that a script can use: "yorg.plot" or "Channel.between", to how it's defined ("" a value). */
function defined(): Map<string, string> {
    const found = new Map<string, string>();
    let owner: string | null = null; // the class the lines are in
    for (const line of source.split("\n")) {
        if (/^\S/.test(line)) {
            owner = null; // back at the module's own level
        }
        const named = /^class ([A-Za-z]\w*)/.exec(line);
        const made = /^ {4}def __init__\(self, (.*)\):$/.exec(line);
        const method = /^ {4}def ([A-Za-z]\w*)\(self(?:, )?(.*)\):$/.exec(line);
        const fn = /^(async )?def ([A-Za-z]\w*)\((.*)\):$/.exec(line);
        const value = /^([A-Za-z]\w*) = /.exec(line);
        if (named) {
            owner = named[1]!;
        } else if (made && owner) {
            found.set(`yorg.${owner}`, `(${made[1]})`);
        } else if (method && owner) {
            found.set(`${owner}.${method[1]}`, `(${method[2]})`);
        } else if (fn) {
            found.set(`yorg.${fn[2]}`, `${fn[1] ?? ""}(${fn[3]})`);
        } else if (value) {
            found.set(`yorg.${value[1]}`, "");
        }
    }
    return found;
}

test("the Reference has every name yorg.py has, as yorg.py defines it, and none it doesn't", () => {
    const documented = new Map(
        ENTRIES.filter((entry) => entry.of !== null).map((entry) => [
            `${entry.of}.${entry.name}`,
            `${entry.kind === "async" ? "async " : ""}${entry.signature}`,
        ]),
    );
    expect(documented).toEqual(defined());
    expect(defined().get("yorg.plot")).toBe('(x, y=None, name=None, unit="", title=None)'); // it reads yorg.py
});

const example = (of: string, name: string) => ENTRIES.find((entry) => entry.of === of && entry.name === name)!.example!;

test("beside a script, the Reference finds yorg's names and puts an example into the code", async () => {
    fakePython();
    const team = await Team.create();
    renderApp(team.chief, "/yorg/scripts");
    await setCode(1, 'pt = yorg.channel("PT-TANK")');

    await userEvent.click(screen.getByRole("button", { name: "Reference" }));
    const reference = within(await screen.findByRole("complementary", { name: "Reference" }));
    expect(screen.queryByRole("complementary", { name: "Data" })).toBeNull(); // in its place

    // Found by its name: yorg.plot (and matplotlib), not everything that mentions a plot.
    await userEvent.type(reference.getByLabelText("Find in the reference"), "plot");
    expect(reference.getByRole("button", { name: /^yorg\.plot\(x, y=None/ })).toBeTruthy();
    expect(reference.queryByText("window")).toBeNull();
    // A word in none of the names: what it's in.
    await userEvent.clear(reference.getByLabelText("Find in the reference"));
    await userEvent.type(reference.getByLabelText("Find in the reference"), "gauge");
    expect(reference.getByRole("button", { name: /^yorg\.si\(values/ })).toBeTruthy();
    expect(reference.queryByRole("button", { name: /^yorg\.plot\(/ })).toBeNull();

    await userEvent.clear(reference.getByLabelText("Find in the reference"));
    await userEvent.click(reference.getByRole("button", { name: /^yorg\.plot\(/ }));
    expect(reference.getByText(/same title share a plot/)).toBeTruthy();
    await userEvent.click(reference.getByRole("button", { name: "Insert the example of yorg.plot" }));
    await waitFor(async () => expect(await codeOf(1)).toBe(`pt = yorg.channel("PT-TANK")\n${example("yorg", "plot")}`));

    // Data, back in its place.
    await userEvent.click(screen.getByRole("button", { name: "Data" }));
    expect(await screen.findByRole("complementary", { name: "Data" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Reference" })).toBeNull();
});

test("a page's Python has the Reference in its notebook's place, and an example goes back into the code", async () => {
    fakePython();
    const team = await Team.create();
    const data = await team.data(team.chief, "Cold flow", ["Time (s),PT-TANK (psig)", "0,300", "1,301"].join("\n"));
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await userEvent.click(await channels.findByRole("button", { name: /PT-TANK/ }));
    await userEvent.click(screen.getByRole("button", { name: "Python" }));
    const dock = within(await screen.findByRole("complementary", { name: "Python" }));
    await waitFor(async () => expect(await codeOf(2)).toContain('pt_tank = yorg.channel("PT-TANK")'));

    await userEvent.click(dock.getByRole("button", { name: "Reference" }));
    const reference = within(dock.getByRole("complementary", { name: "Reference" }));
    expect(dock.queryByRole("toolbar", { name: "Notebook" })).toBeNull(); // the notebook's hidden meanwhile
    await userEvent.type(reference.getByLabelText("Find in the reference"), "between");
    await userEvent.click(reference.getByRole("button", { name: /^Channel\.between\(/ }));
    await userEvent.click(reference.getByRole("button", { name: "Insert the example of Channel.between" }));

    expect(dock.queryByRole("complementary", { name: "Reference" })).toBeNull();
    expect(dock.getByRole("toolbar", { name: "Notebook" })).toBeTruthy();
    await waitFor(async () => expect(await codeOf(2)).toContain(example("Channel", "between")));
});
