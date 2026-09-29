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
| Yorg, the test data app (see "Yorg") | `server/src/cvc_server/yorg`, `web/src/yorg` | working |

The add-in has to be .NET Framework, because SolidWorks add-ins are .NET Framework
COM components. The workspace logic lives in a netstandard2.0 library so the add-in
and the CLI share it, and it can be developed and tested on a Mac through the CLI.

## Concepts

- **Vault**: the one tree of folders and files on the server.
- **Path**: `Propulsion/Injector/Faceplate.SLDPRT`. Paths are case-insensitive and
  case-preserving, like Windows. Every name must be legal on Windows, and a path
  can be at most 200 characters, so `C:\VLT\` plus the path stays under Windows'
  260-character limit, which SolidWorks doesn't lift.
- **Version**: the contents of a file at one check-in, numbered 1, 2, 3… per file.
  Versions never change.
- **Check-in**: one save to the vault. It has a comment, an author and a computer,
  and it can contain versions of many files.
- **Blob**: file contents, stored once under their SHA-256 hash. An unchanged
  file, or the same STEP file in two folders, takes no extra space.
- **Lock (check-out)**: a file checked out by one person on one computer.
- **Workspace**: your local copy of the vault, at the same path on every machine
  (default `C:\VLT`).

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
4. A new version of a drawing must show a part or assembly (reference one), and be
   named after one it shows: `Fin.SLDDRW`, or a name that starts with it and goes on
   after a space or a symbol (`Fin - machining.SLDDRW`), for `Fin.SLDPRT`
   (`paths.named_after`). So a drawing is never lost from its model, and sorts next to
   it. The CLI can't read what a drawing shows, so drawings are checked in from
   SolidWorks.

Locks are released unless `keep_checked_out` is set.

**Undo check-out.** Releases your lock without checking in. A lead can do this to
someone else's lock ("break lock"), for when someone went home for the summer with
files checked out. It's recorded in the activity log with the lock holder's name.

**Revert.** Makes an older version the latest again, as a new version with that
version's contents and pinned references, recorded as a check-in ("Reverted to v2:
…"), so nothing is lost. It needs editor rights and the file not checked out by
someone else; a lead can force it, which releases their check-out. Your own check-out
ends, as with a check-in.

A check-in of unchanged contents that brings references for a version that had none (an
assembly uploaded in the web app, which can't read SolidWorks files, then checked in from
SolidWorks) makes a new version, with the same contents, to record them.

**Move and rename.** Files and folders move into another folder (made if it isn't there)
or get a new name (a file keeps its type), all or nothing, and never while checked out.
SolidWorks finds a file that an assembly or drawing uses by its name, in the assembly's
folder or where it was relative to the assembly. So a move that would lose a file from
the files using it is refused (`_still_found`): move a part into its assembly's folder,
or their whole folder together, and rename used files in SolidWorks. Moving or renaming
a folder, which takes its permissions along, takes a lead of it. Afterwards every client
syncs everything again (clients know folders by path, and where a file is decides who
can see it), and the CLI and add-in move their copies to match; a copy SolidWorks has
open moves at a later refresh, and counts as that file meanwhile.

**Delete and restore.** Deleting moves files to a trash that anyone with edit
access can restore from, with full history. CVC refuses to delete a file that the
latest version of another file still uses, unless you force it or delete both
together, and a file someone else has checked out. A new file can reuse a deleted
file's name. Restoring the old file then needs the name freed up first.

A folder goes to the trash with everything in it, which takes a lead of it (as moving
it does), under the same rules for the files inside. Deleted folders keep their place
(`Tree.by_id`) but not their name (`uq_folders_live_name` covers live folders only), so
a new folder can take it. Everything deleted in one go shares its `deleted_at`: restoring
a folder brings back what went with it, but not what was deleted from it before, which
stays in its trash. Restoring a file whose folder is in the trash brings the folder
back too (empty but for it). A folder's trash (`GET /api/folders?deleted=true`) lists
the folders and files deleted from it. Deleting a folder has every client sync
everything again, like a move, and drop it.

**History and where-used.** `GET /api/files/{id}` returns every version, newest
first, with comments, authors, and pinned references, plus the live files whose
latest version uses this file. Every file the API returns, including in the sync
feed, also lists what its latest version uses (`uses`: file ids, each with the version
it was checked in with, limited to files you can see), and who created it and when
(`created_by`, `created_at`) next to who changed it last (`modified_by`, `modified_at`). So the web app and the add-in,
which keep a copy of the feed, know every assembly's parts and where each part is used,
at every level, without asking for each file. References are by id, so renaming a file
later won't touch the files that use it.

**Get latest** (client). The client asks `GET /api/sync?since=<seq>` for what
changed since its last sync. It downloads only the files you open or ask for (an
assembly brings its references along), not the whole vault. Each workspace holds the
whole vault's index, and a folder for each of its folders (`MirrorFolders`: somewhere to
save new parts where they belong; folders gone from the vault go once they're empty), but
only the files someone there has opened, checked out, or asked for, at their latest
versions; history stays on the server. Updating
(`Workspace.UpdateAsync`: the add-in's Update my files, `cvc get` with no paths) brings
the files that are here up to date, with any parts they've started to use, and nothing
else. Downloading everything, or a folder's files that aren't here yet, is its own
step, and the add-in says how many files and how much space first (`SizeOfGetAsync`).

## Permissions

| Role | Can |
|---|---|
| Viewer | browse, download, see history |
| Editor | + check out, check in, add files and folders, delete and restore, revert |
| Lead | + undo or take over other people's check-outs, force a revert, and change who has access to the folder |
| Admin (a flag on the account) | everything, everywhere, plus approving and disabling accounts, and the whitelist |

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

- **People** sign in with Google, and anyone who does joins at once (decided September
  2026, for now), unless an admin has turned on the *whitelist* (Admin > People in the web
  app, `site_settings`). With it on, a first sign-in creates a *pending* account that an
  admin approves, unless an admin invited that email beforehand. Emails listed in
  `CVC_BOOTSTRAP_ADMINS` are always active admins, and a disabled account stays disabled
  however it signs in. Turning the whitelist off approves everyone waiting, since they
  could sign in again to join; turning it on changes no one who already has an account.
  While it's off, anyone with a Google account gets what *everyone* is granted, and Yorg.
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

- **Same root everywhere.** Every machine uses `C:\VLT` by default. SolidWorks stores
  absolute paths to referenced files, so with the same root, references resolve on
  every machine.
- **Files from elsewhere.** A file uploaded in the web app has no references recorded
  (the server can't read SolidWorks files), and one brought over from Kenesto keeps the
  paths its parts had there (`K:\Yellow Jacket Space Program\Project
  CAD\09_Hopper\Stringer.SLDPRT`). Opening or getting one in the add-in reads the paths
  SolidWorks keeps in it (`GetDocumentDependencies2`, not searching), level by level, and
  `Workspace.FindUsedFiles` takes each to the vault file whose path ends the same way,
  with the most folders matching (none if two match as well); those come down with it,
  and kept paths nothing matches are listed. When SolidWorks can't find a file anyway,
  the add-in's `ReferenceNotFoundNotify` handler points it at the vault file that match
  means, if it's here, or else at the file here at the longest end of the path
  (`Workspace.LocalFileFor`). Checking such an assembly in from SolidWorks records its
  references (see "A check-in of unchanged contents" above); one that uses files the vault
  can't have (missing, or outside the workspace) names them all at once, and nothing is
  checked in.
- **Read-only unless checked out.** Files you don't have checked out are read-only
  on disk, so SolidWorks opens them read-only. Checking out makes a file writable;
  checking in or undoing makes it read-only again.
- **Local state.** `.cvc/state.json` records the sync cursor, the vault's files (with
  what each uses) and folders (with your role in each), and each local copy's id,
  version, hash, size, and write time. A file is rehashed only when its size or write
  time changes. A workspace whose state is from an older client (`SyncFormat`), or that
  synced while its server didn't say what files use yet, gets everything once more.
  From this state each file is one of:
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
  references, and the server refuses drawings from it (a drawing must show a part or
  assembly).

## The SolidWorks add-in

`client/src/Cvc.SolidWorks` targets SolidWorks 2025 (API version 33) and is built
against the `Visiativ.SOLIDWORKS.Interop` 33.0.0 package. It is a .NET Framework 4.8
COM add-in, registered with RegAsm.

- **Installing.** `Vault-Setup.exe` (`client/src/Cvc.Setup`, built by CI) is the one
  download: it carries the add-in's files, and after Windows asks for administrator
  rights, puts them in `C:\Program Files\Vault for SolidWorks`, registers the add-in
  (RegAsm, which runs its own registration with SolidWorks) and `cvc://` links, and
  lists itself in Windows' installed apps to remove all that again. It isn't signed yet,
  so Windows' SmartScreen warns about it once. The server offers it to members from
  `CVC_DOWNLOADS_DIR` (`GET /api/downloads`), on the web app's SolidWorks page, whose
  Connect SolidWorks button (`cvc://connect?server=…`) has the add-in sign in to that
  vault. `install.ps1` does the same by hand, from wherever the add-in is (for development).

