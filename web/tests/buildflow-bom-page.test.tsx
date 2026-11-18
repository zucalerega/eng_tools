import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import type { ProgramDetail } from "../src/buildflow/api";
import { renderApp, Team } from "./team";

// A program's bill of materials, through the app: the team's BOM spreadsheet read in, each line matched to the
// component its Component column names, the day to order each part by and the long leads; where each part is, kept on
// the site through the next read; and a component's parts on its panel.

beforeAll(async () => {
    await Promise.all([import("../src/buildflow/Bom"), import("../src/buildflow/Program")]);
});

const component = (bill: ProgramDetail, name: string) => bill.components.find((c) => c.name === name)!;

const CSV = [
    "Part No.,Description,Assembly,Qty,Supplier,Unit Price,Lead Time (wks),Link",
    ",PROPULSION,,,,,,",
    "SS-63TS8,1/2 in ball valve,Main oxidizer valve,1,Swagelok,$412.50,10,https://www.swagelok.com/en/catalog",
    "91251A463,Socket head screw,Injector,12,McMaster-Carr,$0.38,1,",
    "RH-2,Recovery harness,Harness,1,Fruity Chutes,$85.00,2,",
].join("\n");

test("a member reads in the team's BOM from a spreadsheet, each line matched to its component", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    const member = await team.member(`riley${team.folder.slice(5)}`);
    renderApp(member, `/buildflow/programs/${program.id}/bom`);

    expect(await screen.findByText(/No BOM yet/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Read in a spreadsheet…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Read in a BOM" }));
    await userEvent.upload(
        dialog.getByLabelText(/The team's BOM/),
        new File([CSV], "Elytra BOM.csv", { type: "text/csv" }),
    );

    // Its columns, guessed from their headers; its section title isn't a part.
    expect(await dialog.findByRole("option", { name: "A: Part No.", selected: true })).toBeTruthy();
    expect((dialog.getByRole("combobox", { name: "Lines are for" }) as HTMLSelectElement).value).toBe("column");
    const preview = within(dialog.getByRole("table", { name: "The lines, as they'll be read in" }));
    expect(preview.getAllByRole("row")).toHaveLength(4);
    expect(preview.getByText("Main oxidizer valve")).toBeTruthy();
    expect(dialog.getByText(/No component is called Harness/)).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Read in 3 lines" }));

    expect(await screen.findByText("Read in Elytra BOM.csv: 3 new, 0 changed, 0 taken off.")).toBeTruthy();
    const table = within(await screen.findByRole("table", { name: "Bill of materials" }));
    const valve = within(table.getByRole("link", { name: "SS-63TS8" }).closest("tr")!);
    expect(valve.getByText("Long lead")).toBeTruthy();
    expect(valve.getByRole("link", { name: "Main oxidizer valve" })).toBeTruthy();
    const kept = await team.bom(program.id);
    expect(kept.map((line) => [line.part_number, line.component_id, line.lead_days, line.unit_cost])).toEqual([
        ["SS-63TS8", component(program, "Main oxidizer valve").id, 70, 41250],
        ["91251A463", component(program, "Injector").id, 7, 38],
        ["RH-2", null, 14, 8500],
    ]);
});

test("where each part is, and its note, are kept on the site, through the next read", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    const valve = component(program, "Main oxidizer valve");
    await team.readBom(program.id, [{ component_id: valve.id, part_number: "SS-63TS8", quantity: 1, lead_days: 70 }]);
    renderApp(team.chief, `/buildflow/programs/${program.id}/bom`);

    const table = within(await screen.findByRole("table", { name: "Bill of materials" }));
    await userEvent.selectOptions(table.getByRole("combobox", { name: "SS-63TS8: status" }), "Ordered");
    await userEvent.type(table.getByRole("textbox", { name: "SS-63TS8: note" }), "PO 1142{Enter}");
    await waitFor(async () => {
        const [line] = await team.bom(program.id);
        expect([line?.status, line?.note]).toEqual(["ordered", "PO 1142"]);
    });

    // Read in again with two of them: it's the same part, still ordered.
    const again = await team.readBom(program.id, [
        { component_id: valve.id, part_number: "SS-63TS8", quantity: 2, lead_days: 70 },
    ]);
    expect([again.added, again.changed, again.removed]).toEqual([0, 1, 0]);
    const [line] = await team.bom(program.id);
    expect([line?.quantity, line?.status, line?.note]).toEqual([2, "ordered", "PO 1142"]);
});

test("a component's panel lists its parts, the longest lead first", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    const injector = component(program, "Injector");
    await team.readBom(program.id, [
        { component_id: injector.id, part_number: "91251A463", lead_days: 2 },
        { component_id: injector.id, part_number: "9452K33", lead_days: 21, status: "received" },
    ]);
    renderApp(team.chief, `/buildflow/programs/${program.id}?phase=build&component=${injector.id}`);

    const panel = within(await screen.findByRole("complementary", { name: "Injector" }));
    const parts = within(await panel.findByRole("region", { name: "Parts" }));
    expect(await parts.findByText("1 of 2 still to come")).toBeTruthy();
    expect(parts.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
        "9452K33 · 3 wkReceived",
        "91251A463 · 2 dTo order",
    ]);
    expect(parts.getByRole("link", { name: "The BOM" }).getAttribute("href")).toBe(
        `/buildflow/programs/${program.id}/bom?component=${injector.id}`,
    );
});
