# CVC: agent guide

CVC is CAD version control (check-out/check-in, version history, folder permissions)
for a college rocketry team's SolidWorks and STEP files. It replaces Kenesto. The
team trusts it with flight-hardware designs, so correctness and not losing data come
before speed. README.md is the user guide; docs/design.md has the design, API, and
roadmap. Read the design before changing behavior.

## Layout

| Path | What |
|---|---|
| `server/` | Python 3.13 FastAPI server. Start at `vault.py` (every vault operation, no HTTP). `access.py`: folder tree and permissions. `paths.py`: path rules. `auth.py`: accounts and tokens. `api/`: thin routes and request/response schemas. |
| `client/` | C#. `Cvc.Client`: workspace library (netstandard2.0 for the SolidWorks add-in, net10.0 for the rest). `Cvc.Cli`: the `cvc` command. `Cvc.SolidWorks`: the SolidWorks 2025 add-in (net48, COM; see its README). Tests run against the real server. |
| `docs/design.md` | Design, API, roadmap, open questions. |
| `.github/workflows/ci.yml` | The checks every change must pass. |

## Commands

The full check, the same one CI runs. Run it before every commit:

```bash
cd server && uv sync --locked && uv run ruff check . && uv run ruff format --check . && uv run pytest
cd client && dotnet format --verify-no-changes && dotnet build && dotnet test
```

- `cd server && uv run ruff format .`: format the Python.
- `cd server && uv run alembic revision --autogenerate -m "..."`: after changing `models.py`.
- `cd server && CVC_DEV_AUTH=1 CVC_BOOTSTRAP_ADMINS=you@example.com uv run cvc-server`: local
  server at http://localhost:8000 (API docs at `/docs`).
- `cd client && dotnet run --project src/Cvc.Cli -- <command>`: the CLI.
- The add-in builds anywhere (`dotnet build`), but it only runs inside SolidWorks 2025 on
  Windows. CI uploads each build as the `cvc-solidworks-addin` artifact, next to
  `cvc-windows` (a self-contained `cvc.exe`). Install and manual-testing steps are in
  `client/src/Cvc.SolidWorks/README.md`.
- `docker build -t cvc-server server/`: the production image.

## How changes are made

- **`main` is always releasable.** Work on a branch, open a PR, and merge only when
  CI is green. One logical change per PR. Never push to `main` directly or rewrite
  its history.
- **Commits:** an imperative subject line of at most 72 characters ("Add undo for
  check-outs"), and a body that explains why. Every commit builds and passes tests.
- **Done means** the code, its tests, and the docs it affects are in the same PR,
  the full check passes, and you have read the whole diff. No debug output, no
  commented-out code, no TODO without an issue link.
- **Report what actually happened.** Say which checks you ran and what they showed.
  Never claim tests pass without running them. If a check couldn't run, say so.

## Code standards

- **One home for each rule.** Server rules live in `vault.py`/`auth.py`, client rules
  in `Cvc.Client`. Routes, the CLI, and the add-in only translate.
- **Errors tell people what to do next,** e.g. "X is checked out by Alice on ALICE-PC".
  Server errors are `CvcError` subclasses with a stable `code`.
- **Comments explain why.** Match the style of the code around you.
- **Dependencies:** add one only with a reason given in the PR. Lockfiles (`uv.lock`,
  `packages.lock.json`) are committed and only change on purpose.
- **Python:** type hints on every function, SQLAlchemy 2.0 typed models, ruff clean
  (line length 120).
- **C#:** `Cvc.Client` must build for netstandard2.0 (the add-in runs on .NET
  Framework 4.8), so .NET 5+ APIs only inside `#if NET...`. Nullable references are
  on, warnings are errors, `dotnet format` must be clean, and library awaits use
  `ConfigureAwait(false)`.

## Testing

- Every behavior change ships with tests. Every bug fix starts with a failing test
  that reproduces the bug.
- **Test through the public surface:**
  - server: the HTTP API, using the `Team` helper in `tests/conftest.py`
  - client: `Workspace`, against the real server via `ServerFixture`

  Don't mock the protocol.
- Tests are offline, deterministic, and isolated: temporary folders, no sleeping to
  wait for timing, no state shared between tests.
- `tests/test_database.py` fails if models and migrations disagree. Keep it green.
- The add-in has no automated tests, because they would need SolidWorks. Keep its logic in
  `Cvc.Client`, where it is tested, and keep the add-in a thin layer over SolidWorks. Before
  releasing it, run the manual checks in its README on SolidWorks 2025.

## Invariants

Server:
- Every mutating vault operation calls `vault.begin_write(db)` before reading
  anything it validates. That serializes writers (SQLite and Postgres) and keeps
  `change_seq` in commit order, which the sync feed relies on.
- Check-in needs the lock, held by the same user on the same computer (`host`). A
  check-in is all-or-nothing, references included.
- Versions and blobs never change. Blobs are named by their SHA-256 and verified on
  upload.
