import upstream from "./engine/upstream.json";
import type { CompatibilityBaseline, CompatibilityReport } from "./types";

const BASELINE: CompatibilityBaseline = upstream;
export const LIVE_STATUS_URL =
    "https://raw.githubusercontent.com/gt-space/sequence-tester/compatibility-status/status.json";

const SHA40_RE = /^[0-9a-f]{40}$/i;

export interface LiveCompatibilityPayload {
    schema_version?: unknown;
    mode?: unknown;
    luna_sha?: unknown;
    tester_sha?: unknown;
    compatible?: unknown;
    checked_at?: unknown;
    error?: unknown;
}

export function validBaselineMetadata(baseline: CompatibilityBaseline | null | undefined): boolean {
    return Boolean(
        baseline &&
        baseline.schema_version === 1 &&
        SHA40_RE.test(baseline.luna_sha) &&
        SHA40_RE.test(baseline.tester_sha) &&
        typeof baseline.synced_at === "string" &&
        Number.isFinite(Date.parse(baseline.synced_at)) &&
        baseline.files &&
        typeof baseline.files === "object" &&
        typeof baseline.files["engine.py"] === "string" &&
        typeof baseline.files["luna_contract.py"] === "string" &&
        typeof baseline.files["luna_validation.py"] === "string",
    );
}

export function validCompatibilityStatus(status: LiveCompatibilityPayload | null | undefined, mode: string): boolean {
    const isSha = (value: unknown) => typeof value === "string" && SHA40_RE.test(value);
    return (
        status?.schema_version === 1 &&
        status.mode === mode &&
        isSha(status.luna_sha) &&
        isSha(status.tester_sha) &&
        typeof status.compatible === "boolean" &&
        (mode !== "build" || status.compatible === true) &&
        typeof status.checked_at === "string" &&
        Number.isFinite(Date.parse(status.checked_at))
    );
}

export function getPinnedBaseline(): CompatibilityBaseline {
    return BASELINE;
}

export function baselineCompatibilityReport(baseline: CompatibilityBaseline = BASELINE): CompatibilityReport {
    if (!validBaselineMetadata(baseline)) {
        return {
            state: "warning",
            label: "LUNA API BASELINE INVALID",
            detail: "Shipped engine revision metadata is missing or invalid. Do not assume Luna compatibility.",
            lunaSha: baseline?.luna_sha ?? "",
            testerSha: baseline?.tester_sha ?? "",
        };
    }
    const lunaShort = baseline.luna_sha.slice(0, 8);
    const testerShort = baseline.tester_sha.slice(0, 8);
    return {
        state: "unknown",
        label: "CHECKING LUNA API COMPATIBILITY",
        detail:
            `Pinned to Luna ${lunaShort} · Sequence Tester ${testerShort}; checking upstream compatibility status… ` +
            "Simulation paths are not full Python API certification or hardware verification.",
        lunaSha: baseline.luna_sha,
        testerSha: baseline.tester_sha,
    };
}

export interface CheckLunaOptions {
    fetchFn?: typeof fetch;
    nowMs?: number;
    baseline?: CompatibilityBaseline;
}

export async function checkLunaCompatibility(options: CheckLunaOptions = {}): Promise<CompatibilityReport> {
    const baseline = options.baseline ?? BASELINE;
    if (!validBaselineMetadata(baseline)) {
        return baselineCompatibilityReport(baseline);
    }
    const fetchImpl = options.fetchFn ?? fetch;
    const nowMs = options.nowMs ?? Date.now();
    const lunaShort = baseline.luna_sha.slice(0, 8);
    const testerShort = baseline.tester_sha.slice(0, 8);
    try {
        const cacheKey = Math.floor(nowMs / 3600000);
        const response = await fetchImpl(`${LIVE_STATUS_URL}?v=${cacheKey}`, { cache: "no-store" });
        if (!response.ok) {
            return {
                state: "unknown",
                label: "LUNA API LIVE CHECK UNAVAILABLE",
                detail: `Pinned to Luna ${lunaShort} · Sequence Tester ${testerShort}; live compatibility endpoint returned HTTP ${response.status}.`,
                lunaSha: baseline.luna_sha,
                testerSha: baseline.tester_sha,
            };
        }
        const latest = (await response.json()) as LiveCompatibilityPayload;
        if (!validCompatibilityStatus(latest, "live")) {
            return {
                state: "warning",
                label: "LUNA API CHECK INVALID",
                detail: `Pinned to Luna ${lunaShort} · Sequence Tester ${testerShort}; upstream compatibility payload failed validation.`,
                lunaSha: baseline.luna_sha,
                testerSha: baseline.tester_sha,
            };
        }
        const checked = Date.parse(String(latest.checked_at));
        if (!Number.isFinite(checked) || nowMs - checked > 48 * 3600 * 1000 || checked > nowMs + 5 * 60 * 1000) {
            return {
                state: "warning",
                label: "LUNA API CHECK STALE",
                detail: `Pinned to Luna ${lunaShort} (tester ${testerShort}); upstream compatibility check is older than 48h.`,
                lunaSha: baseline.luna_sha,
                testerSha: baseline.tester_sha,
            };
        }
        if (latest.tester_sha !== baseline.tester_sha) {
            return {
                state: "warning",
                label: "LUNA API REVISION MISMATCH",
                detail: `Pinned to Luna ${lunaShort} (tester ${testerShort}); upstream check belongs to tester ${String(latest.tester_sha).slice(0, 8)}.`,
                lunaSha: baseline.luna_sha,
                testerSha: baseline.tester_sha,
            };
        }
        if (!latest.compatible || latest.luna_sha !== baseline.luna_sha) {
            const upstreamLuna = String(latest.luna_sha).slice(0, 8);
            return {
                state: "warning",
                label: "LUNA API DRIFT DETECTED",
                detail: `Pinned to Luna ${lunaShort}; upstream Luna ${upstreamLuna} differs from the tested API. Do not rely on API compatibility.`,
                lunaSha: baseline.luna_sha,
                testerSha: baseline.tester_sha,
            };
        }
        return {
            state: "verified",
            label: "LUNA API SOURCE BASELINE MATCHES",
            detail:
                `Luna ${String(latest.luna_sha).slice(0, 8)} · Sequence Tester ${testerShort} · ` +
                "API source matches reviewed baseline; executed simulation paths are not full Python API certification. " +
                "Mappings and units must match the vehicle.",
            lunaSha: baseline.luna_sha,
            testerSha: baseline.tester_sha,
        };
    } catch {
        return {
            state: "unknown",
            label: "LUNA API LIVE CHECK UNAVAILABLE",
            detail:
                `Pinned to Luna ${lunaShort} · Sequence Tester ${testerShort}; ` +
                "live upstream drift monitor could not be reached.",
            lunaSha: baseline.luna_sha,
            testerSha: baseline.tester_sha,
        };
    }
}