- **Task pane.** Everything is in the Vault tab: sign-in, the active document's status
  and actions (including opening its drawing), and two views: the files that need
  attention, and Browse, the whole vault as a tree (`Workspace.BrowseAsync`, a
  `VaultTree`) in which every file says whether it's checked in, assemblies open up into
  their parts, and parts and assemblies list their drawings. It refreshes every 20
  seconds and after every action, and redraws only when something changed, so what you
  opened in the tree stays open.
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
- **New files from the web app.** New part, New assembly, and New drawing (of a part or
  assembly) are `cvc://new?server=…&path=…[&model=…]` links. The add-in checks that the
  name is free and that you can add files there (`Workspace.CheckNewFileAsync`); for a
  drawing, gets the model and the parts it uses; starts the file from SolidWorks' default
  template for its type (a drawing with an isometric view of the model); saves it; and
  checks it in at once as version 1, kept checked out to you, so everyone sees it and
  the name is taken. Changes to the model that you haven't checked in stay out of that
  check-in.

## The web app

`web/` is one page (TypeScript, React, Vite) that the server serves at `/` and at any
path the API doesn't own (`api/web.py`), to people who are signed in and approved;
everyone else signs in on the server's home page first. It uses the browser session
cookie, and sends `X-CVC-Request` on every request.

