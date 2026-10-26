import { expect, test } from "vitest";
import { emptyDrawing } from "../src/piper/drawing";
import { applyScheme, fluidOf, isGas, monochrome, schemeChanged, type SchemeColors } from "../src/piper/fluids";

// A diagram in a color scheme's colors: taken into its drawing, so it draws (and prints) the same anywhere, and noted,
// to see when the scheme's changed.

const SCHEME: SchemeColors = {
    id: 7,
    name: "Stand",
    fluids: [
        { id: "lox", name: "Liquid oxygen", label: "LOX", color: "#0000ff", gas: false },
        { id: "steam", name: "Steam", label: "STM", color: "#cccccc", gas: true },
    ],
    states: { no: "#00ff00", nc: "#ff0000", fip: "#888888", other: "#ffaa00" },
    updated_at: "2026-10-25T12:00:00Z",
};

test("a scheme's fluids and states become the diagram's own, over what it had, its other own fluids kept", () => {
    const before = {
        ...emptyDrawing(),
        fluids: [
            { id: "lox", name: "LOX", label: "O2", color: "#123456" },
            { id: "kero", name: "Kerosene", label: "KERO", color: "#654321" },
        ],
    };
    const after = applyScheme(before, SCHEME);
    expect(fluidOf(after, "lox")).toEqual(SCHEME.fluids[0]);
    expect(fluidOf(after, "kero")?.color).toBe("#654321");
    expect(isGas(after, "steam")).toBe(true);
    expect(isGas(after, "gn2")).toBe(true); // a standard one it doesn't name: as the standard has it
    expect(after.style).toMatchObject({ no: "#00ff00", nc: "#ff0000", fip: "#888888", scheme: "7" });
    expect(schemeChanged(after, SCHEME)).toBe(false);
    expect(schemeChanged(after, { ...SCHEME, updated_at: "2026-10-26T09:00:00Z" })).toBe(true);
    expect(schemeChanged(after, { ...SCHEME, id: 8, updated_at: "2026-10-26T09:00:00Z" })).toBe(false); // not its
});

test("in black and white, every line's in ink, and valves are told apart by their fill", () => {
    const drawing = monochrome(applyScheme(emptyDrawing(), SCHEME));
    expect(
        new Set([fluidOf(drawing, "lox")?.color, fluidOf(drawing, "rp1")?.color, fluidOf(drawing, "steam")?.color]),
    ).toEqual(new Set(["#1b2433"]));
    expect([drawing.style.no, drawing.style.nc]).toEqual(["#ffffff", "#1b2433"]);
});
