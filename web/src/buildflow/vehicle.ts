import type { Component, Milestone, Phase, PhaseState, Profile, Section, Status } from "./api";

// A program's vehicle, drawn from its sections (aft end to nose) as line art, and where its components are on it and
// in each phase: pure functions of a program, which the stage (VehicleView.tsx) draws and the tests read.

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A vehicle as SVG paths, in its drawing's units with y down (the drawing's y is up), and the box around it all. */
export interface Drawn {
    outline: string; // its skin: walls, nozzles, fins, legs, the nose
    detail: string; // what's inside or behind, drawn fainter: joints, tank domes, a coupler's flanges, a stand's frame
    box: Box;
    length: number;
    spans: { x0: number; x1: number; section: Section }[]; // each section, aft to nose
}

const f = (n: number) => String(Math.round(n * 1000) / 1000);
const M = (x: number, y: number) => `M${f(x)} ${f(-y)}`;
const L = (x: number, y: number) => `L${f(x)} ${f(-y)}`;
const C = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) =>
    `C${f(x1)} ${f(-y1)} ${f(x2)} ${f(-y2)} ${f(x)} ${f(-y)}`;
/** Half an ellipse from (x, y) to (x, -y) about (x, 0), bulging aft (toward smaller x) or forward. */
const dome = (x: number, y: number, depth: number, aft: boolean) =>
    `${M(x, y)}A${f(depth)} ${f(y)} 0 0 ${aft ? 0 : 1} ${f(x)} ${f(-y)}`;

