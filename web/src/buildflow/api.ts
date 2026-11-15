// Buildflow's part of the server's API (server/src/yjsp_server/buildflow/schemas.py, or /docs on a running server).

import { request, type UserRef } from "../api";

export type Phase = "design" | "build" | "test" | "launch";
export const PHASES: Phase[] = ["design", "build", "test", "launch"];
export const PHASE_NAMES: Record<Phase, string> = { design: "Design", build: "Build", test: "Test", launch: "Launch" };

export type Status = "not_started" | "in_progress" | "done" | "blocked" | "skipped";
/** Where a component is in a phase, from its milestones in it (server: progress.phase_state). */
export type PhaseState = "done" | "in_progress" | "blocked" | "not_started" | "skipped";

/** A stretch of the vehicle, from its aft end to its nose (vehicle.ts draws them). */
export interface Section {
    kind: "engine" | "body" | "tank" | "coupler" | "transition" | "nose";
    length: number;
    diameter: number;
    label: string;
    count: number; // an engine's nozzles, side by side
    fins: boolean;
    legs: boolean;
}

export interface Profile {
    sections: Section[];
    stand: boolean; // on a test stand's frame, as for a static fire
}

export interface Milestone {
    id: number;
    phase: Phase;
    name: string; // "CDR"
    title: string; // "Critical Design Review"
    review: boolean;
    position: number;
}

export interface Subsystem {
    id: number;
    name: string;
    position: number;
}

export interface Progress {
    milestone_id: number;
    status: Status;
    due: string | null; // a day, 2026-12-04
    done_on: string | null;
    note: string;
    updated_at: string;
    updated_by: UserRef | null;
}

export type LinkKind =
    "cad" | "drawing" | "requirement" | "document" | "review" | "pid" | "data" | "procedure" | "other";

export interface Link {
    id: number;
    phase: Phase;
    milestone_id: number | null;
    kind: LinkKind;
    title: string;
    url: string; // http(s), or a page of the site's own: /vault/file/12
    added_at: string;
    added_by: UserRef | null;
}

export interface Assignment {
    phase: Phase;
    user: UserRef;
}

export interface Component {
    id: number;
    program_id: number;
    subsystem_id: number;
    name: string;
    description: string;
    bought: boolean; // off the shelf
    x: number | null; // on the vehicle's drawing, from its aft end; null: not on it
    y: number | null; // up from its centerline
    position: number;
    lead: UserRef | null;
    updated_at: string;
    updated_by: UserRef | null;
    removed_at: string | null;
    progress: Progress[];
    links: Link[];
    people: Assignment[];
}

export type PhaseCounts = Record<PhaseState, number>;

export interface Program {
    id: number;
    name: string;
    description: string;
    profile: Profile;
    position: number;
    created_at: string;
    created_by: UserRef | null;
    updated_at: string;
    updated_by: UserRef | null;
    archived_at: string | null;
    component_count: number;
    phases: Record<Phase, PhaseCounts>;
    through: Record<Phase, number>; // how many are through each phase's last milestone
    last_milestone: Record<Phase, string | null>;
    can_edit: boolean; // admins lay programs out
}

export interface ProgramDetail extends Program {
    milestones: Milestone[];
    subsystems: Subsystem[];
    components: Component[];
    removed: Component[]; // for admins, to bring back
}

export interface Activity {
    id: number;
    component_id: number | null;
    component: string | null;
    user: UserRef | null;
    at: string;
    what: string;
}

export type Template = "rocket" | "hopper" | "stand" | "blank";

export interface ProgressChange {
    status?: Status;
    due?: string | null;
    done_on?: string | null;
    note?: string;
}

export interface ComponentChange {
    name?: string;
    subsystem_id?: number;
    description?: string;
    bought?: boolean;
    x?: number | null;
    y?: number | null;
    position?: number;
    lead_id?: number | null;
}

const program = (id: number) => `/api/buildflow/programs/${id}`;
const component = (id: number) => `/api/buildflow/components/${id}`;

export const buildflow = {
    programs: (archived = false) =>
        request<Program[]>("GET", `/api/buildflow/programs${archived ? "?archived=true" : ""}`),
    program: (id: number) => request<ProgramDetail>("GET", program(id)),
    addProgram: (name: string, description: string, template: Template) =>
        request<ProgramDetail>("POST", "/api/buildflow/programs", { name, description, template }),
    changeProgram: (
        id: number,
        change: { name?: string; description?: string; profile?: Profile; position?: number },
    ) => request<Program>("PATCH", program(id), change),
    archive: (id: number) => request<Program>("POST", `${program(id)}/archive`),
    restore: (id: number) => request<Program>("POST", `${program(id)}/restore`),
    activity: (id: number, limit = 50) => request<Activity[]>("GET", `${program(id)}/activity?limit=${limit}`),

    addMilestone: (id: number, body: { phase: Phase; name: string; title?: string; review?: boolean }) =>
        request<Milestone>("POST", `${program(id)}/milestones`, body),
    changeMilestone: (
        id: number,
        change: { phase?: Phase; name?: string; title?: string; review?: boolean; position?: number },
    ) => request<Milestone>("PATCH", `/api/buildflow/milestones/${id}`, change),
    removeMilestone: (id: number) => request<void>("DELETE", `/api/buildflow/milestones/${id}`),
    addSubsystem: (id: number, name: string) => request<Subsystem>("POST", `${program(id)}/subsystems`, { name }),
    changeSubsystem: (id: number, change: { name?: string; position?: number }) =>
        request<Subsystem>("PATCH", `/api/buildflow/subsystems/${id}`, change),
    removeSubsystem: (id: number) => request<void>("DELETE", `/api/buildflow/subsystems/${id}`),
    addComponent: (
        id: number,
        body: { subsystem_id: number; name: string; bought?: boolean; x?: number | null; y?: number | null },
    ) => request<Component>("POST", `${program(id)}/components`, body),

    component: (id: number) => request<Component>("GET", component(id)),
    changeComponent: (id: number, change: ComponentChange) => request<Component>("PATCH", component(id), change),
    removeComponent: (id: number) => request<Component>("DELETE", component(id)),
    restoreComponent: (id: number) => request<Component>("POST", `${component(id)}/restore`),
    setProgress: (id: number, milestone: number, change: ProgressChange) =>
        request<Component>("PUT", `${component(id)}/progress/${milestone}`, change),
    addLink: (
        id: number,
        body: { phase: Phase; kind: LinkKind; url: string; title: string; milestone_id: number | null },
    ) => request<Component>("POST", `${component(id)}/links`, body),
    removeLink: (id: number) => request<Component>("DELETE", `/api/buildflow/links/${id}`),
    setPeople: (id: number, phase: Phase, userIds: number[]) =>
        request<Component>("PUT", `${component(id)}/people`, { phase, user_ids: userIds }),
};
