import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, inject, onTestFinished, test } from "vitest";
import { PASSED, quiet, REPOSITORY, sha, type GitHubState } from "./github";
import { renderApp, Team, type Member } from "./team";

// The Deploy card, on Admin > People, for the site's owner alone (the chief, on the tests' server): what's live, what
// deploying main would deploy, from a stand-in for GitHub, and a deploy as it goes, which a stand-in for systemctl begins
// and the test carries on in yjsp-deploy's folder, as yjsp-deploy would (deploy/deploy-here.sh).

const SOON = { timeout: 10_000 }; // the card asks how a running deploy is going every 2 seconds
const folder = () => inject("deployDir");
const short = (commit: string) => commit.slice(0, 7);

/** What GitHub says, for this test; and afterwards, no deploys, and GitHub as it was. */
async function github(owner: Member, state: GitHubState): Promise<void> {
    onTestFinished(async () => {
        rmSync(join(folder(), "deploys"), { recursive: true, force: true });
        rmSync(join(folder(), "live.json"), { force: true });
        rmSync(join(folder(), "systemctl.log"), { force: true });
        await setGitHub(owner, quiet());
    });
    await setGitHub(owner, state);
}

/** What GitHub says from now on, as the server sees it too: it keeps main for a few seconds, so it's asked anew, as
 * Check again on the card does. */
async function setGitHub(owner: Member, state: GitHubState): Promise<void> {
    const response = await fetch(`${inject("githubUrl")}/test/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
    });
    expect(response.ok).toBe(true);
    const asked = await fetch(new URL("/api/deploys/main?fresh=true", inject("serverUrl")), {
        headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(asked.ok).toBe(true);
}

function live(commit: string, subject: string): void {
    const deployedAt = new Date(Date.now() - 3_600_000).toISOString();
    writeFileSync(join(folder(), "live.json"), JSON.stringify({ commit, subject, deployed_at: deployedAt }));
}

/** The record of a deploy, changed as yjsp-deploy changes it, and more said in its log. */
function carryOn(id: string, change: Record<string, string>, said = ""): void {
    const path = join(folder(), "deploys", `${id}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...change }));
    if (said) {
        appendFileSync(join(folder(), "deploys", `${id}.log`), said);
    }
}

/** main, with a pull request merged since what's live, which brings a migration. */
function aPullRequestSince(): { before: string; head: string; state: GitHubState } {
    const before = sha("before");
    const branch = sha("branch");
    const head = sha("head");
    return {
        before,
        head,
        state: {
            main: head,
            commits: {
                [before]: { message: "Put a dot between the app names in the switcher", parents: [] },
                [branch]: { message: "Add the Deploy card", parents: [before] },
                [head]: {
                    message: "Merge pull request #143 from rocketry/deploy\n\nDeploy main from the site",
                    parents: [before, branch],
                },
            },
            runs: { [head]: PASSED },
            migrations: { [head]: { "0999_deploys.py": '"""deploys: what yjsp-deploy did\n\nAnd more."""\n' } },
        },
    };
}

