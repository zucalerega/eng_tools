# CVC

CAD version control for the team's SolidWorks and STEP files: check out, check in,
version history, and per-folder permissions, from SolidWorks, the command line, or
the web. It replaces Kenesto. People know it as **Vault**: that's its name in the web
app and in SolidWorks, in the Yellow Jacket Space Program's colors. The code, the `cvc`
command, and this repository keep the name CVC.

> **Status:** early development. The server, the `cvc` command-line tool, and the web
> app work and are tested. The SolidWorks 2025 add-in had its first run in SolidWorks in
> September 2026. See [docs/design.md](docs/design.md) for how it works and the roadmap.

## How it works

- **Check out a file before you edit it.** While it's checked out, everyone else
  can open it read-only. Check it back in with a comment to save a new version.
- **Every version is kept.** See who changed what and why, and download any old
  version.
- **Assemblies stay consistent.** An assembly is checked in together with the new
  or changed parts it uses. Getting an assembly brings its parts along.
- **Drawings stay with what they show.** A drawing is checked in only if it shows a
  part or assembly in the vault, and only if it's named after it (`Fin.SLDDRW`, or
  `Fin - machining.SLDDRW`, for `Fin.SLDPRT`), so it sits next to it in its folder.
  Check drawings in from SolidWorks: the `cvc` command can't read what a drawing shows.
- **Access is per folder:** viewer, editor, or lead, plus admins. Subteams can own
  their folders.
- **Sign in with Google.** An admin approves new accounts.
- **See everything on the web:** browse and search the vault; see what each assembly
  contains and which assemblies each part is in, at every level, and whether each file
  is checked in; see each file's history and drawings and who has what checked out;
  download any version; follow the activity as it happens; start new parts,
  assemblies, and drawings, which SolidWorks makes on your computer; and organize the
  vault: new folders, uploads (files, whole folders, or what's in a zip, by dropping them
  on the page), moving or renaming, which every computer's copies follow, and deleting,
  to a trash each folder keeps. Admins and folder leads can switch on admin mode to
  release someone's check-out or revert a file they have checked out.
- **SolidWorks in one download:** the web app's SolidWorks page offers `Vault-Setup.exe`,
  which installs the add-in, and a button that connects it to the vault.

## Layout

| Path | What | Status |
|---|---|---|
| `server/` | API server: Python, FastAPI, SQLAlchemy; Docker image | working |
| `client/` | C# workspace library and `cvc` CLI | working |
| `client/src/Cvc.SolidWorks` | SolidWorks 2025 add-in ([install](client/src/Cvc.SolidWorks/README.md)) | working |
| `client/src/Cvc.Setup` | `Vault-Setup.exe`, the add-in's installer | working |
| `web/` | Web app: TypeScript, React, Vite; served by the server | working |
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

To get the web app there too, build it once. You need [Node.js](https://nodejs.org/) 24:

```bash
cd web && npm ci && npm run build
```

To work on the web app, `cd web && npm run dev` serves it at http://localhost:5173 and
updates it as you edit. Sign in at http://localhost:8000 first; the dev server passes
API requests to it.

## Use the `cvc` command

On Windows, download `cvc.exe` (the `cvc-windows` artifact of any CI run). It runs
without installing anything. Otherwise you need the
[.NET 10 SDK](https://dotnet.microsoft.com/download). With the server running, sign in
through your browser, create a workspace, and work in it:

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
| `cvc checkout <files>` | Check files out to edit them. Everyone else sees who has them. `--force` takes over a check-out on another computer: yours, or anyone's if you're a lead there. |
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

```bash
cd web && npm test
```

The client and web app tests start the real server, so they need uv too. How we work
(branches, reviews, releases) is in [CLAUDE.md](CLAUDE.md).
