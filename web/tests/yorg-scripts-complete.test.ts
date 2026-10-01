import { describe, expect, test } from "vitest";
import { handoffOf, modelsLink, starterScript, variableName } from "../src/yorg/analysis";
import { parseCells } from "../src/yorg/scripts/cells";
import { newLayout, newPanel, type Layout } from "../src/yorg/layout";
import { channelCode, completionAt, inString, testRef, type Attached } from "../src/yorg/scripts/complete";
import { channelsToLoad } from "../src/yorg/scripts/tree";

// The Python window's help as you write: suggestions, the channels loaded for a script, and scripts started from what
// a dataset's or view's page had.

const ATTACHED: Attached[] = [
    {
        id: 3,
        name: "Cold flow 1",
        channels: [
            { name: "PT-TANK", unit: "psig" },
            { name: "PT-MANIFOLD", unit: "psig" },
            { name: "FM-OX", unit: "lbm/s" },
        ],
    },
    {
        id: 4,
        name: "Hotfire 4",
        channels: [
            { name: "PT-TANK", unit: "psig" },
            { name: "PT-CHAMBER", unit: "psia" },
        ],
    },
];

/** A completion at the | in code. */
const at = (code: string, asked = false) => completionAt(code.replace("|", ""), code.indexOf("|"), ATTACHED, asked);

describe("suggestions", () => {
    test("in quotes after yorg.channel(: the attached tests' channels, a name once", () => {
        const found = at('pt = yorg.channel("PT|');
        expect(found?.items.map((item) => [item.label, item.detail])).toEqual([
            ["PT-TANK", "psig · Cold flow 1"],
            ["PT-MANIFOLD", "psig · Cold flow 1"],
            ["PT-CHAMBER", "psia · Hotfire 4"],
        ]);
        // Accepting one finishes the name and closes its quote.
        expect(found?.items[0]?.insert).toBe('PT-TANK"');
        expect(found?.from).toBe('pt = yorg.channel("'.length);
        // A quote already there isn't doubled.
        expect(at('yorg.channel("PT|")')?.items[0]?.insert).toBe("PT-TANK");
    });

    test("after dataset=: the tests", () => {
        expect(at('yorg.channel("PT-TANK", dataset="|')?.items.map((item) => item.label)).toEqual([
            "Cold flow 1",
            "Hotfire 4",
        ]);
    });

    test("letters matched anywhere, those starting with them first", () => {
        expect(at('x = "man|')?.items.map((item) => item.label)).toEqual(["PT-MANIFOLD"]);
        expect(at('x = "ta|')?.items.map((item) => item.label)).toEqual(["PT-TANK"]);
    });

    test("not unasked in any string, nor in a comment; always when asked", () => {
        expect(at('print("|')).toBeNull();
        expect(at('# yorg.channel("PT|')).toBeNull();
        expect(at('print("|', true)?.items.length).toBe(6); // every channel once, and both tests
    });

    test("after yorg.: what the module has, as the Reference says it", () => {
        const found = at("pt = yorg.ch|");
        expect(found?.items.map((item) => item.label)).toEqual(["channel", "channels", "Channel", "attached"]);
        expect(found?.from).toBe("pt = yorg.".length);
        expect(found?.items[0]).toMatchObject({ detail: "(name, dataset=None)", type: "function" });
        expect(found?.items[0]?.info).toMatch(/^A channel of a test attached under Data/);
        expect(at("x = yorg.lo|")?.items[0]).toMatchObject({
            label: "load",
            detail: "(name, dataset=None), with await",
        });
        expect(at("x = yorg.PS|")?.items[0]).toMatchObject({ label: "PSI", detail: "", type: "constant" });
    });

    test("asked on a word: a whole yorg.channel() of the test it's in", () => {
        const found = at("pt = cham|", true);
        expect(found?.items.map((item) => item.insert)).toEqual(['yorg.channel("PT-CHAMBER", dataset="Hotfire 4")']);
        expect(found?.from).toBe("pt = ".length);
    });

    test("a channel's code, and whether the caret is in a string", () => {
        expect(channelCode("PT-TANK", null)).toBe('yorg.channel("PT-TANK")');
        expect(channelCode("PT-TANK", "Hotfire 4")).toBe('yorg.channel("PT-TANK", dataset="Hotfire 4")');
        expect(channelCode("PT-TANK", 12)).toBe('yorg.channel("PT-TANK", dataset=12)');
        expect(inString('x = "PT-', 8)).toBe(true);
        expect(inString('x = "PT"', 8)).toBe(false);
    });

    test("two tests attached with one name (in two folders): the code names the other by its id", () => {
        const twins: Attached[] = [ATTACHED[0]!, ATTACHED[1]!, { ...ATTACHED[0]!, id: 9 }];
        expect(twins.map((_, index) => testRef(twins, index))).toEqual([null, "Hotfire 4", 9]);
        const code = 'yorg.channel("PT-TANK", dataset="';
        const tests = completionAt(code, code.length, twins, false);
        expect(tests?.items.map((item) => [item.label, item.insert])).toEqual([
            ["Cold flow 1 (3)", '3"'],
            ["Hotfire 4", 'Hotfire 4"'],
            ["Cold flow 1 (9)", '9"'],
        ]);
        const asked = completionAt("x = manif", 9, twins, true);
        expect(asked?.items.map((item) => item.insert)).toEqual([
            'yorg.channel("PT-MANIFOLD")',
            'yorg.channel("PT-MANIFOLD", dataset=9)',
        ]);
    });
});

