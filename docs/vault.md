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
| Caliper, the 3D viewer: in the web app, and its models on the server (`caliper.py`, the mesh format; `solidworks.py`, reading SolidWorks files' 3D view) | `web/src/vault/caliper`, `server/src/yjsp_server/vault` |
| The workspace library | `client/src/Vault.Client` (netstandard2.0 + net10.0) |
| The `vault` command | `client/src/Vault.Cli` (.NET 10) |
| The SolidWorks 2026 add-in, and `vault-open.exe`, which follows the web app's links into it | `client/src/Vault.SolidWorks`, `client/src/Vault.SolidWorks.Open` (.NET Framework 4.8) |
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
- **See it without SolidWorks.** Caliper shows any part or assembly in 3D in the browser,
  to turn, cut, and measure, on any computer.
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
   model. Each one must already be in the vault, where you can see it, or be part
   of this check-in, and is recorded with the version it used. That's how "where
   used" works, and later "get this assembly as it was at version 5".
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
versions; history stays on the server. Updating (`Workspace.UpdateAsync`: the add-in's
Update downloaded files, `vault get` with no paths) brings the files that are here up to
date, with any parts they've started to use, and nothing else. Downloading everything, or
a folder's files that aren't here yet, is its own step, and the add-in says how many
files and how much space first (`SizeOfGetAsync`), and asks, with No as the default.
Freeing up space (`Workspace.FreeUpAsync`: the add-in's Free up space, `vault free`) goes
the other way: it removes the copies here of files that are just as they came, at any
version, and not checked out to you, so nothing is lost, and they're not downloaded again
until someone opens or gets them. The add-in keeps what SolidWorks has open, and every file
that uses, and asks first; it never frees anything by itself, since freed files need a
connection to come back.

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

Using and adding files answer the same way, as if what you can't see weren't there. A
check-in that uses a file you can't see is missing a reference (`missing_references`), at
any version. Making a folder or checking in a file where one you can't see is, or putting
anything in a folder you can't see, is refused as it would be where nothing is: you can't
add anything there (if you could, you'd see what's in it), so it's never "exists". Where
files you can't see are why something can't be done, as when they use a file you're
deleting or moving, they're counted but not named: "Still used by Rocket.SLDASM and 2
files you can't see".

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
- **Every permission check goes through `access.Access`.** What the user can't see
  answers as what isn't there (see "Permissions"): `vault._find` finds files, and
  `Access.deepest` folders, as they see them.
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
  SolidWorks keeps in it (`GetDocumentDependencies2`, not searching), level by level, each
  level once it's here (`Workspace.GetUsedFilesAsync`), and `Workspace.FindUsedFiles` takes
  each to the vault file whose path ends the same way, with the most folders matching (none
  if two match as well); those come down with it, and kept paths nothing matches are
  listed. A file placed with 3D Interconnect (a STEP file, say) is kept as the document
  SolidWorks made of it in its temporary folder (`...\IC~~\BMS.step.SLDASM`), never on disk,
  so where no vault file has that name, it means the vault file of the name it was made
  from (`BMS.step`): of several, the one whose folders, from the top, are most like those
  of the file that uses it (none if two are as like). The file itself keeps the STEP file's
  path too (`swImportedPath`, which the server reads), but `GetDocumentDependencies2` gives
  only the document's, and the add-in reads what files use before they're open. Opening a
  file that's here goes through every level too, since a sub-assembly
  that's here can be missing its parts, and it waits for a refresh that's running rather
  than skip the check. When SolidWorks can't find a file anyway, the add-in's
  `ReferenceNotFoundNotify` handler points it at the vault file that match means, if it's
  here, or else at the file here at the longest end of the path
  (`Workspace.LocalFileFor`). Checking such an assembly in from SolidWorks records its
  references (see "A check-in of unchanged contents" above); one that uses files the vault
  can't have (missing, or outside the workspace) names them all at once, and nothing is
  checked in.
- **Read-only unless checked out.** Files you don't have checked out are read-only
  on disk, so SolidWorks opens them read-only. Checking out makes a file writable;
  checking in or undoing makes it read-only again.
- **Paths from the server are checked** before anything is done with them, since a
  server that isn't working right, or isn't the team's, mustn't be able to have a client
  write, move, or delete anything outside its workspace. `Workspace.ToLocalPath` takes a
  path only as the server writes them (`VaultPaths.SplitServerPath`: names joined by `/`,
  each one the vault allows, so no `..`, drive, device, or stream), only inside the
  workspace, and never in its own `.vault` folder (or `VAULT~1`, its short name on Windows).
  An answer with a bad path (the sync feed, or a check-out's or check-in's) is refused
  whole, before anything in it is kept, with an error saying the server sent a bad path;
  paths a workspace kept from before are checked as it opens, and forgotten if they're bad.
  Paths over 200 characters are taken: the server's own moves and restores can make them
  (a folder moved with empty folders deep in it, a file restored into a folder renamed
  longer since). A download never replaces a file the workspace didn't know was there (a
  path sent for two files, or another file's short name on Windows) unless it's the
  vault's version already.
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
  downloads the latest version. A conflict has to be settled before checking out.
- **Settling a conflict** (`vault resolve --mine` or `--vault`; the add-in's Keep mine and
  Use the vault's version): keeping yours checks the file out and records the copy as a
  change to the latest version, without downloading anything, so checking it in makes the
  next version on top of the latest, which stays in the history. Taking the vault's backs
  yours up and downloads the latest. Either acts only on files in conflict, and naming one
  that isn't is refused. A copy that didn't come from the vault (put there by hand, or from
  a workspace whose state is gone) is in conflict when it differs from the latest version,
  and settles the same way.
- **Taking over** (`vault checkout --force`, the add-in's Take over): a check-out on
  another computer, yours or, for leads and admins, someone else's. The workspace knows
  your role in each folder from the sync feed, so the add-in only offers it where the
  server will allow it. When someone whose check-out was released or taken over tries
  to check in, they're told who did it and when (from the activity log), and that their
  changes are still on their computer.
- **Some files are never added:** `~$*` (SolidWorks lock files), `*.tmp`,
  `Thumbs.db`, `desktop.ini`, `.DS_Store`, and downloads still under way
  (`*.vault-download`).
- **Saved sign-ins:** `%APPDATA%\Vault\tokens.json`, encrypted with Windows DPAPI.
  Elsewhere, `~/.config/vault/tokens.json`, readable only by its owner.
- **Assemblies:** the add-in asks SolidWorks for an assembly's references
  (`GetDocumentDependencies2`). Referenced files that are new, or checked out to you with
  changes, go into the same check-in. Every reference is pinned to the version this
  workspace has, which is the one the assembly was built against. References outside the
  workspace, such as a Toolbox part in `C:\SOLIDWORKS Data`, are refused with a message
  saying to move them in first. The CLI can't read SolidWorks files, so it doesn't send
  references, and the server refuses drawings from it (a drawing must show a part or
  assembly).

## The SolidWorks add-in

`client/src/Vault.SolidWorks` is for SolidWorks 2026, the team's, and runs in SolidWorks
2025 too, for laptops still moving over: it's built against the 2025 API (version 33, the
`Visiativ.SOLIDWORKS.Interop` 33.0.0 package), which SolidWorks 2026 runs, so one build
serves both. It is a .NET Framework 4.8 COM add-in, registered with RegAsm. Its log says
which SolidWorks loaded it (`RevisionNumber`: 34 for 2026, 33 for 2025).

- **Installing.** `Vault-Setup.exe` (`client/src/Vault.Setup`, built by CI) is the one
  download: it carries the add-in's files, and after Windows asks for administrator
  rights, puts them in `C:\Program Files\Vault for SolidWorks`, registers the add-in
  (RegAsm, which runs its own registration with SolidWorks) and `vault://` links, and
  lists itself in Windows' installed apps to remove all that again. It installs new only
  where SolidWorks 2026 is (files saved in 2026 don't open in older versions, so the team
  stays on one); where the add-in is already, it updates it, on 2025 too. It isn't signed
  for Windows (Authenticode) yet, so Windows' SmartScreen warns about it once; the
  signature its updates are checked with is Vault's own (see Updates). The server offers it
  to members from `YJSP_DOWNLOADS_DIR` (`GET /api/downloads`), on the web app's SolidWorks
  page, whose Connect SolidWorks button (a `connect` link) has the add-in sign in to that
  vault.
  `install.ps1` does the same by hand, from wherever the add-in is (for development).
- **Updates.** Every few hours the add-in asks the server what it offers for download
  (`GET /api/downloads`, which reads each program's version from its version resource and
  gives each file's SHA-256). When `Vault-Setup.exe` installs a newer version than the
  add-in's own (`AddInUpdate.Newer`), Update appears in the task pane's header. It downloads
  setup and checks it (`AddInUpdate.DownloadAsync`): its size and SHA-256 against what was
  offered; its signature, `Vault-Setup.exe.sig` beside it in the downloads (served, not
  listed), against the public key the add-in carries, so that only the holder of the
  private key, which CI signs `main`'s and release tags' builds with, can put a program on
  the team's laptops, not the server or whoever has it (deploying.md, "Signing key"); and
  its own version, read from it as the server reads it, against the one it was offered as,
  so an older signed release can't come back as a newer one. Only then does it start it
  with `/update`; anything amiss means no update, and the tab and the log say why.
  Windows asks for administrator rights, and setup waits for SolidWorks to close in that
  Windows session, which has the add-in loaded, then installs, keeping sign-in, settings,
  and workspaces. Add-ins before Update (0.4.0 and older) have none: run setup by hand
  once. Add-ins up to 0.5.2 don't check signatures.

- **Task pane.** Everything is in the Vault tab: sign-in; a header with your account's
  menu (the vault, the workspace, the web app, sign out); a card for the active document,
  with its status and buttons for only what you can do with it now, the likeliest in navy;
  and two views: the files on this computer that need attention, and Browse, the whole
  vault as a tree (`Workspace.BrowseAsync`, a `VaultTree`) in which assemblies open up
  into their parts, and parts and assemblies list their drawings. One wording and color for
  each status serves the card, the list, and the tree (`VaultPane.Describe`); the look is
  in `Theme.cs` and `PaneControls.cs` (flat WinForms controls, and File Explorer's theme for
  the list and tree), drawn without image files, at 96 DPI and scaled. It refreshes every
  20 seconds and after every action, and redraws only when something changed, so what you
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
- **Inserting from the vault.** Insert into (the active assembly), on a part's or an
  assembly's right-click menu in the task pane, gets its latest version and the parts it
  uses, as Get latest does, then adds it to the assembly (`AddComponent5`, which takes only
  documents SolidWorks has open, so the file is opened without a window and closed again),
  beside the assembly's bounding box, selected. That's how a file that isn't here yet goes
  into an assembly in one step: SolidWorks' own Insert Components only sees files on disk.
- **Sharing with the CLI.** The add-in shares the workspace and the saved sign-in with
  the CLI.
- **Links from the web app.** "Open in SolidWorks" is a `vault://open?server=…&path=…`
  link (`OpenLink`). Setup (or install.ps1) registers `vault-open.exe`, in the add-in's
  folder, for them. It starts SolidWorks if needed and hands the link to the add-in over a named
  pipe for the Windows session, which only the current user can open. The add-in checks
  that the link is for its workspace's server, gets the file's latest version and the
  parts it uses (updating open copies in place), opens it, and comes to the front.
  Once the browser hands the link over, every way that can fail says why (before, an
  unregistered link does nothing, and only the help can say so). Before the add-in has the
  link, `vault-open.exe` says it, in a message kept on top (it isn't the window in front once it has started
  SolidWorks): no SolidWorks, the add-in not answering, or busy with an earlier link (its
  pipe is there, taking one link at a time). The add-in answers a link it won't follow
  (another vault's, not signed in), which `vault-open.exe` shows; once it follows one, the
  Vault tab comes to the front and the open runs like any of its operations, problems in a
  message there: why the file isn't here after getting it (`Workspace.WhyNotHere`: not in
  the vault, or its download failed, and why), or why SolidWorks didn't open it (its
  `OpenDoc6` error, in words). Both write a line for each link, and its outcome, to
  `addin.log`.
- **Connecting from the web app.** Connect SolidWorks is a `vault://connect?server=…` link,
  and any web page can make one, so it doesn't decide where you sign in on its own. Signed
  out, the add-in signs in to the server it's set up for (its workspace's, or the one it
  last signed in to) without asking, and asks first, showing the address, for any other,
  or for any at all before it's set up (`OpenLink.ConnectQuestion`). The address it shows
  is the server's as it really is (`OpenLink.Address`: punycode for a name in other
  alphabets), and a link whose server has a user name, query, or fragment in it is
  refused. An open or new link for a server it isn't set up for doesn't fill in the
  sign-in box: it says to connect from that vault's SolidWorks page.
- **New files from the web app.** New part, New assembly, and New drawing (of a part or
  assembly) are `vault://new?server=…&path=…[&model=…]` links. The add-in checks that the
  name is free and that you can add files there (`Workspace.CheckNewFileAsync`); for a
  drawing, gets the model and the parts it uses; starts the file from SolidWorks' default
  template for its type (a drawing with an isometric view of the model); saves it; and
  checks it in at once as version 1, kept checked out to you, so everyone sees it and
  the name is taken. Changes to the model that you haven't checked in stay out of that
  check-in.
- **3D views for Caliper.** After a check-in, the add-in makes the 3D models (see
  "Caliper") of each checked-in part or assembly that SolidWorks has open, and of the parts
  and rigid sub-assemblies it uses that have none, each of the vault version that's here
  (`CaliperModels` in Vault.Client: it asks the server which are missing, then saves those).
  Make 3D view does it for the active document. SolidWorks gives what it draws (each face's
  display triangles, `IFace2.GetTessTriangles`; a component's bodies come in its part's
  coordinates, in the configuration it uses) and where each component is (`Transform2`,
  relative to the top assembly; a sub-assembly's own model has them relative to it). A part
  with unsaved changes, or loaded lightweight (its bodies aren't), gets no model, and the
  tab says so; making models never undoes the check-in before it.

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
  - Caliper: a part, an assembly, or a STEP or IGES file in 3D (see "Caliper"), from Open
    in Caliper, beside Open in SolidWorks on a file's page and in folders.
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

## Caliper: 3D in the browser

Caliper (`web/src/vault/caliper`, at `/vault/caliper/<file id>?version=&configuration=`)
shows a part or assembly in 3D, to look at and measure, not to change: like SpaceX's
TotalView, on any computer, without SolidWorks. It draws with WebGL (three.js), and loads
only when a file is opened in it.

- **Looking around**, as in a CAD program: drag to turn it about the point under the mouse,
  scroll to zoom where the mouse points, right-drag or shift-drag to pan, double-click a part
  to zoom to it; the standard views (front, top, right, isometric, ...), with SolidWorks' Y
  up; the axes in the corner (click one to look along it), and at the origin if you like;
  perspective or not (not, by default, as in SolidWorks).
- **Sections** across X, Y, and Z, each where you slide it and either way round. With two
  or three, what's past all of them is cut away, as a SolidWorks section view does, and
  where a plane cuts a solid it's filled in (stencil-buffer caps, `viewer.ts`).
- **Measuring** faces, edges, and corners. One shows what it is: a plane's area, a
  cylinder's or sphere's diameter, a cone's angle (a countersink's), an edge's length or a
  circle's diameter, a corner's coordinates. Two show what they are to each other: the
  distance between parallel faces, axes, or lines; between centers; from a point to a face;
  or the angle between them. Meshes have only triangles, but their vertices lie on the true
  surfaces, so fitting them (`geometry.ts`) gives exact sizes, to the float32 the meshes
  keep: a cylinder's area is the cylinder's, not its facets'. Faces and edges no fit
  explains get the closest their vertices come, marked as about. In mm, cm, m, inches, or
  feet; the document's own units first.
- **An assembly's components**, as a tree beside the view: show or hide each (hidden as
  SolidWorks had them, to start with), isolate one (show only it), or open one in its own
  Caliper page, at the version the assembly uses. A STEP file's products are its tree, and
  open where they are.

Where the 3D comes from:

- **SolidWorks parts and assemblies** show a **3D model** of each version, in each
  configuration (`caliper_models`), which comes from one of two places:
  - Vault for SolidWorks makes one of each version it checks in (and of any it has open, on
    request), from what SolidWorks has open.
  - Otherwise, when Caliper opens a version that has none, the server reads one from the
    file itself (`POST /api/files/{id}/caliper/make`, `vault/solidworks.py`). SolidWorks
    saves the triangles it draws inside each part and assembly, which is how eDrawings
    shows files without SolidWorks (Document Properties > Image Quality > Save tessellation
    with part document, on by default).
    - **A part:** its bodies' triangles, names, and colors (and faces' own colors, where the
      file says which), and its units, in the configuration SolidWorks had open when it saved
      the file. That's the only configuration it keeps triangles of, and nearly always the
      only one it keeps a solid of (in the team's assemblies, every part used in another
      configuration had none), so a part used in another configuration shows once Make 3D
      view makes it.
    - **A part without a 3D view** (SolidWorks set not to save one, as vendors' parts often
      are), or with one the server can't follow, is read from its solid instead: SolidWorks
      keeps each configuration's bodies as Parasolid's, the geometry kernel it's built on,
      whose file format is published (`vault/parasolid.py`), and the server turns them into
      triangles of its own (`vault/brep.py`): it samples each edge once, so that its chords
      stray from it by no more than 0.05% of the part's size (measured across its vertices,
      or a tube's, which has none, across its circles), and the faces either side share its
      points; and it cuts each face into strips across its surface's parameters. Its bodies
      have the appearance its configuration keeps (`Contents/Config-N`), where it keeps just
      one: the part's, which SolidWorks shows over the colors Parasolid keeps of faces, often
      older ones. Faces of a color other than most of their body's keep theirs (an O-ring's
      black), and where the configuration keeps more appearances (its faces' too), the
      solid's colors stand. Of the team's 360 parts with both, 322 read this way are colored
      as their 3D views are (101 with Parasolid's colors alone). A part that's an import and
      nothing else (a vendor's fitting, an 80/20 extrusion) keeps its bodies with the import,
      which are the part's only if none of its features could make or change one: the server
      reads them only then. The 435 parts in the team's vault that have both a 3D view and a
      solid read this way agree with their 3D views within a percent in area and volume, and
      to a few microns in size (but for those whose 3D view shows something their solid
      hasn't, a cosmetic thread, say).
    - **An assembly:** its components, from the XML it keeps of each configuration: each
      component's file, configuration, and place, and whether SolidWorks hid or suppressed
      it. A flexible sub-assembly's instance has its own layout there, as flexed. Each
      configuration SolidWorks keeps up to date gets a model, the one it had open first; one
      it says needs rebuilding doesn't, as its places may be old. Its display list sometimes
      has each part's triangles as the assembly shows them, which the model then carries.
      From SolidWorks 2024 on it never does, and many older ones don't either, nor has every
      assembly a display list: each part then shows its own model, which Caliper has the
      server make from the part's file as the assembly loads. Where the display list puts a
      component somewhere the XML doesn't, the display list is the older (placed by the XML,
      the parts fill the box SolidWorks keeps for the assembly), so its triangles aren't
      used either; nor are triangles it doesn't say whose they are.
    - **Its parts' files:** the files its version references, matched by name; a version
      that references nothing (checked in from the web app, or brought over from Kenesto)
      has the vault's files with those names in folders of the names of the folders
      SolidWorks saved them in (a name alone, as STEP imports' SOLID-1, could be any file's):
      the one whose path ends most like the saved one, and none where two end alike, each at
      the version it had when the assembly's version was made, or its first. So they open on
      their own as usual. A STEP or IGES file placed in an assembly (SolidWorks' 3D
      Interconnect) is read in the browser, as the file on its own is (the server says which
      components are one, `format`), one at a time. SolidWorks keeps one as the document it
      made of it in its temporary folder (`...\IC~~\BMS.step.SLDASM`, with a document for
      each of the STEP file's own parts under it), with the STEP file's path
      (`swImportedPath`): that path is the component's, found as any other, and the
      documents under it aren't components of their own, unless the display list draws them.
    - **Parts kept inside an assembly** (virtual components, `virtual`), as SolidWorks
      Routing keeps its routes and their tubes: the assembly's file keeps each one's whole
      file (`VirtualComp/...`), and a virtual sub-assembly's file keeps its own in turn. A
      virtual part is read from its solid there, never its display list, which SolidWorks
      leaves as it was when the part was made: a routed tube's is the library tube's stub,
      12.7 mm long, while its solid follows the route. A sub-assembly that's a file of its
      own (a route saved as one) keeps its virtual parts in that file, which the server reads
      for them. Of the 479 virtual parts the team's assemblies keep, all but 28 read this
      way, and those 28 have empty solids (24 tubes, and 4 parts with nothing in them).
    - **What isn't shown:** parts that were never put in the vault; and virtual parts
      without a shape the server could read where they're kept, which Caliper says (Make 3D
      view makes them, where SolidWorks can build them).
    - **Reading improves, and models are read again.** Each model the server reads notes
      which release of its reader made it (`reader`, `solidworks.READER`, which goes up when
      what the server reads from a file changes). Once a newer one is out, an older one's
      models are read again as they're next wanted: a version with any isn't listed, nor is
      such a part's model counted as its own in an assembly, so Caliper has the server make
      them, which replaces them. Where the file can't be read now, the older model stays and
      comes back. Vault for SolidWorks' models (`reader` 0) are never replaced this way. For
      models made before the server noted it, the server tells by what they carry: it wrote a
      part's mesh if Python gzipped it (whose header names no operating system, where .NET's
      names one), and an assembly's components if none has a color of its own (only Vault for
      SolidWorks gives them one) or a shape .NET wrote.
    - **Files from SolidWorks 2014 and older** are OLE compound documents of the same streams,
      most of them packed (`__ZLB`), and the server reads those too; their units aren't
      saved where it reads them, so they start in mm.
    - **None of this is documented.** It was worked out from files saved by SolidWorks 2015 to
      2019, checked against their STL exports and the bounding boxes SolidWorks keeps; from
      the team's own files saved by SolidWorks 2024 to 2026 (whose faces have 32 more bytes),
      checked against the previews SolidWorks saves in them and, for assemblies, against
      where SolidWorks itself put every component, flexed ones too; and from SparkFun's files
      saved by 2014 or older, checked against their STL exports and the assembly's bounding
      box. So the server refuses (`unreadable_file`, saying why) whatever doesn't fit,
      rather than guess: a part saved without its triangles and without a solid it can
      follow (SolidWorks 2010's vendors' files, written to a Parasolid schema the server
      hasn't), or a layout it doesn't know. Caliper says so, and the add-in can make that
      version's model instead.

  A part's model is a mesh: its bodies'
  triangles, in runs that are their faces, in millimeters in the part's coordinates, with
  their colors (`vault/caliper.py` has the format; the server checks every one, and sends it
  gzip-compressed as it keeps it). An assembly's is its components: each names its file
  (a part or sub-assembly) at the version the assembly was checked in with, and in the
  configuration it uses; where it is (a 3 x 4 transform to the top assembly's coordinates,
  as SolidWorks' `Transform2` gives); whether SolidWorks hid it; its color over its part's;
  and a sub-assembly's own components. A virtual part, kept inside the assembly, carries its
  own mesh. Caliper draws each part's own model wherever its components put it, fetching
  each once (six at a time). A version the server can't read a model from says why, and
  how to make one; with no version asked for, Caliper then shows the newest one that has a
  model, and says so. A component that draws nothing says why beside its name, and the
  page sums them up by why: parts in a configuration their files have no 3D view of, files
  with no 3D view Caliper reads, and parts kept inside an assembly without a shape there
  that Caliper read (all of which Make 3D view in SolidWorks makes); sub-assemblies none of
  whose parts are in the vault (each component says what its file is, so one with nothing
  under it isn't taken for a part); and models that didn't load.
- **STEP and IGES files** are read as they are, in the browser, by OpenCascade compiled to
  WebAssembly (occt-import-js, LGPL-2.1: 7 MB, fetched the first time and cached), in a
  worker, so a big file doesn't freeze the page.
- **STL files** are read as they are, in the browser (`stl.ts`). They're only triangles, so
  Caliper welds them where they meet, makes each separate shell a body, and splits each
  body into faces where its surface bends by more than 30 degrees: a cylinder's facets stay
  one face, which measures as a cylinder. STL keeps no units: its numbers are taken as mm.
  A text STL that doesn't end with `endsolid` was cut off, and says so.

A model shows what the vault lets you see: a component in a file you can't see is left
out, with everything in it, and the page says how many were. Anyone who may upload (an
editor anywhere) and can see a file can add a model its version doesn't have yet, as the
add-in does for every part of an assembly it checks in; making one again, in place of the
one there, takes editor rights to the file's folder. Anyone who can see a file can have the
server read its model from the file, as that adds nothing the file doesn't say. A model is
made from its version and describes it: making one changes nothing in the file's history.

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
| `GET /api/files/{id}/caliper` | a file's 3D models, for Caliper: each version's, in each configuration |
| `PUT /api/files/{id}/caliper` | save a version's model `{version, configuration, units, mesh or components}` (upload a mesh first: `PUT /api/blobs`) |
| `POST /api/files/{id}/caliper/make` | read a version's model `{version}` from the 3D view SolidWorks saved in the file (or get the one it has); `unreadable_file` says why not |
| `POST /api/caliper/missing` | which of these `{models: [{file_id, version, configuration}]}` have no model yet, of files you can see: what the add-in makes |
| `GET /api/files/{id}/caliper/assembly?version=&configuration=` | an assembly's components that you can see (each with its file's `kind`: part or assembly; `format`, step or iges, for a STEP or IGES file; and `virtual` for a part kept inside the assembly), and how many are left out |
| `GET /api/files/{id}/caliper/mesh?version=&configuration=&mesh=` | a part's mesh (gzip: `Content-Encoding`), or with `mesh=`, a virtual part's from an assembly's model |

## Roadmap

1. **Server core** (done): folders, check-out/check-in with references, history,
   trash, permissions, Google and client sign-in, sync feed, activity log.
2. **Client library + `vault` CLI** (done): workspace, status, get latest, check
   out/in, undo with backups, history, locks, browser sign-in. Tested against the
   real server.
3. **SolidWorks add-in** (done; first run in SolidWorks in September 2026, for 2026 since
   October 2026): task pane with status and actions, check-out offers when you edit, save
   checks, check-ins that include an assembly's references, and updates from the server.
4. **Web app** (done): browse and search, history, download, who-has-what, activity,
   admin (approvals, permissions), admin mode (releasing check-outs, forced reverts),
   and opening files in SolidWorks.
5. **Moving in** (to do): the current files imported from Kenesto, and the blobs in an
   R2 store, with backups off the host (design.md, "Storage").
6. **Caliper** (October 2026): parts, assemblies, and STEP files in 3D in the browser, to
   turn, cut, and measure; the 3D models of SolidWorks files made by the add-in, or read
   by the server from the files themselves.
7. **Later**: thumbnails, check-in notifications to team chat, released revisions (A, B,
   C) for flight hardware, and rename/move with reference repair. In Caliper: drawings,
   exploded views, and models of the files from Kenesto that the server can't read (saved
   without their 3D views, or used in configurations their files have none of), made on a
   computer that only makes them.

## Open questions

- SolidWorks version: 2026 (decided October 2026; 2025 in September). New installs need
  2026, and laptops on 2025 keep updating the add-in while they move over. The add-in is
  built against API version 33 (2025), which 2026 runs.
- Kenesto: the plan is to import the current files from a synced Kenesto folder
  and keep Kenesto read-only as the archive of old history.
