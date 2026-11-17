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
    reviews: Review[]; // by their days, those with none yet last
}

/** A design review held for several components at once, at one of the program's review milestones. */
export interface Review {
    id: number;
    program_id: number;
    milestone_id: number;
    name: string;
    held_on: string | null; // its day: each component's due date at its milestone
    notes: string; // taken in it, in Markdown
    component_ids: number[]; // those removed from the program too, covered again once they're brought back
    files: ReviewFile[];
    created_at: string;
    created_by: UserRef | null;
    updated_at: string;
    updated_by: UserRef | null;
    removed_at: string | null;
}

/** A review's file: its slides, its package, its minutes, wherever they're kept (SharePoint, say). */
export interface ReviewFile {
    id: number;
    title: string;
    url: string;
    added_at: string;
    added_by: UserRef | null;
}

export interface ReviewChange {
    name?: string;
    held_on?: string | null;
    notes?: string;
    component_ids?: number[];
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

// --- the shop (server: buildflow/shop.py) ---

export type ShopStatus = "queued" | "in_progress" | "blocked" | "done";
export const SHOP_STATUSES: ShopStatus[] = ["queued", "in_progress", "blocked", "done"];
export const SHOP_STATUS_NAMES: Record<ShopStatus, string> = {
    queued: "Queued",
    in_progress: "In progress",
    blocked: "Blocked",
    done: "Done",
};
/** How far someone's trained on a machine. */
export const LEVEL_NAMES = ["Not trained", "Supervised only", "Runs it on their own", "Trains others"];
/** The level at which someone can make a machine's parts: they run it on their own. */
export const RUNS_IT = 2;

export interface Machine {
    id: number;
    name: string;
    position: number;
    retired: boolean; // takes no new parts
}

export interface Trained {
    user: UserRef;
    levels: Record<string, number>; // by machine id: 1 to 3 (left out: not trained)
}

export interface ShopPart {
    id: number;
    name: string;
    program: { id: number; name: string } | null; // what it's for: a program, and maybe one of its components
    component: { id: number; name: string } | null;
    machine_id: number;
    machine: string; // its name
    material: string;
    quantity: number;
    hours: number | null; // estimated, for all of them
    drawing: string; // a link: an address, or a page of the site's own ("/vault/file/12")
    cad: string;
    status: ShopStatus;
    requester: UserRef | null; // its responsible engineer
    machinist: UserRef | null;
    need_by: string | null; // a day, 2026-12-04
    note: string;
    created_at: string;
    updated_at: string;
    updated_by: UserRef | null;
    done_at: string | null;
    removed_at: string | null;
}

/** A part, as it's sent to be queued or changed: what's sent changes (component_id and program_id go together). */
export interface ShopPartChange {
    name?: string;
    machine_id?: number;
    component_id?: number | null;
    program_id?: number | null;
    material?: string;
    quantity?: number;
    hours?: number | null;
    drawing?: string;
    cad?: string;
    status?: ShopStatus;
    requester_id?: number | null;
    machinist_id?: number | null;
    need_by?: string | null;
    note?: string;
}

/** A machine's open work (not done), and who can do it. */
export interface Load {
    machine_id: number;
    parts: number;
    hours: number;
    unestimated: number;
    operators: number; // who run it on their own, or train others on it
    trainers: number;
}

export interface Shop {
    machines: Machine[];
    parts: ShopPart[];
    trained: Trained[];
    load: Load[];
    can_edit_machines: boolean;
}

const program = (id: number) => `/api/buildflow/programs/${id}`;
const component = (id: number) => `/api/buildflow/components/${id}`;
const shopPart = (id: number) => `/api/buildflow/shop/parts/${id}`;
const review = (id: number) => `/api/buildflow/reviews/${id}`;

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

    /** A program's design reviews (removed: those taken off it instead). */
    reviews: (programId: number, removed = false) =>
        request<Review[]>("GET", `${program(programId)}/reviews${removed ? "?removed=true" : ""}`),
    review: (id: number) => request<Review>("GET", review(id)),
    addReview: (
        programId: number,
        body: { milestone_id: number; name: string; held_on: string | null; component_ids: number[] },
    ) => request<Review>("POST", `${program(programId)}/reviews`, body),
    changeReview: (id: number, change: ReviewChange) => request<Review>("PATCH", review(id), change),
    /** Pass a review: each of its components passes its milestone, on the day said (else the review's, or today). */
    passReview: (id: number, doneOn: string) => request<Review>("POST", `${review(id)}/pass`, { done_on: doneOn }),
    removeReview: (id: number) => request<Review>("DELETE", review(id)),
    restoreReview: (id: number) => request<Review>("POST", `${review(id)}/restore`),
    addReviewFile: (id: number, body: { url: string; title: string }) =>
        request<Review>("POST", `${review(id)}/files`, body),
    removeReviewFile: (id: number, fileId: number) => request<Review>("DELETE", `${review(id)}/files/${fileId}`),

    /** The shop: its machines, its queue (removed: the parts taken off it instead), who's trained, and its load. */
    shop: (removed = false) => request<Shop>("GET", `/api/buildflow/shop${removed ? "?removed=true" : ""}`),
    /** The parts in the shop's queue for a component. */
    shopPartsFor: (componentId: number) =>
        request<ShopPart[]>("GET", `/api/buildflow/shop/parts?component_id=${componentId}`),
    addShopPart: (part: ShopPartChange & { name: string; machine_id: number }) =>
        request<ShopPart>("POST", "/api/buildflow/shop/parts", part),
    changeShopPart: (id: number, change: ShopPartChange) => request<ShopPart>("PATCH", shopPart(id), change),
    removeShopPart: (id: number) => request<ShopPart>("DELETE", shopPart(id)),
    restoreShopPart: (id: number) => request<ShopPart>("POST", `${shopPart(id)}/restore`),
    /** Say how far someone's trained on each machine sent (0 to 3): your own, or anyone's for admins. */
    setLevels: (userId: number, levels: Record<number, number>) =>
        request<Trained>("PUT", `/api/buildflow/shop/skills/${userId}`, { levels }),
    addMachine: (name: string) => request<Machine>("POST", "/api/buildflow/shop/machines", { name }),
    changeMachine: (id: number, change: { name?: string; retired?: boolean }) =>
        request<Machine>("PATCH", `/api/buildflow/shop/machines/${id}`, change),
};
