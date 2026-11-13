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
    // For admins: how long they've had the web app open, and worked in SolidWorks with the add-in, in seconds.
    site_seconds?: number | null;
    solidworks_seconds?: number | null;
}

/** What admins decide for everyone. */
export interface SiteSettings {
    // On: only the emails on the whitelist, and people an admin invited, can make an account; anyone else who signs
    // in is turned away. Off: anyone with a Georgia Tech account can.
    whitelist: boolean;
    // The oldest add-in and vault command that can change the vault, like "0.5.4": older ones can still read it, and
    // are told to update. Null: any version can. It can be no newer than the installer offered.
    min_client_version: string | null;
}

/** A Georgia Tech address on the whitelist, with its account once it has one. */
export interface WhitelistEntry {
    id: number;
    email: string;
    added_at: string;
    account: Account | null;
}

/** What putting emails on the whitelist did with each. */
export interface WhitelistAdded {
    added: string[];
    already: string[]; // on it before
    not_georgia_tech: string[]; // left off: only Georgia Tech accounts make accounts
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

/** A computer someone is signed in to the SolidWorks add-in on. */
export interface AddInComputer {
    name: string; // as the add-in said it when it signed in
    version: string | null; // the add-in's, as its requests last said it
    signed_in_at: string;
    last_used_at: string | null;
    in_use: boolean; // used in the last 90 days, so its person has it
    outdated: boolean; // older than the installer offered now: it offers itself the update
}

/** Someone who has the add-in, or downloaded its installer. */
export interface AddInPerson {
    user: UserRef;
    computers: AddInComputer[];
    downloaded_at: string | null; // when they last downloaded the installer
    downloaded_version: string | null;
    downloads: number; // how many times, updates by the add-in included
}

/** Who has the SolidWorks add-in (Admin > People). */
export interface AddIn {
    people: AddInPerson[]; // the most recently on first
    have_it: number; // signed in with it, and using it in the last 90 days
    this_week: number;
    downloaded: number; // people who downloaded the installer
    newest: string | null; // the installer's version, offered now
    on_newest: number; // of the people who have it, who are on it (or newer) on a computer they use
    counting_since: string | null; // the first download counted: none were before
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

/** How full the server's disk is, in bytes, and how much of it each app takes: anyone signed in sees it (the home page). */
export interface StorageSummary {
    total: number;
    free: number; // what the server can still write
    vault: number;
    yorg: number;
    piper: number; // its drawings and pictures, in the database
}

/** The same for admins (Admin > People): what the whole database takes too, and the off-site backup. */
export interface Storage extends StorageSummary {
    database: number;
    backup?: Backup | null; // null: no off-site backup on this server
}

/** What the off-site backup last said about itself (deploy/yjsp-offsite). */
export interface Backup {
    backed_up_at: string | null; // the last copy that worked
    snapshot: string | null;
    backup_failed_at: string | null; // the last that didn't, if it's since that one
    backup_error: string | null;
    verified_at: string | null; // the last restore that checked out
    verify_failed_at: string | null;
    verify_error: string | null;
}

/** A day of the site's use, by the server's count, in the time zone asked for. */
export interface UsageDay {
    day: string; // 2026-10-14
    people: number; // who used the site: the web app, the add-in, or the CLI
    site_seconds: number; // how long the web app was open, everyone's together
    solidworks_seconds: number; // how long people worked in SolidWorks, with the add-in, everyone's together
}

/** How the site was used, day by day (Admin > People's tracker). */
export interface Usage {
    timezone: string; // the days': the one asked for, or UTC if the server doesn't know it
    days: UsageDay[]; // oldest first; the last is today, so far
    people: number; // who used the site on any of those days
    since: string | null; // the first day anything was recorded: nothing was before it
    total_site_seconds: number; // everyone's time on the web app, since it was first counted
    total_solidworks_seconds: number; // everyone's time in SolidWorks, since it was first counted
    solidworks_since: string | null; // the first day time in SolidWorks was counted: add-ins before said nothing
}

/** A stretch of the server's work: a minute, or ten for more than a day, at its busiest. */
export interface LoadPoint {
    at: string; // its start
    cpu: number | null; // % of all CPUs busy
    steal: number | null; // % the hypervisor took for other machines
    memory: number | null; // % of memory in use
}

/** How hard the server has worked lately (Admin > People's server load). */
export interface Load {
    cpus: number;
    minutes: number; // each point's stretch
    points: LoadPoint[]; // oldest first; a stretch the server wasn't running is left out
    memory_used: number | null; // the latest sample's, in bytes
    memory_total: number | null;
}

/** Whether you can ask Claude now (Help, top right), and how much of your share of it you've used today. */
export interface Assistant {
    available: boolean;
    reason: string | null; // why not, when you can't
    model: string;
    day_used: number; // how much of your daily limit your questions in the last 24 hours took, from 0 to 1
    budget: number | null; // US dollars it may spend in all (0: no budget in all): admins only
    spent: number | null; // what it has spent: admins only
    monthly_budget: number | null; // US dollars it may spend each calendar month (0: no monthly budget): admins only
    month_spent: number | null; // what it has spent this month, since the 1st at 00:00 UTC: admins only
}

/** A message in a conversation with Claude: a question, with the page of the web app it was asked from, or an answer. */
export interface ChatMessage {
    role: "user" | "assistant";
    text: string;
    page?: string;
}

/** A piece of Claude's answer, as it comes. */
export type AnswerEvent =
    | { type: "thinking" } // still thinking: comes every few seconds until it writes
    | { type: "text"; text: string } // the next words of the answer
    | { type: "done"; stop_reason: string; day_used: number } // end_turn; max_tokens (cut off); refusal
    | { type: "error"; error: string; message: string }; // it broke off

/** What Claude's answers have cost, for admins (Admin > People). */
export interface AssistantSpending {
    available: boolean; // whether people can ask now
    reason: string | null; // why not, when they can't
    budget: number; // US dollars it may spend in all (0: no budget in all)
    spent: number;
    monthly_budget: number; // US dollars it may spend each calendar month (0: no monthly budget)
    month_spent: number; // this month, since the 1st at 00:00 UTC
    today: number; // in the last 24 hours, everyone's together
    daily_limit: number; // what one person's questions may cost in 24 hours
    model: string;
    effort: string;
    keep_warm: boolean; // whether the server may keep the help loaded between questions (YJSP_ASSISTANT_KEEP_WARM)
    keep_hours: number | null; // for how long after a question, as admins chose (1 to 24); null: always
    keep_warm_spent: number; // what that cost this month, in month_spent too
    month_questions: number; // this month's questions
    month_questions_loaded: number; // of those, the ones that found the help loaded, and read it for much less
    people: { user: UserRef; questions: number; spent: number; last_asked_at: string }[]; // the most spent first
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

/** A request sent as the page closes: the browser sends it after the page is gone, so no one's there for its answer. */
export function requestAsLeaving(method: string, path: string): void {
    fetch(apiUrl(path), { method, headers: baseHeaders(), credentials: "same-origin", keepalive: true }).catch(
        () => {},
    );
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

/**
 * Ask Claude the conversation's last question. The answer comes as it's written, a line of JSON for each piece, and
 * each is handed to onEvent as it arrives; the signal stops it. A question it can't take fails as any request does.
 */
export async function askClaude(
    messages: ChatMessage[],
    onEvent: (event: AnswerEvent) => void,
    signal?: AbortSignal,
): Promise<void> {
    const response = await fetch(apiUrl("/api/assistant/ask"), {
        method: "POST",
        headers: { ...baseHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
        credentials: "same-origin",
        signal,
    });
    if (!response.ok || !response.body) {
        throw apiError(response.status, response.statusText, await response.text());
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end).trim();
            pending = pending.slice(end + 1);
            if (line) {
                onEvent(JSON.parse(line) as AnswerEvent);
            }
        }
        if (done) {
            return;
        }
    }
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
    /**
     * Turning the whitelist off approves everyone waiting too: anyone with a GT account can join then. A null
     * min_client_version lets any version change the vault again.
     */
    updateSettings: (change: Partial<SiteSettings>) => request<SiteSettings>("PATCH", "/api/settings", change),
    whitelist: () => request<WhitelistEntry[]>("GET", "/api/whitelist"),
    addToWhitelist: (emails: string[]) => request<WhitelistAdded>("POST", "/api/whitelist", { emails }),
    removeFromWhitelist: (id: number) => request<void>("DELETE", `/api/whitelist/${id}`),
    downloads: () => request<Download[]>("GET", "/api/downloads"),
    /** For admins: who has the SolidWorks add-in, and who downloaded it. */
    addIn: () => request<AddIn>("GET", "/api/add-in"),
    downloadsUrl: (name: string) => apiUrl(`/api/downloads/${encodeURIComponent(name)}`),
    /** For admins: how full the server's disk is. */
    storage: () => request<Storage>("GET", "/api/storage"),
    /** For everyone: how full the server's disk is, and what each app takes (the home page). */
    storageSummary: () => request<StorageSummary>("GET", "/api/storage/summary"),
    /** For admins: how hard the server has worked the last hours (a week at most). */
    load: (hours: number) => request<Load>("GET", `/api/load?hours=${hours}`),
    /** For admins: how many people used the site each of the last days, and for how long, in a time zone's days. */
    usage: (days: number, timezone: string) =>
        request<Usage>("GET", `/api/usage?${new URLSearchParams({ days: String(days), tz: timezone })}`),
    /** Whether you can ask Claude now, and how much of your daily limit you've used. */
    assistant: () => request<Assistant>("GET", "/api/assistant"),
    /** For admins: what Claude's answers have cost, in all and on whose questions. */
    assistantSpending: () => request<AssistantSpending>("GET", "/api/assistant/spending"),
    /** For admins: keep the help loaded for Claude around the clock (null), or for 1 to 24 hours after a question. */
    keepHelpLoaded: (hours: number | null) =>
        request<{ keep_hours: number | null }>("PUT", "/api/assistant/settings", { keep_hours: hours }),
};
