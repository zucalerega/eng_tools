# YJSP: agent guide

YJSP is a college rocketry team's site for its engineering tools: two apps on one
server. **Vault** is CAD version control (check-out/check-in, version history, folder
permissions) for the team's SolidWorks and STEP files; it replaces Kenesto. **Yorg**
plots the team's test data. The team trusts them with flight-hardware designs and test
results, so correctness and not losing data come before speed. README.md is the user
guide. docs/design.md has the site's design (architecture, sign-in, the web app's
frame, API conventions, the names from before YJSP); docs/vault.md and docs/yorg.md
have each app's design, API, and roadmap. Read the design before changing behavior.

The apps share the server, the database, sign-in and accounts, and the web app's
frame, and nothing else. Neither imports the other, and the site's own code imports
neither, except where it puts them together (`app.py`, `migrations/env.py`, `App.tsx`,
`main.tsx`) and where accounts change (`people.py` tells Vault). Keep it that way:
something both apps need belongs to the site.

## Layout

| Path | What |
|---|---|
| `server/` | Python 3.13 FastAPI server, the `yjsp_server` package. The site at its top level: `app.py` puts it together, `auth.py` accounts and tokens, `people.py` managing accounts and the whitelist, `config.py` the `YJSP_*` settings, `api/` sign-in, people, downloads, and serving the web app. `vault/`: Vault. Start at `vault.py` (every vault operation, no HTTP); `access.py`: folder tree and permissions; `paths.py`: path rules; `caliper.py`: the 3D models' mesh format; `solidworks.py`: reading the 3D view SolidWorks saves in its files; `api.py`: its routes. `yorg/`: Yorg, the test data app (its tables, reading CSV files into arrays, rules, and routes under `/api/yorg`). |
| `client/` | Vault's clients, in C#. `Vault.Client`: workspace library (netstandard2.0 for the SolidWorks add-in, net10.0 for the rest). `Vault.Cli`: the `vault` command. `Vault.SolidWorks`: the SolidWorks 2026 add-in, which runs in 2025 too (net48, COM; see its README). `Vault.SolidWorks.Open`: `vault-open.exe`, which follows the web app's links into the add-in. `Vault.Setup`: `Vault-Setup.exe`, the add-in's installer, which carries the add-in's build inside it. Tests run against the real server. |
| `web/` | TypeScript and React, built with Vite into `web/dist`, which the server serves (`api/web.py`). The frame at the top of `src`: `App.tsx` (the top bar, the app switcher), `session.ts` (who's signed in), `api.ts` (requests, and the site's API). `vault/`: Vault's pages (`index.tsx`), and `store.ts`, the vault index, kept current through the sync feed while a Vault page is open; `vault/caliper/`: Caliper, the 3D viewer (three.js; `viewer.ts` draws, `geometry.ts` measures). `yorg/`: Yorg's pages and its canvas plots (`samples.ts` decides what's drawn). Tests run against the real server. |
| `docs/design.md`, `docs/vault.md`, `docs/yorg.md` | The site's design, and each app's: design, API, roadmap, open questions. |
| `docs/deploying.md` | How the live site is hosted, and how to deploy and look after it. |
| `deploy/` | `deploy.sh`, which deploys the live site; `migrate-to-yjsp.sh`, which moves the live server to the YJSP layout once; and copies of the server's service files. |
| `.github/workflows/ci.yml` | The checks every change must pass. |

## Commands

The full check, the same one CI runs. Run it before every commit:

```bash
cd server && uv sync --locked && uv run ruff check . && uv run ruff format --check . && uv run pytest
cd client && dotnet format --verify-no-changes && dotnet build && dotnet test
cd web && npm ci && npm run check && npm test && npm run build
```

- `cd server && uv run ruff format .`: format the Python.
- `cd server && uv run alembic revision --autogenerate -m "..."`: after changing any `models.py`.
- `cd server && YJSP_DEV_AUTH=1 YJSP_BOOTSTRAP_ADMINS=you@example.com uv run yjsp-server`: local
  server at http://localhost:8000 (API docs at `/docs`).
- `cd client && dotnet run --project src/Vault.Cli -- <command>`: the `vault` CLI.
- `cd web && npm run build`: build the web app; the local server then serves it at
  http://localhost:8000. `npm run dev` serves it at http://localhost:5173 and reloads as you
  edit (sign in at http://localhost:8000 first). `npm run format`: format the TypeScript.
- The add-in builds anywhere (`dotnet build`), but it only runs inside SolidWorks (2026, and
  2025 for laptops moving over) on Windows. CI uploads each build of `main` and of a release tag (kept a week, a tag's 90 days) as the `vault-setup` artifact (`Vault-Setup.exe`, which
  installs it; the server offers it from `YJSP_DOWNLOADS_DIR`), the `vault-solidworks-addin`
  artifact (its files, for install.ps1), and `vault-windows` (a self-contained `vault.exe`).
  Install and manual-testing steps are in `client/src/Vault.SolidWorks/README.md`.
- `docker build -f server/Dockerfile -t yjsp-server .`: the production image, server and web app.
- In a Claude Code cloud session, the SessionStart hook (`.claude/settings.json`) runs
  `.claude/cloud-setup.sh`, which installs Node 24 and the .NET 10 SDK, since the cloud
  image lacks them, so the full check runs there too. It does nothing on a laptop. If it
  says a download was blocked, the cloud environment's network access needs those hosts.
  Run as root, 4 client tests that make a file impossible to replace fail; CI runs them
  as a normal user. Cloud sessions can't reach the live site, so deploys happen from a
  laptop.

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
- **Clean up after yourself.** Once a PR merges, delete its branch, on GitHub and
  locally, and its worktree: `git push origin --delete <branch>`, `git worktree remove
  <path>`, `git branch -d <branch>`. Check first that it's merged (its PR says MERGED,
  and `git merge-base --is-ancestor origin/<branch> origin/main` agrees), and use `-d`,
  not `-D`, so git refuses a branch that isn't. A closed, unmerged PR's branch goes only
  once its work is abandoned or done elsewhere; ask before deleting a branch someone is
  still working on. When you're done, also stop the servers and background processes
  you started, and delete their scratch copies and databases: never leave a test or a
  server running.

## Code standards

- **One home for each rule.** The site's rules live in `auth.py`/`people.py`, Vault's in
  `vault/vault.py`, Yorg's in `yorg/` (`datasets.py`, ...), and Vault's client rules in
  `Vault.Client`. Routes, the CLI, and the add-in only translate.
- **Errors tell people what to do next,** e.g. "X is checked out by Alice on ALICE-PC".
  Server errors are `ApiError` subclasses with a stable `code`.
- **Comments explain why.** Match the style of the code around you.
- **Dependencies:** add one only with a reason given in the PR. Lockfiles (`uv.lock`,
  `packages.lock.json`, `package-lock.json`) are committed and only change on purpose.
- **Python:** type hints on every function, SQLAlchemy 2.0 typed models, ruff clean
  (line length 120).
- **C#:** `Vault.Client` must build for netstandard2.0 (the add-in runs on .NET
  Framework 4.8), so .NET 5+ APIs only inside `#if NET...`. Nullable references are
  on, warnings are errors, `dotnet format` must be clean, and library awaits use
  `ConfigureAwait(false)`.
