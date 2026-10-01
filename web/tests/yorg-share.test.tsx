import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { deflateRawSync } from "node:zlib";
import { expect, onTestFinished, test } from "vitest";
import { renderApp, Team } from "./team";

// Copy link, on a dataset's or a view's plots: a link to what's on screen, which opens it for someone else as unsaved
// changes, with nothing saved (src/yorg/share.ts).

const HOTFIRE = [
    "Time (s),PT-OX-01 (psi),PT-FU-01 (psi),TC-NOZ-01 (K),Valve",
    ...Array.from({ length: 50 }, (_, i) =>
        [i / 100, 300 + i, 280 + i / 2, 290 + i * 3, i < 20 ? "CLOSED" : "OPEN"].join(","),
    ),
].join("\n");

type User = ReturnType<typeof userEvent.setup>;

/** What's plotted, plot by plot, as each plot says to a screen reader: "Plot 1: PT-OX-01, PT-FU-01". */
const plotted = (): string[] =>
    screen.getAllByRole("img", { name: /^Plot \d+:/ }).map((plot) => plot.getAttribute("aria-label") ?? "");

const windowInputs = (): string[] =>
    ["Window start", "Window end"].map((label) => (screen.getByLabelText(label) as HTMLInputElement).value);

/** Copy link, and where the link it copied goes: its path and query, to open it at. */
async function copyLink(user: User): Promise<string> {
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeTruthy();
    const link = new URL(await navigator.clipboard.readText());
    expect(link.origin).toBe(window.location.origin);
    expect([...link.searchParams.keys()]).toEqual(["plots"]);
    return link.pathname + link.search;
}

/** A link's plots as Copy link writes them (a layout's JSON, deflated, base64url), made here by hand. */
const plotsParam = (config: unknown): string => deflateRawSync(JSON.stringify(config)).toString("base64url");

test("a link to a dataset's plots opens them for someone else as they were, and saves nothing", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    const hotfire = await team.data(team.chief, "Hotfire", HOTFIRE);
    const coldFlow = await team.data(team.chief, "Cold flow", HOTFIRE);
    const user = userEvent.setup();
    const asChief = renderApp(team.chief, `/yorg/datasets/${hotfire.id}`);

    // Two plots, another test compared and shifted in time, the time in view, and T0.
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await user.click(await channels.findByRole("button", { name: /PT-OX-01/ }));
    fireEvent.click(channels.getByRole("button", { name: /TC-NOZ-01/ }), { shiftKey: true });
    await user.click(channels.getByRole("button", { name: "Compare with another dataset" }));
    await user.selectOptions(
        channels.getByLabelText("Compare with"),
        await channels.findByRole("option", { name: coldFlow.name }),
    );
    const shift = await channels.findByLabelText(`${coldFlow.name}: shift in time (s)`);
    await user.clear(shift);
    await user.type(shift, "0.25{Enter}");
    await waitFor(() => expect(channels.getAllByRole("button", { name: /PT-FU-01/ })).toHaveLength(2));
    await user.click(channels.getAllByRole("button", { name: /PT-FU-01/ })[1]!); // the cold flow's
    await user.clear(screen.getByLabelText("Window start"));
    await user.type(screen.getByLabelText("Window start"), "0.1");
    await user.clear(screen.getByLabelText("Window end"));
    await user.type(screen.getByLabelText("Window end"), "0.3{Enter}");
    await user.click(screen.getByRole("button", { name: "T0" }));
    await user.click(screen.getByRole("menuitem", { name: "Set T0 at the start of the window" }));
    const plots = [
        `Plot 1: PT-OX-01 · ${hotfire.name}, PT-FU-01 · ${coldFlow.name}`,
        `Plot 2: TC-NOZ-01 · ${hotfire.name}`,
    ];
    await waitFor(() => expect(plotted()).toEqual(plots));
    await waitFor(() => expect(windowInputs()).toEqual(["T0", "T+0.2"]));

    const link = await copyLink(user);
    expect(link).toMatch(new RegExp(`^/yorg/datasets/${hotfire.id}\\?plots=[\\w-]+$`));
    asChief.unmount();
    localStorage.clear(); // what the chief's browser kept: Alice's plots come from the link alone

    const asAlice = renderApp(alice, link);
    expect(await screen.findByRole("heading", { name: hotfire.name })).toBeTruthy();
    await waitFor(() => expect(plotted()).toEqual(plots));
    expect(windowInputs()).toEqual(["T0", "T+0.2"]);
    expect(within(screen.getByRole("region", { name: "Markers" })).getByText("0.1 s in the file")).toBeTruthy();
    expect((screen.getByLabelText(`${coldFlow.name}: shift in time (s)`) as HTMLInputElement).value).toBe("0.25");
    expect(screen.getByRole("button", { name: "Save view" })).toBeTruthy(); // to keep them
    expect((await team.views(alice)).filter((view) => view.datasets.includes(hotfire.id))).toEqual([]);

    // Read, then out of the address: the plots are the page's, so a reload after a change shows the change.
    expect(window.location.pathname + window.location.search).toBe(`/yorg/datasets/${hotfire.id}`);
    await user.click(screen.getByRole("button", { name: "Remove Plot 2" }));
    await waitFor(() => expect(plotted()).toEqual(plots.slice(0, 1)));
    asAlice.unmount();
    renderApp(alice, window.location.pathname + window.location.search);
    expect(await screen.findByRole("heading", { name: hotfire.name })).toBeTruthy();
    await waitFor(() => expect(plotted()).toEqual(plots.slice(0, 1)));
});

