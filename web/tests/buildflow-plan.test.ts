import { expect, test } from "vitest";
import type { Component, Milestone, PhaseCounts, ProgramDetail, Status } from "../src/buildflow/api";
import { byStart, dayNumber, dayString, leadInWords, planOf, type Planned } from "../src/buildflow/planning";

// The build plan, worked out without the server: each component's day to order or start it by, when it'll be ready as
// things stand, and whether it's late, at risk, or waiting on what it needs first.

const build: Milestone[] = [
    { id: 1, phase: "build", name: "Procurement", title: "", review: false, position: 0 },
    { id: 2, phase: "build", name: "Manufacturing", title: "", review: false, position: 1 },
];

function component(
    id: number,
    plan: { lead?: number; needBy?: string; needs?: number[] },
    statuses: Record<number, Status> = {},
    doneOn: Record<number, string> = {},
): Component {
    return {
        id,
        program_id: 1,
        subsystem_id: 1,
        name: `Part ${id}`,
        description: "",
        bought: false,
        x: null,
        y: null,
        position: id,
        lead: null,
        lead_days: plan.lead ?? null,
        need_by: plan.needBy ?? null,
        needs: plan.needs ?? [],
        updated_at: "2026-11-01T00:00:00Z",
        updated_by: null,
        removed_at: null,
        progress: Object.entries(statuses).map(([milestone, status]) => ({
            milestone_id: Number(milestone),
            status,
            due: null,
            done_on: doneOn[Number(milestone)] ?? null,
            note: "",
            updated_at: "2026-11-01T00:00:00Z",
            updated_by: null,
        })),
        links: [],
        people: [],
    };
}

const none: PhaseCounts = { done: 0, in_progress: 0, blocked: 0, not_started: 0, skipped: 0 };

function program(components: Component[]): ProgramDetail {
    return {
        id: 1,
        name: "Elytra",
        description: "",
        profile: { sections: [], stand: false },
        position: 0,
        created_at: "2026-09-01T00:00:00Z",
        created_by: null,
        updated_at: "2026-09-01T00:00:00Z",
        updated_by: null,
        archived_at: null,
        component_count: components.length,
        phases: { design: none, build: none, test: none, launch: none },
        through: { design: 0, build: 0, test: 0, launch: 0 },
        last_milestone: { design: null, build: null, test: null, launch: null },
        can_edit: false,
        milestones: build,
        subsystems: [{ id: 1, name: "Fluids", position: 0 }],
        components,
        removed: [],
        reviews: [],
    };
}

const TODAY = "2026-11-17";
const of = (planned: Planned[], id: number) => planned.find((p) => p.component.id === id)!;

test("days count across months and years, and lead times read in weeks when they're whole", () => {
    expect(dayNumber("2027-01-01") - dayNumber("2026-12-25")).toBe(7);
    expect(dayString(dayNumber("2026-02-28") + 1)).toBe("2026-03-01");
    expect([leadInWords(56), leadInWords(10), leadInWords(0)]).toEqual(["8 wk", "10 d", "0 d"]);
});

test("a component's start-by day is its ready-by day less its lead time, and a long lead is six weeks or more", () => {
    const planned = planOf(
        program([component(1, { lead: 84, needBy: "2027-03-01" }), component(2, { lead: 14, needBy: "2027-01-15" })]),
        TODAY,
    );
    expect([of(planned, 1).startBy, of(planned, 1).long, of(planned, 1).atRisk]).toEqual(["2026-12-07", true, false]);
    expect([of(planned, 2).startBy, of(planned, 2).long]).toEqual(["2027-01-01", false]);
    // On plan, each will be ready on its day.
    expect([of(planned, 1).projected, of(planned, 2).projected]).toEqual(["2027-03-01", "2027-01-15"]);
    // The soonest to order first.
    expect(byStart(planned).map((p) => p.component.id)).toEqual([1, 2]);
});

test("one not ordered by its start-by day is late to start, and at risk: ready a lead time from today", () => {
    const planned = planOf(program([component(1, { lead: 56, needBy: "2026-12-15" })]), TODAY);
    const regulator = of(planned, 1);
    expect([regulator.startBy, regulator.lateToStart, regulator.atRisk, regulator.late]).toEqual([
        "2026-10-20",
        true,
        true,
        false,
    ]);
    expect(regulator.projected).toBe(dayString(dayNumber(TODAY) + 56));
});

test("one under way is on its day, and one ready isn't late, long, or at risk", () => {
    const planned = planOf(
        program([
            component(1, { lead: 56, needBy: "2026-12-15" }, { 1: "in_progress" }),
            component(
                2,
                { lead: 56, needBy: "2026-11-01" },
                { 1: "done", 2: "done" },
                { 1: "2026-10-02", 2: "2026-10-30" },
            ),
            component(3, { lead: 7, needBy: "2026-11-10" }, { 1: "in_progress" }),
        ]),
        TODAY,
    );
    expect([of(planned, 1).projected, of(planned, 1).atRisk, of(planned, 1).lateToStart]).toEqual([
        "2026-12-15",
        false,
        false,
    ]);
    expect([of(planned, 2).ready, of(planned, 2).projected, of(planned, 2).long, of(planned, 2).late]).toEqual([
        true,
        "2026-10-30",
        false,
        false,
    ]);
    // Its day passed, and it's still under way: late.
    expect([of(planned, 3).late, of(planned, 3).projected]).toEqual([true, TODAY]);
});

test("one waits on what it needs first, and is at risk when that won't be ready in time", () => {
    const planned = planOf(
        program([
            component(1, { lead: 70, needBy: "2027-02-01" }), // the chamber: start by Nov 23
            component(2, { lead: 21, needBy: "2027-02-22", needs: [1] }), // the structure: start by Feb 1, as it is
            component(3, { lead: 21, needBy: "2027-02-08", needs: [1] }), // the stand: start by Jan 18, before it's ready
        ]),
        TODAY,
    );
    const structure = of(planned, 2);
    expect(structure.waitingOn.map((c) => c.id)).toEqual([1]);
    expect([structure.projected, structure.atRisk]).toEqual(["2027-02-22", false]);
    expect(of(planned, 1).holdsUp.map((c) => c.id)).toEqual([2, 3]);
    // Feb 1 and three weeks: Feb 22, after its day.
    expect([of(planned, 3).projected, of(planned, 3).atRisk]).toEqual(["2027-02-22", true]);
});

test("one with no lead time can't be projected, and one not planned sorts last", () => {
    const planned = planOf(
        program([
            component(1, {}),
            component(2, { needBy: "2026-12-01" }),
            component(3, { lead: 7, needBy: "2027-01-04" }),
        ]),
        TODAY,
    );
    expect([of(planned, 1).projected, of(planned, 1).startBy, of(planned, 2).projected]).toEqual([null, null, null]);
    expect(byStart(planned).map((p) => p.component.id)).toEqual([2, 3, 1]);
});
