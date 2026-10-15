// Talking to the server: requests with the session and the header it wants, its errors, and the site's own API
// (server/src/yjsp_server/api/schemas.py, or /docs on a running server). Each app has the rest: vault/api.ts,
// yorg/api.ts.

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
    // For admins (Admin > People): when they last used the site (the web app, the add-in, the CLI), and if they're on now.
    last_active_at?: string | null;
    active_now?: boolean;
    // For admins: how long they've had the web app open, in seconds (not the add-in or the CLI).
    site_seconds?: number | null;
}

/** What admins decide for everyone. */
export interface SiteSettings {
    whitelist: boolean; // on: only invited people join; anyone else who signs in waits for an admin's approval
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
    /** A Windows program's version, like "0.5.0", read from the program; null for other files. */
    version: string | null;
    sha256: string;
}

/** How full the server's disk is, in bytes, and how much of it Vault's files, Yorg's, and the database take. */
export interface Storage {
    total: number;
    free: number; // what the server can still write
    vault: number;
    yorg: number;
    database: number;
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
export class Bytes {
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

/** A query string from the parameters that are set. */
export const query = (params: Record<string, string | number | boolean | undefined>) =>
    new URLSearchParams(
        Object.entries(params)
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => [name, String(value)]),
    ).toString();

export const api = {
    me: () => request<Account>("GET", "/api/me"),
    /** Your own name, as everyone sees it. */
    renameMe: (name: string) => request<Account>("PATCH", "/api/me", { name }),
    users: () => request<Account[]>("GET", "/api/users"),
    invite: (email: string, name: string) => request<Account>("POST", "/api/users", { email, name }),
    updateUser: (id: number, change: { status?: "active" | "disabled"; is_admin?: boolean }) =>
        request<Account>("PATCH", `/api/users/${id}`, change),
    settings: () => request<SiteSettings>("GET", "/api/settings"),
    /** Turning the whitelist off approves everyone waiting too: anyone can join then. */
    updateSettings: (change: Partial<SiteSettings>) => request<SiteSettings>("PATCH", "/api/settings", change),
    downloads: () => request<Download[]>("GET", "/api/downloads"),
    downloadsUrl: (name: string) => apiUrl(`/api/downloads/${encodeURIComponent(name)}`),
    /** For admins: how full the server's disk is. */
    storage: () => request<Storage>("GET", "/api/storage"),
};
