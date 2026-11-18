import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import { renderApp, Team } from "./team";

// Buildflow's shop, through the app: the parts queued to be machined, a component's parts on its panel, who's trained
// on what, and the machines (admins'). The test server is shared, so each test finds its parts and people by names only
// it uses.

beforeAll(async () => {
    await Promise.all([import("../src/buildflow/Shop"), import("../src/buildflow/Program")]);
});

/** A name for someone only this test has: their email is made from it. */
const someone = (team: Team, name: string) => `${name}${team.folder.slice(5)}`;

/** The row of the queue's table a part is in. */
async function rowOf(part: string) {
    const queue = within(await screen.findByRole("table", { name: "Parts in the queue" }));
    return within((await queue.findByText(part)).closest("tr")!);
}

test("a part queued from a component's panel is for that component, and moves through the queue", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    const injector = program.components.find((c) => c.name === "Injector")!;
    const member = await team.member(someone(team, "Riley"));
    renderApp(member, `/buildflow/programs/${program.id}?phase=build&component=${injector.id}`);

    const inShop = within(await screen.findByRole("region", { name: "In the shop" }));
    expect(await inShop.findByText("Nothing queued for it.")).toBeTruthy();
    await userEvent.click(inShop.getByRole("link", { name: "Queue a part for it" }));

    // It starts as the component, for it.
    const dialog = within(await screen.findByRole("dialog", { name: "Add a part" }));
    const name = dialog.getByRole("textbox", { name: "Part" }) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Injector"));
    await waitFor(() =>
        expect((dialog.getByRole("combobox", { name: "Component" }) as HTMLSelectElement).value).toBe(
            String(injector.id),
        ),
    );
    const part = team.named("Faceplate");
    await userEvent.clear(name);
    await userEvent.type(name, part);
    await userEvent.selectOptions(dialog.getByRole("combobox", { name: "Machine" }), "Mill");
    await userEvent.type(dialog.getByRole("combobox", { name: "Material" }), "C101 copper");
    await userEvent.type(dialog.getByRole("spinbutton", { name: "Est. hours (all of them)" }), "6.5");
    await userEvent.click(dialog.getByRole("button", { name: "Add it" }));

    const row = await rowOf(part);
    expect(row.getByRole("link", { name: `${program.name} · Injector` }).getAttribute("href")).toBe(
        `/buildflow/programs/${program.id}?phase=build&component=${injector.id}`,
    );
    expect(row.getByText(`RE ${member.user.name}`)).toBeTruthy();
    expect(row.getByText("C101 copper")).toBeTruthy();
    expect(row.getByText("6.5")).toBeTruthy();

    // Someone starts on it.
    const status = row.getByRole("combobox", { name: `Status of ${part}` }) as HTMLSelectElement;
    await userEvent.selectOptions(status, "In progress");
    await waitFor(async () => {
        const kept = (await team.shop()).parts.find((each) => each.name === part);
        expect(kept?.status).toBe("in_progress");
    });

    // The component's panel shows it, where it is.
    await userEvent.click(row.getByRole("link", { name: `${program.name} · Injector` }));
    const panel = within(await screen.findByRole("region", { name: "In the shop" }));
    const listed = (await panel.findByText(part)).closest("li")!;
    expect(within(listed as HTMLElement).getByText("In progress")).toBeTruthy();
});

