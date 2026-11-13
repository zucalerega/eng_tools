import upstream from "./engine/upstream.json";
import type { CompatibilityBaseline, CompatibilityReport } from "./types";

const BASELINE: CompatibilityBaseline = upstream;
const LIVE_STATUS_URL = "https://gt-space.github.io/sequence-tester/compatibility-live.json";

export interface LiveCompatibilityPayload {
    schema_version?: unknown;
    mode?: unknown;
    luna_sha?: unknown;
    tester_sha?: unknown;
    compatible?: unknown;
    checked_at?: unknown;
    error?: unknown;
}

export function validCompatibilityStatus(status: LiveCompatibilityPayload | null | undefined, mode: string): boolean {
    const isSha = (value: unknown) => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
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

export function baselineCompatibilityReport(): CompatibilityReport {
    const lunaShort = BASELINE.luna_sha.slice(0, 8);
    const testerShort = BASELINE.tester_sha.slice(0, 8);
    return {
        state: "verified",
        label: "LUNA API BASELINE PINNED",
        detail:
            `Pinned to Luna ${lunaShort} · Sequence Tester ${testerShort}. ` +
            "API source matches reviewed baseline; executed simulation paths are not full Python API certification. " +
            "Mappings and units must match the vehicle.",
        lunaSha: BASELINE.luna_sha,
        testerSha: BASELINE.tester_sha,
    };
}

export async function checkLunaCompatibility(): Promise<CompatibilityReport> {
    const lunaShort = BASELINE.luna_sha.slice(0, 8);
    const testerShort = BASELINE.tester_sha.slice(0, 8);
    try {
        const cacheKey = Math.floor(Date.now() / 3600000);
        const response = await fetch(`${LIVE_STATUS_URL}?v=${cacheKey}`, { cache: "no-store" });
        if (!response.ok) {
            throw new Error("Upstream compatibility status unavailable");
        }
        const latest = (await response.json()) as LiveCompatibilityPayload;
        if (!validCompatibilityStatus(latest, "live")) {
            throw new Error("Invalid live compatibility status");
        }
        const checked = Date.parse(String(latest.checked_at));
        if (
            !Number.isFinite(checked) ||
            Date.now() - checked > 48 * 3600 * 1000 ||
            checked > Date.now() + 5 * 60 * 1000
        ) {
            return {
                state: "warning",
                label: "LUNA API CHECK STALE",
                detail: `Pinned to Luna ${lunaShort} (tester ${testerShort}); upstream compatibility check is not recent.`,
                lunaSha: BASELINE.luna_sha,
                testerSha: BASELINE.tester_sha,
            };
        }
        if (latest.tester_sha !== BASELINE.tester_sha) {
            return {
                state: "warning",
                label: "LUNA API CHECK UNVERIFIED",
                detail: `Pinned to Luna ${lunaShort} (tester ${testerShort}); upstream check belongs to a different Sequence Tester revision.`,
                lunaSha: BASELINE.luna_sha,
                testerSha: BASELINE.tester_sha,
            };
        }
        if (!latest.compatible) {
            const upstreamLuna = String(latest.luna_sha).slice(0, 8);
            return {
                state: "warning",
                label: "LUNA API DRIFT DETECTED",
                detail: `Pinned to Luna ${lunaShort}; upstream Luna ${upstreamLuna} differs from the tested API. Do not rely on API compatibility.`,
                lunaSha: BASELINE.luna_sha,
                testerSha: BASELINE.tester_sha,
            };
        }
        return {
            state: "verified",
            label: "LUNA API SOURCE BASELINE MATCHES",
            detail:
                `Luna ${String(latest.luna_sha).slice(0, 8)} · Sequence Tester ${testerShort} · ` +
                "API source matches reviewed baseline; executed simulation paths are not full Python API certification. " +
                "Mappings and units must match the vehicle.",
            lunaSha: BASELINE.luna_sha,
            testerSha: BASELINE.tester_sha,
        };
    } catch {
        return {
            state: "warning",
            label: "LUNA API STATUS OFFLINE",
            detail:
                `Pinned to Luna ${lunaShort} · Sequence Tester ${testerShort}; ` +
                "cannot reach upstream live drift monitor from this browser.",
            lunaSha: BASELINE.luna_sha,
            testerSha: BASELINE.tester_sha,
        };
    }
}
