# Numbering the vault's files

Part numbers (docs/vault.md, "Part numbers") name new parts and assemblies from the day
they're turned on. The ~5,500 SolidWorks files already in the vault are numbered once, all
at once, by a tool run in SolidWorks 2026 on a computer of its own: it renames each part and
assembly to its number, rewrites what every assembly and drawing names, and checks it all
in as one check-in, keeping every file's history. This is how, and what has to be true
first.

## What's built, and what's left

- **Built:** the server (titles, former names, part numbers and kinds, the pause, renames
  in a check-in with every file that uses them, dry runs); the web app (titles, New part
  with numbers, Admin > Part numbers, the pause); Vault's client (titles, former names in
  name matching); the add-in (titles, New part in Browse, vendors' parts at check-in, the
  pause); and the plan (`Vault.Client/Renumbering`: `RenumberPlan`, `RenumberCsv`), tested
  without SolidWorks.
- **Left:** the checks in SolidWorks 2026 below, then the tool that drives SolidWorks
  (`client/src/Vault.Renumber`, a .NET Framework 4.8 console app, not in the installer),
  and the add-in's numbering of new files as they go in, which renames the same way. Both
  wait on what the checks find.

## First: check SolidWorks 2026 on copies of real files

On a laptop with SolidWorks 2026 (not this one: it has 2025), with copies of real
assemblies, check, and write down what you find:

1. **Files saved in 2025.** Does `ISldWorks.ReplaceReferencedDocument` work on closed files
   saved in 2025, and does it save them as 2026? If it does, every laptop has to be on 2026
   before the run (2025 can't open 2026 files), or the tool uses the Document Manager API,
   which needs a licence key: ask whether the team can get one.
2. **Paths that aren't there.** Does it take reference paths that don't exist on disk
   (`K:\...` from Kenesto, the deleted `09_Hopper` copies)?
3. **What it reaches.** Drawings (views, BOMs), sub-assemblies, derived and in-context
   parts, suppressed components, and components in configurations that aren't active.
4. **Time.** How long it takes on the biggest assemblies.
5. **Caliper.** Does it update the paths in the 3D view's XML that the server reads?
6. **Ties.** How SolidWorks, searching, settles two files of one name.

## Which file gets which number

`RenumberPlan.Plan` decides, from a snapshot of the vault (`RenumberPlan.FilesOf`, a
workspace's Browse tree), the lists the leads review, and the first number handed out. It's
a pure function of those, so a rehearsal and the run make the same plan.

- **Numbered:** live parts and assemblies, but vendors' parts (the vault's flag, McMaster's
  numbers in the name, or `vendors.csv`), files named by part numbers already (Ground
  Structures'), and any the review keeps (`keep.csv`). They take consecutive numbers from
  the first, in the order of their folders, then assemblies before parts, then names,
  then ids, with the kinds their folders take (`kinds.csv`, for a folder and the folders in
  it; else 001 Part and 501 Assembly) and the titles they have (their old names, unless
  `titles.csv` gives others).
- **Named after one:** drawings, PDFs, and exports (STEP, STL, DXF, ...) named after a
  numbered model in their folder take its number, keeping what came after its name:
  `Fin - machining.SLDDRW` becomes `00000123-001 - machining.SLDDRW`. A drawing goes with
  the model it shows, where the vault knows; else with the longest name it starts with.
- **In the way** (`Problems`, which the run won't start with): a drawing that shows a
  numbered part but isn't named after it, a kind that isn't three digits, and two files
  that would get one name.

`RenumberCsv` writes the plan (`plan.csv`: id, path, new name, number, kind, title, and
why) and reads the review's lists, as Excel writes them.

## Rewriting what files name

Every SolidWorks file, parts too (derived and in-context parts name others), has each path
it keeps for another file (`GetDocumentDependencies2`, searching off) taken to that file's
id: the version's recorded references first, then `Workspace.FindUsedFiles`. Where
SolidWorks itself, searching, finds another file, its pick wins, and the report says so.
Each file that uses a renamed one has all its paths rewritten to the new ones, which clears
the old `K:\` and `09_Hopper` paths too. Afterwards every assembly records what it uses, so
where-used, the warnings on delete, and the checks on moves and renames are complete.

## Staging (days before, with the vault in use)

1. On the renumbering computer (SolidWorks 2026), download everything into `C:\VLT`, and
   for each top assembly write down the set of file ids it resolves to.
2. Make the plan, its CSV files and report, and the server's dry run of the check-in.
3. The leads review the vendors' parts, the titles, and each folder's kinds for about a
   week; make the plan again until nothing is in the way.
4. Set the vendors' flags (`POST /api/files/metadata`) and hand out the plan's numbers
   (`POST /api/numbers`, as an admin, with numbering still off, so nobody else gets them).
5. Rename on disk, rewrite the references, check that each top assembly resolves to the
   same file ids as before, and upload the contents. Check the server's free disk first.

## The run (two hours at most, rehearsed)

1. Everyone checks in and closes SolidWorks. Take a fresh backup of the database.
2. Pause the vault (Admin > Part numbers, or `PUT /api/vault/pause` from the renumbering
   computer, whose changes go on).
3. Plan again for anything that changed since staging.
4. Check out every planned file, and every file that uses one, on the renumbering computer.
5. One check-in with all the renames (about 1 MB of request, under the server's 10 MB and
   5000-item limits; split by folder if not): a dry run first, then for real.
6. In a second, clean workspace, check each top assembly's file ids against step 1 of
   staging, then look at a few in SolidWorks, in the web app, and in Caliper.
7. Unpause, and tell the team.

## Afterwards

- Clients follow the renames as they next refresh: copies that aren't open move to their
  new names (`Workspace.FollowMoves`), open ones once they're closed, and Update
  downloaded files brings the rewritten assemblies. Everyone updates the add-in first:
  older ones work, but don't know the names files had.
- Turn numbering to offered, then to required once Admin > People shows the new add-in on
  every laptop that checks in, and the add-in numbers new files as they go in.

## Going back

- Before the check-in: undo the check-outs, give back the numbers, unpause.
- After it: run the plan backwards through the same kind of check-in (versions only go up).
- Restore the database backup only if the check-in damaged the database, and only before
  unpausing.

## Rehearse twice

On the off-site backup restored to a scratch computer (docs/deploying.md, "Off-site
backups"), with a development server reachable only there. Time each step, and try both
the current and the previous add-in against it.