test("a part taken off the queue is kept, to put back", async () => {
    const team = await Team.create();
    const mill = (await team.shop()).machines.find((each) => each.name === "Mill")!;
    const part = team.named("Bracket");
    await team.queuePart(team.chief, { name: part, machine_id: mill.id });
    const member = await team.member(someone(team, "Sam"));
    renderApp(member, "/buildflow/shop");

    const row = await rowOf(part);
    await userEvent.click(row.getByRole("button", { name: `Take ${part} off the queue` }));
    expect(await screen.findByText(`Took ${part} off the queue.`)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(part, { selector: ".bf-shop-part-name" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Put it back" }));
    expect(await rowOf(part)).toBeTruthy();
});

test("each person says how far they're trained, and those who run a machine can make its parts", async () => {
    const team = await Team.create();
    const lathe = (await team.shop()).machines.find((each) => each.name === "Lathe")!;
    const part = team.named("Fin can ring");
    await team.queuePart(team.chief, { name: part, machine_id: lathe.id });
    const member = await team.member(someone(team, "Quinn"));
    renderApp(member, "/buildflow/shop/skills");

    expect(await screen.findByRole("heading", { name: "Your experience" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /^Whose/ })).toBeNull(); // only admins say anyone's
    expect(screen.queryByRole("link", { name: "Machines and places" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Lathe: Runs it on their own" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved how far you're trained.")).toBeTruthy();

    const trained = within(await screen.findByRole("table", { name: "Who's trained on what" }));
    const mine = within((await trained.findByText(member.user.name)).closest("tr")!);
    expect(mine.getByLabelText("Lathe: Runs it on their own")).toBeTruthy();

    await userEvent.click(screen.getByRole("link", { name: "Queue" }));
    const row = await rowOf(part);
    await waitFor(() => expect(row.getByText(new RegExp(member.user.name))).toBeTruthy());
});

test("admins keep the shop's machines: one retired takes no new parts", async () => {
    const team = await Team.create();
    const admin = await team.admin(someone(team, "Morgan"));
    renderApp(admin, "/buildflow/shop/machines");

    const machines = within(await screen.findByRole("region", { name: "Machines" }));
    const name = team.named("Laser");
    await userEvent.type(machines.getByRole("textbox", { name: "New machine" }), name);
    await userEvent.click(machines.getByRole("button", { name: "Add machine" }));
    const added = (await machines.findByRole("textbox", { name: `Name of the ${name}` })).closest("li")!;
    await userEvent.click(within(added as HTMLElement).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(within(added as HTMLElement).getByText("retired")).toBeTruthy());
    const kept = (await team.shop()).machines.find((each) => each.name === name)!;
    expect(kept.retired).toBe(true);
    await expect(team.queuePart(admin, { name: team.named("Gasket"), machine_id: kept.id })).rejects.toThrow(/retired/);
});

test("admins add the places people are trained in, and each person says how far they're trained at each", async () => {
    const team = await Team.create();
    const admin = await team.admin(someone(team, "Avery"));
    const asAdmin = renderApp(admin, "/buildflow/shop/machines");
    const places = within(await screen.findByRole("region", { name: "Places" }));
    const studio = team.named("Studio");
    await userEvent.type(places.getByRole("textbox", { name: "New place" }), studio);
    await userEvent.click(places.getByRole("button", { name: "Add place" }));
    expect(await places.findByRole("textbox", { name: `Name of the ${studio}` })).toBeTruthy();
    expect((await team.shop()).places.find((each) => each.name === studio)?.retired).toBe(false);
    asAdmin.unmount();

    // A member says they work there on their own.
    const member = await team.member(someone(team, "Jordan"));
    renderApp(member, "/buildflow/shop/skills");
    await userEvent.click(await screen.findByRole("button", { name: `${studio}: On their own` }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved how far you're trained.")).toBeTruthy();
    const trained = within(await screen.findByRole("table", { name: "Who's trained on what" }));
    const mine = within((await trained.findByText(member.user.name)).closest("tr")!);
    expect(mine.getByLabelText(`${studio}: On their own`)).toBeTruthy();
    expect(mine.getByLabelText("Lathe: Not trained")).toBeTruthy(); // a place's training isn't a machine's

    // Who's trained there, and only them.
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Trained at" }), studio);
    expect(await screen.findByText(`1 person is trained at ${studio}`)).toBeTruthy();
    const there = within(screen.getByRole("table", { name: "Who's trained on what" }));
    expect(
        there
            .getAllByRole("row")
            .slice(2)
            .map((row) => within(row).getAllByRole("cell")[0]!.textContent),
    ).toEqual([`${member.user.name} you`]);
});
