# CVC

CAD version control for the team's SolidWorks and STEP files: check out, check in,
version history, and per-folder permissions, with a SolidWorks add-in on the way.
It replaces Kenesto.

> **Status:** early development. The server and the `cvc` command-line tool work
> and are tested. The web app and the SolidWorks add-in are next. See
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
| `server/` | API server: Python, FastAPI, SQLAlchemy; Docker image | working |
| `client/` | C# workspace library and `cvc` CLI | working |
| `client/` | SolidWorks add-in | next |
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

## Use the `cvc` command

You need the [.NET 10 SDK](https://dotnet.microsoft.com/download). With the server
running, sign in through your browser, create a workspace, and work in it:

```bash
cd client && dotnet run --project src/Cvc.Cli -- login http://localhost:8000
```

```bash
cd client && dotnet run --project src/Cvc.Cli -- init ~/CVC --server http://localhost:8000
```

In the workspace (`C:\CVC` on Windows):

| Command | What it does |
|---|---|
| `cvc status` | What's new, changed, out of date, or checked out |
| `cvc get` | Get the latest versions. Your local changes are never overwritten unless you add `--force`, and even then they're backed up. |
| `cvc checkout <files>` | Check files out to edit them. Everyone else sees who has them. |
| `cvc checkin <files> -m "what changed"` | Check in changed and new files as one version |
| `cvc undo <files>` | Give up a check-out. Local changes are backed up in `.cvc/backup`. |
| `cvc history <file>` | Every version, with who changed it and why |
| `cvc locks` | Who has what checked out |

## Tests

```bash
cd server && uv run pytest
```

```bash
cd client && dotnet test
```

The client tests start the real server, so they need uv too. How we work (branches,
reviews, releases) is in [CLAUDE.md](CLAUDE.md).
