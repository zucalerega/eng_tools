import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import { renderApp, Team } from "./team";

// Deals, through the app: the deals finder searches a stand-in for eBay (ebay.ts), which has listings only for a test's
// own part numbers (QA-1234); they show on the site's own page, and beside their components on a program's bill.

beforeAll(async () => {
    await Promise.all([import("../src/buildflow/Program"), import("../src/vault/pages/Admin")]);
});

/** A part number only this test has, which the stand-in has four listings of, two of them deals. */
const partNumber = () => `QA-${Math.floor(1000 + Math.random() * 8999)}`;

/** A program whose main oxidizer valve is a test's own part, found on eBay: the program, and the valve. */
async function withDeals(team: Team, number: string) {
    const program = await team.program("Elytra");
    const valve = program.components.find((c) => c.name === "Main oxidizer valve")!;
    await team.describe(valve.id, `Swagelok ${number}, 1/4 in ball valve, MAWP 3000 psi`);
    await team.searchDeals();
    return { program, valve };
}

test("the site's own page shows the deals found, each with what it's for and a link to it on eBay", async () => {
    const team = await Team.create();
    const number = partNumber();
    const { program, valve } = await withDeals(team, number);
    renderApp(team.chief, "/");

    const deals = within(await screen.findByRole("region", { name: "Deals" }));
    expect(deals.getByRole("heading", { name: "Deals for the team" })).toBeTruthy();
    const title = `Swagelok ${number} Stainless Ball Valve 1/4 in`;
    const card = within(deals.getByRole("article", { name: title }));
    expect(card.getByText("$40.00")).toBeTruthy();
    expect(card.getByText("+ $5.00 shipping")).toBeTruthy();
    // A quarter under the typical price of those like it: the median, $60 shipped.
    expect(card.getByText("25% under typical")).toBeTruthy();
    expect(card.getByText(`Its part number, ${number}`)).toBeTruthy();
    expect(card.getByRole("link", { name: "Main oxidizer valve" }).getAttribute("href")).toBe(
        `/buildflow/programs/${program.id}?phase=build&component=${valve.id}`,
    );
    const ebay = card.getByRole("link", { name: "View on eBay ↗" });
    expect([ebay.getAttribute("target"), ebay.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    expect(ebay.getAttribute("href")).toMatch(/^https:\/\/www\.ebay\.com\/itm\/9\d+1$/);
    // One whose shipping is worked out at checkout says so; those dearer than the typical price aren't deals.
    const calculated = within(deals.getByRole("article", { name: `${number} ball valve, 1/4 in, stainless` }));
    expect(calculated.getByText("+ shipping")).toBeTruthy();
    expect(deals.queryByRole("article", { name: `NEW ${number} Swagelok 1/4 in ball valve` })).toBeNull();

    // Not useful: hidden for everyone, with a way back.
    await userEvent.click(card.getByRole("button", { name: `Not useful: hide ${title}` }));
    expect(await deals.findByText("Hidden: it won't be shown, or found again, for Main oxidizer valve.")).toBeTruthy();
    expect(deals.queryByRole("article", { name: title })).toBeNull();
    await userEvent.click(deals.getByRole("button", { name: "Undo" }));
    expect(await deals.findByRole("article", { name: title })).toBeTruthy();
});

test("a program's bill marks the components the finder found deals for, and their panel lists them", async () => {
    const team = await Team.create();
    const { program } = await withDeals(team, partNumber());
    const member = await team.member("Buyer");
    renderApp(member, `/buildflow/programs/${program.id}`);

    const mark = await screen.findByRole("button", { name: "2 deals on eBay for Main oxidizer valve" });
    const vehicle = within(screen.getByRole("group", { name: `${program.name}'s vehicle` }));
    expect(vehicle.getByRole("button", { name: /^Main oxidizer valve:/ }).textContent).toContain("2 on eBay");
    expect(screen.queryByRole("button", { name: /deals? on eBay for LOX tank/ })).toBeNull();

    await userEvent.click(mark);
    const panel = within(await screen.findByRole("complementary", { name: "Main oxidizer valve" }));
    const onEbay = within(panel.getByRole("region", { name: "On eBay" }));
    expect(onEbay.getAllByRole("article")).toHaveLength(2);
    await userEvent.click(onEbay.getAllByRole("button", { name: /^Not useful: hide / })[0]!);
    await waitFor(() => expect(onEbay.getAllByRole("article")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "1 deal on eBay for Main oxidizer valve" })).toBeTruthy();
});

test("admins see how the deals finder's doing, and have it search now", async () => {
    const team = await Team.create();
    const admin = await team.admin("Dealer");
    renderApp(admin, "/vault/admin/deals");
    expect(await screen.findByRole("link", { name: "Deals", current: "page" })).toBeTruthy();
    expect(await screen.findByText(/deals shown/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Search now" }));
    const runs = within(await screen.findByRole("table", { name: "Runs" }));
    await waitFor(() => {
        const latest = runs.getAllByRole("row")[1]!;
        expect(latest.textContent).toContain("Dealer");
        expect(latest.textContent).not.toContain("(going)");
    });
});

test("only admins have Admin > Deals", async () => {
    const team = await Team.create();
    const member = await team.member("Looker");
    renderApp(member, "/vault/admin/deals");
    expect(await screen.findByRole("navigation", { name: "Admin" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Deals" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Search now" })).toBeNull();
});
