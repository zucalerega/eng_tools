import {
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ChangeEvent,
} from "react";
import { Notice } from "../components";
import { navigate, useSearch } from "../router";
import { SessionContext } from "../session";
import { CodeEditor } from "./CodeEditor";
import { baselineCompatibilityReport, checkLunaCompatibility } from "./compatibility";
import { EnvironmentEditor } from "./EnvironmentEditor";
import { DEFAULT_ENVIRONMENT, EXAMPLES, normalizeEnvironment, parseEnvironmentImport } from "./examples";
import { environmentFileName, normalizeSequenceName, sequenceFileName } from "./filename";
import { TempoSandbox, type TempoRunner } from "./sandbox";
import { tempoApi } from "./api";
import { TimelineView } from "./TimelineView";
import type {
    CheckStatus,
    CompatibilityReport,
    SimulationResult,
    TempoEnvironmentRecord,
    TempoTestDetail,
    TempoTestSummary,
    TestEnvironment,
} from "./types";

const LEGACY_DRAFT_KEY = "tempo.draft.v1";
const NOOP_SUBSCRIBE = () => () => {};
const NULL_SESSION_STATE = { me: null };
const GET_NULL_SESSION = () => NULL_SESSION_STATE;

function draftStorageKey(accountKey: string): string {
    return `tempo.draft.v2.user.${accountKey}`;
}

function computeInputFingerprint(source: string, envJson: string): string {
    return `${source.length}:${source}\0${envJson}`;
}