- **A live copy of the vault index.** It loads everything you can see from the sync
  feed (`GET /api/sync`, as the clients do) and asks it for changes every few seconds
  while the page is visible, so browsing and searching need no more requests, and
  check-ins and check-outs on anyone's PC show up within seconds.
- **Pages:**
  - Files: a folder tree on the left (the way to the current folder opens by itself,
    and each folder says how many files in it are checked out) beside the folder's
    contents. Every file says whether it's checked in, or who has it checked out on which
    computer, who created it and when, and who changed it last and when; every folder how
    many files in it are checked out. Assemblies (and drawings) open up to show what they
    use, level by level, each with its own status; parts and assemblies link to their
    drawings. Search (by name, with `*` and `?` patterns, or by path with a `/`) and the
    filters (kind, status, when it was last changed, and by whom) list matching files from
    the folder and every folder in it, or from the whole vault (`browsing.ts`). The sort
    (a dropdown, or the name, date, and size column headings) is remembered per browser.
  - Assemblies: the top-level assemblies (no other assembly uses them), each opening up
    into its sub-assemblies and parts, wherever those are kept.
  - A file: what it contains (or, for a drawing, shows), the assemblies it's in up to
    the top-level ones, its drawings, and its history, with downloads.
  - A folder's trash, with a Restore for each folder and file deleted from it.
  - SolidWorks: the add-in's installer, and Connect SolidWorks (see "The SolidWorks
    add-in").
  - Checked out (who has what, with check-in and undo for your own), activity, and admin
    (people and the whitelist for admins; access for admins and folder leads), which is in
    the account menu.

  All of it comes from the sync feed's `uses`, so a check-in anywhere shows up in every
  tree within seconds.
- **Admin mode**, a switch for admins and folder leads, remembered per browser: it adds
  releasing someone's check-out and reverting a file someone has checked out. The
  server checks every one of them; the app only hides what your role can't do.
- **Open in SolidWorks** links to `cvc://open?server=…&path=…`, which the add-in's
  installer registers on Windows PCs.
- **Branding:** the app calls itself Vault, in the Yellow Jacket Space Program's colors:
  near-black, white, and dark blue, with its gold. Its mark is a vault door crossed by a
  gold orbit, after the team's logo (`VaultMark`); the favicon, the server's sign-in
  pages, and the add-in's task pane icon draw the same shapes. The code, the `cvc`
  command, and the repository keep the name CVC.
- **Light and dark:** light, dark, or the computer's setting, chosen in the account
  menu (top right, with Admin, admin mode, and signing out) and remembered per browser
  (`theme.ts`, as `data-theme` on the page). The sign-in pages, a card with the mark,
  follow the same choice.
