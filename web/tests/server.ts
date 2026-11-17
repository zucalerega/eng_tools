import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";
import { fakeClaude } from "./claude";
import { EBAY_CLIENT, fakeEbay } from "./ebay";
import { fakeGitHub, REPOSITORY } from "./github";

// Starts the real server (uv run yjsp-server in ../server) with development sign-in and a
// throwaway vault and Yorg, once for the whole test run, and gives the tests its address. Its
// assistant asks a stand-in for Anthropic's API (claude.ts), with $5 to spend, and the chief
// approves requests, which start a stand-in for Claude Code's routines (claude.ts too). The chief
// is the site's owner, who deploys it: from a stand-in for GitHub (github.ts), with a stand-in
// for systemctl (systemctl.mjs) that begins a deploy in a folder the tests carry on. Beside it,
// the demo: its made-up data seeded as `yjsp-demo seed` makes it, and its own server, which the
// first passes /demo to, as the live site does (docs/design.md, "The demo").

declare module "vitest" {
    export interface ProvidedContext {
        serverUrl: string;
        githubUrl: string; // the stand-in for GitHub's API: tests say what it says (deploy.test.tsx)
        deployDir: string; // yjsp-deploy's folder, where deploys say how they're going
    }
}

export const CHIEF = "chief@rocketry.test";

function freePort(): Promise<number> {
    return new Promise((done, fail) => {
        const probe = createServer();
        probe.once("error", fail);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            probe.close(() =>
                typeof address === "object" && address ? done(address.port) : fail(new Error("no port")),
            );
        });
    });
}

function stop(server: ChildProcess): void {
    if (server.exitCode !== null || server.pid === undefined) {
        return;
    }
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"]); // uv, and the Python it started
    } else {
        process.kill(-server.pid, "SIGTERM"); // the whole process group
    }
}

/** A stand-in Windows program, with the version resource the server reads its version from. */
function program([major, minor, build]: [number, number, number], content: string): Buffer {
    const fixed = Buffer.alloc(16); // VS_FIXEDFILEINFO, up to the file version
    fixed.writeUInt32LE(0xfeef04bd, 0);
    fixed.writeUInt32LE(0x10000, 4);
    fixed.writeUInt32LE(((major << 16) | minor) >>> 0, 8);
    fixed.writeUInt32LE((build << 16) >>> 0, 12);
    const key = Buffer.from("VS_VERSION_INFO\0", "utf16le");
    return Buffer.concat([Buffer.from("MZ " + content), Buffer.alloc(16), key, fixed, Buffer.alloc(36)]);
}

/** Wait for a server to answer at /healthz, or say why it didn't. */
async function answering(server: ChildProcess, url: string, output: () => string): Promise<void> {
    const deadline = Date.now() + 90_000;
    for (;;) {
        if (server.exitCode !== null) {
            throw new Error(`The server exited while starting:\n${output()}`);
        }
        try {
            if ((await fetch(`${url}/healthz`)).ok) {
                return;
            }
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline) {
            stop(server);
            throw new Error(`The server didn't start within 90 s:\n${output()}`);
        }
        await new Promise((wait) => setTimeout(wait, 200));
    }
}

/** The demo's own server, on its seeded data, in demo mode: nothing it has can sign anyone in, or cost anything. */
async function startDemo(data: string, site: string): Promise<{ server: ChildProcess; url: string }> {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const folder = join(data, "demo");
    const settings = {
        YJSP_ENV: "development",
        YJSP_DEMO: "1",
        YJSP_DATABASE_URL: "sqlite:///" + join(folder, "yjsp.db").replaceAll("\\", "/"),
        YJSP_VAULT_DIR: join(folder, "vault"),
        YJSP_YORG_DIR: join(folder, "yorg"),
        // Whatever a developer's server/.env says: the demo has none of these, and won't start with them.
        YJSP_DEV_AUTH: "0",
        YJSP_GOOGLE_CLIENT_ID: "",
        YJSP_MICROSOFT_CLIENT_ID: "",
        YJSP_ANTHROPIC_API_KEY: "",
        YJSP_EBAY_CLIENT_ID: "",
        YJSP_FEEDBACK_ROUTINE_URL: "",
        YJSP_DEMO_URL: "",
        YJSP_DEPLOYER: "",
    };
    const cwd = resolve(import.meta.dirname, "../../server");
    const seeded = spawnSync("uv", ["run", "--quiet", "yjsp-demo", "seed"], {
        cwd,
        env: { ...process.env, ...settings },
        encoding: "utf8",
    });
    if (seeded.status !== 0) {
        throw new Error(`The demo's seed failed:\n${seeded.stdout}${seeded.stderr}`);
    }
    const server = spawn("uv", ["run", "--quiet", "yjsp-server"], {
        cwd,
        detached: process.platform !== "win32",
        env: {
            ...process.env,
            ...settings,
            YJSP_HOST: "127.0.0.1",
            YJSP_PORT: String(port),
            YJSP_ROOT_PATH: "/demo",
            YJSP_PUBLIC_URL: `${site}/demo`,
            YJSP_WEB_DIR: join(data, "web"),
            YJSP_CALIPER_READ_AHEAD: "0",
        },
    });
    let output = "";
    server.stdout?.on("data", (chunk) => (output += chunk));
    server.stderr?.on("data", (chunk) => (output += chunk));
    await answering(server, url, () => output);
    return { server, url };
}