test("a link to a view's changed plots, copied in the preview, opens on the site as the view changed", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    const data = await team.data(team.chief, "Viewed", HOTFIRE);
    const user = userEvent.setup();
    const asChief = renderApp(team.chief, `/yorg/dev/datasets/${data.id}`);
    await user.click(
        await within(await screen.findByRole("complementary", { name: "Channels" })).findByRole("button", {
            name: /PT-OX-01/,
        }),
    );
    await user.click(screen.getByRole("button", { name: "Save view" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Save this view" }));
    const name = `Tanks ${team.folder}`;
    await user.type(dialog.getByLabelText("Name"), name);
    await user.click(dialog.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name })).toBeTruthy();
    const id = /^\/yorg\/dev\/views\/(\d+)$/.exec(window.location.pathname)?.[1];
    expect(id).toBeDefined();

    // Changed, not saved: a plot of its own for another channel.
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    fireEvent.click(await channels.findByRole("button", { name: /TC-NOZ-01/ }), { shiftKey: true });
    expect(await screen.findByText("saved view, by chief · changed")).toBeTruthy();
    const plots = ["Plot 1: PT-OX-01", "Plot 2: TC-NOZ-01"];
    await waitFor(() => expect(plotted()).toEqual(plots));

    const link = await copyLink(user);
    expect(link).toMatch(new RegExp(`^/yorg/views/${id}\\?plots=[\\w-]+$`)); // the site's page: Alice isn't an admin
    asChief.unmount();

    const asAlice = renderApp(alice, link);
    expect(await screen.findByRole("heading", { name })).toBeTruthy();
    await waitFor(() => expect(plotted()).toEqual(plots));
    expect(screen.getByText("saved view, by chief · changed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as a new view" })).toBeTruthy(); // it's the chief's
    expect(window.location.pathname + window.location.search).toBe(`/yorg/views/${id}`);
    const saved = (await team.views(alice)).find((view) => view.name === name);
    expect(saved).toBeDefined();
    expect((saved!.config as { panels: unknown[] }).panels).toHaveLength(1); // as the chief saved it
    asAlice.unmount();

    // The chief follows it too, changes it again, and saves it: the view, made again, is what he saved, not the link's
    // plots again.
    renderApp(team.chief, link);
    await waitFor(() => expect(plotted()).toEqual(plots));
    await user.click(screen.getByRole("button", { name: "Remove Plot 1" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("saved view, by chief")).toBeTruthy();
    expect(plotted()).toEqual(["Plot 1: TC-NOZ-01"]);
});

test("a link is read as a saved view is, and one that can't be read says so", async () => {
    const team = await Team.create();
    const alice = await team.member("Alice");
    const data = await team.data(team.chief, "Linked", HOTFIRE);

    // Made by hand (or before the layout grew), with only some of a layout: the rest is as a view's would be.
    const plots = plotsParam({ panels: [{ series: [{ channel: "PT-OX-01" }] }], t0: 0.1 });
    let page = renderApp(alice, `/yorg/datasets/${data.id}?plots=${plots}`);
    await waitFor(() => expect(plotted()).toEqual(["Plot 1: PT-OX-01"]));
    expect(within(screen.getByRole("region", { name: "Markers" })).getByText("0.1 s in the file")).toBeTruthy();
    expect(screen.queryByText(/couldn't be read/)).toBeNull();
    page.unmount();
    localStorage.clear();

    // Cut short, as a chat might cut it, or more than a saved view may hold (a few KB that inflate to megabytes): it
    // says so, and the page is as it would be without it.
    const huge = plotsParam({ panels: [{ series: [{ channel: "PT-OX-01" }] }], padding: "x".repeat(600 * 1024) });
    for (const unreadable of [plots.slice(0, plots.length - 8), huge]) {
        page = renderApp(alice, `/yorg/datasets/${data.id}?plots=${unreadable}`);
        expect(await screen.findByText(/The plots in this link couldn't be read/)).toBeTruthy();
        expect(screen.getByText(/Pick channels on the left/)).toBeTruthy();
        expect(window.location.search).toBe("");
        page.unmount();
    }

    // On a view: the view as it was saved.
    const view = await team.view(team.chief, `Garbled ${team.folder}`, data.id, "TC-NOZ-01");
    renderApp(alice, `/yorg/views/${view.id}?plots=not-a-layout`);
    expect(await screen.findByText(/The plots in this link couldn't be read/)).toBeTruthy();
    await waitFor(() => expect(plotted()).toEqual(["Plot 1: TC-NOZ-01"]));
    expect(window.location.search).toBe("");
});

test("where the browser won't copy, Copy link shows the link to copy by hand", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "No clipboard", HOTFIRE);
    // As on a site without HTTPS, where pages get no clipboard.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    onTestFinished(() => {
        delete (navigator as { clipboard?: unknown }).clipboard;
    });
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    await userEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Copy this link" }));
    const link = new URL((dialog.getByLabelText("Link") as HTMLInputElement).value);
    expect(link.pathname).toBe(`/yorg/datasets/${data.id}`);
    expect(link.searchParams.get("plots")).toMatch(/^[\w-]+$/);
    await userEvent.click(dialog.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
});
