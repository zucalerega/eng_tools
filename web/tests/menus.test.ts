import { describe, expect, test } from "vitest";
import { placeMenu } from "../src/components";

// Menus open under (or over) their buttons and stay whole in the window, whatever is near the edge.

const EMPTY = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) };

describe("menus stay on screen", () => {
    function menuFrom(anchor: Partial<DOMRect>, size: { width: number; height: number }, left = false) {
        const from = document.createElement("div");
        const menu = document.createElement("div");
        menu.className = left ? "menu menu-left" : "menu";
        const rect = (values: Partial<DOMRect>) => (() => ({ ...EMPTY, ...values })) as () => DOMRect;
        from.getBoundingClientRect = rect(anchor);
        menu.getBoundingClientRect = rect(size);
        placeMenu(menu, from);
        return { left: menu.style.left, top: menu.style.top, maxHeight: menu.style.maxHeight };
    }

    test("under its button, lined up with it, unless that runs off a side", () => {
        window.innerWidth = 1024;
        window.innerHeight = 768;
        const size = { width: 300, height: 200 };
        expect(menuFrom({ left: 600, right: 700, top: 100, bottom: 130 }, size)).toMatchObject({
            left: "400px",
            top: "136px",
        });
        // A button near the left edge (T0): the menu would run off the left, so it starts at the edge.
        expect(menuFrom({ left: 10, right: 60, top: 100, bottom: 130 }, size).left).toBe("8px");
        // One that lines up on the left (Axes), near the right edge: it moves in from the right.
        expect(menuFrom({ left: 950, right: 1010, top: 100, bottom: 130 }, size, true).left).toBe("716px");
    });

    test("over its button when there's no room under it, and scrolling when there's none either way", () => {
        expect(menuFrom({ left: 600, right: 700, top: 700, bottom: 730 }, { width: 300, height: 200 }).top).toBe(
            "494px",
        );
        const tall = menuFrom({ left: 600, right: 700, top: 300, bottom: 330 }, { width: 300, height: 900 });
        expect(tall.maxHeight).toBe("424px"); // the room under it, which is more than over it
    });
});