test("the site's owner deploys main from Admin, and follows the deploy to its end", async () => {
    const { before, head, state } = aPullRequestSince();
    const team = await Team.create();
    await github(team.chief, state);
    live(before, "Put a dot between the app names in the switcher");
    renderApp(team.chief, "/vault/admin");

    // What's live, and what deploying now would deploy: main's newest commit, with its pull request, CI on it, and
    // the migration it runs, each linked on GitHub.
    const card = within(await screen.findByRole("region", { name: "Deploy" }));
    const facts = (await card.findByText("main")).closest("dl")!;
    expect(facts.textContent).toContain(`Live${short(before)} Put a dot between the app names in the switcher`);
    await waitFor(() => expect(facts.textContent).toContain(`main${short(head)} Deploy main from the site #143`));
    expect(within(facts).getByRole("link", { name: "#143" }).getAttribute("href")).toBe(
        `https://github.com/${REPOSITORY}/pull/143`,
    );
    const ci = within(card.getByRole("list", { name: `CI on ${short(head)}` }));
    expect(ci.getAllByRole("listitem").map((check) => check.textContent)).toEqual([
        "✓ server passed",
        "✓ client passed",
        "✓ web passed",
        "✓ image passed",
    ]);
    const migrations = within(card.getByRole("list", { name: "Migrations it runs" }));
    expect(migrations.getByRole("listitem").textContent).toBe("0999_deploys.py deploys: what yjsp-deploy did");
    expect(migrations.getByRole("link").getAttribute("href")).toBe(
        `https://github.com/${REPOSITORY}/blob/${head}/server/src/yjsp_server/migrations/versions/0999_deploys.py`,
    );
    const news = within(card.getByRole("list", { name: "New on main" }));
    expect(news.getAllByRole("listitem").map((item) => item.textContent!.split(" · ")[0])).toEqual([
        `${short(head)} Deploy main from the site #143`, // its merges, not the commits in its pull requests
    ]);
    expect(card.getByText("No deploys yet.")).toBeTruthy();

    // Deploying asks first, saying what it does.
    await userEvent.click(card.getByRole("button", { name: `Deploy ${short(head)}` }));
    const dialog = within(await screen.findByRole("dialog", { name: `Deploy ${short(head)}?` }));
    expect(dialog.getByText(/^The site is down for about half a minute while it switches over/)).toBeTruthy();
    expect(dialog.getByText(/^It runs 1 migration, rehearsed on a copy of the database first/)).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Deploy" }));

    // systemd is asked to start yjsp-deploy, and nothing else; the card follows it as it goes, step by step.
    const steps = within(await card.findByRole("list", { name: "Deploying main" }));
    expect(steps.getByText("Fetch main from GitHub").getAttribute("aria-current")).toBe("step");
    expect(readFileSync(join(folder(), "systemctl.log"), "utf8")).toBe(
        JSON.stringify(["start", "--no-block", "--no-ask-password", "yjsp-deploy.service"]) + "\n",
    );
    expect(card.queryByRole("button", { name: `Deploy ${short(head)}` })).toBeNull();
    const [id] = readdirSync(join(folder(), "deploys"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));
    const log = card.getByRole("log");
    await waitFor(() => expect(log.textContent).toBe("==> Fetching main from GitHub\n"));

    carryOn(
        id!,
        { step: "build", commit: head, subject: "Deploy main from the site (#143)" },
        "==> Building the web app\n",
    );
    const building = within(await card.findByRole("list", { name: `Deploying ${short(head)}` }, SOON));
    expect(building.getByText("Build the web app").getAttribute("aria-current")).toBe("step");
    expect(building.getByText("Fetch main from GitHub").className).toBe("deploy-step-done");
    await waitFor(() => expect(log.textContent).toContain("==> Building the web app\n"), SOON);

    // It ends: deployed, and live.
    carryOn(
        id!,
        { step: "demo", result: "deployed", finished: new Date().toISOString(), message: `${short(head)} is live` },
        "Deployed: YJSP answers.\n",
    );
    live(head, "Deploy main from the site (#143)");
    expect(await card.findByText(`Deployed ${short(head)}: it's live.`, { exact: false }, SOON)).toBeTruthy();
    expect(await card.findByText("main's newest commit is live.")).toBeTruthy();
    const history = within(card.getByRole("table", { name: "Last deploys" }));
    const row = history.getAllByRole("row")[1]!;
    expect(row.textContent).toContain(`${short(head)} Deploy main from the site (#143)`);
    expect(row.textContent).toContain("The site");
    expect(within(row).getByText("Deployed")).toBeTruthy();
    expect(card.queryByRole("button", { name: /^Deploy / })).toBeNull();
});

