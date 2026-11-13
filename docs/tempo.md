# Tempo design

Tempo (formerly Sequence Tester) is YJSP's Python sequence validation and simulation platform. It is the fourth native application on the Engineering Tools site, alongside Vault, Yorg, and Piper, sharing the server, database, sign-in, accounts, and web app frame ([design.md](design.md)).

An operator writes or imports a Luna Python sequence, configures simulated valves and sensors, validates the script against Luna's actual API, simulates its behavior in the browser, inspects the resulting timelines and diagnostics, and saves tests and reusable environments to the server.

> **Simulation ≠ hardware verification.** Tempo executes sequences in the browser against mock interfaces and configured sensor inputs; it cannot certify flight-hardware behavior, SAM communication, abort safety, or real-world timing. Approved hardware-in-the-loop and hotfire/cold-flow procedures remain mandatory before operational use.

## Architecture

### Authoritative engine and upstream ownership

Luna (`gt-space/luna`) remains the authoritative source for the Python sequencing API. Sequence Tester (`gt-space/sequence-tester`) remains the authoritative implementation of Tempo's compatibility and simulation engine. Tempo does **not** maintain a divergent compatibility or simulation engine.

The core Python engine files are vendored verbatim from `gt-space/sequence-tester` (pinned to commit `436c938a855fe3147cc01579ac6f01b49d9d5f47`, which includes PR #4 `feat/luna-api-compatibility`):

- `web/src/tempo/engine/luna_contract.py` — Extracted Luna API surface (`FUNCTIONS`, `METHODS`, `CONSTRUCTORS`, `UNIT_CLASSES`, `UNIT_CONSTANTS`, `VALVE_STATES`, `PRELUDE`, `SENSOR_COMPARISON_ORDER`, `SOURCE_HASHES`).
- `web/src/tempo/engine/luna_validation.py` — Static AST validation, undefined-name/import checks, Luna API & device checks, deterministic portability failure detection, and conservative partial-verification classification.
- `web/src/tempo/engine/engine.py` — Virtual clock, mock `Valve` / `Sensor` / unit objects, abort-stage evaluation, safing timers, valve-driven and time-based sensor profiles, and `run_sequence(...)`.
- `web/src/tempo/engine/upstream.json` — Pinned upstream metadata (`repo`, `tester_sha`, `luna_sha`, file SHA-256 checksums).

`scripts/sync_tempo_engine.py` verifies that the vendored engine files match `upstream.json` byte-for-byte and supports updating from a reviewed `sequence-tester` checkout.

### Browser-side isolated execution

Operator Python **never** executes on the FastAPI server. Tempo adapts Yorg's isolated Pyodide sandbox architecture (`web/src/yorg/scripts/sandbox.ts`):

1. `web/src/tempo/sandbox.ts` creates a hidden `<iframe sandbox="allow-scripts">` using `srcdoc` (opaque `null` origin, no access to site cookies, `localStorage`, `sessionStorage`, or authenticated `/api/*` endpoints).
2. Inside the iframe, a module Web Worker is started from a `data:` URL (`web/src/tempo/worker.js` imported via `?raw`).
3. Both Yorg and Sequence Tester use **Pyodide `v314.0.7`** (`https://cdn.jsdelivr.net/pyodide/v314.0.7/full/`), so Tempo shares the exact same Pyodide runtime version and browser HTTP cache as Yorg without bundling duplicate WASM assets.
4. Only the operator's `source`, synthetic `mapping` (valves and sensors), and simulation `options` (`mode`, `speed`, `max_duration`) cross the `postMessage` boundary.
5. Execution timeouts and user cancellation call `sandbox.stop()`, terminating the Web Worker and removing the iframe cleanly so runaway or infinite-loop scripts cannot disrupt other tabs or apps.
6. Yorg's `yorg.py` data-analysis module is **not** used for Tempo; Tempo's worker loads only `luna_contract.py`, `luna_validation.py`, and `engine.py`.

### Exact-source preservation

Tempo never rewrites, reformats, or auto-patches operator Python scripts. The exact `source` string entered or imported by the operator is passed to the validator/simulator, saved to the server, restored on load, and exported as `.py` for direct use in Luna's GUI or server.

## Routes and navigation

Tempo lives under `/tempo`:

- `/tempo` — Main sequence-testing workspace (editor, test environment, validation, examples, simulation output). Supports `?test=<id>` to load a server-saved test.
- `/tempo/tests` — Server-saved sequence tests (search, open in workspace, clone, export `.py`, delete).
- `/tempo/environments` — Reusable test environments (create, edit, import/export JSON, load into workspace, delete).
- `/tempo/help` — Tempo operator documentation, Luna compatibility notes, and troubleshooting guidance.

## Persistent storage and API (`/api/tempo`)

Tempo's backend lives in `server/src/yjsp_server/tempo/` with two tables in the shared database (`tempo_tests` and `tempo_environments`):

- **Saved tests (`tempo_tests`):** `id`, `name`, `source` (exact Python source), `environment` (JSON: `valves`, `sensors`), `version` (incremented on update), `owner_id`, `updated_by_id`, `created_at`, `updated_at`.
- **Reusable environments (`tempo_environments`):** `id`, `name`, `description`, `environment` (JSON: `valves`, `sensors`), `version`, `owner_id`, `updated_by_id`, `created_at`, `updated_at`.

Large simulation traces and run histories are not stored on the server.

### Ownership and permissions

- Uses Engineering Tools' existing session authentication (`ActiveUser`) and CSRF protection (`X-YJSP-Request`).
- All signed-in, approved members can list, view, load, and export saved tests and environments.
- Only the owner (`owner_id`) or an admin (`user.is_admin`) can update or delete a saved test or environment (`403` `forbidden` otherwise).
- Browser-local unsaved drafts are stored in `localStorage` (`tempo.draft.v1`) with a clear indicator distinguishing unsaved local edits from the server-persisted version.

### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/tempo/tests` | List saved tests (metadata without full source/environment) |
| `POST /api/tempo/tests` | Create a new saved test |
| `GET /api/tempo/tests/{id}` | Load a saved test (exact `source`, `environment`, `version`) |
| `PUT /api/tempo/tests/{id}` | Update an existing saved test (owner or admin) |
| `DELETE /api/tempo/tests/{id}` | Delete a saved test (owner or admin) |
| `GET /api/tempo/environments` | List reusable test environments |
| `POST /api/tempo/environments` | Create a reusable test environment |
| `GET /api/tempo/environments/{id}` | Load a reusable test environment |
| `PUT /api/tempo/environments/{id}` | Update a reusable test environment (owner or admin) |
| `DELETE /api/tempo/environments/{id}` | Delete a reusable test environment (owner or admin) |

## Verification plan

1. Run `sequence-tester`'s existing Python regression suite against the vendored engine files (`engine.py`, `luna_validation.py`, `luna_contract.py`) to confirm 100% parity with commit `436c938`.
2. Verify `scripts/sync_tempo_engine.py --check` passes.
3. Add server pytest tests covering `/api/tempo/tests` and `/api/tempo/environments` CRUD, exact source round-trip, ownership/admin authorization, CSRF enforcement, and database migration parity (`test_database.py`).
4. Add frontend Vitest tests covering Tempo routes, app switcher/home screen integration, unsaved draft vs saved test behavior, environment/source import & export, sandbox isolation (`<iframe sandbox="allow-scripts">` without `allow-same-origin`), and UI rendering.
5. Run the full Engineering Tools CI checks (`ruff`, `pytest`, `tsc --noEmit`, `prettier --check`, `vitest`, `vite build`).
