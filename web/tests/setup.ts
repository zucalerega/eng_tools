import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeAll } from "vitest";
import { setAdminMode } from "../src/admin";

// What a test waits for often takes a round trip or two to the real server, then a sync: on a busy
// computer (SolidWorks or MATLAB running alongside), an upload and its check-in can take a few seconds.
configure({ asyncUtilTimeout: 10_000 });

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

afterEach(() => {
    cleanup();
    setAdminMode(false);
    localStorage.clear(); // choices remembered in the browser, like the sort
});