function deduplicateDiagnostics(diagnostics: SimulationResult["diagnostics"]): SimulationResult["diagnostics"] {
    const methodCalls = new Set(
        diagnostics
            .map((d) => {
                const match = d.message.match(/^(\w+) does not expose \.(\w+)\(\) in Luna's Python API$/);
                return match ? `${d.stage}:${d.line}:${match[1]}:${match[2]}` : null;
            })
            .filter((k): k is string => k !== null),
    );
    return diagnostics.filter((d) => {
        const attrMatch = d.message.match(/^(\w+) does not expose attribute \.(\w+) in Luna's Python API$/);
        if (!attrMatch) {
            return true;
        }
        return !methodCalls.has(`${d.stage}:${d.line}:${attrMatch[1]}:${attrMatch[2]}`);
    });
}

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

function defaultDraft(): LocalDraft {
    const fallback = EXAMPLES[0]!;
    const envJson = JSON.stringify(fallback.environment);
    return {
        name: fallback.name,
        source: fallback.source,
        environment: fallback.environment,
        serverId: null,
        serverVersion: null,
        savedName: fallback.name,
        savedSource: fallback.source,
        savedEnvironmentJson: envJson,
        canChange: true,
    };
}

function loadInitialDraft(accountKey: string): LocalDraft {
    try {
        localStorage.removeItem(LEGACY_DRAFT_KEY);
        const raw = localStorage.getItem(draftStorageKey(accountKey));
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
    return defaultDraft();
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

function TempoRocketSpinner() {
    return (
        <svg className="tempo-rocket-spinner" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
                d="M12 2.5c2.7 2.4 4.2 5.6 4.2 9.2 0 1.4-.3 2.7-.8 3.8l-3.4-1.3-3.4 1.3c-.5-1.1-.8-2.4-.8-3.8 0-3.6 1.5-6.8 4.2-9.2Z"
                fill="currentColor"
            />
            <path
                d="M8.5 13.5 5.5 16l2.2.8m7.8-3.3 3 2.5-2.2.8"
                stroke="currentColor"
                strokeWidth="1.6"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle cx="12" cy="9.2" r="1.4" className="tempo-rocket-window" />
            <path d="M10.5 16.5 12 21l1.5-4.5" className="tempo-rocket-flame" />
        </svg>
    );
}

export interface WorkspaceProps {
    createRunner?: () => TempoRunner;
}

export function Workspace({ createRunner }: WorkspaceProps) {
    const search = useSearch();
    const sessionStore = useContext(SessionContext);
    const sessionState = useSyncExternalStore(
        sessionStore ? sessionStore.subscribe : NOOP_SUBSCRIBE,
        sessionStore ? sessionStore.getState : GET_NULL_SESSION,
    );
    const currentUser = sessionState.me;
    const accountKey = currentUser ? String(currentUser.id) : "anon";
    const lastAccountKeyRef = useRef<string>(accountKey);

    const initial = useMemo(() => loadInitialDraft(accountKey), []); // eslint-disable-line react-hooks/exhaustive-deps
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

    // Reusable environment link (kept distinct from a test's embedded snapshot)
    const [activeEnvRecord, setActiveEnvRecord] = useState<TempoEnvironmentRecord | null>(null);
    const [activeEnvSnapshotJson, setActiveEnvSnapshotJson] = useState<string>("");
    const [envSaving, setEnvSaving] = useState(false);

    // Sidebar libraries
    const [savedTests, setSavedTests] = useState<TempoTestSummary[]>([]);
    const [savedTestsQuery, setSavedTestsQuery] = useState("");
    const [savedTestsScope, setSavedTestsScope] = useState<"all" | "mine" | "shared">("all");
    const [reusableEnvs, setReusableEnvs] = useState<TempoEnvironmentRecord[]>([]);

    // Unsaved changes confirmation modal
    const [pendingAction, setPendingAction] = useState<{ label: string; apply: () => void } | null>(null);

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
    const [resultFingerprint, setResultFingerprint] = useState<string | null>(null);
    const [runError, setRunError] = useState<string | null>(null);
    const [saveMessage, setSaveMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
    const [saving, setSaving] = useState(false);

    const runnerRef = useRef<TempoRunner | null>(null);
    const runSeqRef = useRef(0);
    const pyInputRef = useRef<HTMLInputElement | null>(null);
    const envInputRef = useRef<HTMLInputElement | null>(null);

    const envJson = useMemo(() => JSON.stringify(environment), [environment]);
    const currentFingerprint = useMemo(() => computeInputFingerprint(source, envJson), [source, envJson]);
    const isResultStale = Boolean(result && resultFingerprint !== currentFingerprint);

    const isTestDirty =
        name !== savedSnapshot.name || source !== savedSnapshot.source || envJson !== savedSnapshot.environmentJson;
    const isEnvDirty = Boolean(activeEnvRecord && envJson !== activeEnvSnapshotJson);
    const isDirty = isTestDirty || isEnvDirty;

    // Reload account-scoped draft if the signed-in user changes in the same browser
    useEffect(() => {
        if (lastAccountKeyRef.current === accountKey) {
            return;
        }
        lastAccountKeyRef.current = accountKey;
        const nextDraft = loadInitialDraft(accountKey);
        setName(nextDraft.name);
        setSource(nextDraft.source);
        setEnvironment(nextDraft.environment);
        setServerId(nextDraft.serverId);
        setServerVersion(nextDraft.serverVersion);
        setSavedSnapshot({
            name: nextDraft.savedName,
            source: nextDraft.savedSource,
            environmentJson: nextDraft.savedEnvironmentJson,
            canChange: nextDraft.canChange,
        });
        setActiveEnvRecord(null);
        setActiveEnvSnapshotJson("");
        setResult(null);
        setResultFingerprint(null);
        setRunError(null);
        setSaveMessage(null);
    }, [accountKey]);

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
            localStorage.setItem(draftStorageKey(accountKey), JSON.stringify(draft));
        } catch {
            // Ignore quota errors on localStorage
        }
    }, [accountKey, name, source, environment, serverId, serverVersion, savedSnapshot]);

    useEffect(() => {
        if (!isDirty) {
            return;
        }
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [isDirty]);

    const refreshLibraries = useCallback(async () => {
        try {
            const [testsList, envsList] = await Promise.all([tempoApi.listTests(), tempoApi.listEnvironments()]);
            setSavedTests(testsList);
            setReusableEnvs(envsList);
        } catch {
            // Non-fatal if offline or not signed in yet
        }
    }, []);

    useEffect(() => {
        void refreshLibraries();
    }, [refreshLibraries, accountKey]);

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

    const applyLoadedTest = useCallback((loaded: TempoTestDetail) => {
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
        setActiveEnvRecord(null);
        setActiveEnvSnapshotJson("");
        setResult(null);
        setResultFingerprint(null);
        setRunError(null);
        setSaveMessage(null);
        setActiveLine(0);
    }, []);

    const applyLoadedEnv = useCallback((loaded: TempoEnvironmentRecord) => {
        const normEnv = normalizeEnvironment(loaded.environment, DEFAULT_ENVIRONMENT);
        setEnvironment(normEnv);
        setActiveEnvRecord(loaded);
        setActiveEnvSnapshotJson(JSON.stringify(normEnv));
        setSaveMessage({
            tone: "info",
            text: `Loaded reusable environment "${loaded.name}" (v${loaded.version}).`,
        });
    }, []);

    function confirmOrRun(label: string, apply: () => void) {
        if (isDirty) {
            setPendingAction({ label, apply });
            return;
        }
        apply();
    }

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
                    applyLoadedTest(loaded);
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
                    applyLoadedEnv(loaded);
                    setViewMode("environment");
                })
                .catch((err: unknown) => {
                    setSaveMessage({
                        tone: "error",
                        text: err instanceof Error ? err.message : "Could not load environment.",
                    });
                });
        }
    }, [search, applyLoadedTest, applyLoadedEnv]);

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
        const runFingerprint = currentFingerprint;
        const runId = ++runSeqRef.current;
        setRunError(null);
        setSaveMessage(null);
        setRunMode(mode);
        setRunning(true);
        try {
            const runner = ensureRunner();
            const res = await runner.run({
                source,
                mapping: envJson,
                mode,
                options: {
                    clock_mode: "realtime",
                    speed,
                    max_duration: Math.max(1, Math.min(3600, maxDuration || 600)),
                },
            });
            if (runSeqRef.current !== runId) {
                return;
            }
            setResult({
                ...res,
                diagnostics: deduplicateDiagnostics(res.diagnostics),
            });
            setResultFingerprint(runFingerprint);
        } catch (err: unknown) {
            if (runSeqRef.current !== runId) {
                return;
            }
            setRunError(err instanceof Error ? err.message : String(err));
        } finally {
            if (runSeqRef.current === runId) {
                setRunning(false);
            }
        }
    }

    function stopRun() {
        runSeqRef.current += 1;
        runnerRef.current?.stop();
        setRunning(false);
        setRuntimeReady(false);
        setRuntimeStatus("Stopped (click Validate or Run to reload Python runtime)");
    }

    async function saveToServer(asNew = false): Promise<boolean> {
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
            void refreshLibraries();
            return true;
        } catch (err: unknown) {
            setSaveMessage({
                tone: "error",
                text: err instanceof Error ? err.message : "Failed to save test.",
            });
            return false;
        } finally {
            setSaving(false);
        }
    }

    function cloneCurrentTest() {
        const cloneName = `${name.trim() || "sequence"}_copy`;
        setName(cloneName);
        setServerId(null);
        setServerVersion(null);
        setSavedSnapshot({ name: "", source: "", environmentJson: "", canChange: true });
        setSaveMessage({ tone: "info", text: `Cloned into unsaved copy "${cloneName}". Click Save test to store.` });
        navigate("/tempo", { replace: true });
    }

    function loadExample(exampleId: string) {
        const found = EXAMPLES.find((ex) => ex.id === exampleId);
        if (!found) {
            return;
        }
        confirmOrRun(`load example "${found.label}"`, () => {
            const normEnv = normalizeEnvironment(found.environment, DEFAULT_ENVIRONMENT);
            const normJson = JSON.stringify(normEnv);
            setName(found.name);
            setSource(found.source);
            setEnvironment(normEnv);
            setServerId(null);
            setServerVersion(null);
            setSavedSnapshot({
                name: found.name,
                source: found.source,
                environmentJson: normJson,
                canChange: true,
            });
            setActiveEnvRecord(null);
            setActiveEnvSnapshotJson("");
            setResult(null);
            setResultFingerprint(null);
            setRunError(null);
            setActiveLine(0);
            setSaveMessage(null);
        });
    }

    function loadSavedTest(testId: number, testName: string) {
        confirmOrRun(`load saved test "${testName}"`, () => {
            void tempoApi
                .getTest(testId)
                .then((loaded) => {
                    applyLoadedTest(loaded);
                    navigate(`/tempo?test=${loaded.id}`, { replace: true });
                })
                .catch((err: unknown) => {
                    setSaveMessage({
                        tone: "error",
                        text: err instanceof Error ? err.message : "Could not load saved test.",
                    });
                });
        });
    }

    function loadReusableEnvironment(envId: number) {
        const target = reusableEnvs.find((item) => item.id === envId);
        const label = target ? `load reusable environment "${target.name}"` : "load reusable environment";
        confirmOrRun(label, () => {
            void tempoApi
                .getEnvironment(envId)
                .then((loaded) => {
                    applyLoadedEnv(loaded);
                })
                .catch((err: unknown) => {
                    setSaveMessage({
                        tone: "error",
                        text: err instanceof Error ? err.message : "Could not load reusable environment.",
                    });
                });
        });
    }

    async function saveReusableEnv(asNew = false) {
        setEnvSaving(true);
        setSaveMessage(null);
        try {
            if (!asNew && activeEnvRecord && activeEnvRecord.can_change) {
                const updated = await tempoApi.updateEnvironment(activeEnvRecord.id, {
                    name: activeEnvRecord.name,
                    description: activeEnvRecord.description,
                    environment,
                    expected_version: activeEnvRecord.version,
                });
                const normEnv = normalizeEnvironment(updated.environment, DEFAULT_ENVIRONMENT);
                setActiveEnvRecord(updated);
                setActiveEnvSnapshotJson(JSON.stringify(normEnv));
                setSaveMessage({
                    tone: "info",
                    text: `Updated reusable environment "${updated.name}" (v${updated.version}). Saved tests keep their own snapshots until re-saved.`,
                });
            } else {
                const suggested = activeEnvRecord ? `${activeEnvRecord.name} copy` : `${name.trim() || "sequence"} env`;
                const envName = window.prompt("New reusable environment name:", suggested)?.trim();
                if (!envName) {
                    return;
                }
                const created = await tempoApi.createEnvironment({
                    name: envName,
                    description: activeEnvRecord
                        ? `Branched from ${activeEnvRecord.name}`
                        : `Created from workspace (${name})`,
                    environment,
                });
                const normEnv = normalizeEnvironment(created.environment, DEFAULT_ENVIRONMENT);
                setActiveEnvRecord(created);
                setActiveEnvSnapshotJson(JSON.stringify(normEnv));
                setSaveMessage({
                    tone: "info",
                    text: `Saved new reusable environment "${created.name}" (v${created.version}).`,
                });
            }
            void refreshLibraries();
        } catch (err: unknown) {
            setSaveMessage({
                tone: "error",
                text: err instanceof Error ? err.message : "Failed to save reusable environment.",
            });
        } finally {
            setEnvSaving(false);
        }
    }

    function revertReusableEnv() {
        if (!activeEnvRecord) {
            return;
        }
        const normEnv = normalizeEnvironment(activeEnvRecord.environment, DEFAULT_ENVIRONMENT);
        setEnvironment(normEnv);
        setSaveMessage({
            tone: "info",
            text: `Reverted environment edits to "${activeEnvRecord.name}" (v${activeEnvRecord.version}).`,
        });
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
            setResultFingerprint(null);
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
            try {
                const parsed = parseEnvironmentImport(text);
                setEnvironment(parsed);
                setSaveMessage({ tone: "info", text: `Imported environment from "${file.name}".` });
            } catch (err: unknown) {
                setSaveMessage({
                    tone: "error",
                    text: err instanceof Error ? err.message : "Invalid environment JSON file.",
                });
            }
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

    const filteredSavedTests = useMemo(() => {
        const q = savedTestsQuery.trim().toLowerCase();
        return savedTests.filter((item) => {
            if (savedTestsScope === "mine" && currentUser && item.owner_id !== currentUser.id) {
                return false;
            }
            if (savedTestsScope === "shared" && currentUser && item.owner_id === currentUser.id) {
                return false;
            }
            if (q && !item.name.toLowerCase().includes(q) && !item.owner_name.toLowerCase().includes(q)) {
                return false;
            }
            return true;
        });
    }, [savedTests, savedTestsQuery, savedTestsScope, currentUser]);

    const validationOutcome = useMemo(() => {
        if (!result) {
            return { label: "NOT CHECKED", tone: "muted" };
        }
        if (isResultStale) {
            return { label: "STALE", tone: "stale" };
        }
        const vals = Object.values(result.checks);
        if (vals.includes("fail")) {
            return { label: "FAILED", tone: "fail" };
        }
        if (vals.includes("partial") || vals.includes("warn")) {
            return { label: "PARTIALLY VERIFIED", tone: "warn" };
        }
        return { label: "PASSED", tone: "pass" };
    }, [result, isResultStale]);

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
                        title="Browser-local draft is account-scoped; Save persists to the Engineering Tools server."
                    >
                        {serverId === null
                            ? isTestDirty
                                ? "Local draft (unsaved edits)"
                                : "Local draft"
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
                        <>
                            <button type="button" disabled={saving} onClick={() => void saveToServer(true)}>
                                Save as new
                            </button>
                            <button type="button" disabled={saving} onClick={cloneCurrentTest}>
                                Clone
                            </button>
                        </>
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

                    {viewMode !== "sequence" && (
                        <div className="tempo-reusable-env-bar">
                            <div className="tempo-reusable-env-info">
                                <span className="tempo-env-source-pill">
                                    {activeEnvRecord
                                        ? `Reusable env: ${activeEnvRecord.name} (v${activeEnvRecord.version})${isEnvDirty ? " · edited" : ""}`
                                        : serverId !== null
                                          ? "Embedded test snapshot"
                                          : "Workspace environment"}
                                </span>
                                <label className="tempo-env-picker">
                                    <span className="muted">Load reusable:</span>
                                    <select
                                        value={activeEnvRecord ? String(activeEnvRecord.id) : ""}
                                        onChange={(e) => {
                                            const id = Number(e.target.value);
                                            if (id > 0) {
                                                loadReusableEnvironment(id);
                                            }
                                        }}
                                    >
                                        <option value="">Select environment…</option>
                                        {reusableEnvs.map((envItem) => (
                                            <option key={envItem.id} value={envItem.id}>
                                                {envItem.name} (v{envItem.version})
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                            <div className="tempo-reusable-env-actions">
                                {activeEnvRecord && activeEnvRecord.can_change && (
                                    <button
                                        type="button"
                                        className="button-small button-primary"
                                        disabled={envSaving || !isEnvDirty}
                                        onClick={() => void saveReusableEnv(false)}
                                    >
                                        {envSaving ? "Saving…" : "Save env changes"}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="button-small"
                                    disabled={envSaving}
                                    onClick={() => void saveReusableEnv(true)}
                                >
                                    Save as new env
                                </button>
                                {activeEnvRecord && isEnvDirty && (
                                    <button type="button" className="button-small" onClick={revertReusableEnv}>
                                        Revert env
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

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
                                {running && runtimeReady && <TempoRocketSpinner />}
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
                            <span className={`tempo-count-badge tone-${validationOutcome.tone}`}>
                                {validationOutcome.label}
                            </span>
                        </div>
                        {isResultStale && (
                            <p className="tempo-stale-note" role="status">
                                Inputs edited since last run. Re-run to verify current source and environment.
                            </p>
                        )}
                        {(
                            [
                                ["syntax", "Python syntax"],
                                ["names", "Names & imports"],
                                ["api", "Luna API & mappings"],
                                ["runtime", "Simulated runtime"],
                            ] as const
                        ).map(([key, label]) => {
                            if (isResultStale) {
                                return (
                                    <div key={key} className="tempo-check-row tone-warn">
                                        <span>
                                            <strong className="tempo-check-icon">↻</strong> {label}
                                        </span>
                                        <span>Stale</span>
                                    </div>
                                );
                            }
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
                            <h2>Saved sequences</h2>
                            <span className="tempo-count-badge">{filteredSavedTests.length}</span>
                        </div>
                        <div className="tempo-saved-controls">
                            <input
                                type="search"
                                className="tempo-saved-search"
                                placeholder="Filter saved tests…"
                                aria-label="Filter saved tests"
                                value={savedTestsQuery}
                                onChange={(e) => setSavedTestsQuery(e.target.value)}
                            />
                            <div className="tempo-saved-scope" role="group" aria-label="Saved tests filter">
                                {(["all", "mine", "shared"] as const).map((scope) => (
                                    <button
                                        key={scope}
                                        type="button"
                                        className={`button-small ${savedTestsScope === scope ? "active" : ""}`}
                                        onClick={() => setSavedTestsScope(scope)}
                                    >
                                        {scope === "all" ? "All" : scope === "mine" ? "Mine" : "Shared"}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {filteredSavedTests.length === 0 ? (
                            <p className="muted">No saved tests match.</p>
                        ) : (
                            <ul className="tempo-saved-list">
                                {filteredSavedTests.slice(0, 12).map((item) => {
                                    const active = item.id === serverId;
                                    const isMine = currentUser ? item.owner_id === currentUser.id : item.can_change;
                                    return (
                                        <li key={item.id}>
                                            <button
                                                type="button"
                                                className={`tempo-saved-item ${active ? "active" : ""}`}
                                                onClick={() => loadSavedTest(item.id, item.name)}
                                            >
                                                <span className="tempo-saved-title">
                                                    <strong>{item.name}</strong>
                                                    <span className="tempo-saved-pill">
                                                        {isMine ? "Mine" : item.owner_name}
                                                    </span>
                                                </span>
                                                <span className="tempo-saved-meta muted">
                                                    v{item.version} · {item.line_count}L · {item.valve_count}V/
                                                    {item.sensor_count}S
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
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
                        <div className="tempo-output-title-row">
                            <h2>Simulation output</h2>
                            {running && runtimeReady && <TempoRocketSpinner />}
                            {isResultStale && <span className="tempo-stale-badge">STALE · Earlier revision</span>}
                        </div>
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

                {running && (
                    <div className="tempo-flight-dial" role="status" aria-live="polite">
                        <div className="tempo-flight-dial-ring">
                            <TempoRocketSpinner />
                        </div>
                        <div className="tempo-flight-dial-meta">
                            <strong>
                                {runtimeReady
                                    ? runMode === "validate"
                                        ? "VALIDATION IN PROGRESS"
                                        : "SIMULATION IN PROGRESS"
                                    : "INITIALIZING PYTHON RUNTIME"}
                            </strong>
                            <span>
                                {wallElapsed.toFixed(1)}s wall · {speed}× speed ·{" "}
                                {runtimeReady ? `~T+ ${(wallElapsed * speed).toFixed(1)}s est.` : runtimeStatus} · limit{" "}
                                {maxDuration}s
                            </span>
                        </div>
                    </div>
                )}

                {isResultStale && (
                    <Notice tone="warning">
                        <strong>Results are stale.</strong> Source or test environment changed after this run. The trace
                        below belongs to an earlier revision — re-run simulation or validation to verify current edits.
                    </Notice>
                )}

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

            {pendingAction && (
                <div
                    className="tempo-modal-backdrop"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="tempo-unsaved-title"
                >
                    <div className="tempo-modal">
                        <h3 id="tempo-unsaved-title">Unsaved changes</h3>
                        <p className="muted">
                            You have unsaved changes in the active workspace. Save before you {pendingAction.label}?
                        </p>
                        <div className="tempo-modal-actions">
                            <button
                                type="button"
                                className="button-primary"
                                disabled={saving}
                                onClick={() => {
                                    const next = pendingAction;
                                    void saveToServer(false).then((ok) => {
                                        if (ok) {
                                            setPendingAction(null);
                                            next.apply();
                                        }
                                    });
                                }}
                            >
                                Save &amp; continue
                            </button>
                            <button
                                type="button"
                                className="button-danger"
                                onClick={() => {
                                    const next = pendingAction;
                                    setPendingAction(null);
                                    next.apply();
                                }}
                            >
                                Discard changes
                            </button>
                            <button type="button" onClick={() => setPendingAction(null)}>
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

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