- **TypeScript:** strict, Prettier-formatted (line length 120), no `any`. The web app only
  shows what the server allows and asks it to do things; permission rules stay on the
  server, and the app hides what your role can't do.

## Testing

- Every behavior change ships with tests. Every bug fix starts with a failing test
  that reproduces the bug.
- **Test through the public surface:**
  - server: the HTTP API, using the `Team` helper in `tests/conftest.py`
  - Vault's client: `Workspace`, against the real server via `ServerFixture`
  - web: the rendered app (Testing Library), against the real server started by
    `web/tests/server.ts`, with data set up through the API (`web/tests/team.tsx`)

  Don't mock the protocol.
- Tests are offline, deterministic, and isolated: temporary folders, no sleeping to
  wait for timing, no state shared between tests.
- `tests/test_database.py` fails if models and migrations disagree. Keep it green.
- The add-in has no automated tests, because they would need SolidWorks. Keep its logic in
  `Vault.Client`, where it is tested, and keep the add-in a thin layer over SolidWorks. Before
  releasing it, run the manual checks in its README on SolidWorks 2026.

## Invariants

Server:
- Every mutating vault operation, and every change to an account (`people.py`), calls
  `vault.begin_write(db)` before reading anything it validates. That serializes writers (SQLite and Postgres) and keeps
  `change_seq` in commit order, which the sync feed relies on.
- Check-in needs the lock, held by the same user on the same computer (`host`). A
  check-in is all-or-nothing, references included.
- Versions and blobs never change. Blobs are named by their SHA-256 and verified on
  upload.
