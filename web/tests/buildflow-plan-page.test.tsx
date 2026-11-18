import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import type { ProgramDetail } from "../src/buildflow/api";
import { dayNumber, dayString } from "../src/buildflow/planning";
import { formatDay, today } from "../src/buildflow/vehicle";
import { renderApp, Team } from "./team";

// Buildflow's build plan, through the app: each component's lead time and ready-by day, the day to order or start it
// by, what it needs first (never one that needs it), on the plan page and on a component's panel; and the bill's mark
// on a long lead.

beforeAll(async () => {
    await Promise.all([import("../src/buildflow/Program"), import("../src/buildflow/Plan")]);
});

const component = (bill: ProgramDetail, name: string) => bill.components.find((c) => c.name === name)!;
const fromToday = (days: number) => dayString(dayNumber(today()) + days);

/** The plan's row for a component. */
async function rowOf(name: string) {
    const plan = within(await screen.findByRole("table", { name: "Build plan" }));
    return within((await plan.findByRole("link", { name })).closest("tr")!);
}

test("a member gives components lead times and ready-by days, and sees what to order now", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    const member = await team.member(`riley${team.folder.slice(5)}`);
    renderApp(member, `/buildflow/programs/${program.id}/plan`);

    const counts = within(await screen.findByRole("list", { name: "The plan, in numbers" }));
    expect(within(counts.getByText("Not planned")).getByText("19")).toBeTruthy(); // nothing's planned yet
    const regulator = await rowOf("Pressure regulator");
    await userEvent.type(
        regulator.getByRole("spinbutton", { name: "Pressure regulator: lead time, in weeks" }),
        "12{Enter}",
    );
    // Ready in ten weeks, with a twelve-week lead: it should have been ordered two weeks ago.
    fireEvent.change(regulator.getByLabelText("Pressure regulator: ready by"), { target: { value: fromToday(70) } });
    expect(await regulator.findByText(`Order by ${formatDay(fromToday(-14))}`, { exact: false })).toBeTruthy();
    expect(regulator.getByText(/, late/)).toBeTruthy();
    expect(regulator.getByText("Long lead")).toBeTruthy();
    expect(regulator.getByText("At risk")).toBeTruthy();
    expect(within(counts.getByText("Order or start now").closest("li")!).getByText("1")).toBeTruthy();

    await waitFor(async () => {
        const kept = component(await team.bill(program.id), "Pressure regulator");
        expect([kept.lead_days, kept.need_by]).toEqual([84, fromToday(70)]);
    });
});

test("what a component needs first is picked, and never one that needs it", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    renderApp(team.chief, `/buildflow/programs/${program.id}/plan`);

    const structure = await rowOf("Thrust structure");
    await userEvent.click(structure.getByRole("button", { name: "What Thrust structure needs first" }));
    let dialog = within(await screen.findByRole("dialog", { name: "What Thrust structure needs first" }));
    expect(dialog.queryByRole("checkbox", { name: "Thrust structure" })).toBeNull(); // not itself
    await userEvent.click(dialog.getByRole("checkbox", { name: "Thrust chamber" }));
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(structure.getByRole("button", { name: "What Thrust structure needs first" }).textContent).toBe(
        "1 component",
    );
    expect(structure.getByText(/waiting on Thrust chamber/)).toBeTruthy();

    const chamber = await rowOf("Thrust chamber");
    await userEvent.click(chamber.getByRole("button", { name: "What Thrust chamber needs first" }));
    dialog = within(await screen.findByRole("dialog", { name: "What Thrust chamber needs first" }));
    await userEvent.click(dialog.getByRole("checkbox", { name: "Thrust structure" }));
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(
        await dialog.findByText(
            "Thrust structure needs Thrust chamber already: a component can't need one that needs it",
        ),
    ).toBeTruthy();
});

test("a component's panel shows its plan, and the bill marks a long lead", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    const valve = component(program, "Main oxidizer valve");
    await team.plan(valve.id, { lead_days: 70, need_by: fromToday(100) });
    renderApp(team.chief, `/buildflow/programs/${program.id}?phase=build&component=${valve.id}`);

    const panel = within(await screen.findByRole("complementary", { name: "Main oxidizer valve" }));
    const plan = within(panel.getByRole("region", { name: "Build plan" }));
    expect(plan.getByText(`Order by ${formatDay(fromToday(30))}`, { exact: false })).toBeTruthy();
    expect(
        (plan.getByRole("spinbutton", { name: "Main oxidizer valve: lead time, in weeks" }) as HTMLInputElement).value,
    ).toBe("10");

    const bill = within(screen.getByRole("table", { name: "Bill of design" }));
    const row = within(bill.getByRole("button", { name: "Main oxidizer valve" }).closest("tr")!);
    expect(row.getByText("Long lead")).toBeTruthy();
    // A lead time cleared on the panel takes the mark off.
    await userEvent.clear(plan.getByRole("spinbutton", { name: "Main oxidizer valve: lead time, in weeks" }));
    await userEvent.tab();
    await waitFor(() => expect(row.queryByText("Long lead")).toBeNull());
});
