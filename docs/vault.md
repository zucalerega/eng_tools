# Vault design

Vault keeps the team's SolidWorks and STEP files in one vault, with check-out/check-in
locking, full version history, and per-folder permissions. It replaces Kenesto. It's one of
the two apps on the team's site, beside Yorg: [design.md](design.md) has what they share
(the server, sign-in and accounts, the web app's frame) and the site's conventions. This
page is Vault's own.

## Parts

| Part | Where |
|---|---|
| On the server: every operation (`vault.py`), the folder tree and permissions (`access.py`), path rules (`paths.py`), file contents (`storage.py`), tables, routes | `server/src/yjsp_server/vault` |
| In the web app: its pages, and the vault's index (`store.ts`) | `web/src/vault` |
| The workspace library | `client/src/Vault.Client` (netstandard2.0 + net10.0) |
| The `vault` command | `client/src/Vault.Cli` (.NET 10) |
| The SolidWorks 2025 add-in, and `vault-open.exe`, which follows the web app's links into it | `client/src/Vault.SolidWorks`, `client/src/Vault.SolidWorks.Open` (.NET Framework 4.8) |
| `Vault-Setup.exe`, the add-in's installer | `client/src/Vault.Setup` |

The add-in has to be .NET Framework, because SolidWorks add-ins are .NET Framework COM
components. The workspace logic lives in a netstandard2.0 library so the add-in and the CLI
share it, and it can be developed and tested without SolidWorks, through the CLI.

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
- **Cheap, and easy to hand over.** It runs in the site's one small server. A student can
  read Vault's part of it in an afternoon.

## Not doing (for now)

- Approval workflows, change orders, BOMs, ERP integration (Teamcenter territory).
- Merging or diffing CAD files.
- Checking in while offline.
- Renaming or moving a file that other files reference. SolidWorks stores
  references as file paths, so SolidWorks itself has to rewrite the parent
  files. This will come later, through the add-in.

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
access can restore from, with full history. Vault refuses to delete a file that the
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
(`Workspace.UpdateAsync`: the add-in's Update my files, `vault get` with no paths) brings
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

`Vault.Client` implements the workspace. The `vault` CLI and the add-in are thin layers
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
- **Local state.** `.vault/state.json` records the sync cursor, the vault's files (with
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
  `.vault/backup/<time>/`. Downloads are verified by SHA-256 and moved into place, so
  an interrupted download changes nothing. Undoing a check-out puts the vault's
  version back before it releases the lock, so a file that can't be replaced (it's
  open in SolidWorks) stays checked out to you.
- **Checking out updates first.** Checking out a file whose local copy is out of date
  downloads the latest version. A conflict has to be resolved before checking out.
- **Taking over** (`vault checkout --force`, the add-in's Take over): a check-out on
  another computer, yours or, for leads and admins, someone else's. The workspace knows
  your role in each folder from the sync feed, so the add-in only offers it where the
  server will allow it. When someone whose check-out was released or taken over tries
  to check in, they're told who did it and when (from the activity log), and that their
  changes are still on their computer.
- **Some files are never added:** `~$*` (SolidWorks lock files), `*.tmp`,
  `Thumbs.db`, `desktop.ini`, `.DS_Store`, and downloads still under way
  (`*.vault-download`, or `*.cvc-download` from before 0.4.0).
- **Saved sign-ins:** `%APPDATA%\Vault\tokens.json`, encrypted with Windows DPAPI.
  Elsewhere, `~/.config/vault/tokens.json`, readable only by its owner.
- **From before 0.4.0** (when it was CVC): opening a workspace renames its `.cvc` folder to
  `.vault`, backups and all, and sign-ins saved in `%APPDATA%\CVC` (or `~/.config/cvc`) are
  read from there when there are none in the new place (design.md, "Names from before YJSP").
- **Assemblies:** the add-in asks SolidWorks for an assembly's references
  (`GetDocumentDependencies2`). Referenced files that are new, or checked out to you with
  changes, go into the same check-in. Every reference is pinned to the version this
  workspace has, which is the one the assembly was built against. References outside the
  workspace, such as a Toolbox part in `C:\SOLIDWORKS Data`, are refused with a message
  saying to move them in first. The CLI can't read SolidWorks files, so it doesn't send
  references, and the server refuses drawings from it (a drawing must show a part or
  assembly).

## The SolidWorks add-in

`client/src/Vault.SolidWorks` targets SolidWorks 2025 (API version 33) and is built
against the `Visiativ.SOLIDWORKS.Interop` 33.0.0 package. It is a .NET Framework 4.8
COM add-in, registered with RegAsm.

- **Installing.** `Vault-Setup.exe` (`client/src/Vault.Setup`, built by CI) is the one
  download: it carries the add-in's files, and after Windows asks for administrator
  rights, puts them in `C:\Program Files\Vault for SolidWorks`, registers the add-in
  (RegAsm, which runs its own registration with SolidWorks) and `vault://` links (and
  `cvc://`, which the web app still makes for older add-ins), and lists itself in Windows'
  installed apps to remove all that again. Over a version from before 0.4.0, it first
  unregisters that one and deletes its `Cvc.*` files. It isn't signed yet, so Windows'
  SmartScreen warns about it once. The server offers it to members from
  `YJSP_DOWNLOADS_DIR` (`GET /api/downloads`), on the web app's SolidWorks page, whose
  Connect SolidWorks button (a `connect` link) has the add-in sign in to that vault.
  `install.ps1` does the same by hand, from wherever the add-in is (for development).

- **Task pane.** Everything is in the Vault tab: sign-in, the active document's status
  and actions (including opening its drawing), and two views: the files that need
  attention, and Browse, the whole vault as a tree (`Workspace.BrowseAsync`, a
  `VaultTree`) in which every file says whether it's checked in, assemblies open up into
  their parts, and parts and assemblies list their drawings. It refreshes every 20
  seconds and after every action, and redraws only when something changed, so what you
  opened in the tree stays open.
- **Offering a check-out.** When you start editing the active document and it isn't
  checked out to you, the add-in offers to check it out. It asks once per document per
  session, and ignores the changes SolidWorks makes while opening a file. Saving such a
  file offers the check-out too. The file is read-only, so SolidWorks turns Save into
  Save As (without the `FileSaveNotify` event): before the dialog opens
  (`FileSaveAsNotify2`), the add-in checks the file out and saves it in place
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
- **Links from the web app.** "Open in SolidWorks" is a `vault://open?server=…&path=…`
  link (`OpenLink`; the web app makes them `cvc://` until every laptop has 0.4.0, and
  both work). Setup (or install.ps1) registers `vault-open.exe`, in the add-in's folder,
  for them. It starts SolidWorks if needed and hands the link to the add-in over a named
  pipe for the Windows session, which only the current user can open. The add-in checks
  that the link is for its workspace's server, gets the file's latest version and the
  parts it uses (updating open copies in place), opens it, and comes to the front.
- **New files from the web app.** New part, New assembly, and New drawing (of a part or
  assembly) are `vault://new?server=…&path=…[&model=…]` links. The add-in checks that the
  name is free and that you can add files there (`Workspace.CheckNewFileAsync`); for a
  drawing, gets the model and the parts it uses; starts the file from SolidWorks' default
  template for its type (a drawing with an isometric view of the model); saves it; and
  checks it in at once as version 1, kept checked out to you, so everyone sees it and
  the name is taken. Changes to the model that you haven't checked in stay out of that
  check-in.

## In the web app

Vault's pages (`web/src/vault`) are the site's own paths, `/` and the rest, in the frame
the site gives both apps (design.md, "The web app").

- **A live copy of the vault index** (`store.ts`). It loads everything you can see from the
  sync feed (`GET /api/sync`, as the clients do) when a page of the vault first shows, and
  asks it for changes every few seconds while one is open and visible, so browsing and
  searching need no more requests, and check-ins and check-outs on anyone's PC show up
  within seconds. Yorg's pages don't load it.
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
- **Open in SolidWorks** is a link for the add-in (`solidWorksLink` in `components.tsx`),
  which its installer registers on Windows PCs.
- **Its mark** is a vault door crossed by a gold orbit, after the team's logo
  (`VaultMark`); the tab's icon on its pages, and the add-in's task pane icon, draw the
  same shapes.
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
  a drawing named after its model), then links to SolidWorks (a `new` link), which makes
  it on this computer. It shows up in the vault a few seconds later, checked out to you.

## API

Vault's endpoints. Every one needs sign-in; how errors look, and the site's own endpoints,
are in [design.md](design.md#api).

| Endpoint | Purpose |
|---|---|
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

## Roadmap

1. **Server core** (done): folders, check-out/check-in with references, history,
   trash, permissions, Google and client sign-in, sync feed, activity log.
2. **Client library + `vault` CLI** (done): workspace, status, get latest, check
   out/in, undo with backups, history, locks, browser sign-in. Tested against the
   real server.
3. **SolidWorks 2025 add-in** (done; first run in SolidWorks in September 2026): task
   pane with status and actions, check-out offers when you edit, save checks, and
   check-ins that include an assembly's references.
4. **Web app** (done): browse and search, history, download, who-has-what, activity,
   admin (approvals, permissions), admin mode (releasing check-outs, forced reverts),
   and opening files in SolidWorks.
5. **Moving in** (to do): the current files imported from Kenesto, and the blobs in an
   R2 store, with backups off the host (design.md, "Storage").
6. **Later**: thumbnails and a 3D STEP preview in the browser, check-in
   notifications to team chat, released revisions (A, B, C) for flight hardware,
   and rename/move with reference repair.

## Open questions

- SolidWorks version: 2025 (decided September 2026). The add-in targets API version 33.
- Kenesto: the plan is to import the current files from a synced Kenesto folder
  and keep Kenesto read-only as the archive of old history.
