import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Notice } from "../components";
import { navigate, useSearch } from "../router";
import { CodeEditor } from "./CodeEditor";
import { baselineCompatibilityReport, checkLunaCompatibility } from "./compatibility";
import { EnvironmentEditor } from "./EnvironmentEditor";
import { DEFAULT_ENVIRONMENT, EXAMPLES, normalizeEnvironment } from "./examples";
import { environmentFileName, normalizeSequenceName, sequenceFileName } from "./filename";
import { TempoSandbox, type TempoRunner } from "./sandbox";
import { tempoApi } from "./api";
import { TimelineView } from "./TimelineView";
import type { CheckStatus, CompatibilityReport, SimulationResult, TempoTestDetail, TestEnvironment } from "./types";

const DRAFT_KEY = "tempo.draft.v1";

interface LocalDraft {
    name: string;
    source: string;
    environment: TestEnvironment;
    serverId: number | null;
    serverVersion: number | null;
    savedName: string;
    savedSource: string;
    savedEnvironmentJson: string;
    canChange: boolean;
}

function loadInitialDraft(): LocalDraft {
    const fallback = EXAMPLES[0]!;
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<LocalDraft>;
            if (typeof parsed.source === "string" && parsed.environment) {
                const env = normalizeEnvironment(parsed.environment, DEFAULT_ENVIRONMENT);
                return {
                    name: typeof parsed.name === "string" ? parsed.name : "sequence",
                    source: parsed.source,
                    environment: env,
                    serverId: typeof parsed.serverId === "number" ? parsed.serverId : null,
                    serverVersion: typeof parsed.serverVersion === "number" ? parsed.serverVersion : null,
                    savedName: typeof parsed.savedName === "string" ? parsed.savedName : "",
                    savedSource: typeof parsed.savedSource === "string" ? parsed.savedSource : "",
                    savedEnvironmentJson:
                        typeof parsed.savedEnvironmentJson === "string" ? parsed.savedEnvironmentJson : "",
                    canChange: Boolean(parsed.canChange),
                };
            }
        }
    } catch {
        // Ignore corrupt local draft and start from default example
    }
    return {
        name: fallback.name,
        source: fallback.source,
        environment: fallback.environment,
        serverId: null,
        serverVersion: null,
        savedName: "",
        savedSource: "",
        savedEnvironmentJson: "",
        canChange: true,
    };
}

function checkBadge(status: CheckStatus): { icon: string; label: string; tone: string } {
    switch (status) {
        case "pass":
            return { icon: "✓", label: "Pass", tone: "pass" };
        case "warn":
            return { icon: "!", label: "Warning", tone: "warn" };
        case "partial":
            return { icon: "!", label: "Partial", tone: "warn" };
        case "fail":
            return { icon: "✕", label: "Failed", tone: "fail" };
        case "skipped":
            return { icon: "—", label: "Skipped", tone: "muted" };
        default:
            return { icon: "—", label: "Not run", tone: "muted" };
    }
}