- **Organizing:** in a folder you can edit, New makes a folder (or a part or assembly,
  below), and Upload (or dropping files and folders on the page) adds files and whole
  folders: each file's contents go up once, hashed in the browser, then they're checked in
  together as version 1 of each, or as the next version of files checked out to you in the
  web app (see "Web check-outs"). New drawings are left out (they come from SolidWorks,
  which links them), and so are temporary files; an assembly goes up without its parts recorded,
  until someone checks it in once from SolidWorks. A zip goes up as the files in it, with
  its folders, where the zip was (unless you say to upload the zip itself): the browser
  reads the zip's directory, then inflates each file (`DecompressionStream`) and checks
  its CRC as it goes up (`zip.ts`). Checkboxes pick folders and files to move to another
  folder, rename (see "Move and rename": the server says if SolidWorks would lose a
  file), or delete (to the trash; files that others use get a warning and a second yes).
- **Web check-outs:** Check out on a file's page (or for files picked in a folder) locks
  it for you with `web` as the computer (`checkouts.ts`). Check in… uploads its new
  version (a file of the same type) with a comment, as uploading it into its folder does;
  Undo check-out ends it, asking first about a check-out on a computer, whose changes stay
  there. The web app can't read SolidWorks files, so an assembly's new version records no
  parts until it's checked in from SolidWorks (see "A check-in of unchanged contents"),
  and a drawing's keeps what its latest version shows, so it stays linked. The add-in
  treats a web check-out as yours on another computer: when you start changing the file,
  it offers to move the check-out to its computer.
- **New files:** New part and New assembly in a folder you can edit, and New drawing on
  a part's or assembly's page. The app checks the name (free, allowed by Windows, and for
  a drawing named after its model), then links to `cvc://new`, and SolidWorks on this
  computer makes it. It shows up in the vault a few seconds later, checked out to you.

## Yorg (test data)

Yorg is a second app on the same server: the team's test data (hotfires, cold flows),
plotted, in the spirit of SpaceX's Borg or Sift. It shares the server, the database,
sign-in, and the web app's frame with the vault, and nothing else: its own tables
(`yorg_*`), its own folder of files (`CVC_YORG_DIR`), its own API (`/api/yorg`), and its
own pages (`/yorg`), with the app switcher in the top bar between the two. The name is a
placeholder: the web app says it in one place (`YORG` in `web/src/yorg/index.tsx`).

- **Datasets.** An upload is a dataset: its file, kept as it came (`datasets/<id>/source`),
  and what was read from it: one time base, and a channel per column. Everyone signed in
  (and approved) sees every dataset and can add them; only the person who added one, or
  an admin, renames it, reads it again, moves it, or deletes it. Deleting hides it with
  everything kept, so it can be restored.
- **Folders** (`yorg_folders`, a tree) hold datasets: a test campaign, a day of cold
  flows. Anyone makes one; whoever made it (or an admin) renames it, moves it (never into
  itself), or deletes it, once it's empty (deleted datasets in it go up to its parent).
  Names are unique within a folder, whatever their case. Moving several datasets is all
  or none. The list shows each dataset's size, and its search looks in every folder.