- Vault paths are case-insensitive, NFC-normalized, valid Windows names, and at most
  200 characters. Compare them with `paths.key()` (`VaultPaths.Key` in C#), never
  `==`. `vault/paths.py` and `VaultPaths.cs` must agree; their tests share cases.
- Permission checks go through `Access`. A file the user can't see is 404, not 403.
- Timestamps are timezone-aware UTC (`db.UTCDateTime`).

Vault's client:
- Files not checked out to you are read-only on disk.
- Never overwrite or delete local changes without first copying them to
  `.vault/backup/`.
- Downloads are verified against their SHA-256 and then moved into place, so a
  failed download leaves the old file untouched.
- Every machine uses the same workspace root (default `C:\VLT`), because SolidWorks
  stores absolute paths to referenced files.

SolidWorks add-in:
- Call the SolidWorks API only on SolidWorks' main thread, and only through
  `SolidWorksHost`. Awaits in the task pane resume on that thread; `Vault.Client` code does
  not, so compute SolidWorks data before calling into it (see `ReferenceMap`).
- Nothing may throw into SolidWorks. Event handlers and UI handlers catch everything and
  log to `%LOCALAPPDATA%\Vault\addin.log`.
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
- So are the names a client or a browser keeps: the `vault://` link scheme, cookie and
  header names, where clients keep their files. Renaming one means accepting the old name
  until no client needs it, as docs/design.md, "Names from before YJSP", does.

## Database migrations

- After changing `models.py`, generate a migration, then read and fix it: naming,
  backfilling existing data, SQLite batch mode. Never trust autogenerate blindly.
- Never edit a migration once it has been merged; fix forward with a new one.
- Migrations must work on SQLite and Postgres, and on databases that already have
  data. A new non-null column needs a default or a backfill. SQLite changes a table by
  copying it and dropping the old one, which only works with foreign keys off (`db.migrate`
  does that): test a migration like that on a database with rows that point at the table,
  as `test_upgrades_keep_the_vault` does.
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
  (`Settings.check()`), and the server refuses settings named the old way (`CVC_*`).
  Never weaken that.
- **CI supply chain:** third-party GitHub Actions are pinned to a full commit SHA,
  with the version in a comment. GitHub's own `actions/*` may use a major-version tag.
  CI jobs get the smallest `permissions` they need.

## Data safety

- Normal code never modifies or hard-deletes Vault's versions or blobs. Deleting a file
  puts it in the trash. Any future purge must be an explicit admin action that runs only
  after a backup.
- Never run destructive operations (dropping tables, deleting blob files or Yorg's
  files, rewriting the database) against the live site's data. Do them on a copy.

## Deployment

The live site (https://lucazerega.tail07089c.ts.net) is an Oracle Cloud VM behind
Tailscale Funnel, running the server from a uv environment as a systemd service.
**docs/deploying.md has all of it:** where it runs, getting access, deploying, the checks,
rolling back, backups, setting up a new server, and the rules. In short:

- **Deploy with `bash deploy/deploy.sh`** (`main`) or `bash deploy/deploy.sh v1.2.3` (a
  release). It builds exactly that commit in a checkout of its own, backs up the
  database, switches over, and puts the old version back if `/healthz` doesn't answer.
  Deploy only `main` or a release tag, and only when the owner asks for a deploy.
- **Releasing:**
  1. Bump the version in `server/pyproject.toml`, `server/src/yjsp_server/__init__.py`,
     and `client/Directory.Build.props`.
  2. Tag `main`.
  3. Write release notes in the GitHub release.
- **Before deploying:**
  - CI is green on what you deploy.
  - You have read every migration in the release (the script backs the database up).
  - The team knows if check-ins will be briefly unavailable.
- **After deploying:**
  - The script says "Deployed: YJSP answers." (`/healthz`).
  - You can sign in.
  - On a scratch folder, you can check a file in, out, and in again.
  - The logs are clean.
- **Rolling back:** deploy the previous tag. If the release ran a migration, also
  restore the database backup taken before the deploy. Blobs are append-only, so they
  never need restoring.
- **Backups:** the server backs its database up every night (kept 14 days). Still to
  do: copy the database, Vault's folder (`YJSP_VAULT_DIR`), and Yorg's (`YJSP_YORG_DIR`)
  off the host every night (blobs never change, so their backups are incremental; Yorg's
  scripts and models do, so keep their old versions), and test a restore every semester.
- **Configuration:** production runs with `YJSP_ENV=production`, and every setting
  comes from `/srv/yjsp/.env` on the server. Never print it, copy it off, or commit it.
- **Never expose a development server** (dev sign-in) through Funnel or any other way.
- **The server's own files** (its systemd units and backup script) are copied in
  `deploy/`. Change them there too when you change them on the server.
- **Clients:** each CLI and add-in release must work with both the current and the
  previous server release.
- **The move to YJSP:** until 0.4.0 the live server was laid out as `/srv/vault`, with
  `CVC_*` settings. `deploy.sh` refuses it until `deploy/migrate-to-yjsp.sh` has moved it,
  once, when the owner asks (docs/deploying.md, "Moving to YJSP").
- The Docker image (`server/Dockerfile`, which CI publishes to
  `ghcr.io/<owner>/yjsp-server:<tag>` for version tags) is another way to run the server.
  The live site doesn't use it.
