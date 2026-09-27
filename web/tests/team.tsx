import { render, screen, within } from "@testing-library/react";
import { createHash, randomUUID } from "node:crypto";
import { inject, onTestFinished } from "vitest";
import { App } from "../src/App";
import { configureApi, type Account, type VaultFile } from "../src/api";
import { StoreContext, VaultStore } from "../src/store";
import { CHIEF } from "./server";

// Drives the real server the way the add-in and the CLI do, to set up what a test looks at.

const serverUrl = () => inject("serverUrl");

async function call<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    // Bytes go as they are (isView: jsdom's TextEncoder makes arrays from another realm); the rest is JSON.
    const bytes = ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : null;
    if (body !== undefined && !bytes) {
        headers["Content-Type"] = "application/json";
    }
    const payload: BodyInit | undefined =
        body === undefined ? undefined : bytes ? new Uint8Array(bytes) : JSON.stringify(body);
    const response = await fetch(new URL(path, serverUrl()), { method, headers, body: payload });
    if (!response.ok) {
        throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
}

export interface Member {
    token: string;
    user: Account;
}

async function signIn(email: string): Promise<Member> {
    return call<Member>("POST", "/auth/dev-token", null, { email });
}

export class Team {
    /** A folder of its own, so tests don't see each other's files. */
    readonly folder = "Test-" + randomUUID().slice(0, 8);

    private constructor(readonly chief: Member) {}

    /** A new folder in which everyone may edit (as in ServerFixture, the C# tests' server). */
    static async create(): Promise<Team> {
        const team = new Team(await signIn(CHIEF));
        await call("POST", "/api/folders", team.chief.token, { path: team.folder });
        await team.grant(team.folder, null, "editor");
        return team;
    }

    /** Someone the chief invited, so they're approved from the start. */
    async member(name: string): Promise<Member> {
        const email = `${name.toLowerCase()}@rocketry.test`;
        try {
            await call("POST", "/api/users", this.chief.token, { email, name });
        } catch (error) {
            if (!String(error).includes("409")) {
                throw error; // 409: invited by an earlier test
            }
        }
        return signIn(email);
    }

    /** Someone who signed in without an invitation: waiting for approval. */
    async stranger(): Promise<Member> {
        return signIn(`someone-${randomUUID().slice(0, 8)}@example.test`);
    }

    async grant(path: string, userId: number | null, role: string | null): Promise<void> {
        await call("PUT", "/api/grants", this.chief.token, { path, user_id: userId, role });
    }

    path(relative: string): string {
        return `${this.folder}/${relative}`;
    }

    /** Check files in as one check-in; refs says which files each one uses. */
    async checkin(
        who: Member,
        files: Record<string, string>,
        options: { comment?: string; host?: string; refs?: Record<string, string[]> } = {},
    ): Promise<VaultFile[]> {
        const items = [];
        for (const [relative, text] of Object.entries(files)) {
            const data = new TextEncoder().encode(text);
            const sha256 = createHash("sha256").update(data).digest("hex");
            await call("PUT", `/api/blobs/${sha256}`, who.token, data);
            const references = (options.refs?.[relative] ?? []).map((used) => ({ path: this.path(used) }));
            items.push({ path: this.path(relative), sha256, size: data.length, references });
        }
        const body = { comment: options.comment ?? "", host: options.host ?? "TEST-PC", items };
        const result = await call<{ files: { file: VaultFile }[] }>("POST", "/api/checkin", who.token, body);
        return result.files.map((entry) => entry.file);
    }

    async checkout(who: Member, relative: string, host: string): Promise<void> {
        await call("POST", "/api/checkout", who.token, { files: [this.path(relative)], host });
    }

    async file(id: number): Promise<VaultFile> {
        return (await call<{ file: VaultFile }>("GET", `/api/files/${id}`, this.chief.token)).file;
    }

    async account(email: string): Promise<Account | undefined> {
        const people = await call<Account[]>("GET", "/api/users", this.chief.token);
        return people.find((person) => person.email === email);
    }
}

// A folder's page names its folders twice: in its table, and in the folder tree beside it. These look
// in one of them (or in the breadcrumbs), waiting for it as findBy does.

/** The folder page's table of folders and files. */
export const table = async () => within(await screen.findByRole("table", { name: "Files" }));

/** The folder tree beside the table. */
export const folderTree = async () => within(await screen.findByRole("navigation", { name: "Folder tree" }));

/** The breadcrumbs above it: Vault / Team / Folder. */
export const breadcrumbs = async () => within(await screen.findByRole("navigation", { name: "Folders" }));

/** The web app at this page, as this person, talking to the test server. */
export function renderApp(who: Member, page: string) {
    configureApi({ baseUrl: serverUrl(), token: who.token });
    window.history.pushState(null, "", page);
    const store = new VaultStore(150); // poll often, so changes elsewhere show up quickly
    store.start();
    onTestFinished(() => store.stop());
    return render(
        <StoreContext.Provider value={store}>
            <App />
        </StoreContext.Provider>,
    );
}
