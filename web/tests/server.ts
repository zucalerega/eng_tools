import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

// Starts the real CVC server (uv run cvc-server in ../server) with development sign-in and a
// throwaway vault, once for the whole test run, and gives the tests its address.

declare module "vitest" {
    export interface ProvidedContext {
        serverUrl: string;
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

export default async function setup(project: TestProject): Promise<() => void> {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const data = mkdtempSync(join(tmpdir(), "cvc-web-tests-"));
    const downloads = join(data, "downloads"); // stand-ins for what the web app offers to download
    mkdirSync(downloads);
    writeFileSync(join(downloads, "Vault-Setup.exe"), "the add-in's installer");
    writeFileSync(join(downloads, "cvc.exe"), "the command line");
    const server = spawn("uv", ["run", "--quiet", "cvc-server"], {
        cwd: resolve(import.meta.dirname, "../../server"),
        detached: process.platform !== "win32",
        env: {
            ...process.env,
            CVC_ENV: "development",
            CVC_DEV_AUTH: "1",
            CVC_BOOTSTRAP_ADMINS: CHIEF,
            CVC_HOST: "127.0.0.1",
            CVC_PORT: String(port),
            CVC_PUBLIC_URL: url,
            CVC_DATABASE_URL: "sqlite:///" + join(data, "cvc.db").replaceAll("\\", "/"),
            CVC_BLOB_DIR: join(data, "blobs"),
            CVC_WEB_DIR: join(data, "web"),
            CVC_DOWNLOADS_DIR: downloads,
        },
    });
    let output = "";
    server.stdout?.on("data", (chunk) => (output += chunk));
    server.stderr?.on("data", (chunk) => (output += chunk));

    const deadline = Date.now() + 90_000;
    for (;;) {
        if (server.exitCode !== null) {
            throw new Error(`The CVC server exited while starting:\n${output}`);
        }
        try {
            if ((await fetch(`${url}/healthz`)).ok) {
                break;
            }
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline) {
            stop(server);
            throw new Error(`The CVC server didn't start within 90 s:\n${output}`);
        }
        await new Promise((wait) => setTimeout(wait, 200));
    }

    project.provide("serverUrl", url);
    return () => {
        stop(server);
        rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    };
}