- **Reading a file** (`yorg/ingest.py`, pure Python, no numpy) happens once, on the
  server, when it's uploaded, about 15 MB of CSV a second. The first 512 KB say how it's
  laid out: the encoding (UTF-8, UTF-16, or Windows' cp1252), the delimiter (comma, tab,
  semicolon, pipe, or spaces; decimal commas with semicolons or tabs), where the data
  starts (after notes, LabVIEW's header blocks, and the names), a row of units if
  there's one (else a unit in brackets after a name, PT-1 (psi); written with every
  value, as some loggers do, 23.958 V; or a name's last word, Upstream Pressure PSI, if
  it's a unit of more than one letter), and which column is time: one named like it
  (`Time`, `t_ms`, `Timestamp`, `X_Value`...), else the first if it only goes up. Its
  format comes from its name, unit, and values: seconds, milliseconds, microseconds, or
  nanoseconds; Unix time (by size: 1.7e9 is seconds, 1.7e12 milliseconds...); or dates
  and times (ISO 8601, American and European dates, AM/PM, times of day that pass
  midnight). Then the whole file streams through a block of rows at a time, one file per
  column, so memory doesn't limit it. Rows without a readable time are left out, rows
  out of time order are put in order, and cells that aren't numbers are left empty; each
  is said once, with a row number, in the dataset's warnings. A column empty in at least
  half the rows (a slower sensor in the same file) keeps only its samples, with their
  own times. A text column is a state, numbered as its values first appear, or, if it's
  in fewer than 5% of rows, events (a sequence's steps), shown as markers. A switch's
  states (a valve's, a command's: any that say on or off, however a log mixes words and
  digits, like closed, 1, fault, open) are numbered again once the column's read: off
  (closed, 0, false...) is 0, on (open, 1, true...) is 1, named in the file's words, and
  anything else (fault, disconnected) comes after them. A column of only those words and
  0 and 1 is a switch, whichever the first rows say more of. Anyone who can change a
  dataset can read it again with other options (the time column and format, where the
  names are, the delimiter); a read that fails leaves the last one standing.
- **Arrays.** A read writes little-endian float64 arrays (times in seconds, and values,
  NaN where missing) to `datasets/<id>/<version>/`, a new folder each read. Their URLs
  name the version, so browsers keep them forever (`Cache-Control: immutable`), and the
  previous read's folder is deleted once the new one is in the database. Times are
  "relative" (as the file had them), "absolute" (seconds after `start_epoch`, the first
  row's Unix time), or "clock" (times of day).
- **Plotting** (`web/src/yorg`) happens in the browser, on a canvas, with no plotting
  library. A channel's arrays are fetched once and shared by every plot. What's drawn is
  a screen's worth of points however long the file: with more samples in view than
  pixels, each pixel column gets its first, lowest, highest, and last value, which draws
  what drawing every sample would, and a min/max index (blocks of 32 samples, blocks of
  those, and so on) finds any run's extremes without looking at each sample, so zooming
  and panning stay smooth on millions of samples (`samples.ts`). Samples further apart
  than 20 times the usual step aren't joined (a pause in logging).
- **The workspace**: channels on the left (grouped by prefix: PT, TC, LC...), each a
  toggle: a click plots it on the selected panel, or takes it off every panel if it's
  plotted (shift-click: a panel of its own). Panels stack on one time axis, sharing the
  window's height (at least 220 px each; one dragged to a height keeps it), each with a
  legend that reads each channel's value at the shared cursor. A panel has an axis for
  each kind of value: a channel goes on the axis with others of its unit (states share
  one), else on a new axis, on the side with fewer (each side's axes go out from the
  plot, and every plot keeps room for the most any has, so their time axes line up).
  With more than one, each axis is in its first channel's color. A channel moves to
  another axis, or a new one, by dropping it (from the list, or from a legend, even
  another panel's) on that group of the legend, or with its settings; dropped anywhere
  else on a plot, it goes on the axis for its unit. Axes nothing's on go. A channel's
  settings set its scale, offset, unit, color, axis, and lines or steps; there's T0,
  markers (T0 and markers are dragged to move them), datasets compared, each shifted in
  time (lined up by clock time when both have dates), and exports (a PNG of the plots, a
  CSV of the samples in view).
- **Time** reads from T0 (T−10, T0, T+15 on the axis, at the cursor, and in the window's
  inputs; seconds from the start without a T0), or as time of day, in UTC or this
  computer's zone: dated data (Unix times) reads as time of day until there's a T0, and
  from it after, with the cursor giving the time of day too. T0 is typed (a time of day,
  a Unix or ISO time, T+12 from the T0 there is, or seconds in the file), put where the
  next click on a plot is, set at the cursor, the window's start, or an event, or its
  line dragged. The window's inputs take the same, as the axis reads. Its layout is plain
  JSON (`layout.ts`): each browser keeps its layout per dataset, and a saved view keeps
  one for everyone, listed on its datasets' pages; anyone can open one and save their
  changes as a view of their own. Views name channels by name, so a view opens with
  another test's data.
- **Labels** belong to a plot: words, and an arrow to a point in the data (a time and a
  value on one axis, snapped to the nearest channel where it was clicked). The box sits
  an offset in pixels from that point, kept inside the plot, so it stays readable at any
  zoom. Dragging the box moves it; dragging the arrow's tip points it elsewhere, leaving
  the box where it is. They're drawn on the plot's canvas, so the PNG has them, and the
  plot remembers where it drew them to know what a click or a drag is on.
- **Measuring** is two clicks on a plot: each point snaps to the nearest channel where it
  was clicked, and the second, if the first was on a channel, to that channel at its
  time. It reads the time between them and, when both are on one axis, the change and
  the slope per second, drawn on the plot's canvas like a label (so the PNG has it).
  Layouts and views don't keep it.
- **Calculated channels** (`yorg_formulas`) are the team's: a name, a unit, and an
  expression over channels by name, like `[LC-1] + [LC-2]` or
  `where([FM-FU] > 0.05, [FM-OX] / [FM-FU])` (O/F while fuel flows). Each shows in every
  dataset that has the channels it uses, and plots like a channel. The server keeps the
  text; the browser reads and works it out (`formula.ts`) from the channels' arrays, on
  the times of the channel with the most samples, reading the others between their
  samples (states hold) and leaving gaps outside them and where a division is by zero.
  Besides arithmetic, comparisons, and math functions, it has what test data needs:
  `where`/`if`, `and`/`or`/`not`/`between` for tests (missing only where a missing
  sample would decide it), `min`/`max`/`avg` that skip missing samples (redundant sensors),
  `ddt` (per second), `integral` (total impulse), and `smooth(x, seconds)`. The editor
  checks an expression as it's typed and tries it on the dataset, showing its range.
  Whoever made one (or an admin) changes or deletes it.
- **Masks** belong to a layout: a name, a color, and a test written like a calculated
  channel (`[MOV-OX] == 1`, `[PT-CHAMBER] > 450`, `and(...)`, `between(x, low, high)`),
  which holds where it isn't 0 and isn't missing. The editor puts a test together from a
  channel, a comparison, and a value (a state's by its name), and says how often and how
  long it holds. Its runs (`masks.ts`: from the first sample that holds to the last, ended
  by a pause in logging) are worked out once per dataset and test, like a calculated
  channel. A mask can shade the plots where it holds (the first dataset's runs, under the
  data) and hide data where it doesn't: each series keeps only its samples inside its own
  dataset's runs (so compared tests are masked by their own valves), which the axes fit,
  the cursor reads, and the CSV export writes. Views keep masks by channel name, so a view
  masks another test's data the same way.
- **Splitting a file into its tests** makes a dataset of each test in it. The browser
  finds them: where a mask holds (runs closer than a gap joined into one test, runs
  shorter than a minimum left out, each padded by seconds before and after), and cut at
  times typed or at the markers; each counts its time from where its mask starts holding
  in it (the valve opening), from its start, or as in the file. The server
  (`yorg/pieces.py`) copies each span's samples out of the file's arrays, with times from
  that zero (a dated file's start moves with it, so clock times stay), into new datasets:
  channels without a sample in the span are left out (and said so), events come along,
  and statistics are worked out again. All or none: a span with no samples makes nothing.
  A piece says where it came from (`read_info.split_from`), and, having no file of its
  own, isn't read again: its dataset is, and split again. Pieces go in a new folder next
  to the file (or another folder), and are whoever split them's.
- **System models** (the dev page, `/yorg/dev`, admins only while it's tried out): a
  feed system as a P&ID, simulated with FullFlow (a network solver) and ThermoProp
  (fluid properties) against a test, to tune it until it matches. `yorg/system/catalog.py`
  lists the parts, their settings (SI units; some only when others are set a way, as an
  ullage's wall only with wall heat transfer), links (followed, starting the model, compared,
  or commanding a valve), and outputs; the web app draws its editor from it
  (`web/src/yorg/dev`) and `spec.py` checks a model with it (saving takes a half-drawn one;
  running needs liquid parts between tanks, junctions, and outlets and gas parts between
  gas supplies, gas junctions, tanks' ullages, and outlets; every connected set of liquid
  parts reaching a tank, whose liquid it carries, and every set of gas parts a supply or an
  ullage, of one gas). A part renamed (the press line, now a gas valve) is read under its
  new name. A run is a process of its own (`runner.py`, stopped after 10 minutes; two at a
  time, a new one of yours replacing the last), so a long simulation never slows the site:
  the server cuts the channels the model uses (valve commands, what it follows, what starts
  it) to the run's window, in SI units by their unit (`channels.py`), and the page asks how
  it's going. `network.py` builds the FullFlow network: a fixed tank, supply, or outlet is a
  pressure that follows its channel (a `Sequence`); lines are `DarcyWeisbach` (fittings' K
  folded into f); valves and orifices are a CdA law smoothed near zero flow
  (`components.py`: plain square roots leave a node between a closed valve and an orifice
  hard to solve), venturis FullFlow's `CavitatingVenturi` smoothed the same way (and made
  continuous where it starts to cavitate, its noncavitating Cd the cavitating one over
  sqrt(1 - R)); gas valves and orifices are an ideal-gas orifice, choked or not, taking the
  temperature of where they flow from; a regulator is such an orifice whose opening
  (`Regulator`: fully open at its droop below set pressure, on the pressure where it flows
  to, reached as a first-order lag of its response time) is a state FullFlow solves in each
  step: FullFlow's `PID` and `Actuator` move once a step, on the last step's pressure, a step
  behind the little volume of tubing after a regulator. A gas junction's small volume makes
  a run several times slower (SciPy creeps through each step's last digits), so leave one
  out where no sensor or branch needs it. Liquid junctions balance their flows in kg/s. Gas
  junctions and wall-heated ullages are FullFlow `Volume`s of ideal gas (density,
  internal energy, and enthalpy derived from pressure and temperature, which FullFlow
  iterates while it keeps mass and energy), with gas flowing in bringing the enthalpy of
  where it came from; a wall-heated ullage trades heat with a `Solid` (the tank wall) by
  `Convection`, and its liquid is kept by `LiquidStore`, the ullage's volume a stored
  state for the gas's boundary work. An exponent-heated ullage keeps p = p0 (rho /
  rho0)^n (`UllageTank`). Pressurant flowing into either is divided by the collapse
  factor. Commands step between 0 and 1 (by the command's open and closed values) and a
  rate limit opens a valve over its opening time. Liquids are ThermoProp's at the tank's
  temperature, or, linked to a channel, tabulated over the temperatures it reads and
  following it through the run (density and vapor pressure); a custom one has its
  density and vapor pressure given. What starts from a channel (an ullage's pressure and
  temperatures, a gas junction's) takes its value at the run's start, and the result says
  what it took. All the outputs go to one `Recorder` component's exports, and components
  are added in the order values flow, so FullFlow's settling needs one pass per trial:
  together several times faster than a probe for each output and its default passes.
  FullFlow's transient solver runs with two-point Jacobians and 1e-8 tolerances; results
  come back at up to 2,000 points. A **fit** (`fit.py`, the same kind of process, stopped
  after 30 minutes with the best it found) is SciPy's least squares over the knobs picked,
  each on a 0-to-1 scale (a positive one as its logarithm over 1/30 to 30 times its start,
  within its limits), each try a run of the model; each compared channel (averaged down
  to 300 points) counts the same, its errors over its swing. The page shows a fit's best
  run, and applies what it found only when asked. The browser compares each sensor with
  its output in the model's units (`units.ts`, like `channels.py`) and says the RMS and
  bias; the window's times, and the plots', read from the dataset's T0 in this browser.
  Saved models are JSON files in `CVC_YORG_DIR/models`, so the dev page adds no tables.
  FullFlow, ThermoProp, and FullPlot are GPL-3.0: fine for the team's own server, but if
  Vault is ever given to others, the GPL applies to it.
- **Scripts** (the Python window, `/yorg/dev/scripts`, admins only while it's tried out):
  Python runs in the browser, never on the server: Pyodide (CPython in WebAssembly, pinned
  in `web/src/yorg/scripts/worker.js`, from jsDelivr), in a module worker started from a
  `data:` URL inside an iframe sandboxed to scripts alone (Pyodide 314 runs only in module
  workers, and a sandboxed frame can't start one from a blob). The frame's origin is its
  own, so a script, whoever wrote or uploaded it, can't reach the site, its API, or the
  session: it gets only what it asks the page for in messages (`sandbox.ts` answers
  read-only: the list of tests, a channel's samples, from the same store the plots use).
  Before a script runs, the page loads the picked test's channels it names in quotes, so
  `yorg.channel("PT-TANK")` needs no `await`; others come with `await yorg.load(...)`. The
  `yorg` module (`yorg.py`, sent to the worker as text) gives channels as NumPy arrays with
  their units (`Channel.si()` for SI), and sends plots (drawn with Yorg's `Plot`),
  matplotlib figures (as PNGs), and files to save back to the page. Pyodide's own packages
  (NumPy, SciPy, pandas, matplotlib, CoolProp, ...) load from the imports a script has.
  Stopping a script ends the worker; Python starts again for the next. Scripts are JSON
  files in `CVC_YORG_DIR/scripts` (`yorg/saved.py`, as system models are): a name, a
  folder path, and the code. REFPROP isn't there: it needs NIST's license, and would run
  on the server behind a property API.
- **Menus** (all of the app's, through `usePopover`) are fixed to the window where their
  button is, and moved or flipped to stay whole on screen, so neither a window edge nor
  a scrolling area cuts them off.

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
| `POST /api/delete` | to the trash `{files, folders, force}`: folders go with everything in them |
| `POST /api/files/{id}/restore`, `POST /api/folders/{id}/restore` | bring a file or folder back |
| `POST /api/move`, `POST /api/rename` | move files and folders `{files, folders, to}`; rename one `{file or folder, name}` |
| `GET /api/checkouts?mine=` | who has what checked out |
| `GET /api/sync?since=` | changes since a cursor, for clients |
| `GET /api/activity?before=&file_id=` | activity log, newest first |
| `GET/PUT /api/grants?path=` | who has access to a folder; change it |
| `GET/POST /api/users`, `PATCH /api/users/{id}` | accounts: invite, approve, disable (admins) |
| `GET/PATCH /api/settings` | the whitelist `{whitelist}`: on, new people need an invite or approval; turning it off approves everyone waiting (admins) |
| `GET /api/tokens`, `DELETE /api/tokens/{id}` | your signed-in browsers and clients |
| `GET /api/downloads`, `GET /api/downloads/{name}` | software to download (the add-in's installer), from `CVC_DOWNLOADS_DIR` |
| `GET /api/yorg/datasets?deleted=` | Yorg's datasets, newest first (or the deleted ones) |
| `POST /api/yorg/datasets?filename=&name=&description=&folder=` | upload a file of test data (the raw body) into a folder (or the top) and read it; one that can't be read comes back `failed`, with why |
| `POST /api/yorg/datasets/move` | move datasets `{datasets, folder_id}` into a folder (null: the top); all or none |
| `GET`/`POST /api/yorg/folders`, `PATCH`/`DELETE /api/yorg/folders/{id}` | folders of datasets `{name, parent_id}`; rename or move one; delete an empty one |
| `GET`/`PATCH`/`DELETE /api/yorg/datasets/{id}` | a dataset with its channels, events, and how it was read; rename it; delete it (restorable) |
| `POST /api/yorg/datasets/{id}/read`, `/restore` | read its file again another way `{time_column, time_format, sample_rate, header_row, delimiter}`; restore it |
| `POST /api/yorg/datasets/{id}/split` | make datasets of spans of it `{pieces: [{name, start, end, zero}], folder_id}`, all or none (422 if a span has no samples) |
| `GET /api/yorg/datasets/{id}/source`, `/data/{version}/{file}` | the file as uploaded; one of a read's arrays (little-endian float64) |
| `GET`/`POST /api/yorg/views`, `GET`/`PUT`/`DELETE /api/yorg/views/{id}` | saved plot layouts `{name, description, datasets, config}` |
| `GET`/`POST /api/yorg/formulas`, `PUT`/`DELETE /api/yorg/formulas/{id}` | calculated channels `{name, expression, unit, description}`; names are unique, whatever their case |

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
   `server/.env.example`). Sign-up starts open: anyone with a Google account can join
   until an admin turns on the whitelist (Admin > People).
3. Keep `CVC_DATABASE_URL` (SQLite by default), `CVC_BLOB_DIR`, and `CVC_YORG_DIR`
   (Yorg's uploads and arrays) on a persistent disk, and back them up. An S3/R2 blob
   store (Cloudflare R2: 10 GB free, no download fees) is planned.
4. Put CI's `Vault-Setup.exe` (and `cvc.exe`, if you like) in a folder and point
   `CVC_DOWNLOADS_DIR` at it: members get them from the web app's SolidWorks page.

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
7. **Yorg** (first version done, September 2026): upload, read, plot (an axis per
   unit), compare, views, exports, calculated channels, folders, labels, measuring,
   masks, splitting files into their tests, time from T0 or of day (UTC or local), and a
   Help page (`Help.tsx`, `/yorg/help`: keep it in step with the features). Next:
   statistics over a selected span (and over each test, from its mask),
   reading while the file is still uploading for very big files, and data streamed live
   from the test stand.

## Open questions

- Hosting: Render, a VPS, or a campus machine (decide at deploy time).
- Sign-up: open to any Google account for now (September 2026). Later: turn the whitelist
  on, or let in only the school's Google accounts?
- SolidWorks version: 2025 (decided September 2026). The add-in targets API version 33.
- Kenesto: the plan is to import the current files from a synced Kenesto folder
  and keep Kenesto read-only as the archive of old history.
