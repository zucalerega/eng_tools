import { expect, test } from "vitest";
import type { Component, Milestone, Profile, Section, Status } from "../src/buildflow/api";
import { guessKind, siteTarget, tidyUrl } from "../src/buildflow/links";
import { drawVehicle, headline, phaseState, schedule, through, today } from "../src/buildflow/vehicle";

// What a program's page draws and counts, without the server: the vehicle from its sections, where a component is in a
// phase, the stage's caption, what's due, and the links it knows to be the site's.

const section = (kind: Section["kind"], length: number, diameter: number, more: Partial<Section> = {}): Section => ({
    kind,
    length,
    diameter,
    label: "",
    count: 1,
    fins: false,
    legs: false,
    ...more,
});

const milestones: Milestone[] = [
    { id: 1, phase: "design", name: "PDR", title: "", review: true, position: 0 },
    { id: 2, phase: "design", name: "CDR", title: "", review: true, position: 1 },
    { id: 3, phase: "build", name: "Manufacturing", title: "", review: false, position: 0 },
];

function component(id: number, statuses: Record<number, Status>, due: Record<number, string> = {}): Component {
    return {
        id,
        program_id: 1,
        subsystem_id: 1,
        name: `Part ${id}`,
        description: "",
        bought: false,
        x: id,
        y: 0,
        position: 0,
        lead: null,
        updated_at: "2026-11-01T00:00:00Z",
        updated_by: null,
        removed_at: null,
        progress: [...new Set([...Object.keys(statuses), ...Object.keys(due)].map(Number))].map((milestone) => ({
            milestone_id: milestone,
            status: statuses[milestone] ?? "not_started",
            due: due[milestone] ?? null,
            done_on: null,
            note: "",
            updated_at: "2026-11-01T00:00:00Z",
            updated_by: null,
        })),
        links: [],
        people: [],
    };
}

test("the vehicle is drawn from its sections, aft to nose, and its box holds all of it", () => {
    const profile: Profile = {
        sections: [
            section("engine", 10, 6, { count: 2 }),
            section("tank", 40, 8, { fins: true }),
            section("transition", 6, 6),
            section("nose", 20, 6),
        ],
        stand: false,
    };
    const drawn = drawVehicle(profile);
    expect(drawn.length).toBe(76);
    expect(drawn.spans.map((s) => [s.x0, s.x1])).toEqual([
        [0, 10],
        [10, 50],
        [50, 56],
        [56, 76],
    ]);
    // Two nozzles, each a bell above and below its middle; the tank's two domes, as arcs, in the details.
    expect(drawn.outline.match(/C/g)?.length).toBe(2 * 2 + 2);
    expect(drawn.detail.match(/A/g)?.length).toBe(2);
    // The fins reach past the tank's radius (4) by its radius and a quarter; the box holds them, with room around.
    expect(drawn.box.y).toBeLessThan(-(4 + 5));
    expect(drawn.box.y + drawn.box.height).toBeGreaterThan(4 + 5);
    expect(drawn.box.x).toBeLessThan(0);
    expect(drawn.box.x + drawn.box.width).toBeGreaterThan(76);
});

test("a stand is drawn under the vehicle, and a vehicle not drawn yet still has a box for its components", () => {
    const standing = drawVehicle({ sections: [section("body", 50, 10)], stand: true });
    expect(standing.box.y + standing.box.height).toBeGreaterThan(5 * 2.6); // the ground, under it
    const empty = drawVehicle({ sections: [], stand: false });
    expect([empty.outline, empty.detail]).toEqual(["", ""]);
    expect(empty.box.width).toBeGreaterThan(0);
    const placed = drawVehicle({ sections: [], stand: false }, [{ x: 300, y: 40 }]);
    expect(placed.box.x + placed.box.width).toBeGreaterThan(300);
});

test("where a component is in a phase is counted as the server counts it", () => {
    const design = milestones.filter((m) => m.phase === "design");
    expect(phaseState(component(1, {}), design)).toBe("not_started");
    expect(phaseState(component(1, { 1: "done" }), design)).toBe("in_progress");
    expect(phaseState(component(1, { 1: "done", 2: "done" }), design)).toBe("done");
    expect(phaseState(component(1, { 1: "skipped", 2: "done" }), design)).toBe("done");
    expect(phaseState(component(1, { 1: "skipped", 2: "skipped" }), design)).toBe("skipped");
    expect(phaseState(component(1, { 1: "done", 2: "blocked" }), design)).toBe("blocked");
    expect(phaseState(component(1, {}), [])).toBe("skipped");
});

test("the stage says how many are through each phase's last milestone", () => {
    const parts = [component(1, { 1: "done", 2: "done" }), component(2, { 2: "done", 3: "done" }), component(3, {})];
    expect(through(parts, milestones, "design")).toEqual({ count: 2, last: "CDR" });
    expect(headline(parts, milestones, "design")).toBe("2 component-level CDRs across the vehicle");
    expect(headline(parts.slice(0, 1), milestones, "design")).toBe("1 component-level CDR across the vehicle");
    expect(headline(parts, milestones, "build")).toBe("1 of 3 components built");
    expect(headline(parts, milestones, "test")).toBe("3 components"); // no test milestones
    expect(headline([], milestones, "design")).toBe("No components yet");
});

test("what's due comes soonest first, late or not, and what's done or not needed isn't due", () => {
    const parts = [
        component(1, { 2: "in_progress" }, { 2: "2099-01-05", 3: "2000-01-01" }),
        component(2, { 2: "done" }, { 2: "2001-01-01" }),
        component(3, { 3: "skipped" }, { 3: "2001-01-01" }),
    ];
    const due = schedule(parts, milestones, null);
    expect(due.map((d) => [d.component.id, d.milestone.name, d.late])).toEqual([
        [1, "Manufacturing", true],
        [1, "CDR", false],
    ]);
    expect(schedule(parts, milestones, "design").map((d) => d.milestone.name)).toEqual(["CDR"]);
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("links to the site's own apps are kept as their paths, and known by where they go", () => {
    expect(tidyUrl(`  ${window.location.origin}/vault/file/12 `)).toBe("/vault/file/12");
    expect(tidyUrl("https://notion.so/yjsp/x")).toBe("https://notion.so/yjsp/x");
    expect(siteTarget("/vault/file/12")).toEqual({ app: "vault", id: 12 });
    expect(siteTarget("/vault/files/Elytra/Tanks")).toEqual({ app: "vault", id: null });
    expect(siteTarget("/piper/diagrams/3/parts?find=PT-101")).toEqual({ app: "piper", id: 3 });
    expect(siteTarget("/yorg/datasets/7")).toEqual({ app: "yorg", id: 7 });
    expect(siteTarget("/elsewhere")).toBeNull();
    expect(siteTarget("https://example.com/vault/file/1")).toBeNull();
    expect([guessKind("/piper/diagrams/3"), guessKind("/yorg/datasets/7"), guessKind("/vault/file/1")]).toEqual([
        "pid",
        "data",
        "cad",
    ]);
    expect(guessKind("https://docs.google.com/x")).toBeNull();
});
