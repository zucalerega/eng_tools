import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

// A stand-in for GitHub's API, for the Deploy card: the test server asks it (YJSP_GITHUB_BASE_URL) as it would GitHub,
// about one repository: main's newest commit, CI's check runs on a commit, how two commits compare, and the migrations a
// commit has (the site's own, and any a test adds). A test says what it says with PUT /test/state (deploy.test.tsx),
// and until one does, main is a commit CI passed on, with no migrations of its own.

export const REPOSITORY = "rocketry/tools";
const MIGRATIONS = "server/src/yjsp_server/migrations/versions";

/** A commit's SHA, made up from a name. */
export function sha(name: string): string {
    return createHash("sha1").update(name).digest("hex");
}

export interface CheckRun {
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion: "success" | "failure" | null;
}

export interface GitHubState {
    main: string;
    commits: Record<string, { message: string; parents: string[] }>;
    runs: Record<string, CheckRun[]>; // CI's, on each commit
    migrations: Record<string, Record<string, string>>; // a commit's own, besides the site's: its name, and its source
}

/** Every job of CI, passed. */
export const PASSED: CheckRun[] = ["server", "client", "web", "image"].map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
}));

/** What GitHub says when no test has said otherwise: main is a commit CI passed on. */
export function quiet(): GitHubState {
    const main = sha("main");
    return {
        main,
        commits: { [main]: { message: "The site as it is", parents: [] } },
        runs: { [main]: PASSED },
        migrations: {},
    };
}

export function fakeGitHub(): Promise<{ url: string; close: () => void }> {
    const ours = readdirSync(resolve(import.meta.dirname, "../../server/src/yjsp_server/migrations/versions")).filter(
        (name) => /^\d{4}_\w+\.py$/.test(name),
    );
    let state = quiet();

    function commit(at: string) {
        const found = state.commits[at]!;
        return {
            sha: at,
            commit: {
                message: found.message,
                author: { name: "Chief", date: "2026-11-16T19:00:00Z" },
                committer: { name: "GitHub", date: "2026-11-16T19:05:00Z" },
            },
            author: { login: "chief" },
            parents: found.parents.map((parent) => ({ sha: parent })),
        };
    }

    function ancestors(start: string): string[] {
        const found: string[] = [];
        const waiting = [start];
        while (waiting.length > 0) {
            const at = waiting.pop()!;
            if (!found.includes(at) && state.commits[at]) {
                found.push(at);
                waiting.push(...state.commits[at].parents);
            }
        }
        return found;
    }

    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
            const address = new URL(request.url ?? "/", "http://github.test");
            const send = (status: number, payload: unknown) => {
                const text = typeof payload === "string" ? payload : JSON.stringify(payload);
                response.writeHead(status, {
                    "content-type": typeof payload === "string" ? "text/plain" : "application/json",
                });
                response.end(text);
            };
            if (request.method === "PUT" && address.pathname === "/test/state") {
                state = JSON.parse(body) as GitHubState;
                return send(200, {});
            }
            const prefix = `/repos/${REPOSITORY}/`;
            if (request.method !== "GET" || !address.pathname.startsWith(prefix)) {
                return send(404, { message: "Not Found" });
            }
            const path = decodeURIComponent(address.pathname.slice(prefix.length));
            const ref = address.searchParams.get("ref") ?? "";
            if (path === "commits/main") {
                return send(200, commit(state.main));
            }
            const checks = /^commits\/([0-9a-f]{40})\/check-runs$/.exec(path);
            if (checks) {
                const runs = (state.runs[checks[1]!] ?? []).map((run, index) => ({
                    id: index + 1,
                    ...run,
                    html_url: `https://github.com/${REPOSITORY}/actions/runs/7/job/${index + 1}`,
                }));
                return send(200, { total_count: runs.length, check_runs: runs });
            }
            const compare = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
            if (compare) {
                const had = new Set(ancestors(compare[1]!));
                const commits = ancestors(compare[2]!)
                    .filter((at) => !had.has(at))
                    .map(commit);
                return send(200, { status: "ahead", ahead_by: commits.length, behind_by: 0, commits });
            }
            const theirs = state.migrations[ref] ?? {};
            if (path === `contents/${MIGRATIONS}`) {
                const names = [...ours, ...Object.keys(theirs)].sort();
                return send(
                    200,
                    names.map((name) => ({ name, path: `${MIGRATIONS}/${name}`, type: "file" })),
                );
            }
            const name = path.slice(`contents/${MIGRATIONS}/`.length);
            if (path.startsWith(`contents/${MIGRATIONS}/`) && theirs[name] !== undefined) {
                return send(200, theirs[name]);
            }
            send(404, { message: "Not Found" });
        });
    });
    return new Promise((done) => {
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            done({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
        });
    });
}
