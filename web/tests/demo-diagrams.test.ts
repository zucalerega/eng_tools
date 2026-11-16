import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { documentOf, type Drawing } from "../src/piper/drawing";
import { example } from "../src/piper/example";
import { coldFlow, pressurizedFlow } from "../src/piper/sim/examples";

// The demo's P&IDs (server/src/yjsp_server/demo/diagrams), which its seed saves as Piper's: the examples a new diagram
// can start from, drawn by the editor's own changes as they're drawn now. After changing an example, write them again:
// `npm test -- -u demo-diagrams`. Each part's and line's id comes from the time and chance (newId): here both stand
// still, so a file changes only when its drawing does.

const DIAGRAMS: [string, () => Drawing][] = [
    ["feed-system", example],
    ["cold-flow", coldFlow],
    ["pressurized-flow", pressurizedFlow],
];

/** The same numbers every run, in place of Math.random: a linear congruential generator. */
function steady(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
    };
}

beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-09-01T12:00:00Z"), toFake: ["Date"] });
    vi.spyOn(Math, "random").mockImplementation(steady(2026));
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

test.each(DIAGRAMS)("the demo's %s is Piper's example as it's drawn now", async (name, drawing) => {
    const saved = JSON.stringify(documentOf(drawing()), null, 1) + "\n";
    await expect(saved).toMatchFileSnapshot(`../../server/src/yjsp_server/demo/diagrams/${name}.json`);
});