describe("channels loaded before a script runs", () => {
    test("the first test's named in quotes, and another's when its name is in quotes too", () => {
        const tests = ATTACHED.map((one) => ({
            id: one.id,
            name: one.name,
            channels: one.channels.map((channel) => channel.name),
        }));
        expect(channelsToLoad('a = yorg.channel("PT-TANK")\nb = yorg.channel("FM-OX")', tests)).toEqual([
            { dataset: 3, channel: "PT-TANK" },
            { dataset: 3, channel: "FM-OX" },
        ]);
        expect(
            channelsToLoad('a = yorg.channel("PT-TANK")\nb = yorg.channel("PT-CHAMBER", dataset="Hotfire 4")', tests),
        ).toEqual([
            { dataset: 3, channel: "PT-TANK" },
            { dataset: 4, channel: "PT-TANK" },
            { dataset: 4, channel: "PT-CHAMBER" },
        ]);
        // Named by its id, bare or in quotes (not an id that only starts the same).
        for (const named of ["dataset=4)", 'dataset="4")', "dataset = 4)"]) {
            expect(channelsToLoad(`b = yorg.channel("PT-CHAMBER", ${named}`, tests)).toEqual([
                { dataset: 4, channel: "PT-CHAMBER" },
            ]);
        }
        expect(channelsToLoad('b = yorg.channel("PT-CHAMBER", dataset=41)', tests)).toEqual([]);
    });
});

describe("from a dataset's or view's page", () => {
    function layoutWith(): Layout {
        const layout = newLayout(3);
        const panel = newPanel();
        const series = (dataset: number, channel: string, formula: number | null = null) => ({
            id: `${dataset}${channel}`,
            dataset,
            channel,
            formula,
            label: "",
            color: "#000",
            scale: 1,
            offset: 0,
            unit: null,
            axis: "a",
            hidden: false,
            width: 1,
            step: null,
        });
        panel.series = [series(3, "PT-TANK"), series(4, "PT-TANK"), series(3, "PT-TANK"), series(3, "dP", 7)];
        return {
            ...layout,
            datasets: [
                { id: 3, shift: 0 },
                { id: 4, shift: -1.5 },
            ],
            panels: [panel],
            window: [10, 20],
        };
    }

    test("what it had goes along: its tests, the channels plotted (each once, no calculated ones), its time", () => {
        const handoff = handoffOf(layoutWith(), "Overlay");
        expect(handoff).toEqual({
            title: "Overlay",
            datasets: [3, 4],
            channels: [
                { dataset: 3, name: "PT-TANK" },
                { dataset: 4, name: "PT-TANK" },
            ],
            window: [10, 20],
        });
        expect(modelsLink(handoff)).toBe("/yorg/models?dataset=3&window=10,20");
    });

    test("a page's notebook starts by loading them, then each over the time in view, a moved test's by its clock", () => {
        const code = starterScript(handoffOf(layoutWith(), "Overlay"), { 3: "Cold flow 1", 4: "Hotfire 4" });
        expect(code).toContain('pt_tank = yorg.channel("PT-TANK")\n');
        expect(code).toContain('pt_tank_2 = yorg.channel("PT-TANK", dataset="Hotfire 4")\n');
        expect(code).toContain("start, end = yorg.window");
        expect(code).toContain("shift = yorg.shifts.get(channel.dataset_id, 0.0)");
        expect(code).toContain('print(f"{channel.name} ({channel.dataset}): mean');
        // A notebook: what it says it is, the channels loaded once, then what's done with them.
        expect(parseCells(code).map((cell) => [cell.kind, cell.title])).toEqual([
            ["markdown", ""],
            ["code", "Load the channels"],
            ["code", "Each one, in view"],
        ]);
    });

    test("two of its tests with one name: the notebook says which by id", () => {
        const code = starterScript(handoffOf(layoutWith(), "Twins"), { 3: "Cold flow 1", 4: "Cold flow 1" });
        expect(code).toContain('pt_tank_2 = yorg.channel("PT-TANK", dataset=4)\n');
        expect(code).toContain('print(f"{channel.name} ({channel.dataset} {channel.dataset_id}): mean');
    });

    test("Python names for channels", () => {
        const taken = new Set<string>();
        expect(["PT-TANK", "PT TANK", "1st PT", "Δ"].map((name) => variableName(name, taken))).toEqual([
            "pt_tank",
            "pt_tank_2",
            "ch_1st_pt",
            "ch_",
        ]);
    });
});
