// Piper's part of the server's API (server/src/yjsp_server/piper/schemas.py, or /docs on a running server).

import { apiUrl, Bytes, query, request, requestAsLeaving, requestBytes, type UserRef } from "../api";
import type { SchemeColors } from "./fluids";

export interface Diagram {
    id: number;
    name: string;
    folder: string; // its folder's path, "Vespula/GSE"; "" at the top
    folder_id?: number | null; // its folder (left out by a server from before folders were their own)
    description: string;
    version: number; // each save of its drawing names the version it changed, and gets the next
    revision: number; // its latest revision's number
    parts: number; // on all its pages
    lines: number;
    pages?: number; // how many pages it has (left out by a server from before pages: one)
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
    editing?: Editing | null; // who's editing it, if anyone (left out by a server from before editing: no one)
}

/** Who's editing a diagram: only they change its drawing until they're done (server: piper/diagrams.py). */
export interface Editing {
    by: UserRef;
    since: string;
}

/** A folder of diagrams, in another folder or at the top (parent_id null). */
export interface DiagramFolder {
    id: number;
    parent_id: number | null;
    name: string;
    path: string; // its folders' names from the top down to it: "Vespula/GSE"
    created_at: string;
    created_by: UserRef | null;
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

/** One of the team's color schemes (server: piper/schemes.py): its fluids and valve states' colors. */
export interface Scheme extends SchemeColors {
    is_default: boolean; // the team's: what new diagrams start with
    created_by: UserRef | null;
    updated_by: UserRef | null;
    can_delete: boolean; // yours (or you're an admin), and not the default
    can_edit: boolean; // yours, or you're an admin
}

export type SchemeBody = Pick<Scheme, "name" | "fluids" | "states">;

/** What the server says when someone else is editing a diagram (409 locked). */
export interface LockedDetails {
    editing: Editing;
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
    /** A new diagram, in a folder by its id, or by its path (its folders made where they aren't there). */
    create: (body: {
        name: string;
        folder?: string;
        folder_id?: number | null;
        description?: string;
        drawing?: unknown;
    }) => request<DiagramDetail>("POST", "/api/piper/diagrams", body),
    change: (id: number, change: { name?: string; folder?: string; folder_id?: number | null; description?: string }) =>
        request<Diagram>("PATCH", diagram(id), change),
    remove: (id: number) => request<Diagram>("DELETE", diagram(id)),
    restore: (id: number) => request<Diagram>("POST", `${diagram(id)}/restore`),
    /** Diagrams put in a folder (null: the top), deleted, or restored together: all of them, or none. */
    moveAll: (ids: number[], folder_id: number | null) =>
        request<Diagram[]>("POST", "/api/piper/diagrams/move", { diagrams: ids, folder_id }),
    removeAll: (ids: number[]) => request<Diagram[]>("POST", "/api/piper/diagrams/delete", { diagrams: ids }),
    restoreAll: (ids: number[]) => request<Diagram[]>("POST", "/api/piper/diagrams/restore", { diagrams: ids }),
    folders: () => request<DiagramFolder[]>("GET", "/api/piper/folders"),
    addFolder: (name: string, parent_id: number | null) =>
        request<DiagramFolder>("POST", "/api/piper/folders", { name, parent_id }),
    changeFolder: (id: number, change: { name?: string; parent_id?: number | null }) =>
        request<DiagramFolder>("PATCH", `/api/piper/folders/${id}`, change),
    removeFolder: (id: number) => request<void>("DELETE", `/api/piper/folders/${id}`),
    /** Who's editing it, and the version it's at, without its drawing. */
    editing: (id: number) => request<Diagram>("GET", `${diagram(id)}/lock`),
    /** Start editing it, or say you're still at it; force: an admin taking it over from whoever's editing it. */
    edit: (id: number, force = false) => request<Diagram>("POST", `${diagram(id)}/lock`, { force }),
    doneEditing: (id: number) => request<Diagram>("DELETE", `${diagram(id)}/lock`),
    /** Done editing, as the page closes. */
    doneEditingAsLeaving: (id: number) => requestAsLeaving("DELETE", `${diagram(id)}/lock`),
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
    schemes: () => request<Scheme[]>("GET", "/api/piper/schemes"),
    addScheme: (body: SchemeBody) => request<Scheme>("POST", "/api/piper/schemes", body),
    changeScheme: (id: number, change: Partial<SchemeBody>) =>
        request<Scheme>("PATCH", `/api/piper/schemes/${id}`, change),
    removeScheme: (id: number) => request<void>("DELETE", `/api/piper/schemes/${id}`),
    makeDefault: (id: number) => request<Scheme>("POST", `/api/piper/schemes/${id}/default`),
    /** A picture added (a PNG or a JPEG): the one kept, or the same one added before. */
    addImage: async (file: Blob) =>
        request<ImageInfo>("POST", "/api/piper/images", new Bytes(new Uint8Array(await file.arrayBuffer()))),
    imageBytes: (sha256: string) => requestBytes(`/api/piper/images/${sha256}`),
};

/** A picture a drawing shows, named by its SHA-256. */
export interface ImageInfo {
    sha256: string;
    content_type: string; // image/png, image/jpeg
    width: number; // in pixels
    height: number;
    size: number; // in bytes
    uploaded_at: string;
    uploaded_by: UserRef | null;
}

/** Where a picture is, for the drawing to show it. */
export const imageHref = (sha256: string) => apiUrl(`/api/piper/images/${sha256}`);
