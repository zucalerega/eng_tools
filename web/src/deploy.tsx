import { useCallback, useEffect, useRef, useState } from "react";
import {
    api,
    ApiError,
    type DeployCheck,
    type DeployCommit,
    type DeployMain,
    type DeployRun,
    type Deploys,
} from "./api";
import { Dialog, Notice, Time } from "./components";
import { formatDuration } from "./format";

// Admin > People's Deploy card, for the site's owner alone: what's live, what deploying main now would deploy (what's
// new on it, CI on it, the migrations it runs), the Deploy button, a deploy's steps and log as it goes, and the last
// deploys. The site only asks systemd to start yjsp-deploy, which deploys main as deploy/deploy-here.sh does, and
// restarts the site partway: the card keeps asking until it answers again (server/src/yjsp_server/deploy.py).

/** A deploy's steps, as yjsp-deploy names them: from the site, and deploy.sh's switch-over, from a laptop. */
const STEPS: Record<DeployRun["source"], [string, string][]> = {
    site: [
        ["fetch", "Fetch main from GitHub"],
        ["checks", "Check that CI passed"],
        ["build", "Build the web app"],
        ["rehearse", "Rehearse the migrations on a copy"],
        ["backup", "Back up the database"],
        ["switch", "Switch over"],
        ["health", "Wait for it to answer"],
        ["demo", "Make the demo again"],
    ],
    laptop: [
        ["backup", "Back up the database"],
        ["switch", "Switch over"],
        ["health", "Wait for it to answer"],
        ["demo", "Make the demo again"],
    ],
};
const ENDED: Record<DeployRun["state"], string> = {
    running: "Running",
    deployed: "Deployed",
    stopped: "Stopped",
    "rolled-back": "Rolled back",
    failed: "Failed",
    interrupted: "Interrupted",
};
const POLL_MS = 2_000; // while a deploy runs
const CI_MS = 60_000; // while CI runs on main's newest commit
// How often the card asks again while CI runs, at most: without a token, GitHub answers a server 60 requests an hour.
const CI_LOOKS = 20;
const SHOWN_COMMITS = 10;

