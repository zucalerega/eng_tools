import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test } from "vitest";
import type { ProgramDetail } from "../src/buildflow/api";
import { today } from "../src/buildflow/vehicle";
import { renderApp, Team } from "./team";

// Buildflow, through the app: the programs, a program's vehicle and bill of design, keeping a component's progress,
// people, and links up, and laying a program out.

// Buildflow's pages load when one's first opened (src/buildflow/index.tsx): loaded here first, not while a test waits.
beforeAll(async () => {
    await Promise.all([
        import("../src/buildflow/Programs"),
        import("../src/buildflow/Program"),
        import("../src/buildflow/Layout"),
        import("../src/buildflow/Help"),
    ]);
});

const named = (bill: ProgramDetail, name: string) => bill.components.find((c) => c.name === name)!;
const stone = (bill: ProgramDetail, name: string) => bill.milestones.find((m) => m.name === name)!;

/** A component through every design review. */
async function throughDesign(team: Team, bill: ProgramDetail, name: string) {
    for (const milestone of bill.milestones.filter((m) => m.phase === "design")) {
        await team.progress(team.chief, named(bill, name).id, milestone.id, { status: "done" });
    }
}

/** The stage's caption: how many components are through the phase picked. */
const headline = () =>
    within(screen.getByRole("region", { name: "The vehicle" })).getByText(
        (_, element) => element?.classList.contains("bf-headline") ?? false,
    ).textContent;