- Vault paths are case-insensitive, NFC-normalized, valid Windows names, and at most
  200 characters. Compare them with `paths.key()` (`VaultPaths.Key` in C#), never
  `==`. `paths.py` and `VaultPaths.cs` must agree; their tests share cases.
- Permission checks go through `Access`. A file the user can't see is 404, not 403.
- Timestamps are timezone-aware UTC (`db.UTCDateTime`).

Client:
- Files not checked out to you are read-only on disk.
- Never overwrite or delete local changes without first copying them to
  `.cvc/backup/`.
- Downloads are verified against their SHA-256 and then moved into place, so a
  failed download leaves the old file untouched.
- Every machine uses the same workspace root (default `C:\CVC`), because SolidWorks
  stores absolute paths to referenced files.

SolidWorks add-in:
- Call the SolidWorks API only on SolidWorks' main thread, and only through
  `SolidWorksHost`. Awaits in the task pane resume on that thread; `Cvc.Client` code does
  not, so compute SolidWorks data before calling into it (see `ReferenceMap`).
- Nothing may throw into SolidWorks. Event handlers and UI handlers catch everything and
  log to `%LOCALAPPDATA%\CVC\addin.log`.
- One workspace operation at a time (the pane's gate), because `Workspace` isn't
  thread-safe. Synchronous paths, such as the save hook, must never block waiting for the
  gate.
- Never close a document that has unsaved changes on the user's behalf.
- The add-in's COM GUID (`AddIn.Id`) never changes; changing it orphans every install.

## API compatibility

The CLI and the add-in live on team laptops and update slowly, so the server must
keep working with older clients:
- API changes are additive only: new endpoints, new optional request fields, new
  response fields. Never rename or remove a field or endpoint, or change its
  meaning.
- A breaking change gets a new endpoint (or `/api/v2`). The old one stays until no
  client release still in use needs it.
- Error `code` values are part of the API, because clients branch on them.

## Database migrations

- After changing `models.py`, generate a migration, then read and fix it: naming,
  backfilling existing data, SQLite batch mode. Never trust autogenerate blindly.
- Never edit a migration once it has been merged; fix forward with a new one.
- Migrations must work on SQLite and Postgres, and on databases that already have
  data. A new non-null column needs a default or a backfill.
- The server migrates itself at startup, so a release that contains a migration
  needs a fresh backup before it is deployed.

## Security

- **Secrets** live only in environment variables or the host's secret store. Never put
  them in the repo, in logs, in error messages, or in URLs. `.env` is git-ignored, and
  `server/.env.example` lists every setting.
- **Tokens** are stored only as hashes on the server, and DPAPI-encrypted or owner-only
  on clients. Never log tokens or `Authorization` headers.
- **Paths and permissions:** every vault path goes through `paths.split` /
  `VaultPaths.Split`, and every permission check through `Access`.
- **Untrusted input:** validate request bodies with pydantic, never build SQL from
  strings, and never redirect to a URL a user supplied (`_safe_next`).
- **Production settings:** production refuses dev sign-in and weak settings
  (`Settings.check()`). Never weaken that.
- **CI supply chain:** third-party GitHub Actions are pinned to a full commit SHA,
  with the version in a comment. GitHub's own `actions/*` may use a major-version tag.
  CI jobs get the smallest `permissions` they need.

## Data safety

- Normal code never modifies or hard-deletes versions or blobs. Deleting a file puts
  it in the trash. Any future purge must be an explicit admin action that runs only
  after a backup.
- Never run destructive operations (dropping tables, deleting blob files, rewriting
  the database) against a real vault. Do them on a copy.

## Deployment

The server is one Docker image (`server/Dockerfile`: non-root, health-checked) plus a
persistent `/data` volume holding the SQLite database and the blobs. We haven't chosen
a host yet (docs/design.md, "Deploying").

- **What ships:** only images CI built from a version tag on `main` (`v1.2.3`), which it
  publishes to `ghcr.io/<owner>/cvc-server:<tag>`. Never deploy from a laptop or an
  untagged commit.
- **Releasing:**
  1. Bump the version in `server/pyproject.toml`, `server/src/cvc_server/__init__.py`,
     and `client/Directory.Build.props`.
  2. Tag `main`.
  3. Write release notes in the GitHub release.
- **Before deploying:**
  - CI is green on the tag.
  - The database and blobs are backed up.
  - You have read every migration in the release.
  - The team knows if check-ins will be briefly unavailable.
- **After deploying:**
  - `/healthz` answers.
  - You can sign in.
  - On a scratch folder, you can check a file in, out, and in again.
  - The logs are clean.
- **Rolling back:** redeploy the previous tag. If the release ran a migration, also
  restore the database backup taken before the deploy. Blobs are append-only, so they
  never need restoring.
- **Backups:** every night, copy the database and the blob folder off the host. Blobs
  never change, so blob backups are incremental. Test a restore every semester.
- **Configuration:** production runs with `CVC_ENV=production`, and every setting
  comes from the environment.
- **Clients:** each CLI and add-in release must work with both the current and the
  previous server release.
