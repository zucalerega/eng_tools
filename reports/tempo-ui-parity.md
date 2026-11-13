# Tempo UI & Operator Workflow Parity Report

**Date:** 2026-11-13
**Reference:** `gt-space/sequence-tester` (`436c9383`) vs. `zucalerega/eng_tools` (`codex/tempo-integration`)
**Before screenshot:** [tempo-before.png](screenshots/tempo-before.png)
**After screenshot:** [tempo-after.png](screenshots/tempo-after.png)

## 1. Executive Summary

Tempo currently provides a working Pyodide-based Luna simulator inside Engineering Tools, but diverges from the original Sequence Tester in several P0 correctness areas and P1 operator-workflow details:

1. **P0 — Stale simulation results:** Editing Python source or the test environment does not mark previous Validation, Diagnostics, or Simulation output as stale.
2. **P0 — Invalid environment import:** `normalizeEnvironment()` silently substitutes fallback values when imported JSON is malformed or invalid instead of rejecting with actionable diagnostics and preserving the active environment.
3. **P0 — Unsaved-work protection & draft scoping:** Loading examples, saved tests, or reusable environments can overwrite unsaved edits without prompting (`Save / Discard / Cancel`), and local drafts are not scoped by user account.
4. **P0 — Alembic `0030` collision:** `origin/main` already contains `0030_assistant_keep_hours.py` (resolved in commit `240d695` by renumbering Tempo to `0031_tempo.py`).
5. **P1 — In-workspace saved tests & reusable environments:** Operators must leave `/tempo` to access saved tests on `/tempo/tests`, and cannot update/save-as/revert a loaded reusable environment in place.
6. **P1 — Editor active-line scroll tracking:** `CodeEditor.tsx` positions the active-line highlight without subtracting `scrollTop`, causing it to drift when scrolling.
7. **P1 — Timeline & abort-stage parity:** Missing dedicated abort-stage timeline track, abort coverage cards, sensor read-source markers, and clickable source links on plotted SVG events.
8. **P1 — Flight dial progress card:** During simulation, Tempo shows only an inline spinner instead of the reference flight-dial readout (`SIMULATION IN PROGRESS`, `T+` estimate, wall time, limit).
9. **P1 — Compatibility endpoint & status:** Requests `https://gt-space.github.io/sequence-tester/compatibility-live.json` (404) instead of `https://raw.githubusercontent.com/gt-space/sequence-tester/compatibility-status/status.json`, and initializes with a `verified` baseline before checking live status.
10. **P1 — Responsive layout at 900px & 1920px:** At `900×800`, `.tempo-grid` overflows horizontally by ~365px, clipping the right sidebar. At `1920×1080`, `.main-wide` leaves ~655px unused on the right.

## 2. Feature-Parity Checklist (Before Revision)

| Area | Sequence Tester Reference | Current Tempo (Before) | Status |
|---|---|---|---|
| Main workspace layout | Compact editor/env tabs + split view + right sidebar + output below | Matches structure, but 900px overflows horizontally | Partial |
| Stale result invalidation | `invalidateResults()` resets checks to `↻ Stale` on any source/env edit | Keeps old `PASSED` / plots after edits | **Missing (P0)** |
| Invalid env import rejection | Rejects malformed JSON / invalid units / incomplete rates | `normalizeEnvironment()` silently falls back | **Broken (P0)** |
| Unsaved-work prompt & user scoping | Prompts before overwrite; browser local drafts | Overwrites without prompt; shared key across users | **Missing (P0)** |
| In-workspace Saved Sequences | Right-sidebar panel with quick-save, 1-click load | Separate `/tempo/tests` page only | **Missing (P1)** |
| Reusable environment editing | N/A (local only) | Backend supports PUT, frontend has no update/revert UI | **Missing (P1)** |
| Python editor & line-focus scroll | Gutter + syntax highlight + `line-focus` synced with `scrollTop` | `line-focus` ignores `scrollTop`; drifts on scroll | **Bug (P1)** |
| Simulation progress flight dial | Rocket dial + `T+` virtual time + wall time + limit | Inline spinning rocket + wall time only | Partial |
| Dedicated abort-stage timeline | Separate abort-stage bar, active segments, triggers, safing, coverage cards | Combined into valve row; no coverage cards | Partial |
| Plotted event & read-source links | Clickable valve dots, abort markers, and sensor read markers | Only event-log `Line X` buttons jump to source | Partial |
| Timeline hover & 4 pinned cursors | Synchronized hover + 4 pins + cursor readout table | Works (hover + 4 pins + comparison table) | **Pass** |
| Test Environment editor | Vertical gold Valves + blue Sensors, truth tables, profiles | Restored vertical gold/blue sections & expanded cards | **Pass** |
| Live compatibility monitor | `raw.githubusercontent.com/.../compatibility-status/status.json` | Requests `gt-space.github.io/...` (404); starts `verified` | **Bug (P1)** |

## 3. Verification After Revision

All 10 items above were resolved and verified via unit/integration tests and live browser inspection across `1440×900`, `1920×1080`, and `900×800`:

- **P0 #1 (Stale results):** Fingerprinted `{ source, envJson }`; editing source or environment (including mid-run edits) immediately marks checks `↻ Stale` and displays a `STALE · Earlier revision` warning banner.
- **P0 #2 (Strict env import):** Added `parseEnvironmentImport()` (`examples.ts`) rejecting malformed JSON, missing keys, invalid units, and incomplete truth tables without substituting defaults or overwriting the active environment; legacy formats preserved.
- **P0 #3 (Unsaved-work & account scoping):** Drafts are scoped by `tempo.draft.v2.user.<id>` (`SessionContext`); dirty workspace prompts `Save & continue / Discard changes / Cancel` before destructive replacements.
- **P0 #4 (Alembic `0031`):** Renumbered Tempo migration to `0031_tempo.py` (`down_revision = "0030"`), verified `upgrade` / `downgrade` / `upgrade`.
- **P1 Workspace, Editor & Timeline:** Added right-sidebar **Saved sequences** panel (filter/All/Mine/Shared/1-click load/Clone), **Reusable environment** bar (load/update with `expected_version`/save-as-new/revert), **Flight Dial** progress card, `CodeEditor` `scrollTop`-synced line highlight, dedicated **Abort stages** timeline + coverage cards, unified compact **Sensors** chart with clickable `L# ↗` read-source links, and `0px` horizontal overflow at `900×800`, `1440×900`, and `1920×1080`.
- **Luna Compatibility:** Switched to `https://raw.githubusercontent.com/gt-space/sequence-tester/compatibility-status/status.json`, starting in `unknown` (`CHECKING LUNA API COMPATIBILITY`) and failing visibly into `unknown` / `warning` when unavailable, stale, mismatched, or drifted.
