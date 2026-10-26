// Piper's part of the server's API (server/src/yjsp_server/piper/schemas.py, or /docs on a running server).

import { query, request, type UserRef } from "../api";

export interface Diagram {
    id: number;
    name: string;
    folder: string; // a path of folders, "Vespula/GSE"; "" at the top
    description: string;
    version: number; // each save of its drawing names the version it changed, and gets the next
    revision: number; // its latest revision's number
    parts: number;
    lines: number;
    fluids: string[]; // the fluids its lines carry, by id
    created_at: string;
    created_by: UserRef | null;
    updated_at: string;
    updated_by: UserRef | null;
    deleted_at: string | null;
    deleted_by: UserRef | null;
    can_delete: boolean; // yours, or you're an admin
    released?: string | null; // its latest release's letter ("B"), if it's had one
    released_revision?: number | null; // and the revision that is
}

export interface DiagramDetail extends Diagram {
    drawing: unknown; // drawing.ts reads it
}

export interface Revision {
    number: number;
    note: string; // a name given to it: kept as it is
    size: number; // its drawing's bytes
    created_at: string; // when it began
    saved_at: string; // its last save
    author: UserRef | null;
    restored_from: number | null;
    released?: string | null; // its letter, if it's been released: it stays as it is
    release_pending?: boolean; // a release of it is waiting for its approvers: it stays as it is too
}

export interface RevisionDetail extends Revision {
    drawing: unknown;
}

export interface Approval {
    approver: UserRef;
    decision: "pending" | "approved" | "rejected";
    comment: string;
    decided_at: string | null;
}

/** A revision put forward as a diagram's next release, to the approvers named for it (server: piper/releases.py). */
export interface Release {
    id: number;
    revision: number;
    letter: string | null; // "A", "B"..., once it's released
    note: string;
    state: "pending" | "released" | "rejected" | "withdrawn";
    requested_at: string;
    requested_by: UserRef | null;
    decided_at: string | null;
    approvals: Approval[];
    can_withdraw: boolean;
}

/** What the server says when someone saved a diagram after it was opened here (409 changed). */
export interface ChangedDetails {
    version: number;
    updated_by: UserRef | null;
    updated_at: string;
}

const diagram = (id: number) => `/api/piper/diagrams/${id}`;

export const piper = {
    diagrams: (options: { q?: string; deleted?: boolean } = {}) =>
        request<Diagram[]>(
            "GET",
            `/api/piper/diagrams?${query({ q: options.q || undefined, deleted: options.deleted || undefined })}`,
        ),
    diagram: (id: number) => request<DiagramDetail>("GET", diagram(id)),
    create: (body: { name: string; folder?: string; description?: string; drawing?: unknown }) =>
        request<DiagramDetail>("POST", "/api/piper/diagrams", body),
    change: (id: number, change: { name?: string; folder?: string; description?: string }) =>
        request<Diagram>("PATCH", diagram(id), change),
    remove: (id: number) => request<Diagram>("DELETE", diagram(id)),
    restore: (id: number) => request<Diagram>("POST", `${diagram(id)}/restore`),
    /** Its drawing saved, if it's still at version; fresh: as a new revision, even if the latest is yours. */
    save: (id: number, drawing: unknown, version: number, fresh = false) =>
        request<Diagram>("PUT", `${diagram(id)}/drawing`, { drawing, version, fresh }),
    revisions: (id: number) => request<Revision[]>("GET", `${diagram(id)}/revisions`),
    revision: (id: number, number: number) => request<RevisionDetail>("GET", `${diagram(id)}/revisions/${number}`),
    nameRevision: (id: number, number: number, note: string) =>
        request<Revision>("PATCH", `${diagram(id)}/revisions/${number}`, { note }),
    restoreRevision: (id: number, number: number, version: number) =>
        request<DiagramDetail>("POST", `${diagram(id)}/revisions/${number}/restore`, { version }),
    releases: (id: number) => request<Release[]>("GET", `${diagram(id)}/releases`),
    /** A revision put forward as the next release, to these approvers (accounts' ids). */
    requestRelease: (id: number, revision: number, approvers: number[], note: string) =>
        request<Release>("POST", `${diagram(id)}/releases`, { revision, approvers, note }),
    approve: (id: number, release: number, comment = "") =>
        request<Release>("POST", `${diagram(id)}/releases/${release}/approve`, { comment }),
    reject: (id: number, release: number, comment: string) =>
        request<Release>("POST", `${diagram(id)}/releases/${release}/reject`, { comment }),
    withdraw: (id: number, release: number) => request<Release>("POST", `${diagram(id)}/releases/${release}/withdraw`),
};
