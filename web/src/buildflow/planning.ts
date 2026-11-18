import type { Component, Milestone, PhaseState, ProgramDetail } from "./api";
import { inPhase, phaseState } from "./vehicle";

// The build plan, worked out from each component's lead time (from ordering it, or starting to make it, to having it),
// the day it has to be ready by, and what it needs first: the day to order or start it by, whether it's late or at
// risk as things stand, what it's waiting on, and what it holds up. The plan page (Plan.tsx) draws it on a calendar.

/** A lead time this long or longer is a long lead: six weeks. */
export const LONG_LEAD_DAYS = 42;

const DAY = 86_400_000;

/** A day (2026-12-04) as a number of days, to count with. */
export function dayNumber(day: string): number {
    const [year, month, date] = day.split("-").map(Number);
    return Date.UTC(year!, month! - 1, date!) / DAY;
}

/** A number of days back to a day (2026-12-04). */
export const dayString = (days: number): string => new Date(days * DAY).toISOString().slice(0, 10);

/** A lead time in words: weeks when it's whole weeks ("8 wk"), else days ("10 d"). */
export function leadInWords(days: number): string {
    return days > 0 && days % 7 === 0 ? `${days / 7} wk` : `${days} d`;
}

export interface Planned {
    component: Component;
    state: PhaseState; // where it is in the build phase: done (ready), in progress, blocked, not started
    ready: boolean; // through the build phase: made, or bought and in hand
    lead: number | null; // its lead time, in days
    needBy: string | null; // the day it has to be ready by
    startBy: string | null; // the day to order it (or start it) by, to be ready then: its ready-by day less its lead
    projected: string | null; // when it'll be ready, as things stand (null: can't say, with no lead time)
    late: boolean; // its ready-by day has passed, and it isn't ready
    lateToStart: boolean; // its start-by day has passed, and it hasn't started
    atRisk: boolean; // as things stand, it won't be ready by its day
    long: boolean; // a long lead: six weeks or more, and not ready yet
    waitingOn: Component[]; // what it needs first that isn't ready yet
    holdsUp: Component[]; // what needs it first
}

/**
 * Each of a program's components in its build plan, today being `now`. When a component will be ready, as things
 * stand: once it's ready, it is; one under way, by its day (or today, if that's passed); one not started yet, its lead
 * time after it can start: its start-by day, or today if that's passed, or once what it needs is ready, whichever's
 * last.
 */
export function planOf(program: ProgramDetail, now: string): Planned[] {
    const build = inPhase(program.milestones, "build");
    const today = dayNumber(now);
    const live = new Map(program.components.map((c) => [c.id, c]));
    const states = new Map(program.components.map((c) => [c.id, phaseState(c, build)]));
    const isReady = (c: Component) => ["done", "skipped"].includes(states.get(c.id)!);
    const projected = new Map<number, number | null>();
    const working = new Set<number>(); // on the way to working one out: a circle, which the server refuses, stops here

    function projectedOf(component: Component): number | null {
        if (projected.has(component.id)) {
            return projected.get(component.id)!;
        }
        if (working.has(component.id)) {
            return null;
        }
        working.add(component.id);
        const state = states.get(component.id)!;
        const needBy = component.need_by === null ? null : dayNumber(component.need_by);
        const needs = component.needs.map((id) => live.get(id)).filter((c): c is Component => c !== undefined);
        const after = Math.max(today, ...needs.map((need) => projectedOf(need) ?? today));
        let when: number | null;
        if (state === "done" || state === "skipped") {
            when = readyDay(component, build) ?? today;
        } else if (state === "not_started") {
            const startBy = needBy !== null && component.lead_days !== null ? needBy - component.lead_days : null;
            when = component.lead_days === null ? null : Math.max(after, startBy ?? after) + component.lead_days;
        } else {
            when = Math.max(after, needBy ?? today);
        }
        working.delete(component.id);
        projected.set(component.id, when);
        return when;
    }

    return program.components.map((component) => {
        const state = states.get(component.id)!;
        const ready = isReady(component);
        const lead = component.lead_days;
        const needBy = component.need_by;
        const startBy = needBy !== null && lead !== null ? dayString(dayNumber(needBy) - lead) : null;
        const when = projectedOf(component);
        const needs = component.needs.map((id) => live.get(id)).filter((c): c is Component => c !== undefined);
        return {
            component,
            state,
            ready,
            lead,
            needBy,
            startBy,
            projected: when === null ? null : dayString(when),
            late: !ready && needBy !== null && dayNumber(needBy) < today,
            lateToStart: state === "not_started" && startBy !== null && dayNumber(startBy) < today,
            atRisk: !ready && when !== null && needBy !== null && when > dayNumber(needBy),
            long: !ready && lead !== null && lead >= LONG_LEAD_DAYS,
            waitingOn: needs.filter((need) => !isReady(need)),
            holdsUp: program.components.filter((other) => other.needs.includes(component.id)),
        };
    });
}

/** The day a component became ready: the last day one of its build milestones was done, if it says. */
function readyDay(component: Component, build: Milestone[]): number | null {
    const days = component.progress
        .filter((p) => build.some((m) => m.id === p.milestone_id) && p.done_on)
        .map((p) => dayNumber(p.done_on!));
    return days.length > 0 ? Math.max(...days) : null;
}

/** The plan in order: the soonest to order or start first (long leads float up), then by ready-by day, then those not
 * planned yet, in the program's order. */
export function byStart(planned: Planned[]): Planned[] {
    const key = (p: Planned) => p.startBy ?? p.needBy ?? "9999-12-31";
    return [...planned].sort((a, b) => key(a).localeCompare(key(b)));
}
