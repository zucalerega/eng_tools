// The CVC server's JSON API (see server/src/cvc_server/api/schemas.py, or /docs on a running server).

export interface UserRef {
    id: number;
    name: string;
    email: string;
}

export interface Account extends UserRef {
    status: "invited" | "pending" | "active" | "disabled";
    is_admin: boolean;
    created_at: string;
    last_login_at: string | null;
}

export type Role = "admin" | "lead" | "editor" | "viewer";

export interface Folder {
    id: number;
    path: string;
    name: string;
    role: Role | null; // yours here; null: you can only pass through to a folder below
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
    modified_at: string;
    modified_by: UserRef;
    checked_out: Lock | null;
    deleted_at: string | null;
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

export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

// The browser talks to the server it came from, with its session cookie. Tests point it at a test
// server and use a client token instead.
let baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.origin;
let token: string | null = null;

export function configureApi(options: { baseUrl: string; token: string | null }): void {
    baseUrl = options.baseUrl;
    token = options.token;
}

export function apiUrl(path: string): string {
    return new URL(path, baseUrl).toString();
}

/** Send the browser to sign in, then back here. */
export function signIn(): void {
    window.location.assign("/?next=" + encodeURIComponent(window.location.pathname + window.location.search));
}

/** Bytes to send as they are (a file's contents), rather than as JSON. */
class Bytes {
    constructor(readonly data: Uint8Array<ArrayBuffer>) {}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // The server refuses browser writes without this header, which other sites can't add (CSRF).
    const headers: Record<string, string> = { "X-CVC-Request": "1" };
    if (body !== undefined) {
        headers["Content-Type"] = body instanceof Bytes ? "application/octet-stream" : "application/json";
    }
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    const response = await fetch(apiUrl(path), {
        method,
        headers,
        body: body === undefined ? undefined : body instanceof Bytes ? body.data : JSON.stringify(body),
        credentials: "same-origin",
    });
    if (!response.ok) {
        let code = "error";
        let message = `The server said ${response.status} ${response.statusText}`;
        try {
            const error = (await response.json()) as { error?: string; message?: string };
            code = error.error ?? code;
            message = error.message ?? message;
        } catch {
            // not a JSON error: keep the status line
        }
        throw new ApiError(response.status, code, message);
    }
    return response.status === 204 || method === "HEAD" ? (undefined as T) : ((await response.json()) as T);
}

const query = (params: Record<string, string | number | boolean | undefined>) =>
    new URLSearchParams(
        Object.entries(params)
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => [name, String(value)]),
    ).toString();

export const api = {
    me: () => request<Account>("GET", "/api/me"),
    folder: (path: string) => request<Listing>("GET", "/api/folders?" + query({ path })),
    sync: (since: number) => request<Sync>("GET", "/api/sync?" + query({ since })),
    file: (id: number) => request<FileDetail>("GET", `/api/files/${id}`),
    activity: (options: { before?: number; fileId?: number; limit?: number } = {}) =>
        request<VaultEvent[]>(
            "GET",
            "/api/activity?" + query({ before: options.before, file_id: options.fileId, limit: options.limit }),
        ),
    releaseCheckouts: (fileIds: number[]) =>
        request<{ files: VaultFile[] }>("POST", "/api/undo-checkout", { files: fileIds }),
    revert: (fileId: number, version: number, comment: string, force: boolean) =>
        request<VaultFile>("POST", `/api/files/${fileId}/revert`, { version, comment, force }),
    users: () => request<Account[]>("GET", "/api/users"),
    invite: (email: string, name: string) => request<Account>("POST", "/api/users", { email, name }),
    updateUser: (id: number, change: { status?: "active" | "disabled"; is_admin?: boolean }) =>
        request<Account>("PATCH", `/api/users/${id}`, change),
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
};

export interface Moved {
    folders: Folder[];
    files: VaultFile[];
}

export interface CheckinRequest {
    comment: string;
    host: string;
    items: { path: string; sha256: string; size: number; references: { path: string }[] }[];
}
