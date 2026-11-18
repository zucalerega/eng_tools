import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import type { ProgramDetail } from "../src/buildflow/api";
import { renderApp, Team } from "./team";

// Buildflow's design reviews, through the app: a review held for several components at once (a subsystem's PDR), its
// day each one's date there, passing it passing each one, its files and its notes; and the bill and a component's
// panel pointing to it.

beforeAll(async () => {
    await Promise.all([import("../src/buildflow/Program"), import("../src/buildflow/Review")]);
});

const component = (bill: ProgramDetail, name: string) => bill.components.find((c) => c.name === name)!;
const milestone = (bill: ProgramDetail, name: string) => bill.milestones.find((m) => m.name === name)!;
const FLUIDS = [
    "Main oxidizer valve",
    "Main fuel valve",
    "LOX tank",
    "LOX vent valve",
    "Fuel tank",
    "Pressurant tank",
    "Pressure regulator",
];

test("a member starts a review for a subsystem's components, and its day is each one's date at it", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    const member = await team.member(`riley${team.folder.slice(5)}`);
    renderApp(member, `/buildflow/programs/${program.id}`);

    const reviews = within(await screen.findByRole("region", { name: "Reviews" }));
    expect(reviews.getByText(/None yet/)).toBeTruthy();
    await userEvent.click(reviews.getByRole("button", { name: "New review" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New review" }));
    await userEvent.selectOptions(dialog.getByRole("combobox", { name: "At" }), "PDR: Preliminary Design Review");
    await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Feed system PDR");
    fireEvent.change(dialog.getByLabelText("Day"), { target: { value: "2026-12-03" } });
    await userEvent.click(dialog.getByRole("checkbox", { name: "All of Fluids" }));
    expect(dialog.getByRole<HTMLInputElement>("checkbox", { name: "Main fuel valve" }).checked).toBe(true);
    await userEvent.click(dialog.getByRole("button", { name: "Add it" }));

    // Its page: the components it covers, each with its date at PDR.
    expect(await screen.findByRole("heading", { name: "Feed system PDR" })).toBeTruthy();
    const covered = within(screen.getByRole("table", { name: "Feed system PDR's components" }));
    expect(
        covered
            .getAllByRole("row")
            .slice(1)
            .map((row) => within(row).getByRole("link").textContent),
    ).toEqual(FLUIDS);
    const bill = await team.bill(program.id);
    const pdr = milestone(bill, "PDR");
    for (const name of FLUIDS) {
        expect(component(bill, name).progress.find((p) => p.milestone_id === pdr.id)?.due).toBe("2026-12-03");
    }
    expect(bill.reviews.map((r) => r.name)).toEqual(["Feed system PDR"]);
});

test("passing a review passes its components, and one is set apart with its actions", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    const pdr = milestone(program, "PDR");
    const names = ["Main oxidizer valve", "Main fuel valve", "Pressure regulator"];
    const review = await team.review(team.chief, program.id, {
        milestone_id: pdr.id,
        name: "Valves PDR",
        held_on: "2026-11-02",
        component_ids: names.map((name) => component(program, name).id),
    });
    renderApp(team.chief, `/buildflow/programs/${program.id}/reviews/${review.id}`);

    expect(await screen.findByText("0 of 3 passed")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Pass…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Pass Valves PDR?" }));
    await userEvent.click(dialog.getByRole("button", { name: "Pass" }));
    expect(await screen.findByText("3 of 3 passed")).toBeTruthy();
    const passed = (await team.bill(program.id)).components.filter((c) => names.includes(c.name));
    expect(passed.map((c) => c.progress.find((p) => p.milestone_id === pdr.id)?.done_on)).toEqual([
        "2026-11-02",
        "2026-11-02",
        "2026-11-02",
    ]);

    // The regulator comes back with an action to close.
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Pressure regulator: PDR" }), "In progress");
    expect(await screen.findByText("2 of 3 passed")).toBeTruthy();
    const note = screen.getByRole("textbox", { name: "Pressure regulator: actions, outcome" });
    await userEvent.type(note, "RFA 2: relief setting{Enter}");
    await waitFor(async () => {
        const regulator = component(await team.bill(program.id), "Pressure regulator");
        const kept = regulator.progress.find((p) => p.milestone_id === pdr.id);
        expect([kept?.status, kept?.note]).toEqual(["in_progress", "RFA 2: relief setting"]);
    });
});

test("a review keeps its files and the notes taken in it", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    const review = await team.review(team.chief, program.id, {
        milestone_id: milestone(program, "CDR").id,
        name: "Avionics CDR",
        component_ids: [component(program, "Flight computer").id],
    });
    renderApp(team.chief, `/buildflow/programs/${program.id}/reviews/${review.id}`);

    const files = within(await screen.findByRole("region", { name: "Files" }));
    const slides = "https://team.sharepoint.com/sites/rocketry/Shared%20Documents/Reviews/Avionics%20CDR.pptx";
    await userEvent.type(files.getByRole("textbox", { name: "Address" }), slides);
    await userEvent.type(files.getByRole("textbox", { name: "Name" }), "Slides");
    await userEvent.click(files.getByRole("button", { name: "Add file" }));
    const link = await files.findByRole("link", { name: "Slides" });
    expect([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual([
        slides,
        "_blank",
        "noopener noreferrer",
    ]);

    const notes = within(screen.getByRole("region", { name: "Notes" }));
    await userEvent.click(notes.getByRole("button", { name: "Edit notes" }));
    await userEvent.type(notes.getByRole("textbox", { name: "Notes" }), "- RFA 1: conformal coat the GPS header");
    await userEvent.click(notes.getByRole("button", { name: "Save notes" }));
    expect(await notes.findByRole("listitem")).toBeTruthy();
    expect(notes.getByText("RFA 1: conformal coat the GPS header")).toBeTruthy();
    expect((await team.reviewOf(review.id)).notes).toBe("- RFA 1: conformal coat the GPS header");

    await userEvent.click(files.getByRole("button", { name: "Remove Slides" }));
    await waitFor(() => expect(files.queryByRole("link", { name: "Slides" })).toBeNull());
});

test("the bill's chip and a component's panel point to the review it's in", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    const injector = component(program, "Injector");
    const review = await team.review(team.chief, program.id, {
        milestone_id: milestone(program, "CDR").id,
        name: "Propulsion CDR",
        held_on: "2027-01-12",
        component_ids: [injector.id, component(program, "Thrust chamber").id],
    });
    renderApp(team.chief, `/buildflow/programs/${program.id}?phase=design&component=${injector.id}`);

    // Its panel, at CDR.
    const panel = within(await screen.findByRole("complementary", { name: "Injector" }));
    expect(panel.getByRole("link", { name: "Propulsion CDR" }).getAttribute("href")).toBe(
        `/buildflow/programs/${program.id}/reviews/${review.id}`,
    );

    // The program's reviews, and the chip's menu.
    const reviews = within(screen.getByRole("region", { name: "Reviews" }));
    expect(reviews.getByRole("link", { name: "Propulsion CDR" })).toBeTruthy();
    expect(reviews.getByText("0 of 2")).toBeTruthy();
    const chip = screen.getByRole("button", { name: /^Injector, CDR: Not started, due .*, in Propulsion CDR$/ });
    await userEvent.click(chip);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Propulsion CDR…" }));
    expect(await screen.findByRole("heading", { name: "Propulsion CDR" })).toBeTruthy();
});