/** The vehicle's drawing: each section in turn from the aft end (x 0), around its centerline (y 0). */
export function drawVehicle(profile: Profile, components: Pick<Component, "x" | "y">[] = []): Drawn {
    let outline = "";
    let detail = "";
    const spans: Drawn["spans"] = [];
    // How far it all goes, in the drawing's units with y up.
    let [left, right, low, high] = [0, 0, 0, 0];
    const reach = (x: number, y: number) => {
        [left, right, low, high] = [Math.min(left, x), Math.max(right, x), Math.min(low, y), Math.max(high, y)];
    };
    let x = 0;
    let before: number | null = null; // the radius the last section ended at
    const sections = profile.sections;
    sections.forEach((section, index) => {
        const r = section.diameter / 2;
        const [x0, x1] = [x, x + section.length];
        const length = section.length;
        const first = index === 0 || (index === 1 && sections[0]!.kind === "engine");
        spans.push({ x0, x1, section });
        reach(x0, r);
        reach(x1, -r);
        switch (section.kind) {
            case "engine": {
                const slot = section.diameter / section.count;
                const exit = slot * 0.88;
                const throat = exit * 0.36;
                for (let k = 0; k < section.count; k++) {
                    const middle = -r + slot * (k + 0.5);
                    for (const side of [1, -1]) {
                        const lip = middle + (side * exit) / 2;
                        const neck = middle + (side * throat) / 2;
                        const swell = middle + side * exit * 0.42;
                        outline +=
                            M(x0, lip) +
                            C(x0 + length * 0.35, swell, x0 + length * 0.62, neck, x0 + length * 0.8, neck) +
                            L(x1, neck);
                    }
                    detail += M(x0, middle + exit / 2) + L(x0, middle - exit / 2); // the exit plane
                }
                break;
            }
            case "transition": {
                const from = before ?? r;
                outline += M(x0, from) + L(x1, r) + M(x0, -from) + L(x1, -r);
                reach(x0, from);
                reach(x0, -from);
                break;
            }
            case "nose": {
                outline +=
                    M(x0, r) +
                    C(x0 + length * 0.5, r, x0 + length * 0.88, r * 0.42, x1, 0) +
                    M(x0, -r) +
                    C(x0 + length * 0.5, -r, x0 + length * 0.88, -r * 0.42, x1, 0);
                break;
            }
            default: {
                outline += M(x0, r) + L(x1, r) + M(x0, -r) + L(x1, -r);
                if (section.kind === "tank") {
                    const depth = Math.min(r * 0.55, length * 0.22);
                    detail += dome(x0 + depth, r * 0.94, depth, true) + dome(x1 - depth, r * 0.94, depth, false);
                }
                if (section.kind === "coupler") {
                    const middle = (x0 + x1) / 2;
                    detail += M(middle, r * 1.18) + L(middle, -r * 1.18);
                    detail += M(x0 + length * 0.12, r) + L(x0 + length * 0.12, -r);
                    detail += M(x1 - length * 0.12, r) + L(x1 - length * 0.12, -r);
                    reach(middle, r * 1.18);
                    reach(middle, -r * 1.18);
                }
            }
        }
        // Where one section meets the last: the aft end's base is the skin, the joints behind it are fainter.
        if (section.kind !== "engine" && section.kind !== "nose") {
            const joint = M(x0, r) + L(x0, -r);
            if (first) {
                outline += joint;
            } else {
                detail += joint;
            }
            if (index === sections.length - 1) {
                outline += M(x1, r) + L(x1, -r); // nothing past it: its top is the skin
            }
        } else if (section.kind === "nose" && before !== null) {
            detail += M(x0, r) + L(x0, -r);
        }
        if (section.fins) {
            const chord = Math.min(length * 0.85, r * 3.2);
            const span = r * 1.25;
            const tip = chord * 0.42;
            const back = chord * 0.15;
            for (const side of [1, -1]) {
                outline +=
                    M(x0 + length * 0.02, side * r) +
                    L(x0 + chord, side * r) +
                    L(x0 - back + tip, side * (r + span)) +
                    L(x0 - back, side * (r + span)) +
                    "Z";
                reach(x0 - back, side * (r + span));
            }
        }
        if (section.legs) {
            const foot = { x: x0 - length * 0.9, y: r * 1.9 };
            for (const side of [1, -1]) {
                outline +=
                    M(x0 + length * 0.75, side * r) +
                    L(foot.x, side * foot.y) +
                    M(x0 + length * 0.15, side * r) +
                    L(foot.x, side * foot.y) +
                    M(foot.x, side * (foot.y - r * 0.28)) +
                    L(foot.x, side * (foot.y + r * 0.28));
                reach(foot.x, side * (foot.y + r * 0.28));
            }
        }
        before = r;
        x = x1;
    });
    const length = x;
    if (profile.stand && length > 0) {
        const largest = Math.max(...sections.map((s) => s.diameter / 2));
        const rail = -(largest * 1.45);
        const ground = -(largest * 2.6);
        outline += M(-length * 0.04, ground) + L(length * 1.04, ground);
        detail += M(length * 0.04, rail) + L(length * 0.96, rail);
        const posts = [0.04, 0.35, 0.65, 0.96].map((share) => share * length);
        posts.forEach((post, index) => {
            detail += M(post, rail) + L(post, ground);
            if (index > 0) {
                detail += M(posts[index - 1]!, rail) + L(post, ground); // a brace
            }
        });
        for (const share of [0.2, 0.5, 0.8]) {
            detail += M(share * length, rail) + L(share * length, -largest); // saddles up to the vehicle
        }
        reach(-length * 0.04, ground);
        reach(length * 1.04, ground);
    }
    for (const component of components) {
        if (component.x !== null && component.y !== null) {
            reach(component.x, component.y);
        }
    }
    if (right - left <= 0) {
        [left, right, low, high] = [0, 100, -10, 10]; // nothing drawn yet
    }
    const pad = Math.max((right - left) * 0.03, (high - low) * 0.12);
    return {
        outline,
        detail,
        box: { x: left - pad, y: -high - pad, width: right - left + 2 * pad, height: high - low + 2 * pad },
        length,
        spans,
    };
}

