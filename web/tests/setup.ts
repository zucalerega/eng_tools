import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach } from "vitest";
import { setAdminMode } from "../src/vault/admin";
import { python } from "../src/yorg/scripts/python";
import { FakePython } from "./python";

// What a test waits for often takes a round trip or two to the real server, then a sync: on a busy
// computer (SolidWorks or MATLAB running alongside), an upload and its check-in can take a few seconds.
configure({ asyncUtilTimeout: 10_000 });

// jsdom has no canvas to draw on, and says so every time something asks for one. Yorg's plots draw nothing
// without one; what they show is tested through the numbers behind them (yorg-math.test.ts).
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

// The app updates itself from the server in the background (the sync feed), so React reports
// those updates as "not wrapped in act(...)". The tests wait for what they expect to see instead.
beforeAll(() => {
    const report = console.error;
    console.error = (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].includes("not wrapped in act(")) {
            return;
        }
        report(...args);
    };
});

// The Python window's editor (CodeMirror) measures text by its ranges, which jsdom lays out nowhere: they're empty.
const nowhere = { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getBoundingClientRect = () => nowhere as DOMRect;
Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

// The tab's Python lives as long as the tab: each test starts with its own, which says nothing unless the test tells
// it to (tests/python.ts).
beforeEach(() => python.reset(() => new FakePython()));

afterEach(() => {
    cleanup();
    setAdminMode(false);
    localStorage.clear(); // choices remembered in the browser, like the sort
    sessionStorage.clear(); // and in this tab, like the script open
});
