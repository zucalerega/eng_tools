import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp, Team } from "./team";

// Calculated channels made of calculated channels, and across the datasets compared on a page; and the expression's
// box showing which parentheses go together.

const HOTFIRE = [
    "Time (s),PT-OX-01 (psi),PT-FU-01 (psi)",
    ...Array.from({ length: 50 }, (_, i) => [i / 100, 300 + i, 280 + i / 2].join(",")),
].join("\n");

// A flow meter's log, and the pressure transducers' from another logger, over the same seconds.
const FLOW = ["Time (s),FM-1 (kg/s)", "0,10", "1,10", "2,10", "3,10", "4,10"].join("\n");
const PRESSURES = [
    "Time (s),PT-1 (psi),PT-2 (psi)",
    "0,100,100",
    "1,101,100",
    "2,102,100",
    "3,103,100",
    "4,104,100",
].join("\n");

/** Text to type as it's written: userEvent reads [ and { as keys unless they're doubled. */
const keys = (text: string) => text.replace(/[[{]/g, "$&$&");

const legendNames = (legend: HTMLElement) =>
    within(legend)
        .getAllByRole("button")
        .map((one) => one.getAttribute("aria-label") ?? one.textContent);

test("a calculated channel can use another, by its name, but never itself", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Hotfire", HOTFIRE);
    const doubled = await team.formula(team.chief, "Doubled", "[PT-OX-01] * 2", "psi");
    const user = userEvent.setup();
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    expect(await channels.findByRole("button", { name: `Change ${doubled.name}` })).toBeTruthy();

    await user.click(channels.getByRole("button", { name: "New calculated channel" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New calculated channel" }));
    const name = team.named("Plus one");
    await user.type(dialog.getByLabelText("Name"), name);
    // Offered beside the channels, and put in by its name.
    await user.type(dialog.getByLabelText("Find a channel to put in"), "doubled");
    const offered = within(dialog.getByRole("group", { name: "Calculated channels" }));
    await user.click(offered.getByRole("button", { name: doubled.name }));
    const expression = dialog.getByLabelText("Expression") as HTMLTextAreaElement;
    await user.type(expression, " + 1");
    expect(expression.value).toBe(`[${doubled.name}] + 1`);
    // Worked out from the other's values: (300 to 349) * 2 + 1.
    expect(await dialog.findByText(`In ${data.name}: 601 to 699`)).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Save and plot" }));
    const legend = within(await screen.findByRole("group", { name: "Plot 1: channels" }));
    expect(await legend.findByRole("button", { name })).toBeTruthy();

    // The first made to use the second, which uses it: refused, saying how it comes back.
    await user.click(channels.getByRole("button", { name: `Change ${doubled.name}` }));
    const change = within(await screen.findByRole("dialog", { name: `Change ${doubled.name}` }));
    const box = change.getByLabelText("Expression");
    await user.clear(box);
    await user.type(box, keys(`[PT-OX-01] + [${name}]`));
    expect(
        await change.findByText(
            `A calculated channel can't use itself: ${doubled.name} uses ${name}, which uses ${doubled.name}: it won't show in ${data.name}.`,
        ),
    ).toBeTruthy();
    // Renaming it, it says what uses it by its name; deleting it, what won't work without it.
    await user.clear(box);
    await user.type(box, keys("[PT-OX-01] * 2"));
    await user.type(change.getByLabelText("Name"), " 2");
    expect(
        change.getByText(`${name} uses it as ${doubled.name}: renamed, change it to its new name too.`),
    ).toBeTruthy();
    await user.click(change.getByRole("button", { name: "Delete this calculated channel" }));
    expect(change.getByText(new RegExp(`${name} uses it, and won't work without it`))).toBeTruthy();
});

test("a mask can test a calculated channel", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Hotfire", HOTFIRE);
    const drop = await team.formula(team.chief, "Drop", "[PT-OX-01] - [PT-FU-01]", "psi");
    const user = userEvent.setup();
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    await user.click(await screen.findByRole("button", { name: "Mask" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New mask" }));
    await user.type(dialog.getByLabelText("Test"), keys(`[${drop.name}] > 40`));
    // 20 + i/2 > 40 from i = 41: 9 samples of 50, 0.08 s.
    expect(await dialog.findByText(/^In .*, it holds once: 80 ms in all/)).toBeTruthy();
});

test("a calculated channel across the datasets compared, worked out as they're lined up", async () => {
    const team = await Team.create();
    const flow = await team.data(team.chief, "Flow meter", FLOW);
    const pressures = await team.data(team.chief, "Pressures", PRESSURES);
    const user = userEvent.setup();
    renderApp(team.chief, `/yorg/datasets/${flow.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await channels.findByRole("button", { name: /FM-1/ });
    await user.click(channels.getByRole("button", { name: "Compare with another dataset" }));
    const picker = within(await screen.findByRole("dialog", { name: "Compare with" }));
    await user.type(picker.getByLabelText("Find a dataset"), `${pressures.name}{Enter}`);
    await channels.findByRole("button", { name: /PT-1/ });

    // Made from the flow meter's channels, with the other's: it offers both datasets' channels.
    await user.click(channels.getAllByRole("button", { name: "New calculated channel" })[0]!);
    const dialog = within(await screen.findByRole("dialog", { name: "New calculated channel" }));
    const name = team.named("Per psi");
    await user.type(dialog.getByLabelText("Name"), name);
    await user.click(
        within(dialog.getByRole("group", { name: `Channels of ${flow.name}` })).getByRole("button", { name: "FM-1" }),
    );
    const expression = dialog.getByLabelText("Expression");
    await user.type(expression, " / (");
    const other = within(dialog.getByRole("group", { name: `Channels of ${pressures.name}` }));
    await user.click(other.getByRole("button", { name: "PT-1" }));
    await user.type(expression, " - ");
    await user.click(other.getByRole("button", { name: "PT-2" }));
    await user.type(expression, ")");
    // 10 / 0 at the start is a gap; then 10, 5, 3.33, 2.5.
    expect(
        await dialog.findByText(`Across ${flow.name} and ${pressures.name}, as they're lined up here: 2.5 to 10`),
    ).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Save and plot" }));

    // Listed across the datasets, not under either, and plotted, named for both.
    const across = within(await channels.findByRole("region", { name: "Across datasets" }));
    expect(await across.findByRole("button", { name: `Change ${name}` })).toBeTruthy();
    expect(channels.getAllByRole("button", { name: `Change ${name}` })).toHaveLength(1);
    const legend = await screen.findByRole("group", { name: "Plot 1: channels" });
    await waitFor(() => expect(legendNames(legend)).toContain(`${name} · ${flow.name} + ${pressures.name}`));

    // Shifted a second later, the pressures line up with the flow a second later: 10 / 1 at 2 s, to 10 / 3 at 4 s.
    const shift = channels.getByLabelText(`${pressures.name}: shift in time (s)`);
    await user.clear(shift);
    await user.type(shift, "1{Enter}");
    await user.click(across.getByRole("button", { name: `Change ${name}` }));
    const change = within(await screen.findByRole("dialog", { name: `Change ${name}` }));
    expect(
        await change.findByText(`Across ${flow.name} and ${pressures.name}, as they're lined up here: 3.33333 to 10`),
    ).toBeTruthy();
});

test("the expression's box shows which parentheses go together", async () => {
    const team = await Team.create();
    const data = await team.data(team.chief, "Hotfire", HOTFIRE);
    const user = userEvent.setup();
    renderApp(team.chief, `/yorg/datasets/${data.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await user.click(await channels.findByRole("button", { name: "New calculated channel" }));
    const dialog = await screen.findByRole("dialog", { name: "New calculated channel" });
    const box = within(dialog).getByLabelText("Expression") as HTMLTextAreaElement;
    const parens = () => [...dialog.querySelectorAll(".yorg-x-paren")];
    const matched = () => parens().flatMap((one, index) => (one.classList.contains("yorg-x-match") ? [index] : []));

    await user.type(box, keys("sqrt((1 + [PT-OX-01]) * 2)"));
    // The caret's after the last: it and sqrt's are the pair; each depth has its color.
    expect(matched()).toEqual([0, 3]);
    expect(parens().map((one) => one.className)).toEqual([
        "yorg-x-paren yorg-x-depth-0 yorg-x-match",
        "yorg-x-paren yorg-x-depth-1",
        "yorg-x-paren yorg-x-depth-1",
        "yorg-x-paren yorg-x-depth-0 yorg-x-match",
    ]);
    // After the inner (: the inner pair.
    box.setSelectionRange(6, 6);
    fireEvent.select(box);
    expect(matched()).toEqual([1, 2]);
    // Away from the box, none is marked.
    fireEvent.blur(box);
    expect(matched()).toEqual([]);
    // One without its partner is marked as wrong.
    await user.type(box, ")");
    expect(parens().at(-1)?.className).toContain("yorg-x-paren yorg-x-unmatched");
});
