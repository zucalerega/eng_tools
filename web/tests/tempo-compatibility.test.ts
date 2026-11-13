import { describe, expect, test } from "vitest";
import { baselineCompatibilityReport, checkLunaCompatibility, LIVE_STATUS_URL } from "../src/tempo/compatibility";
import type { CompatibilityBaseline } from "../src/tempo/types";

const BASELINE: CompatibilityBaseline = {
    schema_version: 1,
    repo: "gt-space/sequence-tester",
    tester_sha: "a".repeat(40),
    luna_sha: "b".repeat(40),
    synced_at: "2026-11-01T00:00:00Z",
    files: {
        "engine.py": "hash1",
        "luna_contract.py": "hash2",
        "luna_validation.py": "hash3",
    },
};

const NOW = Date.parse("2026-11-10T12:00:00Z");

describe("Luna compatibility checker", () => {
    test("uses raw.githubusercontent.com compatibility-status endpoint", () => {
        expect(LIVE_STATUS_URL).toBe(
            "https://raw.githubusercontent.com/gt-space/sequence-tester/compatibility-status/status.json",
        );
    });

    test("initial report is unknown (checking), never verified before live check", () => {
        const initial = baselineCompatibilityReport(BASELINE);
        expect(initial.state).toBe("unknown");
        expect(initial.label).toMatch(/CHECKING/i);
    });

    test("reports verified when live payload matches baseline and is recent", async () => {
        const report = await checkLunaCompatibility({
            baseline: BASELINE,
            nowMs: NOW,
            fetchFn: async () =>
                new Response(
                    JSON.stringify({
                        schema_version: 1,
                        mode: "live",
                        luna_sha: BASELINE.luna_sha,
                        tester_sha: BASELINE.tester_sha,
                        compatible: true,
                        checked_at: "2026-11-10T10:00:00Z",
                    }),
                    { status: 200 },
                ),
        });
        expect(report.state).toBe("verified");
        expect(report.label).toMatch(/MATCHES/i);
    });

    test("reports warning on tester revision mismatch or Luna drift", async () => {
        const mismatch = await checkLunaCompatibility({
            baseline: BASELINE,
            nowMs: NOW,
            fetchFn: async () =>
                new Response(
                    JSON.stringify({
                        schema_version: 1,
                        mode: "live",
                        luna_sha: BASELINE.luna_sha,
                        tester_sha: "c".repeat(40),
                        compatible: true,
                        checked_at: "2026-11-10T10:00:00Z",
                    }),
                    { status: 200 },
                ),
        });
        expect(mismatch.state).toBe("warning");
        expect(mismatch.label).toMatch(/MISMATCH/i);

        const drift = await checkLunaCompatibility({
            baseline: BASELINE,
            nowMs: NOW,
            fetchFn: async () =>
                new Response(
                    JSON.stringify({
                        schema_version: 1,
                        mode: "live",
                        luna_sha: "d".repeat(40),
                        tester_sha: BASELINE.tester_sha,
                        compatible: false,
                        checked_at: "2026-11-10T10:00:00Z",
                    }),
                    { status: 200 },
                ),
        });
        expect(drift.state).toBe("warning");
        expect(drift.label).toMatch(/DRIFT/i);
    });

    test("reports warning when live status is stale (>48h old)", async () => {
        const stale = await checkLunaCompatibility({
            baseline: BASELINE,
            nowMs: NOW,
            fetchFn: async () =>
                new Response(
                    JSON.stringify({
                        schema_version: 1,
                        mode: "live",
                        luna_sha: BASELINE.luna_sha,
                        tester_sha: BASELINE.tester_sha,
                        compatible: true,
                        checked_at: "2026-11-01T00:00:00Z",
                    }),
                    { status: 200 },
                ),
        });
        expect(stale.state).toBe("warning");
        expect(stale.label).toMatch(/STALE/i);
    });

    test("reports unknown when live check is unavailable (404 / network error) and warning on invalid payload", async () => {
        const notFound = await checkLunaCompatibility({
            baseline: BASELINE,
            nowMs: NOW,
            fetchFn: async () => new Response("Not Found", { status: 404 }),
        });
        expect(notFound.state).toBe("unknown");
        expect(notFound.label).toMatch(/UNAVAILABLE/i);

        const netErr = await checkLunaCompatibility({
            baseline: BASELINE,
            nowMs: NOW,
            fetchFn: async () => {
                throw new Error("Network failure");
            },
        });
        expect(netErr.state).toBe("unknown");
        expect(netErr.label).toMatch(/UNAVAILABLE/i);

        const invalidPayload = await checkLunaCompatibility({
            baseline: BASELINE,
            nowMs: NOW,
            fetchFn: async () => new Response(JSON.stringify({ bad: true }), { status: 200 }),
        });
        expect(invalidPayload.state).toBe("warning");
        expect(invalidPayload.label).toMatch(/INVALID/i);
    });
});