test("main can't be deployed until every job of CI has passed on it", async () => {
    const { head, state } = aPullRequestSince();
    const running: GitHubState = {
        ...state,
        runs: {
            [head]: [
                { name: "server", status: "completed", conclusion: "success" },
                { name: "client", status: "completed", conclusion: "success" },
                { name: "web", status: "in_progress", conclusion: null },
            ], // image hasn't started
        },
    };
    const team = await Team.create();
    await github(team.chief, running);
    renderApp(team.chief, "/vault/admin");

    const card = within(await screen.findByRole("region", { name: "Deploy" }));
    const ci = within(await card.findByRole("list", { name: `CI on ${short(head)}` }));
    const checks = () => ci.getAllByRole("listitem").map((check) => check.textContent);
    expect(checks()).toEqual(["✓ server passed", "✓ client passed", "… web running", "… image not run yet"]);
    expect(card.getByRole("button", { name: `Deploy ${short(head)}` })).toHaveProperty("disabled", true);
    expect(card.getByText("Once every job of CI has passed on it.")).toBeTruthy();

    // Once it has, Check again finds it so.
    await fetch(`${inject("githubUrl")}/test/state`, { method: "PUT", body: JSON.stringify(state) });
    await userEvent.click(card.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
        expect(card.getByRole("button", { name: `Deploy ${short(head)}` })).toHaveProperty("disabled", false),
    );
    expect(checks()).toEqual(["✓ server passed", "✓ client passed", "✓ web passed", "✓ image passed"]);
});

test("the last deploys say how each went, with its log", async () => {
    const { before, state } = aPullRequestSince();
    const team = await Team.create();
    await github(team.chief, state);
    live(before, "Put a dot between the app names in the switcher");
    const deploys = join(folder(), "deploys");
    mkdirSync(deploys, { recursive: true });
    const record = (id: string, said: Record<string, string>, log: string) => {
        writeFileSync(join(deploys, `${id}.json`), JSON.stringify(said));
        writeFileSync(join(deploys, `${id}.log`), log);
    };
    record(
        "20261116-180000",
        {
            source: "site",
            commit: before,
            subject: "Put a dot between the app names in the switcher",
            started: "2026-11-16T18:00:00Z",
            finished: "2026-11-16T18:03:00Z",
            step: "checks",
            result: "stopped",
            message: `CI hasn't passed on ${short(before)}: image failed`,
        },
        `==> Checking that CI passed on ${short(before)}\nStopped: CI hasn't passed on ${short(before)}: image failed\n`,
    );
    record(
        "20261116-181000",
        {
            source: "laptop",
            commit: before,
            subject: "Put a dot between the app names in the switcher",
            started: "2026-11-16T18:10:00Z",
            finished: "2026-11-16T18:11:30Z",
            step: "demo",
            result: "deployed",
            message: `${short(before)} is live`,
        },
        "==> Backing up the database\nDeployed: YJSP answers.\n",
    );
    renderApp(team.chief, "/vault/admin");

    const card = within(await screen.findByRole("region", { name: "Deploy" }));
    const history = within(await card.findByRole("table", { name: "Last deploys" }));
    const [, laptop, stopped] = history.getAllByRole("row");
    expect(within(laptop!).getByText("Deployed")).toBeTruthy();
    expect(laptop!.textContent).toContain("deploy.sh");
    expect(laptop!.textContent).toContain("2 min");
    expect(within(stopped!).getByText("Stopped")).toBeTruthy();
    expect(stopped!.textContent).toContain(`CI hasn't passed on ${short(before)}: image failed`);

    await userEvent.click(within(stopped!).getByRole("button", { name: "Log" }));
    const log = await card.findByRole("log", { name: "The log of the deploy at 20261116-180000" });
    await waitFor(() =>
        expect(log.textContent).toContain(`Stopped: CI hasn't passed on ${short(before)}: image failed`),
    );
    await userEvent.click(within(stopped!).getByRole("button", { name: "Hide log" }));
    expect(card.queryByRole("log")).toBeNull();
});

test("only the site's owner sees the Deploy card", async () => {
    const team = await Team.create();
    const admin = await team.admin(`Ada-${team.folder}`);
    renderApp(admin, "/vault/admin");
    expect(await screen.findByRole("heading", { name: "Server load" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Deploy" })).toBeNull();
});