export default async function setup(project: TestProject): Promise<() => void> {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const data = mkdtempSync(join(tmpdir(), "yjsp-web-tests-"));
    const demo = await startDemo(data, url);
    const downloads = join(data, "downloads"); // stand-ins for what the web app offers to download
    mkdirSync(downloads);
    writeFileSync(join(downloads, "Vault-Setup.exe"), program([0, 5, 0], "the add-in's installer"));
    writeFileSync(join(downloads, "vault.exe"), "the command line");
    const claude = await fakeClaude();
    const ebay = await fakeEbay();
    const github = await fakeGitHub();
    const deploys = join(data, "deploy");
    mkdirSync(deploys);
    const server = spawn("uv", ["run", "--quiet", "yjsp-server"], {
        cwd: resolve(import.meta.dirname, "../../server"),
        detached: process.platform !== "win32",
        env: {
            ...process.env,
            YJSP_ENV: "development",
            YJSP_DEV_AUTH: "1",
            YJSP_BOOTSTRAP_ADMINS: CHIEF,
            YJSP_HOST: "127.0.0.1",
            YJSP_PORT: String(port),
            YJSP_PUBLIC_URL: url,
            YJSP_DATABASE_URL: "sqlite:///" + join(data, "yjsp.db").replaceAll("\\", "/"),
            YJSP_VAULT_DIR: join(data, "vault"),
            // The tests say when each 3D model is made: the server doesn't read them ahead in a thread of its own.
            YJSP_CALIPER_READ_AHEAD: "0",
            YJSP_WEB_DIR: join(data, "web"),
            YJSP_DOWNLOADS_DIR: downloads,
            YJSP_YORG_DIR: join(data, "yorg"),
            YJSP_ANTHROPIC_API_KEY: "test-key",
            YJSP_ANTHROPIC_BASE_URL: claude.url,
            YJSP_ASSISTANT_BUDGET: "5",
            YJSP_ASSISTANT_MONTHLY_BUDGET: "3",
            YJSP_ASSISTANT_KEEP_WARM: "1",
            YJSP_FEEDBACK_APPROVER: CHIEF,
            YJSP_FEEDBACK_ROUTINE_URL: `${claude.url}/v1/claude_code/routines/trig_test/fire`,
            YJSP_FEEDBACK_ROUTINE_TOKEN: "sk-ant-oat01-test",
            // Deals from a stand-in for eBay, when a test asks for a search: the words alone say which would do.
            YJSP_EBAY_CLIENT_ID: EBAY_CLIENT.id,
            YJSP_EBAY_CLIENT_SECRET: EBAY_CLIENT.secret,
            YJSP_EBAY_BASE_URL: ebay.url,
            YJSP_DEALS_SCHEDULE: "0",
            YJSP_DEALS_CLAUDE: "0",
            YJSP_DEMO_URL: demo.url,
            YJSP_DEPLOYER: CHIEF,
            YJSP_DEPLOY_DIR: deploys,
            YJSP_DEPLOY_REPOSITORY: REPOSITORY,
            YJSP_GITHUB_BASE_URL: github.url,
            YJSP_DEPLOY_SYSTEMCTL: JSON.stringify([
                process.execPath,
                resolve(import.meta.dirname, "systemctl.mjs"),
                deploys,
            ]),
        },
    });
    let output = "";
    server.stdout?.on("data", (chunk) => (output += chunk));
    server.stderr?.on("data", (chunk) => (output += chunk));
    try {
        await answering(server, url, () => output);
    } catch (error) {
        stop(demo.server);
        throw error;
    }

    // Part numbers are offered for new parts and assemblies, as the vault has them once its files are numbered. It's
    // the whole vault's setting, so no test changes it: tests run side by side against this one server.
    const signedIn = await fetch(`${url}/auth/dev-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: CHIEF }),
    });
    const { token } = (await signedIn.json()) as { token: string };
    const offered = await fetch(`${url}/api/numbering`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "offer" }),
    });
    if (!offered.ok) {
        stop(server);
        stop(demo.server);
        throw new Error(`Couldn't offer part numbers: ${await offered.text()}`);
    }

    project.provide("serverUrl", url);
    project.provide("githubUrl", github.url);
    project.provide("deployDir", deploys);
    return () => {
        stop(server);
        stop(demo.server);
        claude.close();
        ebay.close();
        github.close();
        rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    };
}
