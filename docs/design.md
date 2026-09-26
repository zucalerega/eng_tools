# CVC design

CVC (CAD Version Control) keeps the team's SolidWorks and STEP files in one vault,
with check-out/check-in locking, full version history, and per-folder permissions.
It replaces Kenesto. It's built for a college rocketry team, not a company: one
vault, a few dozen people, close to zero hosting cost, and simple enough for next
year's team to keep running.

## Context

- The team runs SolidWorks on their own Windows laptops, with admin rights, so
  each person can install the add-in, and the add-in is the main way people will
  use CVC.
- Development happens on a Mac. The server, web app, and CLI are built and tested
  there. The add-in is tested on a Windows PC with SolidWorks and admin rights.
- People sign in with Google (decided September 2026).

## Goals

- **One editor at a time.** CAD files can't be merged, so you check a file out
  before editing it. Everyone else can still open it read-only.
- **Every check-in is kept.** Anyone can see who changed what, when and why, and
  download or restore any old version.
- **Assemblies stay consistent.** An assembly is checked in together with the new
  and changed parts it uses, and getting an assembly brings its parts along.
- **Permissions per subteam folder.**
- **Works inside SolidWorks** through an add-in. A web app covers browsing,
  history and admin.
- **Cheap, and easy to hand over.** A single Docker container. A student can read
  the whole server in an afternoon.

## Not doing (for now)

- Approval workflows, change orders, BOMs, ERP integration (Teamcenter territory).
- Merging or diffing CAD files.
- Checking in while offline.
- Renaming or moving a file that other files reference. SolidWorks stores
  references as file paths, so SolidWorks itself has to rewrite the parent
  files. This will come later, through the add-in.

## Architecture

```
SolidWorks add-in (C#, .NET Framework 4.8) ─┐
cvc CLI (C#, .NET 10, Windows + macOS)      ─┴─ Cvc.Client library ─┐
                                                                     │ HTTPS, JSON
Web app (React) ─────────────────────────────────────────────────────┤
                                                                     ▼
                                               CVC server (Python, FastAPI)
                                               ├── database: SQLite or Postgres (who, what, when)
                                               └── blob store: disk or S3/R2 (file contents)
```

| Part | Where | Status |
|---|---|---|
| Server: API, sign-in, permissions | `server/` | working |
| Client library: the local workspace | `client/src/Cvc.Client` (netstandard2.0 + net10.0) | working |
| CLI (`cvc`) | `client/src/Cvc.Cli` (.NET 10) | working |
| SolidWorks 2025 add-in | `client/src/Cvc.SolidWorks` (.NET Framework 4.8) | built; untested in SolidWorks |
| Web app | `web/` (TypeScript, React + Vite), served by the server | working |

The add-in has to be .NET Framework, because SolidWorks add-ins are .NET Framework
COM components. The workspace logic lives in a netstandard2.0 library so the add-in
and the CLI share it, and it can be developed and tested on a Mac through the CLI.

## Concepts