function downloadText(filename: string, content: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

export interface WorkspaceProps {
    createRunner?: () => TempoRunner;
}

export function Workspace({ createRunner }: WorkspaceProps) {
    const search = useSearch();
    const initial = useMemo(() => loadInitialDraft(), []);
    const [name, setName] = useState(initial.name);
    const [source, setSource] = useState(initial.source);
    const [environment, setEnvironment] = useState<TestEnvironment>(initial.environment);
    const [serverId, setServerId] = useState<number | null>(initial.serverId);
    const [serverVersion, setServerVersion] = useState<number | null>(initial.serverVersion);
    const [savedSnapshot, setSavedSnapshot] = useState({
        name: initial.savedName,
        source: initial.savedSource,
        environmentJson: initial.savedEnvironmentJson,
        canChange: initial.canChange,
    });

    const [viewMode, setViewMode] = useState<"sequence" | "environment" | "split">("sequence");
    const [speed, setSpeed] = useState<1 | 5>(5);
    const [maxDuration, setMaxDuration] = useState(600);
    const [activeLine, setActiveLine] = useState(0);
    const [jumpToken, setJumpToken] = useState(0);

    const [compat, setCompat] = useState<CompatibilityReport>(() => baselineCompatibilityReport());
    const [runtimeStatus, setRuntimeStatus] = useState("Python runtime idle (loads on first run)");
    const [runtimeReady, setRuntimeReady] = useState(false);
    const [running, setRunning] = useState(false);
    const [runMode, setRunMode] = useState<"validate" | "simulate">("simulate");
    const [wallElapsed, setWallElapsed] = useState(0);
    const [result, setResult] = useState<SimulationResult | null>(null);
    const [runError, setRunError] = useState<string | null>(null);
    const [saveMessage, setSaveMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
    const [saving, setSaving] = useState(false);

    const runnerRef = useRef<TempoRunner | null>(null);
    const pyInputRef = useRef<HTMLInputElement | null>(null);
    const envInputRef = useRef<HTMLInputElement | null>(null);

    const envJson = useMemo(() => JSON.stringify(environment), [environment]);
    const isDirty =
        serverId === null ||
        name !== savedSnapshot.name ||
        source !== savedSnapshot.source ||
        envJson !== savedSnapshot.environmentJson;

    useEffect(() => {
        try {
            const draft: LocalDraft = {
                name,
                source,
                environment,
                serverId,
                serverVersion,
                savedName: savedSnapshot.name,
                savedSource: savedSnapshot.source,
                savedEnvironmentJson: savedSnapshot.environmentJson,
                canChange: savedSnapshot.canChange,
            };
            localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        } catch {
            // Ignore quota errors on localStorage
        }
    }, [name, source, environment, serverId, serverVersion, savedSnapshot]);

    useEffect(() => {
        let cancelled = false;
        void checkLunaCompatibility().then((report) => {
            if (!cancelled) {
                setCompat(report);
            }
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        return () => {
            runnerRef.current?.stop();
        };
    }, []);

    // Load ?test=<id> or ?env=<id> from URL query
    useEffect(() => {
        const params = new URLSearchParams(search);
        const testIdParam = params.get("test");
        const envIdParam = params.get("env");
        if (testIdParam && /^\d+$/.test(testIdParam)) {
            const id = Number(testIdParam);
            void tempoApi
                .getTest(id)
                .then((loaded: TempoTestDetail) => {
                    const normEnv = normalizeEnvironment(loaded.environment, DEFAULT_ENVIRONMENT);
                    setName(loaded.name);
                    setSource(loaded.source);
                    setEnvironment(normEnv);
                    setServerId(loaded.id);
                    setServerVersion(loaded.version);
                    setSavedSnapshot({
                        name: loaded.name,
                        source: loaded.source,
                        environmentJson: JSON.stringify(normEnv),
                        canChange: loaded.can_change,
                    });
                    setResult(null);
                    setRunError(null);
                    setSaveMessage(null);
                })
                .catch((err: unknown) => {
                    setSaveMessage({
                        tone: "error",
                        text: err instanceof Error ? err.message : "Could not load saved test.",
                    });
                });
        } else if (envIdParam && /^\d+$/.test(envIdParam)) {
            const id = Number(envIdParam);
            void tempoApi
                .getEnvironment(id)
                .then((loaded) => {
                    const normEnv = normalizeEnvironment(loaded.environment, DEFAULT_ENVIRONMENT);
                    setEnvironment(normEnv);
                    setSaveMessage({ tone: "info", text: `Loaded environment "${loaded.name}".` });
                })
                .catch((err: unknown) => {
                    setSaveMessage({
                        tone: "error",
                        text: err instanceof Error ? err.message : "Could not load environment.",
                    });
                });
        }
    }, [search]);

    useEffect(() => {
        if (!running) {
            return;
        }
        const started = performance.now();
        setWallElapsed(0);
        const id = setInterval(() => {
            setWallElapsed((performance.now() - started) / 1000);
        }, 100);
        return () => clearInterval(id);
    }, [running]);

    function ensureRunner(): TempoRunner {
        if (!runnerRef.current) {
            const runner = createRunner ? createRunner() : new TempoSandbox();
            runner.onStatus = (msg, ready) => {
                setRuntimeStatus(msg);
                setRuntimeReady(ready);
            };
            runnerRef.current = runner;
        }
        return runnerRef.current;
    }

    useEffect(() => {
        if (!createRunner && typeof Worker !== "undefined") {
            ensureRunner().warm?.();
        }
        return () => {
            runnerRef.current?.stop();
        };
    }, []);

    async function runSequence(mode: "validate" | "simulate") {
        setRunError(null);
        setSaveMessage(null);
        setRunMode(mode);
        setRunning(true);
        try {
            const runner = ensureRunner();
            const res = await runner.run({
                source,
                mapping: JSON.stringify(environment),
                mode,
                options: {
                    clock_mode: "realtime",
                    speed,
                    max_duration: Math.max(1, Math.min(3600, maxDuration || 600)),
                },
            });
            setResult(res);
        } catch (err: unknown) {
            setRunError(err instanceof Error ? err.message : String(err));
        } finally {
            setRunning(false);
        }
    }

    function stopRun() {
        runnerRef.current?.stop();
        setRunning(false);
        setRuntimeReady(false);
        setRuntimeStatus("Stopped (click Validate or Run to reload Python runtime)");
    }

    async function saveToServer(asNew = false) {
        const trimmedName = name.trim() || "sequence";
        setSaving(true);
        setSaveMessage(null);
        try {
            const saved =
                !asNew && serverId !== null && savedSnapshot.canChange
                    ? await tempoApi.updateTest(serverId, {
                          name: trimmedName,
                          source,
                          environment,
                          expected_version: serverVersion ?? undefined,
                      })
                    : await tempoApi.createTest({
                          name: trimmedName,
                          source,
                          environment,
                      });
            const normEnv = normalizeEnvironment(saved.environment, DEFAULT_ENVIRONMENT);
            setName(saved.name);
            setServerId(saved.id);
            setServerVersion(saved.version);
            setSavedSnapshot({
                name: saved.name,
                source: saved.source,
                environmentJson: JSON.stringify(normEnv),
                canChange: saved.can_change,
            });
            setSaveMessage({ tone: "info", text: `Saved "${saved.name}" (v${saved.version}).` });
            navigate(`/tempo?test=${saved.id}`, { replace: true });
        } catch (err: unknown) {
            setSaveMessage({
                tone: "error",
                text: err instanceof Error ? err.message : "Failed to save test.",
            });
        } finally {
            setSaving(false);
        }
    }

    function loadExample(exampleId: string) {
        const found = EXAMPLES.find((ex) => ex.id === exampleId);
        if (!found) {
            return;
        }
        setName(found.name);
        setSource(found.source);
        setEnvironment(normalizeEnvironment(found.environment, DEFAULT_ENVIRONMENT));
        setServerId(null);
        setServerVersion(null);
        setSavedSnapshot({ name: "", source: "", environmentJson: "", canChange: true });
        setResult(null);
        setRunError(null);
        setActiveLine(0);
        setSaveMessage(null);
    }

    function handleImportPy(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) {
            return;
        }
        void file.text().then((text) => {
            setSource(text);
            setName(normalizeSequenceName(file.name));
            setResult(null);
            setActiveLine(0);
        });
    }

    function handleImportEnv(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) {
            return;
        }
        void file.text().then((text) => {
            const parsed = normalizeEnvironment(text, environment);
            setEnvironment(parsed);
            setResult(null);
        });
    }

    function jumpToSource(line: number) {
        if (!line || line <= 0) {
            return;
        }
        if (viewMode === "environment") {
            setViewMode("sequence");
        }
        setActiveLine(line);
        setJumpToken((t) => t + 1);
    }

    const lineCount = useMemo(() => source.split("\n").length, [source]);
    const issueCount = result ? result.diagnostics.length : null;

    return (
        <div className="tempo-workspace-page">
            <header className="tempo-header">
                <div>
                    <h1>Tempo</h1>
                    <p className="muted">Luna Sequence Simulator</p>
                </div>
                <div className="tempo-header-actions">
                    <span
                        className={`tempo-draft-badge ${isDirty ? "dirty" : "saved"}`}
                        title="Browser-local draft is kept automatically; Save persists to the Engineering Tools server."
                    >
                        {serverId === null
                            ? "Local draft (unsaved)"
                            : isDirty
                              ? `Unsaved changes · v${serverVersion}`
                              : `Saved · v${serverVersion}`}
                    </span>
                    <button
                        type="button"
                        className="button-primary"
                        disabled={saving}
                        onClick={() => void saveToServer(false)}
                    >
                        {saving ? "Saving…" : serverId !== null && savedSnapshot.canChange ? "Save" : "Save test"}
                    </button>
                    {serverId !== null && (
                        <button type="button" disabled={saving} onClick={() => void saveToServer(true)}>
                            Save as new
                        </button>
                    )}
                </div>
            </header>

            <section className={`tempo-compat-banner state-${compat.state}`} role="status" aria-live="polite">
                <strong>{compat.label}</strong>
                <span>{compat.detail}</span>
            </section>

            {saveMessage && <Notice tone={saveMessage.tone}>{saveMessage.text}</Notice>}
            {runError && <Notice tone="error">{runError}</Notice>}

            <div className="tempo-grid">
                <section className="tempo-editor-panel" aria-label="Sequence and test environment editors">
                    <div className="tempo-panel-bar">
                        <div className="tempo-tabs" role="tablist" aria-label="Editor tabs">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={viewMode === "sequence"}
                                className={viewMode === "sequence" ? "active" : ""}
                                onClick={() => setViewMode("sequence")}
                            >
                                {sequenceFileName(name)}
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={viewMode === "environment"}
                                className={viewMode === "environment" ? "active" : ""}
                                onClick={() => setViewMode("environment")}
                            >
                                Test Environment
                            </button>
                            <button
                                type="button"
                                aria-pressed={viewMode === "split"}
                                className={viewMode === "split" ? "active" : ""}
                                onClick={() => setViewMode(viewMode === "split" ? "sequence" : "split")}
                            >
                                Split view
                            </button>
                        </div>

                        <div className="tempo-file-actions">
                            <button type="button" className="button-small" onClick={() => pyInputRef.current?.click()}>
                                Open .py
                            </button>
                            <button
                                type="button"
                                className="button-small"
                                onClick={() => downloadText(sequenceFileName(name), source, "text/x-python")}
                            >
                                Export .py
                            </button>
                            <button type="button" className="button-small" onClick={() => envInputRef.current?.click()}>
                                Import env
                            </button>
                            <button
                                type="button"
                                className="button-small"
                                onClick={() =>
                                    downloadText(
                                        environmentFileName(name),
                                        JSON.stringify(environment, null, 2) + "\n",
                                        "application/json",
                                    )
                                }
                            >
                                Export env
                            </button>
                        </div>
                    </div>

                    <div className={`tempo-editor-body mode-${viewMode}`}>
                        {viewMode !== "environment" && (
                            <CodeEditor
                                value={source}
                                onChange={setSource}
                                activeLine={activeLine}
                                onClearActiveLine={() => setActiveLine(0)}
                                onRunShortcut={() => void runSequence("simulate")}
                                jumpToken={jumpToken}
                            />
                        )}
                        {viewMode !== "sequence" && (
                            <EnvironmentEditor environment={environment} onChange={setEnvironment} />
                        )}
                    </div>

                    <div className="tempo-editor-footer">
                        <span className="muted">{lineCount} lines</span>
                        <label className="tempo-name-field">
                            <span>Test name</span>
                            <input type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
                        </label>
                    </div>

                    <div className="tempo-run-bar">
                        <div className="tempo-run-buttons">
                            <button
                                type="button"
                                className="button-primary"
                                disabled={running}
                                onClick={() => void runSequence("simulate")}
                            >
                                {running && runMode === "simulate" ? "Simulating…" : "Run simulation"}
                            </button>
                            <button type="button" disabled={running} onClick={() => void runSequence("validate")}>
                                Validate only
                            </button>
                            {running && (
                                <button type="button" className="button-danger" onClick={stopRun}>
                                    Stop
                                </button>
                            )}
                        </div>

                        <div className="tempo-run-options">
                            <label>
                                <span>Speed</span>
                                <select value={speed} onChange={(e) => setSpeed(e.target.value === "1" ? 1 : 5)}>
                                    <option value="1">1× real-time</option>
                                    <option value="5">5× accelerated</option>
                                </select>
                            </label>
                            <label>
                                <span>Limit (s)</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={3600}
                                    value={maxDuration}
                                    onChange={(e) => setMaxDuration(Number(e.target.value) || 600)}
                                />
                            </label>
                            <span className="tempo-runtime-status muted" role="status">
                                {running
                                    ? runtimeReady
                                        ? `Running (${wallElapsed.toFixed(1)}s wall · ${speed}×)`
                                        : `${runtimeStatus} (${wallElapsed.toFixed(1)}s)`
                                    : runtimeStatus}
                            </span>
                        </div>
                    </div>
                </section>

                <aside className="tempo-side-panel">
                    <section className="tempo-side-card">
                        <div className="tempo-side-head">
                            <h2>Validation</h2>
                            <span className="tempo-count-badge">
                                {result
                                    ? Object.values(result.checks).includes("fail")
                                        ? "FAILED"
                                        : Object.values(result.checks).includes("warn") ||
                                            Object.values(result.checks).includes("partial")
                                          ? "WARNINGS"
                                          : "PASSED"
                                    : "NOT CHECKED"}
                            </span>
                        </div>
                        {(
                            [
                                ["syntax", "Python syntax"],
                                ["names", "Names & imports"],
                                ["api", "Luna API & mappings"],
                                ["runtime", "Simulated runtime"],
                            ] as const
                        ).map(([key, label]) => {
                            const status = result ? result.checks[key] : "not-run";
                            const badge = checkBadge(status);
                            return (
                                <div key={key} className={`tempo-check-row tone-${badge.tone}`}>
                                    <span>
                                        <strong className="tempo-check-icon">{badge.icon}</strong> {label}
                                    </span>
                                    <span>{badge.label}</span>
                                </div>
                            );
                        })}
                    </section>

                    <section className="tempo-side-card">
                        <div className="tempo-side-head">
                            <h2>Diagnostics</h2>
                            <span className="tempo-count-badge">{issueCount === null ? "—" : issueCount}</span>
                        </div>
                        {!result ? (
                            <p className="muted">Not checked</p>
                        ) : result.diagnostics.length === 0 ? (
                            <p className="tempo-good-text">No issues found.</p>
                        ) : (
                            <ul className="tempo-diagnostics-list">
                                {result.diagnostics.map((diag, idx) => (
                                    <li key={idx} className={`tempo-diag-item severity-${diag.severity}`}>
                                        <div className="tempo-diag-meta">
                                            <strong>{diag.severity.toUpperCase()}</strong>
                                            <span>{diag.stage}</span>
                                            {diag.line > 0 && (
                                                <button
                                                    type="button"
                                                    className="tempo-line-link"
                                                    onClick={() => jumpToSource(diag.line)}
                                                >
                                                    Line {diag.line}
                                                </button>
                                            )}
                                        </div>
                                        <p>{diag.message}</p>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    <section className="tempo-side-card">
                        <div className="tempo-side-head">
                            <h2>Examples</h2>
                        </div>
                        <div className="tempo-examples-grid">
                            {EXAMPLES.map((ex) => (
                                <button
                                    key={ex.id}
                                    type="button"
                                    className="tempo-example-btn"
                                    onClick={() => loadExample(ex.id)}
                                >
                                    <span>{ex.label}</span>
                                    <span aria-hidden="true">↗</span>
                                </button>
                            ))}
                        </div>
                    </section>
                </aside>
            </div>

            <section className="tempo-output-panel">
                <div className="tempo-output-head">
                    <div>
                        <h2>Simulation output</h2>
                        {result?.timing && (
                            <p className="muted">
                                {result.virtual_time.toFixed(2)}s simulated in {result.timing.wall_seconds.toFixed(2)}s
                                wall time
                                {result.timing.actual_speed != null
                                    ? ` (${result.timing.actual_speed.toFixed(2)}× actual · ${result.timing.requested_speed ?? speed}× target)`
                                    : result.timing.requested_speed != null
                                      ? ` (${result.timing.requested_speed}×)`
                                      : ""}
                            </p>
                        )}
                    </div>
                    <div className="tempo-vtime">
                        <strong>{result ? `${result.virtual_time.toFixed(2)}s` : "—"}</strong>
                        <small>VIRTUAL TIME</small>
                    </div>
                </div>

                {!result ? (
                    <p className="muted">Run simulation to view valve states, sensor traces, and abort coverage.</p>
                ) : (
                    <>
                        <TimelineView result={result} onJumpToSource={jumpToSource} />

                        {result.events.length > 0 && (
                            <details className="tempo-event-details">
                                <summary>Event log ({result.events.length})</summary>
                                <div className="tempo-event-table">
                                    {result.events.map((ev, idx) => (
                                        <div key={idx} className="tempo-event-row">
                                            <span className="tempo-mono">T+ {ev.time.toFixed(3)}s</span>
                                            <span>{ev.kind}</span>
                                            <strong>{ev.target}</strong>
                                            <span>{ev.detail}</span>
                                            {ev.line > 0 ? (
                                                <button
                                                    type="button"
                                                    className="tempo-line-link"
                                                    onClick={() => jumpToSource(ev.line)}
                                                >
                                                    Line {ev.line}
                                                </button>
                                            ) : (
                                                <span />
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </details>
                        )}

                        {result.stdout && (
                            <div className="tempo-stdout-box">
                                <h3>Printed output</h3>
                                <pre>{result.stdout}</pre>
                            </div>
                        )}
                    </>
                )}
            </section>

            <footer className="tempo-disclaimer">
                <p>
                    <strong>Simulation ≠ hardware verification.</strong> Tempo runs in your browser using mock
                    interfaces and configured sensor inputs; it cannot certify engine behavior, SAM communication, abort
                    safety, or real-world timing. Always perform approved hardware-based testing before operational use.
                </p>
            </footer>

            <input
                ref={pyInputRef}
                type="file"
                accept=".py,text/x-python,text/plain"
                hidden
                onChange={handleImportPy}
            />
            <input ref={envInputRef} type="file" accept=".json,application/json" hidden onChange={handleImportEnv} />
        </div>
    );
}