/** The point in a drawing's units (y up) at a place on its SVG, from where on screen it is. */
export function toDrawing(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
    const matrix = svg.getScreenCTM();
    if (!matrix) {
        return null;
    }
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: Math.round(point.x * 10) / 10, y: Math.round(-point.y * 10) / 10 };
}

// --- where components are -----------------------------------------------------------------------------------------

export function statusAt(component: Component, milestone: Milestone): Status {
    return component.progress.find((p) => p.milestone_id === milestone.id)?.status ?? "not_started";
}

/** Where a component is in a phase, from its milestones in it, as the server counts it (progress.phase_state). */
export function phaseState(component: Component, milestones: Milestone[]): PhaseState {
    const wanted = milestones.map((m) => statusAt(component, m)).filter((s) => s !== "skipped");
    if (wanted.length === 0) {
        return "skipped";
    }
    if (wanted.every((s) => s === "done")) {
        return "done";
    }
    if (wanted.includes("blocked")) {
        return "blocked";
    }
    return wanted.some((s) => s === "done" || s === "in_progress") ? "in_progress" : "not_started";
}

export const inPhase = (milestones: Milestone[], phase: Phase) => milestones.filter((m) => m.phase === phase);

export const STATE_NAMES: Record<PhaseState, string> = {
    done: "Done",
    in_progress: "In progress",
    blocked: "Blocked",
    not_started: "Not started",
    skipped: "Not needed",
};

export const STATUS_NAMES: Record<Status, string> = {
    not_started: "Not started",
    in_progress: "In progress",
    done: "Done",
    blocked: "Blocked",
    skipped: "Not needed",
};

/** A status as a milestone says it: a review that's done has passed. */
export const statusName = (status: Status, milestone: Milestone) =>
    status === "done" && milestone.review ? "Passed" : STATUS_NAMES[status];

/** How many components are through a phase's last milestone (the CDRs passed, the components flown), and its name. */
export function through(components: Component[], milestones: Milestone[], phase: Phase) {
    const last = inPhase(milestones, phase).at(-1) ?? null;
    const count = last ? components.filter((c) => statusAt(c, last) === "done").length : 0;
    return { count, last: last?.name ?? null };
}

/** What a program's stage says of a phase, in big letters: how many components are through it. */
export function headline(components: Component[], milestones: Milestone[], phase: Phase): string {
    const total = components.length;
    const { count, last } = through(components, milestones, phase);
    if (total === 0) {
        return "No components yet";
    }
    if (last === null) {
        return `${total} component${total === 1 ? "" : "s"}`;
    }
    switch (phase) {
        case "design":
            return `${count} component-level ${last}${count === 1 ? "" : "s"} across the vehicle`;
        case "build":
            return `${count} of ${total} components built`;
        case "test":
            return `${count} of ${total} components through ${last}`;
        case "launch":
            return `${count} of ${total} components flown`;
    }
}

/** A day, as the server keeps it (2026-12-04), in words: Dec 4, 2026. */
export function formatDay(day: string): string {
    const [year, month, date] = day.split("-").map(Number);
    return new Date(year!, month! - 1, date!).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}

/** Today in this computer's time zone, as the server keeps days. */
export function today(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface Due {
    component: Component;
    milestone: Milestone;
    due: string;
    status: Status;
    late: boolean;
}

/** What's due and not yet done, the soonest first (in a phase, or in all of them). */
export function schedule(components: Component[], milestones: Milestone[], phase: Phase | null): Due[] {
    const now = today();
    const found: Due[] = [];
    for (const component of components) {
        for (const kept of component.progress) {
            const milestone = milestones.find((m) => m.id === kept.milestone_id);
            if (!milestone || !kept.due || kept.status === "done" || kept.status === "skipped") {
                continue;
            }
            if (phase === null || milestone.phase === phase) {
                found.push({ component, milestone, due: kept.due, status: kept.status, late: kept.due < now });
            }
        }
    }
    return found.sort((a, b) => a.due.localeCompare(b.due) || a.component.name.localeCompare(b.component.name));
}
