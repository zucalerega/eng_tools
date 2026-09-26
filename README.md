# CVC

CAD version control for the team's SolidWorks and STEP files: check out, check in,
version history, and per-folder permissions, with a SolidWorks add-in on the way.
It replaces Kenesto.

> **Status:** early development. The server works and is tested. The `cvc` CLI,
> the web app, and the SolidWorks add-in are next. See
> [docs/design.md](docs/design.md) for how it works and the roadmap.

## How it works

- **Check out a file before you edit it.** While it's checked out, everyone else
  can open it read-only. Check it back in with a comment to save a new version.
- **Every version is kept.** See who changed what and why, and download any old
  version.
- **Assemblies stay consistent.** An assembly is checked in together with the new
  or changed parts it uses. Getting an assembly brings its parts along.
- **Access is per folder:** viewer, editor, or lead, plus admins. Subteams can own
  their folders.
- **Sign in with Google.** An admin approves new accounts.

## Layout

| Path | What | Status |
|---|---|---|
| `server/` | API server: Python, FastAPI, SQLAlchemy | working |
| `client/` | C# workspace library, `cvc` CLI, SolidWorks add-in | next |
| `web/` | Web app: React + Vite | planned |
| `docs/` | Design and roadmap | |

## Run the server locally

You need [uv](https://docs.astral.sh/uv/).

```bash
cd server && uv sync
```

```bash
cd server && CVC_DEV_AUTH=1 CVC_BOOTSTRAP_ADMINS=you@example.com uv run cvc-server
```

Open http://localhost:8000 and sign in with the development form as
`you@example.com`, which makes you an admin. The API is at
http://localhost:8000/docs. The local database and file contents go in
`server/data/`, which git ignores.

Run the tests:

```bash
cd server && uv run pytest
```
