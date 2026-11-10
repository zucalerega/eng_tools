# Troubleshooting

Find your problem under the part of the site it's in, or search this page for words from the
message you saw: every error the server sends is under [What an error means](#what-an-error-means),
with its code. If your problem isn't here, see [Getting more help](#getting-more-help), at the end.

## Signing in

- **Signing in with Google says your email has no YJSP account.** Google signs in only to accounts
  already there: one made with Google before, or an admin's invite. New people join with their
  Georgia Tech account: click *Sign in with Georgia Tech*. Without a GT account (a mentor, say), ask
  an admin to invite the address you use with Google (Admin > People).
- **Signing in with Georgia Tech says your email isn't on YJSP's whitelist.** The admins have turned
  the whitelist on, so only GT emails on it, and people they invite, can make an account. Ask an
  admin to add your GT email (Admin > Whitelist), then sign in again.
- **Signing in says only Georgia Tech accounts sign in this way.** *Sign in with Georgia Tech* takes
  only GT's own accounts, with a GT email; a personal Microsoft account, or a guest GT invited from
  outside, isn't one. Sign in on GT's login page with your GT username, like gburdell3@gatech.edu.
- **You joined with Google, then signed in with Georgia Tech, and your check-outs are gone.**
  Signing in with Georgia Tech finds your account only if its email is your GT address; otherwise it
  makes a new, empty account, and what you have checked out stays with the old one. Sign out (in the
  account menu, top right) and keep signing in with Google for now: admins can't change an
  account's email yet.
- **The page says "Waiting for approval".** Your account was made when new accounts waited for an
  admin. Ask an admin to approve it (*Approve*, on Admin > People), then reload the page; or to put
  your GT email on the whitelist, then sign in again.
- **The page says the account is disabled.** An admin disabled it. If that's a mistake, ask an admin
  to enable it (*Enable*, on Admin > People).
- **Google says your email address isn't verified.** The site takes a Google account only once
  Google has verified its email. Verify it with Google, or sign in with Georgia Tech.
- **Signing in says your email belongs to a different Google account, or GT account.** The account
  with that email here is tied to another Google or GT account than the one you used. Sign in with
  the one you used before; if you can't, ask an admin.
- **"Georgia Tech sign-in failed", or "Google sign-in failed".** The trip to GT's or Google's login
  page didn't finish, and the rest of the message is theirs: often it was cancelled, or took more
  than 10 minutes. Go back to the sign-in page and start again.
- **"Georgia Tech sign-in isn't set up on this server", or Google's.** That way to sign in isn't
  ready on the site. Use the other button, and tell an admin.
- **The web app sends you to the sign-in page.** A browser stays signed in for 30 days, or until you
  sign out. Sign in again, and you come back to the page you were on.
- **A link to Yorg's plots opens without them after you sign in.** Signing in brings you back to the
  link's page, but a link over 2,000 characters loses its plots on the way. Now that you're signed
  in, open the link again.
- **SolidWorks or the `vault` command says your sign-in expired.** Their sign-ins lapse after 90
  days unused, so a laptop in a drawer, or one gone missing, isn't signed in forever. Sign in again
  in the Vault tab, or with `vault login` and the address you open the site at; your workspace and
  check-outs stay.
- **Signing in from SolidWorks, the browser says the page expired, or the request doesn't match.**
  The *Sign in to Vault* page, which the Vault tab and `vault login` open, has to be answered within
  10 minutes, by whoever was signed in when it opened. Start signing in again, and click *Allow* on
  the page that opens.

## Vault

### Checking out and in

- **Check out says someone else has the file checked out.** One person at a time has a file checked
  out, on one computer, and the message says who and where. Ask them to check it in, or to undo
  their check-out. If they can't (gone for the summer, say), a lead of the folder or an admin can
  release it, and their changes stay on their computer: in the web app, turn on *Admin mode* in the
  account menu and click *Release check-out* on the file's page; in SolidWorks, *Take over...* on
  the Vault tab.
- **A file is checked out to you, but on another computer or in the web app.** A check-out is yours
  on one computer, and only that one can check the file in. Check it in there, or move the check-out
  here: in SolidWorks, start changing the file and Vault offers to, or click
  *Move check-out here...*; with the `vault` command, `vault checkout --force`. Changes made on the
  other computer stay there.
- **Check in says to check the file out first.** Only a file checked out to you gets a new version;
  a new file needs no check-out. Check it out, then check it in. If your check-out was released or
  taken over, Vault says who did it and when, and your changes are still on your computer: check it
  out again, settling the conflict first if someone checked in since (see [Conflicts](#conflicts)).
- **A file is read-only, or SolidWorks opens it read-only.** Files you haven't checked out are
  read-only on your computer, so two people can't change one file at once. Check it out: in
  SolidWorks, start editing and Vault offers to, or click *Check out* on the Vault tab's card; with
  the `vault` command, `vault checkout` and the file.
- **Vault stopped offering to check a file out.** It offers once per file each time SolidWorks runs.
  Click *Check out* on the Vault tab's card, or save the file, and it offers again.
- **Saving in SolidWorks asks to check the file out, or offers to save under another name.** The
  file isn't checked out to you, so it's read-only. Say Yes, and Vault checks it out and saves it in
  place. If someone else has it checked out, or there's a newer version, Vault says so and offers to
  save your changes under another name.
- **You undid a check-out: where are your changes?** Undoing puts the vault's version back, and
  copies yours into `C:\VLT\.vault\backup` first. Undoing in the web app a check-out made on a
  computer leaves its changes on that computer.
- **Get latest skipped a file.** Vault never replaces a file you've changed here, or an open file
  with unsaved changes, and says which it skipped. Check your change in, or undo it;
  `vault get --force` replaces it, copying yours into `.vault\backup` first.
- **"Can't replace ... If it's open in SolidWorks, close it and try again."** Windows wouldn't let
  Vault replace the file. Close it, and any assembly or drawing that uses it, then try again.
- **"Can't get ...: there's another file at ..."** A file that didn't come from the vault is where
  the vault's goes. Move it out of the way, then try again.
- **A revert is refused.** *Revert to v2* (say) needs editor access, a version older than the
  latest, and the file not checked out by someone else. A lead of the folder or an admin can revert
  it anyway in admin mode, which releases the check-out.

### Conflicts

- **A file is "in conflict".** You changed it here, and someone checked in a newer version since,
  so Vault won't check it in or out until you choose. *Keep mine...* (or
  `vault resolve <file> --mine`) checks your copy out as it is, to check in as the next version, on
  top of theirs. *Use the vault's version...* (or `vault resolve <file> --vault`) replaces your copy
  with the latest, keeping yours in `C:\VLT\.vault\backup`; changes you haven't saved in SolidWorks
  are lost.
- **A copy you put in `C:\VLT` by hand is in conflict.** A copy that didn't come from the vault
  (copied in, or there before Vault was installed) is in conflict when it differs from the vault's
  latest version. Settle it the same way.
- **Check in says the assembly uses a file that's in conflict.** The message names the file, which
  changed here after someone checked in a newer version. Settle that first (*Keep mine...* or
  *Use the vault's version...*), then check the assembly in.

### Assemblies and Kenesto

- **Check in says the assembly uses files the vault doesn't have.** An assembly goes in with every
  file it uses, all or nothing. A missing file (not here or in the vault, like a part left in
  Kenesto or saved only on someone's computer) needs adding to the vault, by upload or check-in, or
  taking out of the assembly. A file outside `C:\VLT`, like a Toolbox part in `C:\SOLIDWORKS Data`,
  needs moving into it first (Pack and Go can), and a file in a folder you can't see counts as
  missing.
- **Check in says a part uses an assembly that was deleted.** The part was edited in the context
  of that assembly, so SolidWorks links it there. The add-in checks such a part in without the
  link, and the assemblies that use it too. An older add-in refuses them: restore the assembly from
  its folder's trash, check them in, then delete it again; or break the part's link in SolidWorks
  (right-click the part at the top of its tree, *External References*, *Break All*), save it, and
  check it in.
- **An assembly opens with parts missing.** Open it from the Browse list in the Vault tab, or with
  *Open in SolidWorks* in the web app: Vault gets everything it uses first, at every level, STEP
  files placed with 3D Interconnect included. Whatever the vault doesn't have, the Vault tab names:
  add it to the vault, or take it out of the assembly.
- **An assembly from Kenesto names its parts on Kenesto's drive.** Files brought over from Kenesto
  name their parts where Kenesto had them (`K:\Yellow Jacket Space Program\Project CAD\...`). Open
  them from the Vault tab, or with *Open in SolidWorks*: the add-in gets the vault's files whose
  paths end the same way. To keep the vault's paths in an assembly for good, check it out, save it,
  and check it in.
- **A part from Kenesto is named missing, though it's in the vault.** Vault takes each old path to
  the vault file whose path ends most like it, and takes neither when two end alike. Upload
  Kenesto's project folders as they are (`09_Hopper` stays `09_Hopper`), so the paths line up.
- **An assembly uploaded or checked in on the web doesn't list its parts.** The web app can't read
  SolidWorks files, so the assembly records no parts until it's checked in from SolidWorks: check
  it out there, then in.

### Drawings

- **Check in says a drawing doesn't show a part or assembly in the vault.** A drawing goes in only
  with what it shows, a part or assembly in the vault (or in the same check-in), and only SolidWorks
  can say what that is: the `vault` command can't read drawings, and the web app only keeps what a
  drawing's last version showed. Check it in from the Vault tab in SolidWorks.
- **Check in says to name the drawing after what it shows.** A drawing's name is its model's, or
  starts with it and goes on after a space or a symbol: `Fin.SLDDRW` or `Fin - machining.SLDDRW`
  for `Fin.SLDPRT`, but not `Fin2.SLDDRW`. That keeps it next to its model. Save it under such a
  name, then check it in.
- **An upload leaves a drawing out.** Drawings are checked in from SolidWorks, so they stay linked
  to what they show. To start one, click *New drawing* on the part's or assembly's page in the web
  app, or make it in SolidWorks.
- **A drawing's page says it isn't linked to what it shows.** Check it in again from SolidWorks,
  where Vault records what each drawing shows.

### Moving, renaming, deleting, and the trash

- **Move or rename is refused because SolidWorks wouldn't find a file.** SolidWorks finds the files
  an assembly or drawing uses by name, in its folder or where they were next to it, so Vault refuses
  a move or rename that would lose one. Move a part into its assembly's folder, or move their whole
  folder together. To rename a file something uses, rename it in SolidWorks, then check both in.
- **Move, rename, or delete is refused because a file is checked out.** Files don't move or get
  renamed while anyone has them checked out, you included: check them in, or undo the check-out,
  first. A file someone else has checked out can't be deleted until it's checked in or released.
- **Delete warns that other files use what you're deleting.** SolidWorks would miss it in the files
  that stay. Delete them together, or click *Delete anyway* if you mean it.
- **You can't move, rename, delete, or restore a folder.** A folder takes a lead of it, or an admin;
  files take editor access.
- **A name is refused.** Names have to work on Windows: none of `< > : " / \ | ? *`, no space at
  either end or dot at the end, not a name Windows reserves (`CON`, `NUL`, `COM1`...), not a
  temporary file (`~$...`), and at most 255 characters. A whole path is at most 200 characters, so
  that `C:\VLT\` and it stay under Windows' 260-character limit: shorten the name or its folders.
- **"... is taken", or "already exists".** Names are unique in a folder, whatever their case. Pick
  another name, or move the other one out of the way.
- **You deleted something by mistake.** Deleting puts it in the trash of the folder it was in,
  history and all: click *Trash* on the folder's page, then *Restore*. Restoring a file takes editor
  access, and a folder a lead; a folder comes back with everything deleted along with it. If
  something else has the name now, move or rename that first.

### Uploading

- **An upload leaves files out.** It says why for each: it's in the vault already (check it out on
  its page, then upload it as its next version), someone has it checked out, it's a drawing, there's
  a folder with its name, or its name doesn't work on Windows. Temporary files (`~$...`, `*.tmp`,
  `Thumbs.db`, `desktop.ini`, `.DS_Store`) are left out without a word.
- **An upload says the server's disk is nearly full.** Every upload has to leave 2 GB free on the
  server's disk, for the database and its backups. Ask an admin to make room (Admin > People shows
  what's using it).
- **An upload says files over a size aren't accepted.** A file can be up to the server's limit,
  which the message names (2 GB, unless the site is set up otherwise). Anything else sent at once
  can be up to 10 MB: check in or upload fewer files at a time.
- **An upload says it doesn't match its SHA-256.** The file was damaged on the way: upload it
  again.

### Access

- **Vault says you need editor (or lead) access.** Your role in that folder doesn't allow it.
  Viewers browse and download; editors also check out, check in, add, delete, restore, and revert;
  leads also release or take over other people's check-outs, and change who has access. Ask the
  folder's lead, or an admin, for the role (Admin > Vault Access).
- **A file or folder isn't there, or Vault says it isn't in the vault.** Files in folders you can't
  view don't show anywhere, and asking for one says it isn't there, not that it's forbidden. Check
  the path and the folder's *Trash*, or ask the folder's lead for access.

### Caliper

- **Caliper says it can't read a SolidWorks file.** Caliper shows the 3D view Vault for SolidWorks
  makes when a file is checked in; for other versions, the server reads the 3D view SolidWorks saved
  in the file, and some files have none it can read. Open the file in SolidWorks and click
  *Make 3D view* on the Vault tab: Caliper shows it after.
- **Caliper shows an assembly with parts missing.** It lists the parts it couldn't show, and why: a
  part used in a configuration its file has no 3D view of, a file with no 3D view Caliper reads, a
  part kept inside the assembly (a routed tube, say) without a shape Caliper read, or a sub-assembly
  none of whose parts are in the vault. *Make 3D view* in SolidWorks makes the first three; the last
  need their parts in the vault. Parts in folders you can't see are left out, and the page says how
  many.
- **Caliper says the server is reading other SolidWorks files.** The server reads two at a time.
  Wait a minute and open it again.
- **Make 3D view says a part's view wasn't made.** A part with unsaved changes, or changed and not
  checked in, gets none until it is. A part loaded lightweight needs resolving first: right-click
  the assembly, choose Set Lightweight to Resolved, then click *Make 3D view* again.
- **A STEP, IGES, or STL file is slow to open, or measures wrong.** Caliper reads these in your
  browser, fetching its STEP and IGES reader (7 MB) the first time. STL keeps no units, so its
  numbers are taken as mm, and a text STL that doesn't end with `endsolid` was cut off, which
  Caliper says.
- **A file from SolidWorks 2014 or older measures in mm.** Its units aren't saved where the server
  reads them, so it starts in mm: pick its units in Caliper.

## The SolidWorks add-in

### Installing and connecting

- **Windows won't run `Vault-Setup.exe`.** It isn't signed for Windows yet, so Windows warns about
  it: click *More info*, then *Run anyway*. Your browser may ask whether to keep the download first.
- **Setup says it needs SolidWorks 2026.** Setup installs the add-in new only where SolidWorks 2026
  is, since files saved in 2026 don't open in older versions and the team stays on one. With
  SolidWorks 2025, it only updates an add-in that's there already.
- **The SolidWorks page says the server doesn't have the installer yet.** Ask an admin for
  `Vault-Setup.exe`.
- **There's no Vault tab in SolidWorks.** Open Tools > Add-ins and tick Vault in both columns, so it
  loads now and every time SolidWorks starts. This happens when setup ran as another Windows user.
- **Connect SolidWorks does nothing.** Install the add-in first (step 1 on the SolidWorks page):
  it's what follows the link. If your browser asks whether to open it, say yes.
- **SolidWorks asks whether to connect to a vault.** Say Yes only if the address it shows is the
  one you open Vault at in your browser: any web page can make a Connect link, and a server that
  isn't your team's would get your sign-in. It asks the first time, and for a vault it isn't set up
  for.
- **SolidWorks is set up for another vault.** Each vault needs a folder of its own. In the Vault
  tab, sign out, type another folder (like `C:\VLT-2`), then connect again.

### Opening files

- **Open in SolidWorks does nothing at all.** The add-in isn't installed on this computer (run
  `Vault-Setup.exe`), or your browser asked whether to open `vault-open.exe` and was told no: click
  again, and say yes. In a Command Prompt,
  `reg query HKLM\SOFTWARE\Classes\vault\shell\open\command` shows whether the links are registered.
- **A Vault message on top of SolidWorks says the add-in isn't answering.** The add-in is turned
  off. Tick Vault in both columns of Tools > Add-ins, so it loads now and every time SolidWorks
  starts; if they're ticked already, `addin.log` says why the add-in didn't start.
- **A message says Vault is still busy with a link you clicked before.** The add-in follows one
  link at a time. Wait for that file to open, or answer Vault's message in SolidWorks, then try
  again.
- **A message says SolidWorks 2026 isn't installed.** *Open in SolidWorks* starts SolidWorks when it
  isn't running, and found none to start. Start SolidWorks yourself, then click again.
- **Open in SolidWorks says the file was saved in a newer SolidWorks.** A file saved in SolidWorks
  2026 doesn't open in 2025 or older. Open it in SolidWorks 2026, the team's.
- **Open in SolidWorks says SolidWorks has another file of the same name open.** SolidWorks can't
  open two files with the same name at once. Close that one, and any assembly or drawing that uses
  it, then try again.
- **The right-click menu says to open an assembly first.** *Insert into* puts a part or assembly
  from Browse into the assembly you have open, so an assembly has to be the active document. A
  drawing has no *Insert into*.

### Sign-in, updates, and the log

- **The Vault tab says your sign-in expired.** The add-in's sign-in lapses after 90 days unused.
  Sign in again in the Vault tab; your workspace and check-outs stay.
- **Update appears at the top of the Vault tab.** A newer add-in is out. Click it, say Yes, and let
  setup make changes when Windows asks; then save your work and close SolidWorks, and setup
  finishes. Your sign-in, settings, and workspace stay.
- **Update says the update isn't signed, or isn't the version offered.** Vault installs only an
  update it can check: signed with the key Vault's releases are signed with, at the version it was
  offered as. Nothing was installed: keep working, and tell an admin.
- **Update says it needs permission.** Windows asked to let setup make changes, and the answer was
  No. Click *Update* again, and say Yes.
- **There's no Update button, though a newer add-in is out.** The add-in looks every few hours.
  Add-ins 0.4.0 and older have no *Update*: run the new `Vault-Setup.exe` once, from the web app's
  SolidWorks page.
- **The Vault tab says it can't reach the Vault server, or couldn't refresh.** The rest of the
  message says why, most often that the vault is out of reach from this computer; the tab tries
  again every 20 seconds. Files already on this computer still open, but checking out and in need
  the connection.
- **Something else went wrong.** The add-in logs to `%LOCALAPPDATA%\Vault\addin.log`: a line for
  each click on *Open in SolidWorks* and what became of it, and the details of anything that
  failed. Send it to an admin with what you clicked and when. `vault status` in `C:\VLT` is a good
  second opinion.

## Yorg

### Getting data in

- **A file was read wrong: the wrong time column, wrong times, or names in the wrong row.** Yorg
  works out each file's layout, and keeps the file as it was uploaded. A dataset's *About* page says
  how it was read and what was left out; its Read settings choose the time column, what the time is
  in, the row the names are in, and what the values are separated by, and *Read it again* reads the
  file that way. Only whoever added the dataset, or an admin, can read it again, and a read that
  fails leaves the last one standing.
- **An upload says it couldn't be read.** The file is kept: change its Read settings on the
  dataset's *About* page and click *Read it again*, rather than upload it again. Yorg reads CSV
  files of test data, of up to 2,000 columns.
- **Rows or values are missing.** Rows without a readable time are left out, rows out of time order
  are put in order, and cells that aren't numbers are left empty; the *About* page says so, with a
  row number. A column empty in at least half the rows (a slower sensor in the same file) keeps only
  its own samples, with their times.
- **A file is too big to upload.** A file can be up to the server's limit, which the message names
  (2 GB, unless the site is set up otherwise), and an upload has to leave 2 GB free on the server's
  disk.

### Time and T0

- **Times read as time of day in UTC, not your time zone.** Data with Unix times reads as time of
  day in UTC until there's a T0. Options > Time reads switches to your computer's time zone, or to
  time from T0.
- **You want time to read T−10, T0, T+15.** Set T0 from the *T0* menu: type a time of day
  (`21:15:03.25`), a Unix time, or `T+12`; click a plot; or pick an event like MOV OPEN. Drag its
  line to move it.
- **Your plots, T0, or markers aren't there on another computer, or for someone else.** Each browser
  keeps its own plots for each dataset. *Save view* keeps them for everyone, and *Copy link* sends
  what's on screen without saving a view.
- **A compared test doesn't line up.** Shift it in time to line them up; two tests with dates line
  up by their clock times.

### Calculated channels and views

- **A calculated channel doesn't show in a dataset.** It shows in every dataset that has the
  channels it uses, by name, so a dataset missing one of them doesn't list it. Check the names in
  brackets against the dataset's channels.
- **A calculated channel has gaps.** It's missing outside the samples of the channels it uses, and
  where it divides by zero; `min`, `max`, and `avg` skip missing samples, as for redundant sensors.
- **"There's already a calculated channel called ..."** Calculated channels are the whole team's,
  and their names are unique whatever their case. Pick another name.
- **A view opened with another test is missing plots.** A view plots channels by name, so it shows
  another test's channels of the same names, and leaves out those the test hasn't got.
- **You can't change or delete a dataset, view, calculated channel, script, or folder.** Only
  whoever added it, or an admin, can. To keep your changes to someone's view, click
  *Save as a new view*; for a copy of someone's script, *Save as…*.

### Organizing

- **A folder won't delete.** Only an empty folder can be deleted: move its datasets and folders out
  first. Deleted datasets that were in it go to the folder it's in.
- **You deleted a dataset by mistake.** It waits in Deleted datasets, at the foot of the list:
  *Restore* puts it back in its folder. You can restore your own, or anyone's if you're an admin.
- **A test split out of a file can't be read again or downloaded.** It has no file of its own. Read
  the file it came from again, and split it again.
- **Split says a test would be empty.** One of its spans has no samples, so nothing was made. Change
  that span's times, and split again.
- **A plot says the dataset has been read again since.** Its file was read again while you had it
  open. Reload the page.

### Scripts

- **A script says to attach a test, or that a test isn't attached.** A script works on the tests
  attached to it, under *Data* beside it, and `yorg.channel("PT-TANK")` takes from the first. Attach
  the test there; for another one, add `dataset="Hotfire 4"`, and when two attached tests share a
  name, name one by its id (`dataset=12`), as the message says.
- **A script says a channel isn't loaded.** Channels named in quotes in the code are loaded before
  it runs. For a name the code makes as it runs, use `await yorg.load(name, dataset=...)`.
- **Python is slow to start, or to import.** Python runs in your browser, not on the server. It
  downloads the first time, and CoolProp's first import reads its whole fluid library (20 seconds to
  a minute); while a script is open, Python gets its slow imports ready, and the output says what
  it's doing, and for how long.
- **Python forgot your variables or imports.** Python stays open while the tab does, but stopping a
  running cell starts it again without what it had, and 30 minutes without using it stops it, to
  give its memory back. Run the cells that load your data again.
- **A package isn't there.** NumPy, SciPy, pandas, matplotlib, and CoolProp load when a script
  imports them, and pure-Python packages install from PyPI with micropip (`import micropip`, then
  `await micropip.install("tabulate")`), until Python starts again. REFPROP isn't there: it needs
  NIST's license.

## Piper

### Simulation

- **There's no Simulation in Piper's bar.** Simulation mode is for admins while it's tried out.
- **The Simulation box can't be changed, or Apply to the P&ID is off.** The diagram is only looked
  at: press *Edit* (if someone else is editing it, it says who; wait until they're done). Runs,
  fits, and anchoring don't change the drawing, so they work without it.
- **The Simulation panel lists what keeps the model from running.** Each says which part and what to
  change, with *Go to*: say what a part's lines carry (give one a fluid; *Carry along its run* gives
  it to the rest), put a valve or an orifice between two tanks joined by a plain line, or make a part
  in the wrong lines something else (a regulator in liquid lines, a cavitating venturi in gas ones).
- **A valve doesn't move, or a transducer isn't compared.** A part reads the test's channel named in
  its *Test channel*, or else its tag, whatever its case; the panel lists the parts whose channel the
  test hasn't got. A valve with none stays where its settings have it (closed if it's normally
  closed), and a sensor with none isn't compared. A channel unchecked in its part's *Simulation*
  box is left out on purpose, so the part does what its settings say: check it to use the test's.
- **A transducer still isn't compared.** It has to tap a line or a part the model has: a tank, or
  the point between two parts. A thermocouple reads a temperature only where the model has one (a
  tank's liquid or ullage, a gas line's tubing, a bottle), and a flow transmitter isn't compared: put
  a flow meter in the line instead.
- **The run's window is in the wrong place.** It's in seconds on the test's clock, as the timeline
  reads it. Put the timeline where it should start or end, and click ◷ beside *From* or *To*.
- **A run says other runs are using the server.** Two runs go at once, and a new run of yours
  replaces your last. Try again in a minute; a run stops after 10 minutes, and a fit after 30, with
  the best it found.
- **A run's results are gone.** They're shown until you leave the diagram, and never saved: run it
  again. What a fit found is the P&ID's only once you *Apply to the P&ID*.

## What an error means

Each error the server sends has a code, in backticks below, and a message, which is what the web
app, the add-in, and the `vault` command show. In the messages, "..." stands for a name, a path, or
a number. A few codes come up in more than one place.

### Signing in and accounts

- **Sign in first** (`unauthorized`): you aren't signed in, or your sign-in has ended: a browser's
  after 30 days or when you sign out there, and the add-in's or the `vault` command's after 90 days
  unused. Sign in again.
- **This account is disabled** (`disabled`): an admin disabled your account. If that's a mistake,
  ask an admin to enable it on Admin > People.
- **An admin needs to approve your account first**, or **Your account isn't active**
  (`pending_approval`): the account is waiting for an admin, from when new accounts did (signing in
  from SolidWorks or the `vault` command, it may be disabled instead). Ask an admin to approve it on
  Admin > People, or to put your GT email on the whitelist, then sign in again.
- **... has no YJSP account, and Google doesn't make new ones** (`no_account`): you signed in with a
  Google account whose email has no account here. Sign in with Georgia Tech, or ask an admin to
  invite the email you use with Google.
- **... isn't on YJSP's whitelist** (`not_whitelisted`): the whitelist is on, and your GT email
  isn't on it. Ask an admin to add it on Admin > Whitelist, then sign in again.
- **Only Georgia Tech accounts sign in this way** (`not_georgia_tech`): the Microsoft account you
  used isn't one of GT's own, with a GT email. Sign in with your GT username, like
  gburdell3@gatech.edu.
- **Your Google account's email address isn't verified** (`unverified_email`): verify it with
  Google, or sign in with Georgia Tech.
- **... belongs to a different Google account**, or **GT account** (`identity_mismatch`): the
  account with that email here is tied to another Google or GT account than the one you used. Sign
  in with that one; if you can't, ask an admin.
- **... sign-in isn't set up on this server** (`signin_unavailable`): that way to sign in isn't
  ready on the site. Use the other one, and tell an admin.
- **... sign-in failed: ...** (`signin_failed`): GT's or Google's login didn't finish, and the rest
  of the message is theirs. Start again from the sign-in page.
- **Requests from the browser need an X-YJSP-Request header** (`csrf`): a change came with your
  browser's sign-in, but not from the web app; that's how the site keeps other sites from acting as
  you. If it happens in the web app, reload the page.
- **This sign-in request from the Vault client is malformed** (`bad_client_request`): the address
  SolidWorks or the `vault` command opened in your browser was cut short or changed. Start signing
  in again from it; if it keeps happening, update the add-in or the `vault` command.
- **This page expired; start signing in again from the client** (`expired`): the
  *Sign in to Vault* page waited more than 10 minutes for *Allow*. Start again from the Vault tab,
  or with `vault login`.
- **This sign-in request doesn't match** (`mismatch`): *Allow* was for another request than the one
  the page was made for, as when someone else signed in on that browser meanwhile. Start again from
  the client.
- **This sign-in has expired**, or **Sign-in verification failed** (`invalid_code`): the one-time
  code that finishes signing in from SolidWorks or the `vault` command was used already, was over 5
  minutes old, or didn't match. Sign in again from the client.
- **Only admins can do that**, or **Only admins can see what the assistant has cost**
  (`admin_only`): inviting, approving, and disabling people, the whitelist, and Admin > People's
  figures are for admins. Ask an admin.
- **... isn't an email address** (`bad_email`): an invite, or an email for the whitelist, that isn't
  an email address. Check what was typed.
- **... already has an account** (`exists`): the person you're inviting has one already. One waiting
  for approval, or disabled, is approved or enabled on Admin > People. (In Vault, `exists` is about
  names: see [Vault files and folders](#vault-files-and-folders).)
- **You can't disable yourself or drop your own admin rights** (`self_lockout`): another admin can.
- **An account can be set active or disabled** (`bad_status`): a request asked for another status.
  In the web app, *Approve*, *Enable*, and *Disable* are the ways to change one.
- **A name can't be empty**, or **A name can be at most 200 characters** (`bad_name`):
  *Change your name…*, in the account menu, takes 1 to 200 characters.
- **That email isn't on the whitelist** (`not_on_whitelist`): someone took it off meanwhile. Reload
  the Whitelist tab to see the list.

### Vault files and folders

- **... contains characters Windows doesn't allow**, **... is a reserved name on Windows**,
  **... is longer than 200 characters**, and the like (`bad_path`): a name or path that won't work
  in a Windows folder, as every workspace is. "A name is refused", under
  [Moving, renaming, deleting, and the trash](#moving-renaming-deleting-and-the-trash), has the
  rules: rename it, or shorten its folders.
- **... already exists**, **... is taken**, **... is a folder**, **... is a file, not a folder**, or
  **Something else is at ... now** (`exists`): something in that folder has the name already,
  whatever its case. Pick another name, or move or rename the other one first; restoring from the
  trash needs the old name free.
- **Still used by ...** (`in_use`): files that stay use what you're deleting, and SolidWorks would
  miss it. Delete them together, or *Delete anyway*.
- **... is used by ..., and SolidWorks wouldn't find it after this** (`in_use`): a move or rename
  would lose a file from what uses it. Keep it in their folder, or where it was next to them (move
  their folder together); to rename it, rename it in SolidWorks, then check both in.
- **... can't go inside itself**, **... is moving with its folder already**,
  **The top of the vault doesn't move**, or **Say what to move** (`bad_move`): a move that can't be
  done as asked, like a folder into one of its own folders. Pick another place, or move the folder
  without the files in it.
- **... would change what kind of file ... is** (`bad_rename`): a rename keeps a file's type, so
  keep its extension. **Rename a file or a folder** and **The top of the vault has no name** are the
  same code.
- **The top of the vault can't be deleted**, or **Say what to delete** (`bad_delete`): pick the
  files and folders to delete.
- **You need editor access to ... to ...** (`forbidden`): your role in that folder doesn't allow
  it, as with **You need editor access somewhere to upload files**. Ask the folder's lead, or an
  admin, for the role (Admin > Vault Access).
- **... is not in the vault**, **There's no folder ...**, or **Not found** (`not_found`): it isn't
  there, or it's in a folder you can't view, which answers the same. Check the path and the
  folder's trash, or ask the folder's lead for access.

### Check-out and check-in

- **Already checked out: ...**, or **... is checked out by ...** (`checked_out`): someone else has
  the file checked out, and the message says who and on which computer. Ask them to check it in; if
  they can't, a lead of the folder or an admin can release it in admin mode, or take it over in
  SolidWorks. A move or rename waits for any check-out to end, yours too.
- **... is checked out to you on ..., not ...** (`checked_out_elsewhere`): you have it checked out
  on another computer (`web` is the web app). Check it in there, or move the check-out here:
  *Move check-out here...* in SolidWorks, or `vault checkout --force`.
- **Check out ... before checking it in** (`not_checked_out`): only a file checked out to you gets
  a new version. Check it out, then check it in.
- **Some referenced files aren't in the vault; add them to this check-in** (`missing_references`):
  a file being checked in uses files that aren't in the vault, or that you can't see, so nothing was
  checked in. Add them to the vault, or take them out of what uses them.
- **... has no version ...** (`bad_reference`): the check-in records a file it uses at a version the
  vault doesn't have. Get the latest version of that file, then check in again.
- **... doesn't show a part or assembly in the vault** (`drawing_without_model`): a drawing goes in
  only with what it shows, and only SolidWorks can say what that is. Check it in from SolidWorks,
  with the Vault add-in.
- **Name each drawing after what it shows** (`drawing_name`): a drawing's name has to start with its
  model's, like `Fin.SLDDRW` or `Fin - machining.SLDDRW` for `Fin.SLDPRT`. Save it under such a
  name, then check it in.
- **Upload ... before checking it in** (`blob_missing`): the file's contents didn't reach the server
  first, as when an upload was cut off. Check in again: it uploads them.
- **The size of ... doesn't match its upload** (`size_mismatch`): the file changed between its
  upload and the check-in. Let SolidWorks finish saving, then check in again.
- **v... is already the latest version of ...**, or **... has no version ...** (`bad_version`): a
  revert to the latest version, or to one that isn't there. Pick an older version in the history.
- **Say which computer this is (host)** (`bad_host`): the client didn't say which computer it's on.
  Update the add-in or the `vault` command; if it keeps happening, tell an admin.
- **... is at v... now, not v..., which these changes start from** (`out_of_date`): someone checked
  in a newer version after the one your changes (a rename in a check-in, say) were made on. Get its
  latest version, and make the changes again there.

### Part numbers and titles

- **Say what ... is called**, **...'s title is longer than ... characters**, or **...'s title has a
  tab or a line break in it** (`bad_title`): a title is one line that says what the file is. Type
  one, shorter if need be.
- **... needs a part number** (`part_number_needed`): new parts and assemblies take part numbers
  now (Admin > Part numbers). Start them with *New part* or *New assembly*, in the web app or in
  SolidWorks, which gives them one; for a vendor's part, say it's a vendor's.
- **... wasn't handed out**, or **No part or assembly has ...** (`unknown_part_number`): a file is
  named by a part number the vault never gave out, or a drawing, PDF, or export is named after the
  number of a part that isn't in the vault yet. Get a number with *New*, or check the part in
  first.
- **... was handed out for ..., so it can't be ...'s**, **Call it ...**, **... is named by a part
  number, so it isn't a vendor's part**, or **... isn't a part number, like 00000123-001**
  (`bad_part_number`): the number doesn't fit the file: it's of another kind (a part's number on an
  assembly, say), the name has more than the number, or it isn't a part number at all. Name the
  file by its number alone (its title says what it is), or get a number of the right kind.
- **... is another file's part number** (`part_number_taken`): each part or assembly has a number
  of its own. Get one with *New*.
- **... is named by its part number, ..., which never changes** (`part_number_fixed`): a numbered
  file keeps its name. To say what it is, change its title instead.
- **... is a file's, for good** (`part_number_used`): a number a file has taken can't be given back.
  Give back only the ones no file has.
- **Part numbers aren't handed out yet** (`numbering_off`): an admin turns them on, on Admin > Part
  numbers. Until then, name new files as before.
- **... isn't a kind of part number**, **A kind is three digits, like 001**, or **Say what a kind is
  in a line of at most 100 characters** (`bad_kind`): pick a kind from the list. An admin adding
  one gives it three digits and a one-line label.
- **Files have numbers of ... already, so it stays a kind of ...** (`kind_in_use`): what a kind is
  for can't change once files have numbers of it. Add another kind instead.
- **Part numbers only go up** (`bad_next_number`): the next number can only move forward, never back
  to numbers that may have been handed out.
- **Ask for 1 to ... part numbers at a time** (`bad_count`): ask for fewer at once.
- **You have ... part numbers you haven't used** (`too_many_numbers`): use the ones you have
  (*New part* offers them first), or give back the ones you won't, then ask again.
- **The vault has run out of part numbers** (`numbers_exhausted`): every number has been handed out.
  Tell an admin.
- **The vault is paused while ... works on it**, or **... has the vault paused already**
  (`paused`): an admin is working on the whole vault (numbering its files, say). You can still look
  at everything and undo your check-outs; changes wait until it's unpaused. Another admin waits for
  that pause to end before pausing it again.
- **Say why in at most 500 characters** (`bad_reason`): a pause's reason, which everyone sees, is
  short. Shorten it.

### Uploads and downloads

- **Files over ... MB aren't accepted** (`too_large`): the file is bigger than the server takes
  (2 GB, unless the site is set up otherwise). **That request is over 10 MB** is the same code, for
  anything else sent at once, like a check-in of a great many files: send fewer at a time. So is
  **A view can be up to 512 KB**, for a saved view's plots.
- **The server's disk is nearly full** (`disk_full`): the upload would leave the server's disk under
  2 GB free, which the database and its backups need. Ask an admin to make room (Admin > People
  shows what's using it).
- **The upload doesn't match its SHA-256** (`hash_mismatch`): the file was damaged on the way.
  Upload it again.
- **Blobs are named by their SHA-256** (`bad_sha256`): a client asked to upload under a name that
  isn't a SHA-256. Update the add-in or the `vault` command; if it keeps happening, tell an admin.
- **There's no download called ...** (`not_found`): the server doesn't offer that file. Ask an
  admin for it.

### Old add-ins and `vault` commands

- **Vault for SolidWorks ... is too old to make changes in this vault, which takes ... and newer**,
  or **This vault command (...) is too old to make changes in this vault** (`client_too_old`): an
  admin has set the oldest version that can change the vault. You can still open and get files; to
  change anything, update first: click *Update* at the top of the Vault tab, then close SolidWorks,
  or download Vault-Setup.exe (or the new `vault.exe`) from the web app's SolidWorks page.
- **This server offers no Vault-Setup.exe for add-ins to update to** (`no_installer`): setting the
  oldest version that can change the vault needs a release's downloads on the server first, so
  add-ins have something to update to. Put them on (docs/deploying.md), then set it.
- **No add-in could update to ...: the Vault-Setup.exe this server offers is ...**
  (`not_offered`): the oldest version can be no newer than the installer the server offers. Put that
  release's downloads on the server first, or pick a version no newer than it.

### Caliper

- **SolidWorks saved no 3D view in it**, **Caliper can't make sense of the 3D view**,
  **... is over 256 MB, too big to read here**, or **Caliper found none of its parts in the vault**
  (`unreadable_file`): the server can't read a 3D view from that version of the file, and the
  message says why. Open the file in SolidWorks and click *Make 3D view* on the Vault tab.
- **SolidWorks marked its ... configuration as needing a rebuild when it saved it**, or
  **SolidWorks kept no solid of its ... configuration in it** (`configuration_not_saved`): SolidWorks
  keeps a configuration's shape in the file only while it's up to date, and that version was saved
  with that configuration not shown since the file last changed, so the file has nothing of it
  Caliper can trust. Check the file out in SolidWorks, show that configuration (or right-click it in
  the ConfigurationManager and click *Add Rebuild/Save Mark*, so every save keeps it), save, and
  check it in: Caliper shows it in the new version. In an assembly, *Make 3D view* makes the models
  of the parts it uses in such configurations.
- **... has no configuration named ...** (`no_configuration`): that version of the file has no
  configuration of that name (a link to another version can ask for one). Pick one from the
  *Configuration* list.
- **The server is reading other SolidWorks files: try again in a minute** (`busy`): it reads two at
  a time. Open it again in a minute.
- **... has no 3D model in its ... configuration** (`no_model`): Caliper asked for a 3D view that
  isn't there. Reload the page; if it stays, open the file in SolidWorks and click *Make 3D view*.
- **Caliper's models are of SolidWorks parts and assemblies**,
  **Component ... is of file ..., which isn't in the vault**,
  **An assembly's model has at most 20000 components**, and the like (`bad_model`): a 3D view the
  server won't keep, from *Make 3D view* or a check-in. Tell an admin, with the add-in's log.
- **The mesh ends early: it was cut off on the way**, **That isn't a Caliper mesh**, or
  **This server reads Caliper meshes of version 1, not ...** (`bad_mesh`): a 3D view from the
  add-in didn't arrive whole, or is newer than the server reads. Click *Make 3D view* again; if it
  says to update the server, tell an admin.
- **Upload the mesh first** (`blob_missing`): a 3D view's file didn't reach the server. Click
  *Make 3D view* again.
- **... isn't a SolidWorks drawing**, or **PDFs are of SolidWorks drawings: ... isn't one**
  (`not_a_drawing`): sheets and PDFs are only for drawings (`.SLDDRW`). Open a part or an assembly
  in 3D instead.
- **... has no PDF** (`no_pdf`): that version went in without one (from the web app, or before Vault
  for SolidWorks made them). Open it in SolidWorks and click *Make PDF* on the Vault tab;
  meanwhile Caliper shows the pictures of its sheets.
- **... has no picture of sheet ...** (`no_picture`): SolidWorks saved no picture of that sheet in
  the file. Make the drawing's PDF in SolidWorks (*Make PDF*).
- **That isn't a PDF** (`bad_pdf`): what the add-in sent as a drawing's PDF isn't one. Click
  *Make PDF* again; if it keeps happening, tell an admin, with the add-in's log.

### Yorg

- **... is empty** (`empty`): the uploaded file has nothing in it. Upload the file with its data.
- **That didn't work: ...** (`unreadable`): reading a dataset's file again with other Read settings
  failed, and the last read stands. The message says what went wrong: try other settings.
- **... hasn't been read, so there's nothing to split** (`not_read`): the dataset's file couldn't be
  read. Fix its Read settings, on its *About* page, first.
- **... was split from ..., and has no file of its own** (`split`): a test split out of a file can't
  be read again, or downloaded as a file. Read the file it came from again, and split it again.
- **... would be empty: ... has no samples from ... to ... s** (`empty_piece`): a span of the split
  has no samples, so nothing was made. Change its times.
- **... has been read again since: load it again** (`stale`): the dataset's file was read again
  while you had it open. Reload the page.
- **... is deleted: restore it first** (`conflict`): reading a deleted dataset again, or splitting
  it. Restore it from Deleted datasets first.
- **There's already a folder called ... there**, or
  **There's already a calculated channel called ...** (`name_taken`): names are unique in a folder,
  and calculated channels' across the team, whatever their case. Pick another.
- **... can't go inside itself** (`cycle`): a folder can't move into one of its own folders.
- **... isn't empty: move what's in it out first** (`not_empty`): only an empty folder can be
  deleted.
- **Only whoever added this ..., or an admin, can change it** (`not_yours`): a dataset, folder,
  view, calculated channel, or script is its owner's to change. *Save as a new view*, or
  *Save as…* a script, for a copy of your own.
- **Simulations are for admins, while they're tried out** (`admins_only`): Piper's Simulation mode
  runs Yorg's system models, which are admins' for now.
- **...'s ... is ..., which ... doesn't have** (`no_channel`): a simulation's part is linked to a
  channel the test hasn't got. Run it against a test that has it.
- **Draw the system first**, **... isn't connected to a tank, so nothing says what liquid is there**,
  **... isn't ready to run against: open it in Yorg first**, and the like (`bad_model`): the P&ID's
  model can't run as it is, and the message names the part (by its tag) and what's wrong. Fix that
  in Piper, and run again.
- **Other runs are using the server: try again in a minute** (`busy`): two simulations go at once.
  Run it again in a minute.

### Piper

- **You saved ... in another window after you opened it here**, or **... saved ..., or restored it
  to revision ..., after you opened it** (`changed`): the diagram changed after you opened it. Copy
  what you need, reload it, and make your changes again on what's there now.
- **... is editing ...: you can look at it, and edit it once they're done**, **...: your change
  isn't saved...**, or **...: restore a revision once they're done** (`locked`): one person
  edits a diagram at a time, and someone else is editing it. Look at it meanwhile; its Edit
  works once they're done (Done editing, closing their tab, or about 25 minutes without a
  click in it). If it was yours and an admin took it over, or you were away long enough for
  someone else to start, your changes since your last save are still in your window: Save mine
  as a new diagram keeps them, or Load theirs. An admin can Take over if it can't wait.
- **... is deleted: restore it first** (`deleted`): restore the diagram from Piper's deleted
  diagrams, then change it.
- **... has pages** (or **simulation settings**, or **links on its parts**)**, which this tab's Piper
  is too old to keep: reload the page, then make your change again** (`drawing_newer`): the tab was
  opened before Piper had pages (or kept parts' settings in a simulation, or links on parts), and
  saving from it would leave them out. Reload it, which gets the new Piper, and make your change
  again.
- **Part ...'s link ... isn't an http, https, or mailto link** (`invalid_drawing`): a link on a part
  can only open a web page (`https://`, `http://`) or an email (`mailto:`), with no spaces in it, so
  opening it from the part can't run anything. Piper's own Add a link won't take any other, so
  this comes from a drawing sent another way (the API). Fix or remove that link, and save again.
- **Two parts or lines share the id ...**, **The drawing has text that isn't valid Unicode**, and
  the like (`invalid_drawing`): the drawing as the web app sent it isn't one the server keeps.
  Reload the diagram; if it keeps happening, tell an admin, with what you did.
- **Name at least one approver besides yourself**, or **Account ... isn't an active member**
  (`needs_approver`): a release needs someone else to approve it. Pick approvers from the team.
- **Revision ... is waiting on ... to approve it** (`release_pending`): a diagram has one release
  waiting at a time, and a revision waiting to be released keeps its name. Its approvers approve
  or reject it, or whoever asked withdraws it, first.
- **Revision ... isn't after Rev ...** (`older_than_released`): each release is of a revision
  after the last one released. Release a newer revision.
- **Revision ... is Rev ..., released: it stays as it was** (`revision_released`): a released
  revision never changes, its name included. Name a later revision instead.
- **Only the approvers named for this release can approve or reject it** (`not_an_approver`):
  ask whoever asked for the release to ask again, naming you.
- **This release was ... already**, or **You've approved this release already**
  (`already_decided`): the release is over, or you've had your say. History shows where it stands.
- **Only whoever asked for this release, or an admin, can withdraw it** (`not_yours`): ask them,
  or reject it if you're one of its approvers.
- **Only whoever made ..., or an admin, can change it** (or **delete it**) (`not_yours`): a color
  scheme is its maker's (the team's first, YJSP standard, the admins'), since a change reaches
  every diagram that takes its colors again. Make a scheme of your own with **New scheme**.
- **... is the team's default: make another the default first** (`scheme_default`): the team's
  default color scheme can't be deleted. An admin makes another the default on Schemes, then
  this one can go.
- **Only an admin can pick the team's default color scheme**, or **Only an admin can take over
  editing from someone else** (`admin_only`): ask an admin, or ask whoever's editing the
  diagram to finish.
- **There's already a folder called ... there** (`name_taken`): two folders in one can't have the
  same name, whatever its case. Pick another, or use the one there is.
- **... can't go inside itself** (`cycle`): a folder can't move into one of its own folders.
- **... isn't empty: move what's in it out first** (`not_empty`): only an empty folder can be
  deleted. Move its diagrams and folders out (or delete the diagrams) first.
- **That isn't a PNG or a JPEG picture** (`not_an_image`): a picture on a drawing is a PNG or a
  JPEG. Save it as one (File > Export in most programs; a screenshot is a PNG), then add it.
- **A picture can be up to 5 MB**, or **That picture is ... by ... pixels** (`too_large`): save
  it smaller (fewer pixels, or a JPEG instead of a PNG for a photo), then add it.
- **... is a Visio drawing from before 2013 (.vsd)**, or **... is a Visio XML drawing (.vdx)**:
  Piper reads Visio 2013 and later's .vsdx files. Open it in Visio, save it as a .vsdx (File >
  Save As > Visio Drawing), and import that.
- **... isn't a Visio drawing (.vsdx), or it's damaged**, **...: it has no pages**, or **Its ...
  isn't XML Piper can read**: the file isn't a .vsdx, or it's damaged. Open it in Visio and save
  it again, then import that.
- **A page has more than 20000 shapes**, **Its ... is too big to read here**, or **A drawing can be
  up to 2 MB** (`too_large`) on importing a Visio drawing: it's too big to import whole (what's
  drawn as Visio drew it keeps every outline). In Visio, delete what the P&ID doesn't need (old
  pages, pictures, hidden layers), or save its pages as drawings of their own, and import those.
- **A part of an imported drawing is drawn as it was in Visio, not as Piper's part**: Piper didn't
  know it, by its stencil's name or by its tag. Drag the part it is from the library onto it,
  give it its tag, draw its lines to it, and delete the figure; the import lists the symbols it
  drew this way.

### Asking Claude

- **Claude isn't set up on this server**, or **Claude has nothing to read on this server**
  (`assistant_off`): the site isn't set up to ask Claude, or has no help for it to read. An admin
  can ask whoever runs the server; meanwhile, search this help.
- **Claude has spent this month's budget for questions: it answers again on ...**
  (`assistant_month_spent`): its answers this month have cost what the site sets aside for them
  each month. It answers again on the day it says, the 1st of next month (from 00:00 UTC, which
  is the evening before in the US); meanwhile, search this help.
- **Claude has spent its budget for questions** (`assistant_spent`): its answers have cost what the
  site set aside for them in all, so it stops until that's raised. An admin can ask whoever runs
  the server to raise it.
- **Claude is out of API credits** (`assistant_no_credits`): the site's credits for Claude have run
  out. Credits that come each month come back with the next month's; otherwise, an admin can ask
  whoever runs the server.
- **Claude has reached its monthly spending limit at Anthropic: it answers again on ...**
  (`assistant_spend_limit`): Anthropic stopped the site's questions at a monthly limit on its
  account there, which starts again on the 1st (at 00:00 UTC, the evening before in the US). An
  admin can ask whoever runs the server to raise it sooner; meanwhile, search this help.
- **You've asked Claude as much as one person can in a day** (`assistant_daily_limit`): each
  person's questions can cost so much in 24 hours. As your questions from 24 hours ago fall out of
  that, you can ask again.
- **Claude is still answering your last question** (`assistant_busy`): Claude answers one question
  of yours at a time. Wait for the answer, or click *Stop*, then ask.
- **This conversation is too long for Claude: start a new one**,
  **A question holds up to 20,000 characters**, and the like (`bad_conversation`): a question, or
  the conversation so far, is longer than Claude takes. Shorten the question, or click
  *New conversation*.
- **Claude is overloaded or down**, **The server couldn't reach Claude**,
  **Claude's answer broke off**, and the like (`assistant_failed`): Claude didn't take the question,
  or its answer stopped partway. Try again in a minute or two, or ask another way if it says to; if
  it says Claude's API key isn't working, tell an admin.

### Anything

- **Nothing to check in**, **... is listed twice**, and other messages that say what's wrong
  (`bad_request`): a request that can't be done as asked. Do what the message says.
- **Not found**, **There's no ...**, or **... not found** (`not_found`): it isn't there (deleted, or
  never was), or you can't see it. Reload the page; for access, ask an admin or the folder's lead.
- **You need ... access**, and other refusals (`forbidden`): your role doesn't allow it. Ask an
  admin, or for Vault, the folder's lead.
- **... is deleted: restore it first**, and other clashes (`conflict`): what you asked for clashes
  with how things are now. Reload the page, and do what the message says.
- **... MB aren't accepted**, and other sizes (`too_large`): see
  [Uploads and downloads](#uploads-and-downloads).
- **Sign in first** (`unauthorized`): see [Signing in and accounts](#signing-in-and-accounts).
- **The server said** and a number, or **Can't reach the server**: no code, since the answer wasn't
  one of the server's own, or none came. The site may be restarting, or out of reach from where you
  are: check your connection, wait a minute, and try again. If it keeps happening, tell an admin.

## Glossary

- **Check out**: take a file to change it, on one computer (or in the web app); everyone else can
  still open it, read-only, until you check it in.
- **Check in**: save your changes to the vault as a new version, with a comment saying what
  changed; it ends your check-out.
- **Version**: a file's contents at one check-in, numbered v1, v2, v3...; versions never change, and
  every one is kept.
- **Workspace**: your computer's copy of the vault, at `C:\VLT` on every computer so assemblies find
  their parts; it holds only the files you've opened, checked out, or got.
- **References**: the files a file uses (an assembly's parts and sub-assemblies, the part or
  assembly a drawing shows), recorded at each check-in with the version of each.
- **Drawing**: a SolidWorks drawing (`.SLDDRW`); in the vault, it shows a part or assembly there,
  and is named after it.
- **Viewer, editor, lead**: the roles a folder gives, for everything in it. Viewers browse and
  download; editors also change files; leads also release check-outs and decide who has access.
- **Admin**: an account that can do everything, everywhere, and manages people and the whitelist
  (Admin, in the account menu).
- **Admin mode**: a switch in the account menu, for admins and folder leads, that adds releasing
  someone's check-out, and reverting a file they have checked out.
- **Trash**: where deleted files and folders wait, with their history; each folder has its own, and
  *Restore* brings things back.
- **Caliper**: Vault's 3D viewer in the browser, for parts, assemblies, and STEP, IGES, and STL
  files: turn them, cut them, and measure them, without SolidWorks.
- **The `vault` command**: Vault on the command line (`vault.exe`, from the web app's SolidWorks
  page), sharing the add-in's workspace and sign-in.
- **Dataset**: one uploaded file of test data in Yorg, read into channels; the file is kept as it
  came.
- **Channel**: one column of a dataset (a PT, a TC, a load cell, a valve's state), with its unit and
  its times.
- **Calculated channel**: a channel worked out from others by an expression, like `[LC-1] + [LC-2]`;
  it's the whole team's, in every dataset that has the channels it uses.
- **View**: plots saved for everyone, which open with any test's channels of the same names.
- **Mask**: a test on channels, like a valve open, that shades the plots where it holds and can hide
  the data elsewhere.
- **T0**: the time the plots count from, so time reads T−10, T0, T+15.
- **Marker**: a named line across the plots at a time (*M*); drag it to move it.
- **Script**: Python kept for everyone in Yorg's Scripts, working on the tests attached to it, and
  run in your browser.
- **Notebook**: how a script is laid out: cells run one at a time, sharing their variables, as in
  Jupyter.
- **Simulation**: a P&ID run as a model of its system, with FullFlow, against a test from Yorg, in
  Piper's Simulation mode (admins', while it's tried out).
- **Knob**: a setting of a simulation's part marked *tune*, which Tune… can fit or anchor to a test.

## Getting more help

- **The rest of the help page**: [the user guide](../README.md), and
  [the SolidWorks add-in's](../client/src/Vault.SolidWorks/README.md), with its
  [When something goes wrong](../client/src/Vault.SolidWorks/README.md#when-something-goes-wrong).
  Signed in, members also see how Vault and Yorg work inside. In the web app, Yorg's *Help* page
  has Yorg's keys, and Vault's SolidWorks page has "If something's not right".
- **Ask Claude**: signed-in members can ask Claude from *Help*, the question mark at the top right
  of the web app. It has read this help, and answers from it with links to it, but it can be wrong:
  check what it says in the app. When it can't answer, it says why (see
  [Asking Claude](#asking-claude)).
- **An admin, or the folder's lead**: for access to a folder, a check-out someone left behind, an
  account waiting for approval, or the whitelist.
- **For the add-in**: its log, `%LOCALAPPDATA%\Vault\addin.log`. Send it with what you clicked, and
  when.

When you ask, give the message as you saw it, the file or dataset, and what you clicked.
