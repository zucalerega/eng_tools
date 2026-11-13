import { describe, expect, test } from "vitest";
import { EnvironmentImportError, parseEnvironmentImport } from "../src/tempo/examples";

describe("parseEnvironmentImport", () => {
    test("rejects malformed JSON without throwing unhandled syntax errors", () => {
        expect(() => parseEnvironmentImport("{ not valid json")).toThrow(EnvironmentImportError);
        expect(() => parseEnvironmentImport("")).toThrow(/empty/i);
    });

    test("rejects missing required keys", () => {
        expect(() => parseEnvironmentImport({ valves: [] })).toThrow(/"sensors"/i);
        expect(() => parseEnvironmentImport({ sensors: [] })).toThrow(/"valves"/i);
        expect(() => parseEnvironmentImport([])).toThrow(/object/i);
    });

    test("rejects invalid or missing sensor units", () => {
        expect(() =>
            parseEnvironmentImport({
                valves: [{ name: "FBB", initial: "CLOSED" }],
                sensors: [
                    {
                        name: "FTPT",
                        unit: "bar",
                        mode: "time",
                        samples: [{ at: 0, value: 100 }],
                    },
                ],
            }),
        ).toThrow(/invalid unit/i);

        expect(() =>
            parseEnvironmentImport({
                valves: [{ name: "FBB", initial: "CLOSED" }],
                sensors: [
                    {
                        name: "FTPT",
                        mode: "time",
                        samples: [{ at: 0, value: 100 }],
                    },
                ],
            }),
        ).toThrow(/missing or invalid unit/i);
    });

    test("rejects incomplete truth tables for valve-driven sensors", () => {
        expect(() =>
            parseEnvironmentImport({
                valves: [
                    { name: "FBB", initial: "CLOSED" },
                    { name: "FVV", initial: "CLOSED" },
                ],
                sensors: [
                    {
                        name: "FTPT",
                        unit: "psi",
                        mode: "valve",
                        initial: 0,
                        valves: ["FBB", "FVV"],
                        rates: { "00": -1, "10": 15 },
                    },
                ],
            }),
        ).toThrow(/incomplete truth table.*01.*11/i);
    });

    test("accepts valid modern and legacy environment JSON formats", () => {
        const modern = parseEnvironmentImport(
            JSON.stringify({
                valves: [{ name: "FBB", initial: "OPEN" }],
                sensors: [
                    {
                        name: "FTPT",
                        unit: "psi",
                        mode: "valve",
                        initial: 250,
                        min: 0,
                        max: 500,
                        valves: ["FBB"],
                        rates: { "0": -5, "1": 25 },
                        interpolation: "linear",
                    },
                ],
            }),
        );
        expect(modern.valves).toEqual([{ name: "FBB", initial: "OPEN" }]);
        expect(modern.sensors[0]?.rates).toEqual({ "0": -5, "1": 25 });

        // Legacy string-valve + scalar sensor value format
        const legacy = parseEnvironmentImport(
            "\uFEFF" +
                JSON.stringify({
                    valves: ["press_valve"],
                    sensors: [{ name: "tank_pt", unit: "psi", value: 14.7 }],
                }),
        );
        expect(legacy.valves).toEqual([{ name: "press_valve", initial: "CLOSED" }]);
        expect(legacy.sensors[0]?.samples).toEqual([{ at: 0, value: 14.7 }]);
    });
});