const short = (sha: string) => sha.slice(0, 7);
const said = (error: unknown) => (error instanceof Error ? error.message : String(error));
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function DeployCard() {
    const [state, setState] = useState<Deploys | null>(null);
    const [main, setMain] = useState<DeployMain | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [github, setGithub] = useState<string | null>(null); // why GitHub didn't say what's on main
    const [asking, setAsking] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [restarting, setRestarting] = useState(false); // the site isn't answering: the deploy is restarting it
    const [followed, setFollowed] = useState<string | null>(null); // the deploy this card watched as it ran
    const [opened, setOpened] = useState<string | null>(null); // a deploy whose log is shown under the list
    const looks = useRef(0);

    const look = useCallback(async (fresh: boolean) => {
        setAsking(true);
        try {
            setMain(await api.deployMain(fresh));
            setGithub(null);
        } catch (error) {
            setGithub(said(error));
        } finally {
            setAsking(false);
        }
    }, []);

    useEffect(() => {
        api.deploys().then(setState, (error: unknown) => setProblem(said(error)));
    }, []);
    const available = state?.available ?? false;
    useEffect(() => {
        if (available) {
            void look(false);
        }
    }, [available, look]);

    // While a deploy runs, how it's going, every 2 seconds. Partway, it restarts the site, which doesn't answer for a
    // while; once it's ended, main is asked about again, as it may be what's live now.
    const runningId = state?.deploys.find((deploy) => deploy.state === "running")?.id ?? null;
    useEffect(() => {
        if (runningId === null) {
            return;
        }
        setFollowed(runningId);
        const timer = window.setInterval(() => {
            api.deploys().then(
                (now) => {
                    setRestarting(false);
                    setState(now);
                    if (!now.deploys.some((deploy) => deploy.id === runningId && deploy.state === "running")) {
                        void look(true);
                    }
                },
                () => setRestarting(true),
            );
        }, POLL_MS);
        return () => window.clearInterval(timer);
    }, [runningId, look]);

    // While CI runs on main's newest commit, ask again each minute, a few times, while the page is in view.
    const ciRunning = main !== null && !main.passed && main.checks.every((check) => check.status !== "completed");
    useEffect(() => {
        if (!ciRunning) {
            return;
        }
        const timer = window.setInterval(() => {
            if (!document.hidden && looks.current < CI_LOOKS) {
                looks.current += 1;
                void look(false);
            }
        }, CI_MS);
        return () => window.clearInterval(timer);
    }, [ciRunning, look]);

    async function checkAgain() {
        looks.current = 0;
        await Promise.all([api.deploys().then(setState, (error: unknown) => setProblem(said(error))), look(true)]);
    }

    async function deploy(commit: string) {
        setBusy(true);
        setProblem(null);
        try {
            const started = await api.deploy(commit);
            setState((now) => now && { ...now, deploys: [started, ...now.deploys.filter((d) => d.id !== started.id)] });
        } catch (error) {
            setProblem(said(error));
            if (error instanceof ApiError && ["deploy_main_moved", "deploy_checks_failed"].includes(error.code)) {
                void look(true); // what the card showed has changed: show it as it is
            }
        } finally {
            setBusy(false);
            setConfirming(false);
        }
    }

    const running = state?.deploys.find((deploy) => deploy.id === runningId) ?? null;
    const outcome = running === null ? state?.deploys.find((deploy) => deploy.id === followed) : undefined;
    const repository = state?.repository ?? "";
    const live = state?.live ?? null;
    return (
        <section className="tracker deploy" aria-labelledby="deploy-title">
            <div className="tracker-head">
                <h2 id="deploy-title">Deploy</h2>
                {available && (
                    <button type="button" className="button-small" disabled={asking} onClick={() => void checkAgain()}>
                        {asking ? "Asking GitHub…" : "Check again"}
                    </button>
                )}
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
            {state === null ? (
                !problem && <p className="muted">Loading…</p>
            ) : !state.available ? (
                <Notice tone="info">{state.reason}.</Notice>
            ) : (
                <>
                    <dl className="deploy-facts">
                        <div>
                            <dt>Live</dt>
                            <dd>
                                {live ? (
                                    <>
                                        <CommitLink repository={repository} sha={live.commit} /> {live.subject}
                                        {live.deployed_at && (
                                            <span className="muted">
                                                {" "}
                                                · deployed <Time at={live.deployed_at} />
                                            </span>
                                        )}
                                    </>
                                ) : (
                                    <span className="muted">Not recorded yet: the next deploy records it.</span>
                                )}
                            </dd>
                        </div>
                        <div>
                            <dt>main</dt>
                            <dd>
                                {main ? (
                                    <CommitLine repository={repository} commit={main.commit} />
                                ) : (
                                    <span className="muted">{github ? `Not known: ${github}.` : "Asking GitHub…"}</span>
                                )}
                            </dd>
                        </div>
                    </dl>
                    {main && github && <Notice tone="warning">{github}.</Notice>}
                    {main && (
                        <>
                            <NewOnMain main={main} live={live?.commit ?? null} repository={repository} />
                            <Checks main={main} />
                            <Migrations main={main} />
                            {running === null && live?.commit !== main.commit.sha && (
                                <div className="deploy-go">
                                    <button
                                        type="button"
                                        className="button-primary"
                                        disabled={!main.passed || busy}
                                        onClick={() => setConfirming(true)}
                                    >
                                        Deploy {short(main.commit.sha)}
                                    </button>
                                    {!main.passed && (
                                        <span className="muted">
                                            {main.checks.some((check) => check.status === "completed" && !check.passed)
                                                ? "CI didn't pass on it: main needs a fix that passes before it's deployed."
                                                : "Once every job of CI has passed on it."}
                                        </span>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                    {confirming && main && (
                        <Dialog
                            title={`Deploy ${short(main.commit.sha)}?`}
                            confirm="Deploy"
                            busy={busy}
                            onCancel={() => setConfirming(false)}
                            onConfirm={() => void deploy(main.commit.sha)}
                        >
                            <p>
                                <strong>{main.commit.title}</strong>
                                {main.commit.pull !== null && ` (#${main.commit.pull})`}
                                {main.commits && main.commits.length > 1 && `, and ${main.commits.length - 1} more`}.
                            </p>
                            <p>
                                The site is down for about half a minute while it switches over. The database is backed
                                up first, and if the new version doesn&apos;t answer, the old one comes back.
                            </p>
                            <p>
                                {main.migrations.length === 0
                                    ? "It runs no migrations."
                                    : `It runs ${plural(main.migrations.length, "migration")}, rehearsed on a copy of the database first: nothing changes if ${main.migrations.length === 1 ? "it fails" : "they fail"}.`}
                            </p>
                        </Dialog>
                    )}
                    {running && <Running deploy={running} restarting={restarting} />}
                    {outcome && <Outcome deploy={outcome} />}
                    <History
                        deploys={state.deploys}
                        repository={repository}
                        opened={opened}
                        onOpen={(id) => setOpened(id)}
                    />
                    {opened && <DeployLog key={opened} id={opened} running={false} />}
                </>
            )}
        </section>
    );
}

function CommitLink({ repository, sha }: { repository: string; sha: string }) {
    return (
        <a
            className="deploy-sha"
            href={`https://github.com/${repository}/commit/${sha}`}
            target="_blank"
            rel="noreferrer"
        >
            {short(sha)}
        </a>
    );
}

/** A commit: its SHA, its title, the pull request it merged, who made it, and when. */
function CommitLine({ repository, commit }: { repository: string; commit: DeployCommit }) {
    return (
        <>
            <CommitLink repository={repository} sha={commit.sha} /> {commit.title}
            {commit.pull !== null && (
                <>
                    {" "}
                    <a href={`https://github.com/${repository}/pull/${commit.pull}`} target="_blank" rel="noreferrer">
                        #{commit.pull}
                    </a>
                </>
            )}
            <span className="muted">
                {commit.author && ` · ${commit.author}`}
                {commit.at && (
                    <>
                        {" · "}
                        <Time at={commit.at} />
                    </>
                )}
            </span>
        </>
    );
}

/** What's on main since what's live: its merges, and any commit straight to it. */
function NewOnMain({ main, live, repository }: { main: DeployMain; live: string | null; repository: string }) {
    if (live === null) {
        return null;
    }
    if (live === main.commit.sha) {
        return <p className="deploy-note">main&apos;s newest commit is live.</p>;
    }
    if (main.commits === null) {
        return (
            <p className="muted deploy-note">GitHub can&apos;t say what&apos;s new on main since what&apos;s live.</p>
        );
    }
    return (
        <div className="deploy-new">
            <p className="deploy-note">
                New on main since what&apos;s live
                {main.ahead !== null && main.ahead > main.commits.length && (
                    <span className="muted"> ({plural(main.ahead, "commit")} in all)</span>
                )}
                :
            </p>
            <ul aria-label="New on main">
                {main.commits.slice(0, SHOWN_COMMITS).map((commit) => (
                    <li key={commit.sha}>
                        <CommitLine repository={repository} commit={commit} />
                    </li>
                ))}
            </ul>
            {main.commits.length > SHOWN_COMMITS && (
                <p className="muted">and {main.commits.length - SHOWN_COMMITS} more.</p>
            )}
        </div>
    );
}

function checkState(check: DeployCheck): "passed" | "failed" | "waiting" {
    return check.passed ? "passed" : check.status === "completed" ? "failed" : "waiting";
}

const CHECK_ENDED: Record<string, string> = {
    failure: "failed",
    cancelled: "cancelled",
    timed_out: "timed out",
    skipped: "skipped",
    action_required: "needs action",
};

function checkWords(check: DeployCheck): string {
    if (check.passed) {
        return "passed";
    }
    if (check.status === "completed") {
        return CHECK_ENDED[check.conclusion ?? ""] ?? check.conclusion ?? "ended";
    }
    return check.status === "in_progress" ? "running" : check.status === "missing" ? "not run yet" : "waiting";
}

const CHECK_MARK = { passed: "✓", failed: "✕", waiting: "…" };

/** CI's jobs on main's newest commit, each with its run on GitHub. */
function Checks({ main }: { main: DeployMain }) {
    return (
        <div className="deploy-ci">
            <span className="deploy-ci-head">CI on {short(main.commit.sha)}:</span>
            <ul className="deploy-checks" aria-label={`CI on ${short(main.commit.sha)}`}>
                {main.checks.map((check) => (
                    <li key={check.name} className={`deploy-check deploy-check-${checkState(check)}`}>
                        <span aria-hidden="true">{CHECK_MARK[checkState(check)]}</span>{" "}
                        {check.url ? (
                            <a href={check.url} target="_blank" rel="noreferrer">
                                {check.name}
                            </a>
                        ) : (
                            check.name
                        )}{" "}
                        <span className="muted">{checkWords(check)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The migrations it would run, each linked to read before deploying (docs/deploying.md, "Before deploying"). */
function Migrations({ main }: { main: DeployMain }) {
    if (main.migrations.length === 0) {
        return <p className="muted deploy-note">It runs no migrations: the database stays as it is.</p>;
    }
    return (
        <div className="deploy-migrations">
            <p className="deploy-note">
                It runs {plural(main.migrations.length, "migration")}, rehearsed on a copy of the database first. Read{" "}
                {main.migrations.length === 1 ? "it" : "them"} before deploying:
            </p>
            <ul aria-label="Migrations it runs">
                {main.migrations.map((migration) => (
                    <li key={migration.name}>
                        <a href={migration.url} target="_blank" rel="noreferrer">
                            <code>{migration.name}</code>
                        </a>
                        {migration.title && <span className="muted"> {migration.title}</span>}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** A deploy as it runs: its steps, the one it's on, and its log. */
function Running({ deploy, restarting }: { deploy: DeployRun; restarting: boolean }) {
    const steps = STEPS[deploy.source];
    // Putting the old version back comes after waiting for the new one to answer, which it didn't.
    const at = steps.findIndex(([name]) => name === (deploy.step === "rollback" ? "health" : deploy.step));
    return (
        <div className="deploy-running">
            <ol className="deploy-steps" aria-label={`Deploying ${deploy.commit ? short(deploy.commit) : "main"}`}>
                {steps.map(([name, words], index) => (
                    <li
                        key={name}
                        className={index < at ? "deploy-step-done" : index === at ? "deploy-step-now" : undefined}
                        aria-current={index === at ? "step" : undefined}
                    >
                        {words}
                    </li>
                ))}
            </ol>
            {deploy.step === "rollback" && (
                <Notice tone="warning">The new version doesn&apos;t answer: putting the old one back.</Notice>
            )}
            {restarting && <p className="muted">The site is restarting: this carries on once it answers.</p>}
            <DeployLog id={deploy.id} running />
        </div>
    );
}

/** How the deploy this card watched ended. */
function Outcome({ deploy }: { deploy: DeployRun }) {
    const what = deploy.commit ? short(deploy.commit) : "main";
    switch (deploy.state) {
        case "deployed":
            return (
                <Notice>
                    Deployed {what}: it&apos;s live.{" "}
                    <button type="button" className="button-small" onClick={() => window.location.reload()}>
                        Reload
                    </button>{" "}
                    this page for its web app.
                </Notice>
            );
        case "stopped":
            return <Notice tone="warning">Stopped, and nothing changed: {deploy.message}.</Notice>;
        case "rolled-back":
            return <Notice tone="warning">{deploy.message}.</Notice>;
        case "failed":
            return <Notice tone="error">{deploy.message}.</Notice>;
        case "interrupted":
            return (
                <Notice tone="warning">
                    It stopped without saying how it ended, at {deploy.step ?? "its start"}: journalctl -u yjsp-deploy,
                    on the server, says why.
                </Notice>
            );
        default:
            return null;
    }
}

function took(deploy: DeployRun): string {
    if (!deploy.started_at || !deploy.finished_at) {
        return "";
    }
    return formatDuration((Date.parse(deploy.finished_at) - Date.parse(deploy.started_at)) / 1000);
}

/** The last deploys, the newest first: from the site, or deploy.sh's, and how each went. */
function History({
    deploys,
    repository,
    opened,
    onOpen,
}: {
    deploys: DeployRun[];
    repository: string;
    opened: string | null;
    onOpen: (id: string | null) => void;
}) {
    if (deploys.length === 0) {
        return <p className="muted deploy-note">No deploys yet.</p>;
    }
    return (
        <div className="deploy-history">
            <table className="table" aria-label="Last deploys">
                <thead>
                    <tr>
                        <th>Started</th>
                        <th>Commit</th>
                        <th>From</th>
                        <th>Took</th>
                        <th>How it went</th>
                        <th>
                            <span className="visually-hidden">Its log</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {deploys.map((deploy) => (
                        <tr key={deploy.id}>
                            <td>{deploy.started_at ? <Time at={deploy.started_at} /> : deploy.id}</td>
                            <td>
                                {deploy.commit && <CommitLink repository={repository} sha={deploy.commit} />}{" "}
                                {deploy.subject}
                            </td>
                            <td>{deploy.source === "site" ? "The site" : "deploy.sh"}</td>
                            <td>{took(deploy)}</td>
                            <td>
                                <span className={`deploy-state deploy-state-${deploy.state}`}>
                                    {ENDED[deploy.state]}
                                </span>
                                {deploy.message && deploy.state !== "deployed" && (
                                    <div className="muted deploy-message">{deploy.message}</div>
                                )}
                            </td>
                            <td className="row-actions">
                                <button
                                    type="button"
                                    className="button-small"
                                    aria-expanded={opened === deploy.id}
                                    onClick={() => onOpen(opened === deploy.id ? null : deploy.id)}
                                >
                                    {opened === deploy.id ? "Hide log" : "Log"}
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** A deploy's log, as it's written: read on from where the last read ended, every 2 seconds while it runs. */
function DeployLog({ id, running }: { id: string; running: boolean }) {
    const [text, setText] = useState("");
    const offset = useRef(0);
    const box = useRef<HTMLPreElement>(null);
    useEffect(() => {
        let stopped = false;
        let timer: number | undefined;
        const read = async () => {
            try {
                for (;;) {
                    const more = await api.deployLog(id, offset.current);
                    if (stopped) {
                        return;
                    }
                    if (more.size <= offset.current) {
                        break;
                    }
                    offset.current = more.size;
                    setText((before) => before + more.text);
                }
            } catch {
                // the site restarts partway through a deploy: the next read carries on
            }
            if (!stopped && running) {
                timer = window.setTimeout(() => void read(), POLL_MS);
            }
        };
        void read();
        return () => {
            stopped = true;
            window.clearTimeout(timer);
        };
    }, [id, running]);
    useEffect(() => {
        if (box.current) {
            box.current.scrollTop = box.current.scrollHeight;
        }
    }, [text]);
    return (
        <pre ref={box} className="deploy-log" role="log" aria-label={`The log of the deploy at ${id}`}>
            {text || "…"}
        </pre>
    );
}