- **Vault**: the one tree of folders and files on the server.
- **Path**: `Propulsion/Injector/Faceplate.SLDPRT`. Paths are case-insensitive and
  case-preserving, like Windows. Every name must be legal on Windows, and a path
  can be at most 200 characters, so `C:\CVC\` plus the path stays under Windows'
  260-character limit, which SolidWorks doesn't lift.
- **Version**: the contents of a file at one check-in, numbered 1, 2, 3… per file.
  Versions never change.
- **Check-in**: one save to the vault. It has a comment, an author and a computer,
  and it can contain versions of many files.
- **Blob**: file contents, stored once under their SHA-256 hash. An unchanged
  file, or the same STEP file in two folders, takes no extra space.
- **Lock (check-out)**: a file checked out by one person on one computer.
- **Workspace**: your local copy of the vault, at the same path on every machine
  (default `C:\CVC`).

## How it works

**Check out.** Takes locks on one or more files for you on this computer: all of
them or none. If a file is already checked out by someone else, the error says who
has it, on which computer, and since when. Checking out a file you already have
checked out on this computer succeeds and changes nothing. With `force`, a check-out
takes over: your own check-out moves to this computer, and a lead (or admin) can take
someone else's, which releases it as a "break lock" (below).

**Check in.** Uploads the new contents, then creates the new versions under one
comment, all or nothing:

1. The client uploads each file's contents to `PUT /api/blobs/{sha256}`. The server
   verifies the hash and skips contents it already has (`HEAD` says whether it
   does).
2. `POST /api/checkin` lists each file's path, hash, and references.
   - A file that already exists must be checked out by you, on this computer.
   - A new file is added, along with any folders it needs.
   - A file whose contents didn't change gets no new version, but is still
     unlocked.
3. References are the files each item uses: an assembly's parts, a drawing's
   model. Each one must already be in the vault or be part of this check-in, and
   is recorded with the version it used. That's how "where used" works, and later
   "get this assembly as it was at version 5".

Locks are released unless `keep_checked_out` is set.

**Undo check-out.** Releases your lock without checking in. A lead can do this to
someone else's lock ("break lock"), for when someone went home for the summer with
files checked out. It's recorded in the activity log with the lock holder's name.

**Revert.** Makes an older version the latest again, as a new version with that
version's contents and pinned references, recorded as a check-in ("Reverted to v2:
…"), so nothing is lost. It needs editor rights and the file not checked out by
someone else; a lead can force it, which releases their check-out. Your own check-out
ends, as with a check-in.

**Delete and restore.** Deleting moves files to a trash that anyone with edit
access can restore from, with full history. CVC refuses to delete a file that the
latest version of another file still uses, unless you force it or delete both
together. A new file can reuse a deleted file's name. Restoring the old file then
needs the name freed up first.

**History and where-used.** `GET /api/files/{id}` returns every version, newest
first, with comments, authors, and pinned references, plus the live files whose
latest version uses this file.

**Get latest** (client). The client asks `GET /api/sync?since=<seq>` for what
changed since its last sync. It downloads only the files you open or ask for (an
assembly brings its references along), not the whole vault.

## Permissions

| Role | Can |
|---|---|
| Viewer | browse, download, see history |
| Editor | + check out, check in, add files and folders, delete and restore, revert |
| Lead | + undo or take over other people's check-outs, force a revert, and change who has access to the folder |
| Admin (a flag on the account) | everything, everywhere, plus approving and disabling accounts |

A role is granted on a folder, for one person or for *everyone* (all active
accounts), and covers everything below that folder. If several grants apply, the
highest role wins. A typical setup:

- everyone = viewer at the root
- each subteam's members = editor on their subteam's folder
- the subteam lead = lead on that folder

If you can't view a folder, its files are invisible to you: asking for one returns
"not found", never "forbidden". You can still see the names of folders on the way
down to one you do have access to, so you can navigate there.

## Sign-in

- **People** sign in with Google. A first sign-in creates a *pending* account that
  an admin approves, unless an admin invited that email beforehand or it's listed
  in `CVC_BOOTSTRAP_ADMINS`.
- **The browser** keeps an HttpOnly session cookie. Requests that change something
  must also send an `X-CVC-Request` header, which cross-site pages can't add
  (CSRF protection).
- **The CLI and add-in** sign in through the browser, like `gh auth login`:
  1. The client listens on `127.0.0.1:<port>` and opens `/auth/client` with a PKCE
     challenge.
  2. You confirm in the browser.
  3. The server redirects to `http://127.0.0.1:<port>/callback` with a one-time
     code.
  4. The client exchanges the code and its PKCE verifier for a token. Tokens can be
     revoked (`GET/DELETE /api/tokens`), and the server stores only their hashes.
- **Local development:** `CVC_DEV_AUTH=1` enables `/auth/dev-login` and
  `/auth/dev-token`, which sign in as any email. The server refuses to start in
  production with this on, or without Google configured.

## Server rules

These rules keep the data consistent. The code relies on them, so keep them true:

- **Writers go one at a time.** Every change starts with `vault.begin_write()`,
  which increments `vault_state.seq` before reading anything the operation checks.
  In SQLite that takes the write lock; in Postgres it takes the row lock. So checks
  never race, and changes commit in `seq` order. The sync feed depends on that
  order: every changed row gets `change_seq = seq`.
- **Check-ins are all or nothing**, including their references. A missing reference
  rolls back the whole check-in, including any folders it created.
- **Versions and blobs never change.** Blobs are verified against their hash on
  upload.
- **Every permission check goes through `access.Access`.**
- **Timestamps are timezone-aware UTC.**

## The local workspace (client)

`Cvc.Client` implements the workspace. The `cvc` CLI and the add-in are thin layers
on top of it.

- **Same root everywhere.** Every machine uses `C:\CVC` by default. SolidWorks stores
  absolute paths to referenced files, so with the same root, references resolve on
  every machine.
- **Read-only unless checked out.** Files you don't have checked out are read-only
  on disk, so SolidWorks opens them read-only. Checking out makes a file writable;
  checking in or undoing makes it read-only again.
- **Local state.** `.cvc/state.json` records the sync cursor, the vault's files, and
  each local copy's id, version, hash, size, and write time. A file is rehashed only
  when its size or write time changes. From this state each file is one of:
  - up to date
  - out of date
  - modified
  - conflict: changed here, but a newer version was checked in since
  - not downloaded
  - new
  - deleted in the vault

  Each status also records who has the file checked out.
