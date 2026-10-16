// Vault's part of the server's API (server/src/yjsp_server/vault/schemas.py, or /docs on a running server).

import { apiUrl, ApiError, Bytes, query, request, requestBytes, type UserRef } from "../api";

export type Role = "admin" | "lead" | "editor" | "viewer";

export interface Folder {
    id: number;
    path: string;
    name: string;
    role: Role | null; // yours here; null: you can only pass through to a folder below
    deleted_at?: string | null; // in a folder's trash: when it was deleted, and by whom
    deleted_by?: UserRef | null;
}

export interface Lock {
    user: UserRef;
    host: string;
    since: string;
}

/** A file that another file's latest version uses, and the version it was checked in with. */
export interface Use {
    file_id: number;
    version: number;
}

export interface VaultFile {
    id: number;
    path: string;
    name: string;
    folder_id: number;
    version: number;
    size: number;
    sha256: string;
    created_at: string; // when it was added (its version 1), and by whom
    created_by: UserRef | null;
    modified_at: string; // its latest version's: when it was last changed, and by whom
    modified_by: UserRef;
    checked_out: Lock | null;
    deleted_at: string | null;
    deleted_by?: UserRef | null;
    uses: Use[]; // an assembly's parts, a drawing's model: files you can see, maybe deleted since
}

export interface Listing {
    folder: Folder;
    folders: Folder[];
    files: VaultFile[];
}

export interface Reference {
    file_id: number;
    path: string;
    version: number;
    deleted: boolean;
}

export interface Version {
    number: number;
    size: number;
    sha256: string;
    created_at: string;
    author: UserRef;
    comment: string;
    host: string;
    checkin_id: number;
    references: Reference[];
}

export interface FileDetail {
    file: VaultFile;
    versions: Version[]; // newest first
    used_by: { file: VaultFile; uses_version: number }[];
}

export interface Sync {
    seq: number;
    full: boolean;
    folders: Folder[];
    files: VaultFile[];
}

export interface VaultEvent {
    id: number;
    at: string;
    action: string;
    user: UserRef | null;
    folder_id: number | null;
    file_id: number | null;
    detail: Record<string, unknown>;
    checkin_id?: number | null;
    comment?: string | null;
}

export interface Grant {
    folder: string; // where it's granted: this folder or one above it
    user: UserRef | null; // null: everyone
    role: Role;
}

export interface Grants {
    folder: Folder;
    grants: Grant[];
}

export interface Moved {
    folders: Folder[];
    files: VaultFile[];
}

/** What a delete did: the folders it deleted, and the files it was given. */
export type Deleted = Moved;

export interface CheckinRequest {
    comment: string;
    host: string;
    items: { path: string; sha256: string; size: number; references: { path: string }[] }[];
}

/** A version's 3D model in one configuration, for Caliper (made by Vault for SolidWorks). */
export interface CaliperModel {
    version: number;
    configuration: string;
    kind: "part" | "assembly"; // a part's is a mesh; an assembly's, its components
    units: "mm" | "cm" | "m" | "in" | "ft"; // the document's length unit
    created_at: string;
    created_by: UserRef;
}

/** A component of an assembly's model: a part or sub-assembly, where the assembly has it. */
export interface CaliperComponent {
    name: string;
    file_id: number | null; // null: a virtual part, which the assembly keeps (its mesh is the assembly's)
    version: number | null;
    configuration: string;
    transform: number[]; // rows of a 3 x 4 matrix to the assembly's coordinates (mm)
    hidden: boolean;
    color: [number, number, number] | null;
    opacity: number;
    mesh: string | null;
    model: boolean; // whether its file has a model of its own, at its version and in its configuration
    kind: "part" | "assembly" | null; // its file's: a sub-assembly without children has none of its parts here
    format?: "step" | "iges" | null; // a STEP or IGES file's, placed with 3D Interconnect: read as it is
    children: CaliperComponent[];
}

export interface CaliperAssembly {
    model: CaliperModel;
    components: CaliperComponent[];
    left_out: number; // components in files you can't see
}

