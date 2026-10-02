// The server's JSON API (see server/src/yjsp_server/api/schemas.py, or /docs on a running server).

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
    // For admins (Admin > People): when they last used Vault (the web app, the add-in, the CLI), and if they're on now.
    last_active_at?: string | null;
    active_now?: boolean;
}

/** What admins decide for everyone. */
export interface SiteSettings {
    whitelist: boolean; // on: only invited people join; anyone else who signs in waits for an admin's approval
}

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

export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly details: Record<string, unknown> = {}, // what the problem was about, like the files in use
    ) {
        super(message);
    }
}

/** A file the server offers for download, like the add-in's installer. */
export interface Download {
    name: string;
    size: number;
    modified_at: string;
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

/** What every request carries: the header the server wants on browser writes, and (in tests) a client token. */
function baseHeaders(): Record<string, string> {
    // The server refuses browser writes without this header, which other sites can't add (CSRF).
    const headers: Record<string, string> = { "X-YJSP-Request": "1" };
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
}

/** The server's error, from its JSON body: {"error": code, "message": ..., "details": {...}}. */
function apiError(status: number, statusText: string, text: string): ApiError {
    let code = "error";
    let message = `The server said ${status} ${statusText}`;
    let details = {};
    try {
        const error = JSON.parse(text) as { error?: string; message?: string; details?: Record<string, unknown> };
        code = error.error ?? code;
        message = error.message ?? message;
        details = error.details ?? details;
    } catch {
        // not a JSON error: keep the status line
    }
    return new ApiError(status, code, message, details);
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = baseHeaders();
    if (body !== undefined) {
        headers["Content-Type"] = body instanceof Bytes ? "application/octet-stream" : "application/json";
    }
    const response = await fetch(apiUrl(path), {
        method,
        headers,
        body: body === undefined ? undefined : body instanceof Bytes ? body.data : JSON.stringify(body),
        credentials: "same-origin",
    });
    if (!response.ok) {
        throw apiError(response.status, response.statusText, await response.text());
    }
    return response.status === 204 || method === "HEAD" ? (undefined as T) : ((await response.json()) as T);
}

/** A binary answer, like an array of samples. */
export async function requestBytes(path: string): Promise<ArrayBuffer> {
    const response = await fetch(apiUrl(path), { headers: baseHeaders(), credentials: "same-origin" });
    if (!response.ok) {
        throw apiError(response.status, response.statusText, await response.text());
    }
    return response.arrayBuffer();
}

/**
 * Send a file as the request body, saying how much has gone as it goes. Only XMLHttpRequest reports an upload's
 * progress, and only to its own server; elsewhere (the tests' server) fetch sends it, read into memory first.
 */
export function uploadFile<T>(path: string, file: Blob, onProgress: (sent: number) => void): Promise<T> {
    const url = apiUrl(path);
    if (new URL(url).origin !== window.location.origin) {
        return file.arrayBuffer().then(async (contents) => {
            const body = new Uint8Array(contents);
            const response = await fetch(url, { method: "POST", headers: baseHeaders(), body });
            const text = await response.text();
            if (!response.ok) {
                throw apiError(response.status, response.statusText, text);
            }
            onProgress(file.size);
            return JSON.parse(text) as T;
        });
    }
    return new Promise<T>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        for (const [name, value] of Object.entries(baseHeaders())) {
            xhr.setRequestHeader(name, value);
        }
        xhr.upload.onprogress = (event) => onProgress(event.loaded);
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(JSON.parse(xhr.responseText) as T);
            } else {
                reject(apiError(xhr.status, xhr.statusText, xhr.responseText));
            }
        };
        xhr.onerror = () => reject(new ApiError(0, "network", "The upload didn't reach the server; try again"));
        xhr.send(file);
    });
}

const query = (params: Record<string, string | number | boolean | undefined>) =>
    new URLSearchParams(
        Object.entries(params)
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => [name, String(value)]),
    ).toString();

export const api = {
    me: () => request<Account>("GET", "/api/me"),
    /** Your own name, as everyone sees it. */
    renameMe: (name: string) => request<Account>("PATCH", "/api/me", { name }),
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
    users: () => request<Account[]>("GET", "/api/users"),
    invite: (email: string, name: string) => request<Account>("POST", "/api/users", { email, name }),
    updateUser: (id: number, change: { status?: "active" | "disabled"; is_admin?: boolean }) =>
        request<Account>("PATCH", `/api/users/${id}`, change),
    settings: () => request<SiteSettings>("GET", "/api/settings"),
    /** Turning the whitelist off approves everyone waiting too: anyone can join then. */
    updateSettings: (change: Partial<SiteSettings>) => request<SiteSettings>("PATCH", "/api/settings", change),
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
    downloads: () => request<Download[]>("GET", "/api/downloads"),
    downloadsUrl: (name: string) => apiUrl(`/api/downloads/${encodeURIComponent(name)}`),
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

/** What a delete did: the folders it deleted, and the files it was given. */
export type Deleted = Moved;

export interface CheckinRequest {
    comment: string;
    host: string;
    items: { path: string; sha256: string; size: number; references: { path: string }[] }[];
}
