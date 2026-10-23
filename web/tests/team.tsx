import { render, screen, within } from "@testing-library/react";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { inject, onTestFinished } from "vitest";
import { App } from "../src/App";
import { configureApi, type Account, type SiteSettings, type WhitelistEntry } from "../src/api";
import { type VaultFile } from "../src/vault/api";
import { writeMesh, type Mesh } from "../src/vault/caliper/format";
import { SessionContext, SessionStore } from "../src/session";
import { StoreContext, VaultStore } from "../src/vault/store";
import type { Dataset, DatasetDetail, SavedView } from "../src/yorg/api";
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

    /** Someone signed in with the SolidWorks add-in on a computer, whose requests have said its version. */
    async addInOn(email: string, computer: string, version = "0.5.2.0"): Promise<Member> {
        const member = await call<Member>("POST", "/auth/dev-token", null, {
            email,
            client: `SolidWorks add-in on ${computer}`,
        });
        await fetch(new URL("/api/me", serverUrl()), {
            headers: { Authorization: `Bearer ${member.token}`, "User-Agent": `vault-client/${version}` },
        });
        return member;
    }

    /** Someone who made an account by signing in, as with a Georgia Tech account: without an invite. */
    async signUp(email: string): Promise<Member> {
        return signIn(email);
    }

    /**
     * Turn the whitelist on or off, as an admin does on the Whitelist tab. Every test starts with it off, as a new
     * server has it, so it goes off again when the test finishes.
     */
    async whitelist(on: boolean): Promise<void> {
        onTestFinished(async () => {
            await call("PATCH", "/api/settings", this.chief.token, { whitelist: false });
        });
        await call("PATCH", "/api/settings", this.chief.token, { whitelist: on });
    }

    async settings(): Promise<SiteSettings> {
        return call<SiteSettings>("GET", "/api/settings", this.chief.token);
    }

    async addToWhitelist(emails: string[]): Promise<void> {
        await call("POST", "/api/whitelist", this.chief.token, { emails });
    }

    async whitelisted(): Promise<string[]> {
        return (await call<WhitelistEntry[]>("GET", "/api/whitelist", this.chief.token)).map((entry) => entry.email);
    }

    async grant(path: string, userId: number | null, role: string | null): Promise<void> {
        await call("PUT", "/api/grants", this.chief.token, { path, user_id: userId, role });
    }

    path(relative: string): string {
        return `${this.folder}/${relative}`;
    }

    /** Check files in as one check-in, each its text or its bytes; refs says which files each one uses. */
    async checkin(
        who: Member,
        files: Record<string, string | Uint8Array>,
        options: { comment?: string; host?: string; refs?: Record<string, string[]> } = {},
    ): Promise<VaultFile[]> {
        const items = [];
        for (const [relative, contents] of Object.entries(files)) {
            const data = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
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

    /** Rename a file where it is: given its part number, say. */
    async rename(who: Member, relative: string, name: string): Promise<void> {
        await call("POST", "/api/rename", who.token, { file: this.path(relative), name });
    }

    /** A part number handed out (00000123-001), as New gets one; admins get them before numbering is turned on. */
    async partNumber(who: Member, kind = "001"): Promise<string> {
        const issued = await call<{ numbers: { number: string }[] }>("POST", "/api/numbers", who.token, { kind });
        return issued.numbers[0]!.number;
    }

    /** Say what a file is called (its title), as Edit title does. */
    async title(who: Member, relative: string, title: string): Promise<void> {
        await call("POST", "/api/files/metadata", who.token, { files: [{ file: this.path(relative), title }] });
    }

    /** A mesh uploaded as Vault for SolidWorks uploads them, gzip-compressed: its SHA-256. */
    async mesh(who: Member, mesh: Mesh): Promise<string> {
        const data = gzipSync(writeMesh(mesh));
        const sha256 = createHash("sha256").update(data).digest("hex");
        await call("PUT", `/api/blobs/${sha256}`, who.token, data);
        return sha256;
    }

    /** A version's 3D model, as Vault for SolidWorks makes them: a part's mesh, or an assembly's components. */
    async model(
        who: Member,
        file: VaultFile,
        model: { mesh?: Mesh; components?: unknown[]; configuration?: string; units?: string },
    ): Promise<void> {
        await call("PUT", `/api/files/${file.id}/caliper`, who.token, {
            version: file.version,
            configuration: model.configuration ?? "Default",
            units: model.units ?? "mm",
            mesh: model.mesh ? await this.mesh(who, model.mesh) : undefined,
            components: model.components,
        });
    }

    /** A file's 3D models, as Caliper lists them. */
    async caliperModels(id: number): Promise<{ version: number; configuration: string }[]> {
        return (
            await call<{ models: { version: number; configuration: string }[] }>(
                "GET",
                `/api/files/${id}/caliper`,
                this.chief.token,
            )
        ).models;
    }

    /** A drawing's PDF, of its latest version, as Vault for SolidWorks saves one when it checks the drawing in. */
    async drawingPdf(who: Member, file: VaultFile, pdf: string): Promise<void> {
        const data = new TextEncoder().encode(pdf);
        const sha256 = createHash("sha256").update(data).digest("hex");
        await call("PUT", `/api/blobs/${sha256}`, who.token, data);
        await call("PUT", `/api/files/${file.id}/drawing/pdf`, who.token, { version: file.version, pdf: sha256 });
    }

    async file(id: number): Promise<VaultFile> {
        return (await call<{ file: VaultFile }>("GET", `/api/files/${id}`, this.chief.token)).file;
    }

    async account(email: string): Promise<Account | undefined> {
        const people = await call<Account[]>("GET", "/api/users", this.chief.token);
        return people.find((person) => person.email === email);
    }

    /** A saved view of a dataset, with one plot of one channel, in a folder ("": at the top). */
    async view(
        who: Member,
        name: string,
        dataset: number,
        channel: string,
        folder = "",
    ): Promise<{ id: number; name: string }> {
        const config = { datasets: [{ id: dataset, shift: 0 }], panels: [{ series: [{ dataset, channel }] }] };
        return call("POST", "/api/yorg/views", who.token, { name, folder, datasets: [dataset], config });
    }

    /** A new saved script, in a folder ("": at the top). */
    async addScript(
        who: Member,
        name: string,
        folder = "",
        code = "print(1)\n",
    ): Promise<{ id: string; name: string }> {
        return call("POST", "/api/yorg/scripts", who.token, { name, folder, code });
    }

    /** Every saved view, as the server keeps it. */
    async views(who: Member): Promise<SavedView[]> {
        return call<SavedView[]>("GET", "/api/yorg/views", who.token);
    }

    /** A script (the Python window's), as the server keeps it: found by its name. */
    async script(who: Member, name: string): Promise<{ id: string; name: string; code: string }> {
        const all = await call<{ id: string; name: string }[]>("GET", "/api/yorg/scripts", who.token);
        const found = all.find((one) => one.name === name);
        if (!found) {
            throw new Error(`There's no script called ${name}`);
        }
        return call("GET", `/api/yorg/scripts/${found.id}`, who.token);
    }

    /** Yorg's datasets, as the server lists them. */
    async datasets(who: Member): Promise<Dataset[]> {
        return call<Dataset[]>("GET", "/api/yorg/datasets", who.token);
    }

    /** A file of test data, uploaded to Yorg (named to be unique to this test). */
    async data(who: Member, name: string, csv: string): Promise<DatasetDetail> {
        const params = new URLSearchParams({ filename: `${name}.csv`, name: `${name} ${this.folder}` });
        return call<DatasetDetail>("POST", `/api/yorg/datasets?${params}`, who.token, new TextEncoder().encode(csv));
    }
}

// A folder's page names its folders twice: in its table, and in the folder tree beside it. These look
// in one of them (or in the breadcrumbs), waiting for it as findBy does.

/** The folder page's table of folders and files. */
export const table = async () => within(await screen.findByRole("table", { name: "Files" }));

/** The folder tree beside the table. */
export const folderTree = async () => within(await screen.findByRole("navigation", { name: "Folder tree" }));

/** The breadcrumbs above a page's title: Files / Team / Folder. */
export const breadcrumbs = async () => within(await screen.findByRole("navigation", { name: "Folders" }));

/** The web app at this page, as this person, talking to the test server. */
export function renderApp(who: Member, page: string) {
    configureApi({ baseUrl: serverUrl(), token: who.token });
    window.history.pushState(null, "", page);
    const session = new SessionStore();
    session.start();
    const store = new VaultStore(session, 150); // poll often, so changes elsewhere show up quickly
    onTestFinished(() => {
        store.stop();
        session.stop();
    });
    return render(
        <SessionContext.Provider value={session}>
            <StoreContext.Provider value={store}>
                <App />
            </StoreContext.Provider>
        </SessionContext.Provider>,
    );
}