- **Local changes are never lost.** Get latest skips files changed here unless forced.
  Forcing it, or undoing a check-out, first copies your version to
  `.cvc/backup/<time>/`. Downloads are verified by SHA-256 and moved into place, so
  an interrupted download changes nothing. Undoing a check-out puts the vault's
  version back before it releases the lock, so a file that can't be replaced (it's
  open in SolidWorks) stays checked out to you.
- **Checking out updates first.** Checking out a file whose local copy is out of date
  downloads the latest version. A conflict has to be resolved before checking out.
- **Taking over** (`cvc checkout --force`, the add-in's Take over): a check-out on
  another computer, yours or, for leads and admins, someone else's. The workspace knows
  your role in each folder from the sync feed, so the add-in only offers it where the
  server will allow it. When someone whose check-out was released or taken over tries
  to check in, they're told who did it and when (from the activity log), and that their
  changes are still on their computer.
- **Some files are never added:** `~$*` (SolidWorks lock files), `*.tmp`,
  `Thumbs.db`, `desktop.ini`, `.DS_Store`.
- **Saved sign-ins:** `%APPDATA%\CVC\tokens.json`, encrypted with Windows DPAPI.
  Elsewhere, `~/.config/cvc/tokens.json`, readable only by its owner.
- **Assemblies:** the add-in asks SolidWorks for an assembly's references
  (`GetDocumentDependencies2`). Referenced files that are new, or checked out to you with
  changes, go into the same check-in. Every reference is pinned to the version this
  workspace has, which is the one the assembly was built against. References outside the
  workspace, such as a Toolbox part in `C:\SOLIDWORKS Data`, are refused with a message
  saying to move them in first. The CLI can't read SolidWorks files, so it doesn't send
  references.

## The SolidWorks add-in

`client/src/Cvc.SolidWorks` targets SolidWorks 2025 (API version 33) and is built
against the `Visiativ.SOLIDWORKS.Interop` 33.0.0 package. It is a .NET Framework 4.8
COM add-in, registered with `install.ps1` (RegAsm).

- **Task pane.** Everything is in the CVC tab: sign-in, the active document's status
  and actions, and a list of files that need attention.
- **Offering a check-out.** When you start editing the active document and it isn't
  checked out to you, CVC offers to check it out. It asks once per document per
  session, and ignores the changes SolidWorks makes while opening a file. Saving such a
  file offers the check-out too. The file is read-only, so SolidWorks turns Save into
  Save As (without the `FileSaveNotify` event): before the dialog opens
  (`FileSaveAsNotify2`), CVC checks the file out and saves it in place
  (`SetSaveAsFileName`), or says who has it or that there's a newer version, and offers
  to save under another name.
- **Open files.** SolidWorks holds the files it has open, including parts that an open
  assembly uses, even after the part's own window is closed. Before get latest, undo,
  or a check-out that needs the latest version replaces open files, SolidWorks lets go
  of them (`ForceReleaseLocks`; drawings are closed), and afterwards reloads them in
  place (`ReloadOrReplace`), so windows stay open and assemblies update. A file with
  unsaved changes isn't replaced, except by an undo you've confirmed; one changed while
  it was being replaced keeps its changes and isn't reloaded. These decisions use the
  vault's current state, not the task pane's last refresh. Check-out and check-in
  switch open documents between read-only and editable (`SetReadOnlyState`).
- **Sharing with the CLI.** The add-in shares the workspace and the saved sign-in with
  the CLI.
- **Links from the web app.** "Open in SolidWorks" is a `cvc://open?server=…&path=…`
  link (`OpenLink`). install.ps1 registers `cvc-open.exe` (in the add-in's folder) for
  them. It starts SolidWorks if needed and hands the link to the add-in over a named
  pipe for the Windows session, which only the current user can open. The add-in checks
  that the link is for its workspace's server, gets the file's latest version and the
  parts it uses (updating open copies in place), opens it, and comes to the front.

## The web app

`web/` is one page (TypeScript, React, Vite) that the server serves at `/` and at any
path the API doesn't own (`api/web.py`), to people who are signed in and approved;
everyone else signs in on the server's home page first. It uses the browser session
cookie, and sends `X-CVC-Request` on every request.

- **A live copy of the vault index.** It loads everything you can see from the sync
  feed (`GET /api/sync`, as the clients do) and asks it for changes every few seconds
  while the page is visible, so browsing and searching need no more requests, and
  check-ins and check-outs on anyone's PC show up within seconds.
- **Pages:** files (browse and search), a file (history, downloads, what it uses and
  what uses it), checked out (who has what), activity, and admin (people for admins;
  access for admins and folder leads).
- **Admin mode**, a switch for admins and folder leads, remembered per browser: it adds
  releasing someone's check-out and reverting a file someone has checked out. The
  server checks every one of them; the app only hides what your role can't do.
- **Open in SolidWorks** links to `cvc://open?server=…&path=…`, which the add-in's
  installer registers on Windows PCs.

## API

Every endpoint needs sign-in except `/auth/*` and `/healthz`. Errors look like
`{"error": "checked_out", "message": "...", "details": {...}}`. Interactive docs
are at `/docs`.

| Endpoint | Purpose |
|---|---|
| `GET /api/me` | who you are, and whether you're approved |
| `GET /api/folders?path=&deleted=` | a folder's subfolders and files (or its trash) |
| `POST /api/folders` | create a folder |
| `GET /api/files/{id}` | a file's versions, references, and where it's used |
| `GET /api/files/{id}/content?version=` | download a version (default: latest) |
| `HEAD`/`PUT /api/blobs/{sha256}` | check for / upload file contents |
| `POST /api/checkout` | lock files `{files: [id or path], host, force}` |
| `POST /api/files/{id}/revert` | make an older version the latest again `{version, comment, force}` |
| `POST /api/checkin` | new versions and new files `{comment, host, items, keep_checked_out}` |
| `POST /api/undo-checkout` | release locks (leads: anyone's) |
| `POST /api/delete`, `POST /api/files/{id}/restore` | trash and restore |
| `GET /api/checkouts?mine=` | who has what checked out |
| `GET /api/sync?since=` | changes since a cursor, for clients |
| `GET /api/activity?before=&file_id=` | activity log, newest first |
| `GET/PUT /api/grants?path=` | who has access to a folder; change it |
| `GET/POST /api/users`, `PATCH /api/users/{id}` | accounts: invite, approve, disable (admins) |
| `GET /api/tokens`, `DELETE /api/tokens/{id}` | your signed-in browsers and clients |

## Deploying

The server ships as a Docker image (`server/Dockerfile`). It runs as a non-root user,
has a health check, and keeps its database and file contents on a `/data` volume.
CI builds and smoke-tests the image on every change, and publishes it to
`ghcr.io/<owner>/cvc-server:<tag>` for version tags. The release, backup, and
rollback rules are in CLAUDE.md, under "Deployment". Setup:

1. In Google Cloud Console, create an OAuth client of type *Web application* with
   the redirect URI `https://<your CVC address>/auth/callback`. Sign-in only asks
   for `openid email profile`, so Google doesn't need to verify the app.
2. Set `CVC_ENV=production`, `CVC_PUBLIC_URL`, `CVC_SECRET_KEY`,
   `CVC_GOOGLE_CLIENT_ID`/`_SECRET`, and `CVC_BOOTSTRAP_ADMINS` (see
   `server/.env.example`).
3. Keep `CVC_DATABASE_URL` (SQLite by default) and `CVC_BLOB_DIR` on a persistent
   disk, and back both up. An S3/R2 blob store (Cloudflare R2: 10 GB free, no
   download fees) is planned.

We still need to decide where to host it: Render (about $7/month plus disk), a
~$5/month VPS, or a machine on campus. The image runs on any of them.

## Roadmap

1. **Server core** (done): folders, check-out/check-in with references, history,
   trash, permissions, Google and client sign-in, sync feed, activity log.
2. **Client library + `cvc` CLI** (done): workspace, status, get latest, check
   out/in, undo with backups, history, locks, browser sign-in. Tested against the
   real server.
3. **SolidWorks 2025 add-in** (built; needs its first run in SolidWorks): task pane
   with status and actions, check-out offers when you edit, save checks, and
   check-ins that include an assembly's references.
4. **Web app** (done): browse and search, history, download, who-has-what, activity,
   admin (approvals, permissions), admin mode (releasing check-outs, forced reverts),
   and opening files in SolidWorks (the `cvc:` link).
5. **Deploy**: Docker image and CI (done). Still to do: R2 blob store, hosting,
   backups, and importing the current files from Kenesto.
6. **Later**: thumbnails and a 3D STEP preview in the browser, check-in
   notifications to team chat, released revisions (A, B, C) for flight hardware,
   and rename/move with reference repair.

## Open questions

- Hosting: Render, a VPS, or a campus machine (decide at deploy time).
- SolidWorks version: 2025 (decided September 2026). The add-in targets API version 33.
- Kenesto: the plan is to import the current files from a synced Kenesto folder
  and keep Kenesto read-only as the archive of old history.
