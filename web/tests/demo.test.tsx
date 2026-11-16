import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, inject, onTestFinished, test } from "vitest";
import { App } from "../src/App";
import { configureApi } from "../src/api";
import { SessionContext, SessionStore } from "../src/session";
import { StoreContext, VaultStore } from "../src/vault/store";

// The demo, at /demo: the tests' site passes it on to the demo's own server, seeded with its made-up data and in demo
// mode (server.ts), as the live site does. The page says the root (api/web.py's meta tag), and the app keeps to it.

beforeAll(async () => {
    await Promise.all([
        import("../src/buildflow/Programs"),
        import("../src/buildflow/Program"),
        import("../src/piper/Diagrams"),
        import("../src/piper/Editor"),
    ]);
});

/** The web app at a page of the demo, as anyone: no sign-in, the root on the page, as the server serves it. */
function renderDemo(page: string) {
    const meta = document.createElement("meta");
    meta.name = "yjsp-root";
    meta.content = "/demo";
    document.head.append(meta);
    configureApi({ baseUrl: inject("serverUrl"), token: null });
    window.history.pushState(null, "", "/demo" + page);
    const session = new SessionStore();
    session.start();
    const store = new VaultStore(session, 150);
    onTestFinished(() => {
        store.stop();
        session.stop();
        meta.remove();
    });
    return render(
        <SessionContext.Provider value={session}>
            <StoreContext.Provider value={store}>
                <App />
            </StoreContext.Provider>
        </SessionContext.Provider>,
    );
}

test("anyone sees the demo as its guest, under a banner that says what it is", async () => {
    renderDemo("/");
    expect(await screen.findByText(/Made-up data, for a look around: nothing here can be changed/)).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Account: Guest" }));
    expect(screen.getByText("guest@demo.invalid")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change your name…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    // Its links stay in the demo.
    const apps = within(screen.getByRole("navigation", { name: "Apps" }));
    expect(apps.getByRole("link", { name: "Vault" }).getAttribute("href")).toBe("/demo/vault");
    expect(screen.getByRole("link", { name: "What it does" }).getAttribute("href")).toBe("/demo/help");
});

test("the demo's tests are there to plot, and nothing to upload", async () => {
    renderDemo("/yorg");
    await userEvent.click(await screen.findByRole("link", { name: "Kestrel" }));
    await userEvent.click(await screen.findByRole("link", { name: "Hot fires" }));
    expect(await screen.findByRole("link", { name: "HF-2 5 s hot fire" })).toBeTruthy();
    expect(window.location.pathname).toMatch(/^\/demo\/yorg\//);
    expect(screen.queryByRole("button", { name: "Upload data" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
});

test("the demo's saved view opens as it was saved, with nothing to save", async () => {
    renderDemo("/yorg/views");
    await userEvent.click(await screen.findByRole("link", { name: "Kestrel" }));
    await userEvent.click(await screen.findByRole("link", { name: /HF-2 chamber, thrust, and valves/ }));
    expect(await screen.findByText(/saved view in Kestrel, by Ben Hartley/)).toBeTruthy();
    expect(screen.queryByText(/· changed/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save as a new view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New calculated channel" })).toBeNull();
});

test("the demo's P&IDs open to be looked at, released, and not to be edited", async () => {
    renderDemo("/piper");
    expect(await screen.findByRole("link", { name: "Kestrel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New diagram" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import Visio…" })).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "Kestrel" }));
    await userEvent.click(await screen.findByRole("link", { name: "Kestrel feed system" }));
    expect(await screen.findByText("Draft after Rev A")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
});

test("a chip on the demo's bill of design opens its component, which can't be changed", async () => {
    renderDemo("/buildflow");
    await userEvent.click(await screen.findByRole("link", { name: "Kestrel" }));
    const chip = await screen.findByRole("button", { name: /^Thrust chamber, CDR: / });
    await userEvent.click(chip);
    const panel = await screen.findByRole("complementary", { name: "Thrust chamber" });
    expect(within(panel).queryByRole("menu")).toBeNull();
    // Its controls are off: a fieldset that's disabled turns off everything in it.
    const lead = within(panel).getByRole<HTMLSelectElement>("combobox", { name: "Lead" });
    expect(lead.matches(":disabled")).toBe(true);
    expect(lead.selectedOptions[0]?.textContent).toBe("Ben Hartley");
});

test("the demo's vault has SparkFun's servo to look at, and nothing to open in SolidWorks or connect it to", async () => {
    renderDemo("/vault/files/Kestrel/Avionics/Airbrake%20actuator");
    expect(await screen.findByText("9347.SLDASM")).toBeTruthy();
    expect(screen.getByText("Servomoteur.SLDPRT")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open in SolidWorks" })).toBeNull();
    window.history.pushState(null, "", "/demo/vault/solidworks");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByText(/In the demo, there's nothing to connect/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Connect SolidWorks" })).toBeNull();
});

test("Help in the demo is the help alone: no Claude, and no requests", async () => {
    renderDemo("/");
    await userEvent.click(await screen.findByRole("button", { name: /^Help/ }));
    expect(await screen.findByText(/In the demo, the help is all there is/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask Claude" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Report a bug or idea" })).toBeNull();
    expect(screen.getByRole("link", { name: "The guide and troubleshooting" }).getAttribute("href")).toBe("/demo/help");
});