export const vaultApi = {
    folder: (path: string) => request<Listing>("GET", "/api/folders?" + query({ path })),
    /** A folder's trash: the folders and files deleted from it. */
    trash: (path: string) => request<Listing>("GET", "/api/folders?" + query({ path, deleted: true })),
    sync: (since: number) => request<Sync>("GET", "/api/sync?" + query({ since })),
    file: (id: number) => request<FileDetail>("GET", `/api/files/${id}`),
    activity: (options: { before?: number; fileId?: number; limit?: number } = {}) =>
        request<VaultEvent[]>(
            "GET",
            "/api/activity?" + query({ before: options.before, file_id: options.fileId, limit: options.limit }),
        ),
    /** Lock files for you on host: a computer's name, or the web app's (WEB_HOST). */
    checkout: (fileIds: number[], host: string) =>
        request<{ files: VaultFile[] }>("POST", "/api/checkout", { files: fileIds, host }),
    /** Your own check-outs undone, or (for a lead) someone else's released. */
    releaseCheckouts: (fileIds: number[]) =>
        request<{ files: VaultFile[] }>("POST", "/api/undo-checkout", { files: fileIds }),
    revert: (fileId: number, version: number, comment: string, force: boolean) =>
        request<VaultFile>("POST", `/api/files/${fileId}/revert`, { version, comment, force }),
    grants: (path: string) => request<Grants>("GET", "/api/grants?" + query({ path })),
    setGrant: (path: string, userId: number | null, role: Role | null) =>
        request<Grants>("PUT", "/api/grants", { path, user_id: userId, role }),
    downloadUrl: (fileId: number, version?: number) =>
        apiUrl(`/api/files/${fileId}/content` + (version === undefined ? "" : "?" + query({ version }))),
    createFolder: (path: string) => request<Folder>("POST", "/api/folders", { path }),
    move: (files: number[], folders: string[], to: string) =>
        request<Moved>("POST", "/api/move", { files, folders, to }),
    rename: (target: { file: number } | { folder: string }, name: string) =>
        request<Moved>("POST", "/api/rename", { ...target, name }),
    /** To the trash: files, and folders with everything in them. force: even if files elsewhere use them. */
    delete: (files: number[], folders: string[], force: boolean) =>
        request<Deleted>("POST", "/api/delete", { files, folders, force }),
    restore: (fileId: number) => request<VaultFile>("POST", `/api/files/${fileId}/restore`),
    restoreFolder: (folderId: number) => request<Folder>("POST", `/api/folders/${folderId}/restore`),
    /** Whether the server has these contents already (so the upload can be skipped). */
    hasBlob: async (sha256: string): Promise<boolean> => {
        try {
            await request<unknown>("HEAD", `/api/blobs/${sha256}`);
            return true;
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
                return false;
            }
            throw error;
        }
    },
    uploadBlob: (sha256: string, data: Uint8Array<ArrayBuffer>) =>
        request<unknown>("PUT", `/api/blobs/${sha256}`, new Bytes(data)),
    checkin: (body: CheckinRequest) =>
        request<{ files: { status: string; file: VaultFile }[] }>("POST", "/api/checkin", body),
    /** A file's 3D models for Caliper: each version's, newest first, in each configuration. */
    caliperModels: (fileId: number) => request<{ models: CaliperModel[] }>("GET", `/api/files/${fileId}/caliper`),
    /** Make a version's 3D model from the 3D view SolidWorks saved in the file; or the model it has already. */
    makeCaliperModel: (fileId: number, version: number) =>
        request<CaliperModel>("POST", `/api/files/${fileId}/caliper/make`, { version }),
    caliperAssembly: (fileId: number, version: number, configuration: string) =>
        request<CaliperAssembly>("GET", `/api/files/${fileId}/caliper/assembly?` + query({ version, configuration })),
    /** A part's mesh (caliper/format.ts), or with mesh, a virtual part's that an assembly's model carries. */
    caliperMesh: (fileId: number, version: number, configuration: string, mesh?: string) =>
        requestBytes(`/api/files/${fileId}/caliper/mesh?` + query({ version, configuration, mesh })),
};