test("Buildflow is the site's fourth app: on its front page, and in the switcher", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/");
    const home = within(await screen.findByRole("main"));
    const card = home.getByRole("link", { name: /^Buildflow/ });
    expect(card.getAttribute("href")).toBe("/buildflow");
    const apps = within(screen.getByRole("navigation", { name: "Apps" }));
    expect(apps.getByRole("link", { name: "Buildflow" }).getAttribute("href")).toBe("/buildflow");

    await userEvent.click(card);
    expect(await screen.findByRole("heading", { name: "Programs" })).toBeTruthy();
    expect(document.title).toBe("Buildflow");
    expect(apps.getByRole("link", { name: "Buildflow" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Help" }).getAttribute("href")).toBe("/buildflow/help");
});

test("each program is a card, with how far its components have come in each phase", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    await throughDesign(team, program, "LOX tank");
    const member = await team.member("Reader");
    renderApp(member, "/buildflow");
    const card = within(await screen.findByRole("link", { name: program.name }));
    expect(card.getByText("19 components, 1 through CDR")).toBeTruthy();
    expect(card.getByRole("img", { name: "Design: 1 done, 0 in progress, 0 blocked, of 19" })).toBeTruthy();
    // Only admins make programs.
    expect(screen.queryByRole("button", { name: "New program" })).toBeNull();
});

test("a program's page draws its components on the vehicle, in the colors of where each is in each phase", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    await throughDesign(team, program, "LOX tank");
    await throughDesign(team, program, "Fins");
    await team.progress(team.chief, named(program, "Igniter").id, stone(program, "DCR").id, { status: "in_progress" });
    await team.progress(team.chief, named(program, "Batteries").id, stone(program, "PDR").id, { status: "blocked" });
    const member = await team.member("Watcher");
    renderApp(member, `/buildflow/programs/${program.id}`);

    const vehicle = within(await screen.findByRole("group", { name: `${program.name}'s vehicle` }));
    expect(vehicle.getByRole("button", { name: "LOX tank: Done" })).toBeTruthy();
    expect(vehicle.getByRole("button", { name: "Igniter: In progress" })).toBeTruthy();
    expect(vehicle.getByRole("button", { name: "Batteries: Blocked" })).toBeTruthy();
    expect(vehicle.getByRole("button", { name: "Main oxidizer valve: Not started" })).toBeTruthy();
    expect(headline()).toBe("2 component-level CDRs across the vehicle");
    expect(screen.queryByRole("link", { name: "Layout" })).toBeNull(); // admins'

    await userEvent.click(screen.getByRole("tab", { name: /^Build/ }));
    expect(headline()).toBe("0 of 19 components built");
    expect(vehicle.getByRole("button", { name: "LOX tank: Not started" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("phase")).toBe("build");

    // A dot opens its component beside the page, and says so in the address.
    await userEvent.click(vehicle.getByRole("button", { name: "LOX tank: Not started" }));
    expect(await screen.findByRole("complementary", { name: "LOX tank" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("component")).toBe(String(named(program, "LOX tank").id));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "LOX tank" })).toBeNull();
});

test("anyone sets a component's status at a milestone from the bill, and the activity says who", async () => {
    const team = await Team.create();
    const program = await team.program("Hopper", "hopper");
    const member = await team.member("Keeper");
    renderApp(member, `/buildflow/programs/${program.id}`);
    const bill = within(await screen.findByRole("table", { name: "Bill of design" }));

    await userEvent.click(bill.getByRole("button", { name: "Engine, CDR: Not started" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Passed" }));
    expect(await bill.findByRole("button", { name: /^Engine, CDR: Passed, / })).toBeTruthy();
    const kept = named(await team.bill(program.id), "Engine").progress.find(
        (p) => p.milestone_id === stone(program, "CDR").id,
    );
    expect([kept?.status, kept?.done_on, kept?.updated_by?.name]).toEqual(["done", today(), "Keeper"]);
    const activity = within(screen.getByRole("region", { name: "Recent activity" }));
    expect(await activity.findByText(/Engine: CDR: passed/)).toBeTruthy();

    await userEvent.click(bill.getByRole("button", { name: /^Engine, CDR: Passed/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Blocked" }));
    expect(await bill.findByRole("button", { name: "Engine, CDR: Blocked" })).toBeTruthy();
});

test("a component's panel keeps its lead, people, dates, notes, and links, each named by what it goes to", async () => {
    const team = await Team.create();
    const program = await team.program("Elytra");
    const tank = named(program, "LOX tank");
    const [file] = await team.checkin(team.chief, { "Tanks/LOX Tank.SLDASM": "tank" });
    await team.member("Devon");
    renderApp(team.chief, `/buildflow/programs/${program.id}?phase=build&component=${tank.id}`);
    const panel = within(await screen.findByRole("complementary", { name: "LOX tank" }));

    await userEvent.selectOptions(panel.getByRole("combobox", { name: "Lead" }), "Devon");
    await waitFor(async () => expect(named(await team.bill(program.id), "LOX tank").lead?.name).toBe("Devon"));

    await userEvent.selectOptions(panel.getByRole("combobox", { name: "Add someone to making it" }), "Devon");
    expect(await panel.findByRole("button", { name: "Take Devon off making it" })).toBeTruthy();

    fireEvent.change(panel.getByLabelText("Manufacturing, Made: due"), { target: { value: "2026-12-04" } });
    await userEvent.type(panel.getByLabelText("Manufacturing, Made: note"), "Dome welds done{Enter}");
    await waitFor(async () => {
        const kept = named(await team.bill(program.id), "LOX tank").progress.find(
            (p) => p.milestone_id === stone(program, "Manufacturing").id,
        );
        expect([kept?.due, kept?.note]).toEqual(["2026-12-04", "Dome welds done"]);
    });

    // A link to the vault's file: named by the file, marked as Vault's, and a CAD link, as where it goes says.
    const build = within(panel.getByText("Build").closest("details")!);
    await userEvent.click(build.getByRole("button", { name: "+ Add a link" }));
    await userEvent.type(build.getByLabelText("Address"), `${window.location.origin}/vault/file/${file!.id}`);
    expect((build.getByRole("combobox", { name: "Kind" }) as HTMLSelectElement).value).toBe("cad");
    await userEvent.click(build.getByRole("button", { name: "Add" }));
    const link = await build.findByRole("link", { name: "LOX Tank.SLDASM" });
    expect(link.getAttribute("href")).toBe(`/vault/file/${file!.id}`); // kept as the site's own path
    expect(build.getByText("Vault")).toBeTruthy();

    // Anywhere else opens in a tab of its own; and a link that isn't one is refused, saying why.
    await userEvent.click(build.getByRole("button", { name: "+ Add a link" }));
    await userEvent.type(build.getByLabelText("Address"), "https://drive.google.com/weld-drawings");
    await userEvent.type(build.getByLabelText(/^Name/), "Weld drawings");
    await userEvent.click(build.getByRole("button", { name: "Add" }));
    const drawings = await build.findByRole("link", { name: "Weld drawings" });
    expect([drawings.getAttribute("target"), drawings.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    await userEvent.click(build.getByRole("button", { name: "+ Add a link" }));
    await userEvent.type(build.getByLabelText("Address"), "javascript:alert(1)");
    await userEvent.click(build.getByRole("button", { name: "Add" }));
    expect(await panel.findByText(/a link is an http or https address/)).toBeTruthy();

    await userEvent.click(build.getByRole("button", { name: "Remove the link Weld drawings" }));
    await waitFor(() => expect(build.queryByRole("link", { name: "Weld drawings" })).toBeNull());
});

test("admins lay a program out: its drawing, subsystems, components, and milestones", async () => {
    const team = await Team.create();
    const program = await team.program("Felicette", "blank");
    renderApp(team.chief, `/buildflow/programs/${program.id}`);
    await userEvent.click(await screen.findByRole("link", { name: "Layout" }));
    expect(await screen.findByRole("heading", { name: "Layout" })).toBeTruthy();

    // The drawing: sections, saved together.
    await userEvent.click(screen.getByRole("button", { name: "+ Add a section" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Section 1: kind" }), "Tank");
    await userEvent.click(screen.getByRole("button", { name: "+ Add a section" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Section 2: kind" }), "Nose cone");
    expect(screen.getByRole("group", { name: "The drawing as it'll be saved's vehicle" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save the drawing" }));
    await waitFor(async () =>
        expect((await team.bill(program.id)).profile.sections.map((s) => s.kind)).toEqual(["tank", "nose"]),
    );

    await userEvent.type(screen.getByLabelText("New subsystem"), "Structures");
    await userEvent.click(
        within(screen.getByLabelText("New subsystem").closest("form")!).getByRole("button", { name: "Add" }),
    );
    const newComponent = screen.getByLabelText<HTMLInputElement>("New component");
    await waitFor(() => expect(newComponent.disabled).toBe(false)); // once there's a subsystem to put it in
    await userEvent.type(newComponent, "Nose cone");
    await userEvent.click(
        within(screen.getByLabelText("New component").closest("form")!).getByRole("button", { name: "Add" }),
    );
    expect(await screen.findByRole("button", { name: "Place Nose cone" })).toBeTruthy(); // not on the drawing yet

    // Removed, it's kept, to bring back.
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(await screen.findByRole("button", { name: "Bring back" }));
    await waitFor(async () =>
        expect((await team.bill(program.id)).components.map((c) => c.name)).toEqual(["Nose cone"]),
    );

    // A milestone of the team's own, after the others in its phase.
    await userEvent.type(screen.getByLabelText("New test milestone"), "Hotfire");
    await userEvent.click(
        within(screen.getByLabelText("New test milestone").closest("form")!).getByRole("button", { name: "Add" }),
    );
    await waitFor(async () =>
        expect((await team.bill(program.id)).milestones.filter((m) => m.phase === "test").map((m) => m.name)).toEqual([
            "TRR",
            "Testing",
            "QRR",
            "Hotfire",
        ]),
    );
});

test("an admin makes a program from a starting layout", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/buildflow");
    await userEvent.click(await screen.findByRole("button", { name: "New program" }));
    const dialog = within(screen.getByRole("dialog", { name: "New program" }));
    await userEvent.type(dialog.getByLabelText("Name"), team.named("HETS"));
    await userEvent.click(dialog.getByRole("radio", { name: /^Test stand/ }));
    await userEvent.click(dialog.getByRole("button", { name: "Make it" }));
    expect(await screen.findByRole("heading", { name: `${team.named("HETS")} Bill of design` })).toBeTruthy();
    const vehicle = within(screen.getByRole("group", { name: `${team.named("HETS")}'s vehicle` }));
    expect(vehicle.getByRole("button", { name: "Thrust chamber: Not started" })).toBeTruthy();
    // Its DAQ isn't on the drawing, but it's in the bill.
    expect(vehicle.queryByRole("button", { name: /^DAQ:/ })).toBeNull();
    expect(
        within(screen.getByRole("table", { name: "Bill of design" })).getByRole("button", { name: "DAQ" }),
    ).toBeTruthy();
});

test("Buildflow's help says how it works", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/buildflow/help");
    const contents = within(await screen.findByRole("navigation", { name: "Contents" }));
    expect(contents.getAllByRole("link").map((link) => link.textContent)).toEqual([
        "Getting started",
        "The vehicle",
        "The bill of design",
        "A component",
        "Links",
        "What's coming up",
        "The shop",
        "Laying out a program",
    ]);
});
