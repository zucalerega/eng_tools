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
}

export interface RevisionDetail extends Revision {
    drawing: unknown;
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
};
