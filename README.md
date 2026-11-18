# Engineering Tools

The team's engineering tools, on one site: **Vault** (`/vault`), for
the team's SolidWorks and STEP files; **[Yorg](#yorg-test-data)** (`/yorg`), for its test
data; **[Piper](#piper-pids)** (`/piper`), for its P&IDs; and
**[Buildflow](#buildflow-bills-of-design)** (`/buildflow`), for each program's bill of design.
The site's address on its own shows all four (the team's logo at the top left goes back to it),
how full the server's disk is, and how much of it each takes, and **[deals](#deals)** on eBay for
what the team wants; the switcher beside the logo, the four names with a dot between each,
goes between them.

> **Status:** early development. The server, the web app, and Vault's `vault` command-line
> tool work and are tested. Vault's SolidWorks add-in had its first run in SolidWorks
> in September 2026, and is for SolidWorks 2026 since October 2026. See [docs/design.md](docs/design.md) for how the site works, and
> [docs/vault.md](docs/vault.md), [docs/yorg.md](docs/yorg.md), [docs/piper.md](docs/piper.md), and
> [docs/buildflow.md](docs/buildflow.md) for each app and its roadmap.

## About

YJSP, the Yellow Jacket Space Program at Georgia Tech, built these tools for its own team, and runs
them on its own site ([The live site](#the-live-site)). **Its demo**, at `/demo`, is the site as a
made-up team's, the Liquid Rocket Team's, with made-up data: a rocket, its tests, P&IDs, and bill of
design, for anyone to look around without signing in (send someone the link), and for no one to
change. Any team can run a site of its own, with its own name, its school's sign-in, and its own
data: [docs/self-hosting.md](docs/self-hosting.md).

The rest of this page is also each site's user guide: its help (`/help`) shows it, all but this
section and the ones about the code and YJSP's own site, so it's written for any team's site.

## Signing in

Sign in with your school's account, on its own login page (the sign-in page's button names
the school): it's how new people join. Anyone with an account at the school can, unless an
admin turns on the whitelist (Admin > Whitelist, from the account menu at the top right): then
only the school's addresses on it, and people an admin invites, can, and anyone else who signs
in is told to ask an admin to add theirs. Admins put the team's emails on the whitelist by uploading a roster's
CSV, or one at a time, and see who on it has joined.

Google signs in to accounts already there: one made with Google before, or an admin's
invite; and, at a school whose accounts are Google's, the school's own people, as above.
Someone without an account at the school (a mentor, say) joins by an invite to the address
they use with Google (Admin > People). Admin > People also shows how many people used the site
each day this past month and how long they spent on it (on the web app, and working in
SolidWorks with the add-in), who has the SolidWorks add-in (on
how many computers and which versions, and how many people in all), what Claude in Help has
cost, and on whose questions, how hard the server is working
(whether the site is overloaded), how many people there are and how many are on now, and
when each joined and was last on. Change the name everyone sees you by
from your account menu.

Under who has the add-in, admins can set the oldest version of the add-in and the `vault`
command that can change the vault, for when the team needs a release's fixes: older ones can
still open, get, and browse files, but checking out, checking in, and anything else that
changes the vault says to update first. It's off until an admin sets it, and it can be no
newer than the `Vault-Setup.exe` the site offers, so everyone can update to it.

Joined with Google, at a school whose own sign-in isn't Google's? Keep signing in with Google
for now. Signing in with the school's account finds your account only if its email is your
school address; otherwise it makes a new, empty one, and what you have checked out stays
with the old one.

## Help

The help is at the site's address with `/help` after it, for anyone, signed in or not: this
guide, the SolidWorks add-in's, and [troubleshooting](docs/troubleshooting.md), which says what
every error means. Search it (Ctrl+F) for words from a message you saw. **Copy for an AI**, at its
top, puts all of it on your clipboard as Markdown, to paste into a chat with an AI assistant you
use, or give the assistant the address of `/help.md`. Signed in, the help also has how Vault and
Yorg work inside.

In the web app, **Help** (the question mark at the top right) opens beside the page you're on:
the help, the app's own (Yorg's Help page, Vault's SolidWorks page), and Claude, to ask how to do
something or what an error means. An error on the page is offered as a question, in a click.
Claude has read all of the help, and answers with links to it, but it can be wrong: all it knows
is the help, and it can't see your files or change anything. What you ask goes to Anthropic, so
never paste a password or a key. The tab keeps the conversation until you start a new one. Each
person can ask so much a day, and the server sets what Claude may spend each month, or in all;
admins see what it has spent, and on whose questions, on Admin > People. There, *Keep the help
loaded* says whether the server keeps the help loaded for Claude around the clock, so every
question costs a fraction of one that has to read all of it, or only for some hours after each
question, for a team that asks rarely.

**Report a bug or idea**, Help's other tab, sends the site's owner a bug report or a feature
request, with the page you're on. Say what you did, what happened (an error's exact words, if
there was one), and what you expected; or what you'd like, and what it's for. Claude looks at
it first, from the help, and the owner decides whether Claude Code builds it: approved, it
becomes a change the owner reviews like any other. *Your requests*, under the form, says what's
become of each, with any reply. You can send 10 a day. Admins see every request on
Admin > Requests, with Claude's look at it, and can decline one, saying why, or mark one done;
only the owner can approve one, as Claude Code builds it on their Claude account.

## Vault: CAD files

Version control for the team's SolidWorks and STEP files: check out, check in, version
history, and per-folder permissions, from SolidWorks, the command line, or the web. It
replaces Kenesto.

- **Check out a file before you edit it.** While it's checked out, everyone else
  can open it read-only. Check it back in with a comment to save a new version.
- **Every version is kept.** See who changed what and why, and download any old
  version.
- **Fix a check-in's comment** with **Edit comment…** beside it in a file's history on the
  web: a typo, or a note that says too little. It's one comment for every file checked in
  together, so it changes on all of them; the files stay as they are (no new version, no
  check-out). Whoever checked it in can change it, and so can a lead of the folders its
  files are in. The history says it was edited, by whom and when, and the activity log
  keeps what it said before. A revert's comment ("Reverted to v2: …") stays as it is.
- **Assemblies stay consistent.** An assembly is checked in together with the new
  or changed parts it uses. Getting an assembly brings its parts along. Saving one in
  SolidWorks saves its changed parts too, and SolidWorks 2026 counts every part saved in
  an older SolidWorks as changed: Vault asks once about those you haven't checked out
  (No, the default, leaves them as they are), not once for each.
- **Drawings stay with what they show.** A drawing is checked in only if it shows a
  part or assembly in the vault, and only if it's named after it (`Fin.SLDDRW`, or
  `Fin - machining.SLDDRW`, for `Fin.SLDPRT`), so it sits next to it in its folder.
  Check drawings in from SolidWorks: the `vault` command can't read what a drawing shows.
- **Access is per folder:** viewer, editor, or lead, plus admins. Subteams can own
  their folders.
- **Every file has a title,** what it's called (`Fin bracket`), shown with its name
  wherever it says more than the name does: once part numbers make CAD files' names
  numbers, the title says what each one is. A file's title starts as its name without its
  type; anyone who can edit the file changes it with **Edit title…** on its page, which
  isn't a new version and doesn't need it checked out. A renamed file lists the names it
  had ("Formerly …"), and search finds it by them too.
- **Part numbers** (`00000123-001`: eight digits the vault hands out in order, then a
  kind, from a list admins keep) name parts and assemblies, for good: a file that took one
  can't be renamed. A file takes a number when it's named by exactly one the vault handed
  out; any other name that looks like a number (your team's own, say) goes in as it is. A
  drawing or PDF of a numbered part is named after its number
  (`00000123-001 - machining.SLDDRW`). Vendors' parts keep their vendors' names. Ground
  Structures' numbers stay as they are, and its new files can use the vault's numbers or
  the team's own. Once an admin turns them on, **New part** or **New assembly** in the web app asks
  what kind it is and what it's called (its title), gets the next number (numbers you got and
  haven't used yet come first), and starts it in SolidWorks. When you upload vendors' parts,
  tick that they're vendors': they keep their names. Admins turn numbers on (offered, then
  required), keep the list of kinds, and skip the next number ahead in Admin > Part numbers.
  In SolidWorks, the Vault tab's Browse shows titles after names (right-click a file for Edit
  title), and right-click a folder for New part or New assembly; checking in, tick that new
  parts without numbers are vendors'.
- **An admin can pause the vault** (Admin > Part numbers) for work on all of it, such as
  numbering every file at once. While it's paused, a banner says who paused it and why, and
  check-outs, check-ins and other changes wait; you can still look at everything, download,
  and undo your check-outs.
- **See everything on the web:** browse the vault with a folder tree beside the files;
  search by name or title and filter by kind, status, date, and person, and sort by name, date,
  or size; see what each assembly contains and which assemblies each part is in, at every
  level, and whether each file is checked in, who created it, and who changed it last;
  see each file's history and drawings and who has what checked out;
  download any version; follow the activity as it happens; start new parts,
  assemblies, and drawings, which SolidWorks makes on your computer; and organize the
  vault: new folders, uploads (files, whole folders, or what's in a zip, by dropping them
  on the page), moving or renaming, which every computer's copies follow, and deleting,
  to a trash each folder keeps. Admins and folder leads find Admin (people, access, the
  whitelist, and how full the server's disk is) and admin mode in the account menu; admin mode releases someone's check-out
  or reverts a file they have checked out.
- **See any part or assembly in 3D** with **Open in Caliper**, beside Open in SolidWorks:
  in the browser, on any computer, without SolidWorks. Turn it, zoom, pick a standard view,
  cut it with section planes across X, Y, and Z, and measure: a face's area, a hole's
  diameter, an edge's length, and the distance or angle between two faces, edges, or
  corners. In an assembly, show, hide, or isolate its parts, and open a sub-assembly or a
  part on its own. Nothing in it changes a file. STEP, IGES, and STL files open as they are.
  A strip under the header says what you're looking at: the version and whether it's the
  latest, where the view is from, and how much of an assembly is shown. An assembly shows
  the latest version of every part in it, as SolidWorks opens it, each where the assembly
  last had it; pick an older version of the assembly to see it as it was checked in.
  SolidWorks parts and assemblies show the 3D model Vault for SolidWorks makes of each
  version it checks in, which is exactly what SolidWorks draws; for any other version, the
  server reads the 3D view SolidWorks saved in the file (any SolidWorks up to 2026), in the
  configuration it was saved in, a few minutes after it's checked in, so it's ready when
  you open it. Pick
  another configuration from the Configuration list: the server reads it from the solid
  SolidWorks keeps of it in the file, which SolidWorks does for each configuration that was up
  to date when it saved (one shown since the file last changed, or one with a Rebuild/Save
  Mark: right-click it in SolidWorks' ConfigurationManager). One it didn't keep says so; to see
  it, check the file out, show that configuration (or add the mark), save, and check it in. An
  assembly shows each of its parts that's in the vault, read from the part's own file, even
  if it was uploaded in the web app, and the STEP and IGES files placed in it, in each of its
  configurations. Checked in from SolidWorks, it shows the parts that aren't in the vault
  too (Toolbox screws, say), as SolidWorks had them. Caliper lists every part it couldn't
  show, and why, and marks any that shows an older version or another configuration than
  the assembly uses. A part saved without
  its 3D view, as vendors' parts often are, is drawn from the solid SolidWorks keeps in it,
  in the colors SolidWorks shows, and so are routed tubes, which their assembly keeps inside
  its file. The server reads a version's model once and keeps it; when an update reads files
  better, it reads each one again the first time it's opened after. If Caliper can't read a
  file, it says so: open the file in SolidWorks and click Make 3D view on the Vault tab.
- **See drawings and DXF files** with **Open in Caliper** too. A SolidWorks drawing shows
  as a PDF of all its sheets, as SolidWorks prints them, in the browser's own PDF viewer (to
  zoom, print, or open in a tab of its own with Open PDF): Vault for SolidWorks saves one
  each time it checks a drawing in. A version from before (or from Kenesto, or checked in
  from the web) shows the pictures of its sheets SolidWorks saved in it, which are too small
  to read: open the drawing in SolidWorks and click Make PDF on the Vault tab. The strip
  under the header says which it is, and who made the PDF and when. If the part or
  assembly a drawing shows has been checked in since the drawing was, Caliper warns that
  the sheets may show its older shape, as SolidWorks redraws the views from the latest:
  check the drawing in again from SolidWorks to update them. A DXF file (a
  flat pattern for the laser cutter or waterjet, say) is drawn as it is, in its own units:
  drag to pan, scroll to zoom, show and hide its layers, and measure a line's length, a
  hole's diameter, or the distance between two holes, lines, or corners.
- **Check out and in on the web** too, to change a file without SolidWorks (a PDF, a STEP
  file, or on a computer without the add-in): Check out on its page (or for files picked
  in a folder), download it and change it, then Check in… with the new version, or
  upload it into its folder. A check-out there is "in the web app"; in SolidWorks, the
  Vault tab offers to move it to that computer when you start changing the file. An
  assembly checked in on the web doesn't list its parts until it's next checked in from
  SolidWorks; a drawing stays linked to what it shows.
- **SolidWorks in one download:** the web app's SolidWorks page offers `Vault-Setup.exe`,
  which installs the add-in, and a button that connects it to the vault. When there's a
  newer add-in, **Update** appears at the top of the Vault tab: take it soon, since admins
  can have the vault stop taking changes from older ones. If they have, the Vault tab says
  the add-in is too old to make changes: click Update and close SolidWorks (or run the new
  `Vault-Setup.exe`); until then, you can open and get files as before.
- **When Open in SolidWorks can't open a file,** Vault says why: the Vault tab comes to the
  front with what it's doing, and a message says what went wrong (a file saved in a newer
  SolidWorks, the add-in turned off, still busy with your last click). Nothing at all
  happens on a computer without the add-in. `%LOCALAPPDATA%\Vault\addin.log` has a line for
  each click; the SolidWorks page's "If something's not right" has the rest.
- **Bringing files over from Kenesto:** upload the project folders as they are (the web
  app takes whole folders), so `09_Hopper` stays `09_Hopper`. Assemblies from there still
  name their parts where Kenesto had them (`K:\Team\Project
  CAD\09_Hopper\Stringer.SLDPRT`), and the web app can't read that. So open them from
  the Vault pane in SolidWorks, or with Open in SolidWorks on the web: the add-in reads the
  paths from the files, gets the vault's files whose paths end the same way, and shows
  SolidWorks where they are. A STEP file placed in one with 3D Interconnect comes along
  too: SolidWorks names it by a copy it made, and the add-in gets the STEP file that copy
  was made from (of two with its name, the one nearest the assembly). It says which parts
  aren't in the vault. Check an assembly out, save it, and check it in to store the vault's paths in it for good; while it still
  uses files the vault doesn't have, checking it in lists them, to upload them or take them
  out of it. Once the team works from the vault, disconnect Kenesto's drive, so no one
  opens a part from there.
- **Move files with Move, not by uploading them again:** Move or Rename in the web app
  keeps a file's history, and refuses a move that would leave an assembly without its
  parts. Uploading a folder again under another name and deleting the old one starts every
  file's history over, and assemblies saved before still name the old folder. The add-in
  finds the new copies when it opens such an assembly (the file whose path ends the same
  way, in a folder of the same name at least), but check the assembly out, save it, and
  check it in, so it names them for good.

## Yorg: test data

The site's second app, **Yorg** (the switcher is at the top left), is for the team's
test data: upload a CSV from a hotfire or cold flow, and plot its channels
together on one time axis. Help, in Yorg's top bar, has all of this on one page, with
the keys.

- **Upload a file** (Upload data, or drop it on the page): a column of times and a
  column per channel (PTs, TCs, load cells, valve states). Yorg works out the rest: the
  delimiter (comma, tab, semicolon, spaces; decimal commas too), notes above the column
  names, units (`PT-1 (psi)`, `PT-1 [psi]`, a row of units under the names, units written
  with every value like `23.958 V`, or a name ending in one, `Pressure PSI`), and
  which column is time and in what format (seconds, milliseconds, Unix time, or dates
  and times). Channels logged at a slower rate in the same file keep their own times; a
  text column becomes a state (CLOSED/OPEN, a mode; a valve logged as closed, 1, fault,
  open reads closed = 0, open = 1, fault = 2) or, if it's mostly empty, events,
  like a sequence's IGNITION, which show as markers. If it guessed wrong, change how it's
  read on the dataset's About page: the file is kept as it was uploaded.
- **Folders:** New folder makes one (a test campaign, a day of cold flows). Drag datasets
  onto a folder, or onto a folder above in the path at the top, or check some and Move
  to…. The list shows each dataset's size, and Find datasets looks in every folder.
- **Deleting:** check datasets and Delete… to delete them together (or delete one from its
  About page): your own, or anyone's if you're an admin. Deleted datasets wait in Deleted
  datasets, at the foot of the list: Restore one, or check several and Restore them
  together, back in their folders.
- **Plot:** click a channel to add it to the selected plot (click it again to take it
  off), shift-click for a plot of its own, or drag it onto one. Each unit gets an axis
  of its own, so thrust, pressures, and valves share a plot, each on its scale (psi on
  the left, lbf on the right, the valves further out); drag a channel in a legend onto
  another axis, a new one, or another plot. Plots share the window's height, the time
  window, and the cursor. Drag across a plot to zoom to that time (shift-drag: a box),
  right-drag to pan, scroll to zoom; arrow keys, Home (everything), and Backspace (back)
  work too. The legend reads each channel's value at the cursor.
- **Calculated channels:** New calculated channel (under a dataset's channels) makes one
  for the whole team from an expression, like `[LC-1] + [LC-2]` for total thrust or
  `where([FM-FU] > 0.05, [FM-OX] / [FM-FU])` for O/F while fuel flows; `ddt`,
  `integral`, `smooth`, `avg`, and the usual math are there too. It shows in every
  dataset that has the channels it uses, and plots like any channel. One can use
  another by its name: make `mdot` once, then CdA as
  `[mdot] / sqrt(2 * 997 * ([PT-1] - [PT-2]) * 6894.76)`, never one that comes back to
  itself. Comparing datasets (two loggers' files of one test, say), one can use channels
  of more than one of them: it's worked out on the first one's times, with each lined
  up as it's shifted on the page, and listed under **Across datasets**. The expression's
  box colors channels, calculated channels, and functions, and colors parentheses by
  depth, boxing the pair at the cursor (and marking one without a partner) so you can
  see what goes together. Masks can use calculated channels too.
- **Scale, label, and line up:** a channel's settings rename it and set its color, a
  scale and offset (volts to psi, psi to bar) with its unit, its axis, and lines or
  steps. Set T0 (type a time of day or a Unix time, click the plot, or pick an event like
  MOV OPEN) and time reads T−10, T0, T+15; drag its line to move it. Unix-time data reads
  as time of day in UTC (or your computer's zone, in Options) until then. Add markers
  (drag them to move them) and fix an axis's range. Compare with another dataset to
  overlay two tests, shifted in time to line them up: it opens in the folder of the test
  you're looking at, and you go into a folder, back up by the path above, or type a few
  letters of a name to find it in any folder.
- **Masks:** Mask makes a test on channels, like the main valve open or a pressure over
  its redline: pick a channel, a comparison, and a value (a valve's OPEN, by name), or
  write one like a calculated channel (`and([MOV-OX] == 1, [PT-CHAMBER] > 450)`). A mask
  shades the plots where it holds, and can hide data everywhere else (Hide, in the list
  on the left); a compared test is masked by its own channels.
- **Split a file into its tests:** Split makes a dataset of each test in a file of
  several: where a mask holds (from a second before each valve opening to two after, say,
  with chatter joined and blips left out), cut at times you type or at your markers. Each
  test's time can start where its valve opened. They go in a new folder next to the file,
  or in a folder there is, chosen from the datasets' folders (it opens where the file is,
  and New folder makes one there). The file stays as it was.
- **Labels:** Label (or L), then click a plot: a label with an arrow to the data there.
  Drag the label to move it, or the arrow's tip to point it somewhere else; double-click
  it to change the words, or right-click it for more.
- **Measure:** Measure (or D), then click two points on a plot: the time between them,
  the change, and the slope (per second). Click on a channel and the second point stays
  on it; Esc clears the measurement.
- **Save a view** for everyone, and open it with another test's data: the same plots,
  with that test's channels of the same names (More > Use with another dataset picks the
  test from the datasets' folders, starting in the folder of the view's test). A dataset's
  views are listed on its page (Saved views); open one and Save as a new view to keep your
  changes. Export the plots as an image (labels and all), or the samples in view as CSV.
- **Views' folders:** the Views tab keeps views in folders of their own (not the datasets'),
  and works as the datasets' list does. New folder makes one where you are; open one to see
  what's in it, with the way back up above its name, and rename it, or delete it once it's
  empty (your own folders, or anyone's if you're an admin). Drag views or folders onto a
  folder (or a folder in the way back up) to move them, or check views and Move to…, or
  Delete… to delete them together, for good (the data stays). Only whoever saved a view, or
  an admin, moves or deletes it. Find views looks in every folder (names, folders, notes,
  and data), and says where each is. A view's folder is also picked when you save it, by going
  into it as the Views tab does (or finding it by name, or making a new one where you
  are with New folder), or later with More > Rename or move.
- **Copy link** (beside Save view, on a dataset's or a view's page) to send someone what's
  on screen without saving a view: the plots, the tests compared and their shifts, the time
  in view, T0, and the rest. Whoever opens it sees those plots as unsaved changes, and can
  Save view to keep them; on a dataset's page they become the plots their browser keeps for
  it.
- **Scripts:** a Python notebook. Its cells run
  one at a time in the notebook's variables, so the cell that loads the data runs once and
  the ones after it as often as you change them: Shift+Enter runs a cell and goes on, Run all
  runs them in order and stops at one that fails, and each cell's output is under it. Text
  cells are Markdown. After Escape, Jupyter's keys move between cells and add, delete, and
  turn them into text or code (the keyboard button in the notebook's bar lists them). A script
  works on the tests attached to it (Data, beside it; Attach a test picks one from the
  datasets' folders, starting in the first one's): their channels are listed there, and a
  click puts one in the code (`yorg.channel("PT-TANK")`, or with `dataset="Hotfire 4"` for
  another test). Beside it too, the **Reference** says what the `yorg` module has: each name
  with what it does, found by a word, and an example that **Insert** puts in your code. The editor
  colors Python, folds, finds and replaces (Ctrl+F), and suggests as you type: channels in
  quotes, what the module has after `yorg.`, and what your variables have, from the running
  Python (`pt.` offers `values`, `t`, `si`...); hovering a name says what it is, and a syntax
  error is underlined as you type it. Work them over with NumPy, SciPy, pandas, matplotlib, and
  CoolProp (pure-Python packages install from PyPI with micropip); `yorg.plot` draws on Yorg's
  plots, matplotlib's figures show as images, and `yorg.download` offers a file to save. Python
  (Pyodide) runs in your browser, sandboxed from the site, and stays open while the tab does:
  come back to Scripts and its imports and the channels it had are still there. While a
  script's open, Python gets its slow imports ready (CoolProp's first import reads its whole
  fluid library: 20 seconds to a minute), so Run can go straight away; Run while Python's busy
  and the run waits, saying for what. As it runs, the output says each step (loading
  packages, importing a module, running your code) and how long it's taken, and after, how
  long the run took and where the time went. Scripts are kept for everyone in folders
  (chosen above the script from the scripts' folders, where New folder makes one, or dragged
  onto one in the list of scripts), with their tests, as .py code with a `# %%` line starting
  each cell (as VS Code and
  Spyder read them); upload .py files as scripts and download scripts as them. Anyone can
  open and run a script; only whoever saved it (or an admin) can change or delete it, and
  saving someone else's keeps a copy of your own.
  Examples to start from: a channel's peak, an injector's CdA, ullage gas from CoolProp, a
  spectrum, and more.
- **Python on a dataset or a view:** **Python** on its page docks a notebook
  beside the plots, started on what they show: its cells work on the page's channels, with
  `yorg.window` the time in view (as it is when a cell runs), and what they `yorg.plot` goes on
  the page's own plots, on the same time axis (× takes one off). Drag its edge to widen it;
  the book opens the Reference in the notebook's place, and **Open in Scripts** keeps it as a
  script. **Model** runs a model on the test over the time in
  view, and links back to it.

## Piper: P&IDs

The site's third app, **Piper** (the switcher's at the top left), draws the team's fluid
systems: P&IDs of the test stands, the vehicle's feed system, and the GSE, with the parts
the team uses, each tagged and described, lines in their fluids' colors, and valves in the
colors of their normal states. Help, in Piper's top bar, has all of this on one page, with
the keys.

- **Diagrams**: in folders, as Yorg's datasets are. **New folder** makes one where you are;
  open one to see what's in it, with the way back up above its name, and rename it, or delete
  it once it's empty. **New diagram** makes one, empty or from an example (a pressure-fed
  engine's feed system; for admins, three P&IDs to simulate too), in the folder you're in. Drag
  diagrams or folders onto a folder (or a folder in the way back up) to move them, or check
  diagrams and **Move to…**. Everyone can open, edit, and move every diagram, and make and
  change folders; whoever made a diagram (or an admin) can delete it, checked ones together
  with **Delete…**, to **Deleted diagrams**, where they're checked and restored together.
  **Find diagrams** looks in every folder, in names, folders, and the tags on each drawing:
  PT-101 finds every diagram it's on, each says its folder, and each opens at it. A diagram's
  name, at the top of it, renames, moves, or describes it: its folder is chosen from the
  diagrams' folders, starting in the one it's in, and New folder makes one there. In a diagram,
  **Find a tag** (Ctrl+F) goes to a part by its tag (PUREG, PT-101) or what it is, on whichever
  page, and **Parts** opens every part of the diagram in a table on a page of its own (in a new
  tab): click a column to sort by it, show only valves, instruments, tanks, one fluid, or one
  page, find a tag or a model, and save what's shown as a CSV. A tag opens the drawing at its
  part.
- **Editing**: a diagram opens to be looked at. **Edit**, at the top, makes it yours to change:
  one person edits a diagram at a time, so no one's changes go over anyone else's, and the
  diagrams list and everyone with it open see who's editing it. **Done editing** saves what's
  left and lets it go; so does closing the tab, and leaving it alone for about 25 minutes (a
  laptop shut: ten). While someone else edits it, you can still look around it, read its parts,
  see a test on it, and export it, and what they save shows within half a minute. An admin can
  **Take over**; whoever had it is told, and a change of theirs after that can be saved as a
  new diagram. A diagram you've just made opens ready to edit.
- **Pages**: a diagram can have pages, as a P&ID's sheets are (the vehicle, the GSE): tabs at
  the foot of the drawing, **+** to add one, and each one's **⋯** menu to rename, move, or
  delete it (undo brings it back). **Printed sheet**, with nothing selected, picks a page's
  paper: its outline shows on the drawing, border and title block corner, and the page prints
  just there; **Fit the sheet to the page** moves it to what's on it. An **Off-page connector**
  goes to another page, and a part on it (**To page**, **At**): **Go to**, or a double-click,
  goes there, and the part it arrives at lists it under **Comes from**. A part can be drawn on
  more than one page (the pressurant and propellant systems on sheets of their own, to print,
  and a combined schematic, to look at online): parts pasted onto another page keep their tags
  and are taken out of the parts list, so it has each part once; **In the parts list**, in a
  part's panel, takes one out or puts it back. Once a diagram has
  pages, a tab opened before Piper had them is told to reload rather than save one page of it.
- **Parts**: drag one from the library on the left (search it: valve, PT, COPV, cav, 3x2...), or
  click it and click where it goes. Valves (ball, solenoid, pneumatic, motorized, needle,
  check, relief, regulators, burst discs, quick disconnects, 3/2 and 5/2 solenoid valves...),
  tanks (1 to 5 ports on the top and on the bottom: **Top ports** and **Bottom ports**, on the
  right; every port on its top is its ullage), bottles and COPVs, orifices and venturis, flow meters, filters, diffusers, instruments,
  engines, pumps, vents (a spray), tees, manifolds (2 to 8 outlets: **Outlets**, on the right), a
  box for anything else, shapes and arrows, notes, regions, a legend, a title block, and pictures of your own (a PNG
  or a JPEG of an injector or a TCA, up to 5 MB: drop it on the drawing, or **Choose a picture…**
  on the right; it keeps its shape as it's sized, and the exports have it). What works a valve is
  on a stem above it: a handle, or a box with S (solenoid), P (pneumatic), or M (motor). The 3/2
  and 5/2 solenoid valves are drawn as pneumatic schematics draw them (ISO 1219): a box for each
  position, the solenoid at one end and the return spring at the other, their ports numbered as
  ISO 5599 numbers them, and the position they're in tinted in their state's color. An
  instrument is a bubble with the letter of what it measures in it, whatever its tag says (P
  for pressure, T for temperature, F, W, L, Z, PD), and its whole tag at its side;
  a duplicated or triplicated transducer is two or three bubbles on one tap, reading PT-101A,
  PT-101B (and C). Each part is tagged with the next number free (PT-3); **R** turns it, **F**
  flips it (its words move with it but still read forwards: a flip never mirrors them, and a
  note's, a region's, a legend's, or a title block's stay just as they were), and where parts overlap, **Bring to front** (**]**) and **Send to back** (**[**,
  under the lines too) choose which is on top. Drag the round handle at a selected part's corner (or type its **Size**, in percent)
  to draw it at any size from a quarter of its own to four times, and give it a **Label size**
  of its own, in percent too. A **Text** note dragged
  by its square handle becomes a block of that size, its words wrapped, in bold, italic, a serif
  or monospace font, aligned, and boxed as you choose.
- **Shapes**: the library's **Shapes** (search *cosmetic*) are rectangles, rounded rectangles,
  ellipses, triangles, diamonds, lines, arrows, and double arrows, drawn for how the drawing looks.
  Drag a selected one's square handle to size it. On the right, a shape has a **Fill** (none until
  you pick one), an **Outline** color, an **Outline style** (solid, dashed, dotted, or none), a
  **Weight**, and a **Transparency**; a line or an arrow has its **Arrowheads** (none, at its end,
  its start, or both), a **Direction** (level, or corner to corner across its box, so sizing it
  sets its angle; **R** turns it upright), a **Color**, a **Style**, a **Weight**, and a
  **Transparency**. Black and white are the page's ink and paper, so they read on a dark page too.
  Shapes aren't part of the system: lines route straight through them and labels sit on them, and
  the parts list, the legend, Find, and the simulation leave them out. The exports have them, see-through
  as they're drawn.
- **Lines**: drag from a part's port (the dots on it) to another's, to a line (a tee), or
  anywhere. Lines route themselves around parts, leaving each port the way it faces, and stay
  as they are until their parts move. Drag a segment to move it; **Route automatically** puts
  it back (**Route again** tidies a line that routes itself). A line moved by hand, or brought
  in from Visio, follows its parts, unless that would tangle it (back over itself, into a port
  from behind, through a part, or round a loop it didn't have): then it routes itself again. Parts dragged together take the
  lines between them along, and a tee comes too. Everything snaps to a grid, and a part being
  dragged lines up with what its lines go to (a gold guide shows it; **Alt** drags freely).
  Lines that cross hop over each other.
- **Into a line**: drop a valve (an orifice, a filter...) on a line and it goes into it;
  delete it and the line joins up again.
- **Properties**: select anything to name it and say what it is, on the right: a valve's body,
  actuation, normal state (NO green, NC red, FIP for a double-acting valve that fails in
  place), size, Cv, and MAWP; a tank's fluid, volume, MEOP, and MAWP; an orifice's diameter;
  a sensor's range, model, and what fits what it measures (a pressure transducer's output and
  MAWP; a thermocouple's type, junction, probe, and sheath; a load cell's range and mV/V output);
  a line's fluid, type, size, and MAWP; and any field of your own. Every part that holds
  pressure has a MAWP. The eye beside one shows it under the part's tag.
- **Links**: a part can link to pages about it (an FMV to its Notion page, a COTS valve to its
  spec sheet): **+ Add a link**, under its tag on the right while you're editing, takes a name
  and an address. Anyone looking at the diagram selects the part and clicks a link to open it in
  a tab of its own; a part with links has a small chain mark. Only web pages (https://,
  http://) and email (mailto:) can be linked.
- **Fluids**: each line carries one, in its color (LOX blue, RP-1 red, GN2 green, combustion
  gas rose...); a line drawn from a run takes its fluid, and **Carry along its run** sets it
  on the lines beyond. A line's fluid and a valve's state aren't written beside them unless you
  show them (the eye, or with nothing selected, **Show on every line** and **Show on every
  valve**); a label that's the same along a run (its fluid, or a pipe's tag) is written once,
  on its longest stretch. With nothing selected, change the diagram's fluids' colors and labels, add its own,
  or set its labels' size, in percent.
- **Color schemes**: **Schemes**, in Piper's top bar, has the team's color schemes, each one's
  fluids (color, label, name, gas or not) and valve state colors: anyone makes one, and only
  whoever made it, or an admin, changes or deletes it. New diagrams start in the team's default
  (an admin picks it, and only admins change it), and
  **Colors from**, with nothing selected, gives a diagram another's; when that scheme changes,
  **Take its colors again**. A PDF can be in black and white, to print without color.
- **Saving and history**: a diagram you're editing saves itself as you go; if a save fails,
  **Not saved** beside its name says why, and it tries again on its own (too big: with your
  next change). If you saved it from another window while you had it open here, it asks whether
  to keep this one (the other stays in the history), save it as a new diagram, or load the
  other. **History** lists its revisions:
  look at one, name one (Rev B, for HF-3) to keep it as it is, or restore it.
- **Releases**: for a design review or before a test, **Release…** a revision, saying what
  it's for, to approvers you pick (at least one besides you). Each approves it or rejects it
  with why; once all of them approve, it's released as the diagram's next Rev (A, B...) and
  never changes, and editing goes on in a draft after it. One waits at a time; whoever asked
  can withdraw it. A PDF on a drawing sheet lists the releases and who approved each.
- **Test data**: pick a test from Yorg, in Yorg's folders (it opens in the folder of the test
  chosen, each test says when it was added, and a few letters find one in any folder), and
  each instrument shows its channel's value and each valve whether it was open, in a badge
  on a line to it, at the time on the timeline: drag it or play the test. A part reads the
  channel named as its tag (or its **Test channel**). **Plot in Yorg** opens the test with
  those channels plotted, and the page's address keeps the test and the time. The diagram
  opens to them again in the same browser until you close **Test data**.
- **Simulation (admins, while it's tried out)**: **Simulation**, in the editor's bar, makes the
  P&ID a model of the system, simulated with FullFlow (Saaketh's network solver) and
  ThermoProp's properties against a test from Yorg, to tune it until it matches what was
  measured. What it adds shows only while it's on. The P&ID is the model, drawn as any diagram
  is: tanks, bottles, the engine, and vents hold the pressures; valves, regulators, orifices,
  and venturis carry the flow between them; lines and tees join into one point; and whether a
  part carries liquid or gas comes from its lines' fluids. Select a part and, while you're
  editing the diagram, the inspector's **Simulation** box sets it up: what it is (a bottle as a
  supply at a pressure, or a vessel that blows down), its CdA, opening time, a tank's volume and
  fill and whether its gas is real or ideal; a liquid line can be modeled as a line (friction
  and inertia), and a gas line's box sets the tubing it's part of. Its channels come from the
  P&ID: a valve's command is its Test channel or tag, a pressure transducer reads the pressure
  where it taps, a thermocouple above a tank's liquid reads its ullage, and a flow meter the
  flow through what it's in line with; a tank's, a supply's, or the engine's transducer drives
  it, and the rest are compared. Uncheck a channel in its part's **Simulation** box to leave it
  out and set the conditions yourself: the part then does what its settings say (a valve stays
  where they have it, a tank holds the pressure set on it). In its panel, pick the test, the
  run's window (◷ takes the time on the timeline), the time step, and the solver, and **Run**
  (FullFlow runs on the server): each compared channel is plotted with the model, with how far
  apart they are (RMS and bias). At the time on the timeline, each instrument's badge on the
  drawing shows what the test measured, then the model's value in gold, in the diagram's units;
  a tank shows its pressure, and a valve or an orifice what flows through it, while anything
  does, in gold alone. **Tune…** matches the knobs (settings marked tune) to the test, one of
  two ways it puts side by side: **Fit** runs the model again and again, turning the knobs you
  pick until it matches best; **Anchor** pairs a knob with a sensor, and in one run FullFlow
  moves the knob in every time step until the sensor reads what was measured (give an anchor a
  span where its knob counts, such as a valve's CdA while it's open), fitting what anchoring
  can't settle. **Apply to the P&ID** puts what it found on the parts, once you're editing it;
  runs and fits don't change the drawing, so they go while it's only looked at. The **Steady**
  solver settles everything at once in each time step, with tanks at the pressure measured: much
  faster, without inertia. The panel lists what keeps the model from running, each with **Go
  to**; **Script** shows the FullFlow code that runs, and **How it's modeled** how each part is
  built of FullFlow's components. **New diagram** has a cold flow, a pressurized flow, and
  Vespula's prop system (Saaketh's FullFlow model) with its run's data, which it adds to Yorg
  the first time: a run of it is Saaketh's run again.
- **Visio**: **Import Visio…** asks for a Visio drawing (or drop a .vsdx on the diagrams), shows
  it, and makes a diagram of it in the folder you're in, with its pages. Its valves (3/2 and 5/2
  ones too), regulators, relief valves, orifices, diffusers, quick disconnects, and sensors become
  parts (by their stencil, or by their tags: PRV, FTPT, FO-1, ODIFF), tagged with their labels,
  with their set pressures, worked as
  their actuators' letters say; everything else (the vehicle, its tanks, the key, the title
  block) is drawn as Visio drew it, as figures. Its connectors become lines along their routes,
  on the parts they were glued to, carrying what the drawing's key (or their words, or their
  color) says they carry, and sized as the key says. The import lists the symbols Piper has no
  part for. Figures aren't simulated: to simulate a drawing whose tanks are drawn, put Piper's
  tanks in their place. Save an old .vsd as a .vsdx first.
- **Export**: **PDF**, a page for each of the diagram's, on its printed sheet or else on
  Tabloid, Letter, ANSI D, A3, or A4, on a drawing sheet as Visio's P&IDs are (a border with its
  zones, the named revisions, and a title block that says which sheet of how many), vector and
  searchable; SVG or PNG images of the page shown; printing; and the parts of every page as a
  CSV (a valve list, an instrument list). Each can have a legend (**With a legend**, in its
  dialog): every kind of part on the page with its symbol and name, by category, then its types
  of line, its fluids, and its valves' state colors, beside the drawing (a page whose printed
  sheet is set has its legend on a sheet of its own after it, in a PDF).

## Buildflow: bills of design

The site's fourth app, **Buildflow**, is each program's bill of design: Hopper, Elytra,
Felicette 2, HETS, each with its components, by subsystem, on its vehicle, and how far each has
come through design (DCR, CoDR, PDR, CDR), build (drawings, procurement, manufacturing,
inspection), test (TRR, testing, QRR), and launch (integration, FRR, flight). Help, in
Buildflow's top bar, has all of this on one page.

- **Programs**: a card for each, with its vehicle and a bar for each phase (done, under way,
  blocked). Open one to see its bill of design.
- **The vehicle**: on a black stage, with the phases across the top. Its components are dots in
  the colors of where each is in the phase picked: gold done (through every milestone it needs in
  that phase), orange under way, red blocked, gray not started, and a small ring when it needs
  nothing in it. Under it, in big letters, how many are through the phase: in design, how many
  have passed their CDR ("18 component-level CDRs across the vehicle"); then how many are built,
  through QRR, and flown. Click a dot to open its component. The phase and the component picked
  are in the page's address, to share.
- **The bill**: every component by subsystem, with its lead, a chip for each milestone, and
  what's due next. Click a chip to set the component's status there: *Not started*, *In
  progress*, *Done* (*Passed*, for a review), *Blocked*, or *Not needed*; a chip with a red edge
  is late. *Coming up* lists what's due and not done, the late first, and *Recent activity* what
  everyone's changed, and who.
- **A component** opens beside the page: what it is, its lead, and for each phase its milestones
  (status, due date or a review's day, the day it was done, and a note: a review's actions, or
  what's holding it up), who's on it (designing, making, testing, and flying it: the build
  phase's people are who's manufacturing it), and its links: CAD and drawings in Vault,
  requirements, design documents, reviews' slides (on their milestone), P&IDs in Piper, test data
  in Yorg, procedures. A link to a page of the site (copy its address: `/vault/file/12`,
  `/piper/diagrams/3`, `/yorg/datasets/7`) shows its app and the name of what it goes to; any
  other is an `http` or `https` address, which opens in a tab of its own. Anyone signed in keeps
  all of this up.
- **The build plan** (**Build plan**, on a program's page) is each component's lead time (how long
  it takes to get once it's ordered, or to make once it's started), the day it has to be ready by,
  and what it needs first (what has to be ready before it can start). From them it works out the day
  to order or start each one by, and draws it all on a calendar: the soonest to order first, so the
  long leads (six weeks or more) come to the top. It counts what to order or start now (past its
  day), what's late, what's at risk (it won't be ready in time as things stand, waiting on what it
  needs), and what isn't planned yet. Set a component's lead time (in weeks) and ready-by day in the
  plan's table or on its panel, in the build phase, and what it needs first with **What ... needs
  first** (not one that needs it). The bill marks a long lead not in hand yet with *Long lead*.
- **The BOM** (**BOM**, on a program's page) is its bill of materials, read in from the team's own
  spreadsheet: **Read in a spreadsheet…** takes an Excel workbook (.xlsx) or a CSV file, guesses
  which column says what from its headers (part number, description, the component it's for,
  quantity, vendor, cost each, lead time, link, status), and shows the lines as they'll come in.
  Each line goes to the component its *Component* column names, or all to one component (that
  component's BOM alone). Reading it in again as the spreadsheet changes keeps what the site says
  of a part already on it (where it is, and its note). The page lists each part with the day to
  order it by (to have it when its component's build has to start, by the build plan), the long
  leads (six weeks or more), what to order now, and the cost in all; set where each is (to order,
  ordered, received) and a note (a PO, a tracking number) there. A component's panel lists its
  parts in its build phase, the longest lead first.
- **Reviews** cover several components at once: a subsystem's PDR, say, for its eight components.
  **New review**, under the bill, takes the milestone it's held at (a review: DCR, CoDR, PDR, CDR,
  TRR, QRR, FRR), a name, its day, and the components it covers (**All of** a subsystem picks
  them all). Its day is each component's date at that milestone, and **Pass…** on its page passes
  each of them there (those through it already stay as they are). Its page lists each component's
  status at the milestone and its actions, to set one apart (back *In progress* with its actions
  to close, say); its files (its slides, its package, its minutes: SharePoint links, say); and the
  notes taken in it (**Edit notes**, in Markdown). The bill's chips and a component's panel name the
  review it's in. **Remove…** keeps a review, to bring back from *Removed reviews*. Anyone signed in
  keeps reviews.
- **Laying out a program** is the admins': **New program** starts one from a rocket's, a
  hopper's, or a test stand's layout (its drawing, subsystems, and components), or with nothing but
  the milestones. **Layout**, on a program's page, draws the vehicle from its sections (an engine
  with its nozzles, body tubes, tanks, couplers, transitions, and the nose cone, with fins, landing
  legs, or a test stand's frame), places components on it by dragging their dots, and changes its
  subsystems, components, and milestones. The name, the description, and the drawing are saved
  together with **Save**, in the bar at the foot of the window that says what isn't saved yet;
  everything else is saved as it's changed. **Remove** keeps everything said of a component, to
  **Bring back**; a milestone with anything kept on it can be renamed but not deleted; and
  **Archive…** takes a program off the list, kept as it was, until an admin brings it back.
- **The shop** (**Shop**, in Buildflow's top bar) is the queue of parts the team needs machined,
  as the machining tracker was. The cards across the top say how many hours each machine has
  waiting, and how many people can run it. **Add part** queues one: what it is, what it's for (a
  program, and one of its components, or neither), the machine, its material, how many, about how
  many hours they'll take in all, links to its drawing and CAD (a web address, or a page of the
  site's own like `/vault/file/12`), who asked for it (you, unless you say), who's making it, and
  when it's needed. Anyone can change a part, or move it along: queued, in progress, blocked (say
  why in its note), done. **Remove** takes a part off the queue and keeps it: **Show parts taken
  off the queue** puts it back. A part for a component shows on the component's panel, in its build
  phase (*In the shop*), and **Queue a part for it**, there, starts one for it. **Who's trained**
  is each person's level on each machine (0 not trained, 1 supervised only, 2 runs it on their
  own, 3 trains others): set your own there, and admins can set anyone's. Those at 2 or 3 are who
  can make a machine's parts, and the queue names them. Admins add, rename, and retire machines
  (**Machines**); a retired one takes no new parts. **Export CSV** saves the queue and who's
  trained as a spreadsheet.

## Deals

Once a day the site searches eBay for what the team wants, and shows the listings that would do
at the foot of its own page, as cards that slide by (or with the arrows): each with its picture,
price and shipping, condition, how far under the typical price it is (against the others found
like it), why it would do, what it's for (a link to it: a component on its program's bill of
design, a vendor's part in Vault, a part on a P&ID), how long ago it was checked, and **View on
eBay**, to buy it there. What it searches for:

- **Buildflow's components not yet procured** (through Procurement): a bought one by the part
  numbers in its description and links (`Swagelok SS-43GS4`), and by what it is; one the team
  makes by the stock its description says it's made from ("6061-T6 aluminum, 8 in OD, 0.125 in
  wall"). Those through design, and lately worked on, first. So say a component's part number,
  or its material, form, and sizes, in what it is, for its deals to be found.
- **Vendors' parts in Vault**, by their part numbers, in folders everyone can see.
- **Parts on Piper's P&IDs** that say their model (`Omega PX309-1KG5V`).

A component's links bring its CAD in Vault and its parts on P&IDs with it (a link to a diagram
found at a tag, `/piper/diagrams/3?find=PR-101`), so their deals are the component's. On a
program's bill of design, a component with deals has a small tag with how many beside its name,
and a speck of gold by its dot on the vehicle; its panel lists them under **On eBay**. ✕ on a deal
hides it for everyone, and it isn't found again for what it's for (**Undo** brings it back).
Claude says which listings would do, and why, when it's set up and less than half of its budget is
spent (so Help keeps the rest); otherwise a listing's words do.
Deals are checked again on eBay every four hours, and one sold, ended, or not checked in six hours
isn't shown. Admins see each search and check, and search at once, on Admin > Deals.

## Layout

| Path | What | Status |
|---|---|---|
| `server/` | The server: Python, FastAPI, SQLAlchemy; Docker image. The site (sign-in, accounts, deals in `deals/`) at the top of `src/yjsp_server`, Vault in `vault/`, Yorg in `yorg/`, Piper in `piper/`, Buildflow in `buildflow/` | working |
| `web/` | The web app: TypeScript, React, Vite; served by the server. The frame (and the deals, `deals.tsx`) at the top of `src`, Vault's pages in `src/vault`, Yorg's in `src/yorg`, Piper's in `src/piper`, Buildflow's in `src/buildflow` | working |
| `client/` | Vault's clients, in C#: the workspace library and the `vault` CLI | working |
| `client/src/Vault.SolidWorks` | Vault's SolidWorks 2026 add-in ([install](client/src/Vault.SolidWorks/README.md)) | working |
| `client/src/Vault.Setup` | `Vault-Setup.exe`, the add-in's installer | working |
| `deploy/` | The deploy script, the one-time move to YJSP, and the live server's service files; in `compose/`, a team's own site with Docker ([running it for your team](docs/self-hosting.md)) | working |
| `docs/` | The site's design ([design.md](docs/design.md)), each app's ([vault.md](docs/vault.md), [yorg.md](docs/yorg.md), [piper.md](docs/piper.md), [buildflow.md](docs/buildflow.md)), [troubleshooting](docs/troubleshooting.md), and [hosting and deploying](docs/deploying.md) | |

## Run the server locally

You need [uv](https://docs.astral.sh/uv/).

```bash
cd server && uv sync
```

```bash
cd server && YJSP_DEV_AUTH=1 YJSP_BOOTSTRAP_ADMINS=you@example.com uv run yjsp-server
```

Open http://localhost:8000 and sign in with the development form as
`you@example.com`, which makes you an admin. The API is at
http://localhost:8000/docs. The local database (`yjsp.db`) and files (`vault/`, `yorg/`)
go in `server/data/`, which git ignores. (A database from before YJSP is `cvc.db`, with
`blobs/` beside it: rename them to `yjsp.db` and `vault/blobs/` to keep them.)

To get the web app there too, build it once. You need [Node.js](https://nodejs.org/) 24:

```bash
cd web && npm ci && npm run build
```

To work on the web app, `cd web && npm run dev` serves it at http://localhost:5173 and
updates it as you edit. Sign in at http://localhost:8000 first; the dev server passes
API requests to it.

## Use the `vault` command

Vault's command line. On Windows, download `vault.exe` from the web app's SolidWorks page
(each release has it, on its GitHub release). It runs without installing anything.
Otherwise you need the [.NET 10 SDK](https://dotnet.microsoft.com/download). With the
server running, sign in through your browser, create a workspace, and work in it:

```bash
cd client && dotnet run --project src/Vault.Cli -- login http://localhost:8000
```

```bash
cd client && dotnet run --project src/Vault.Cli -- init ~/VLT --server http://localhost:8000
```

In the workspace (`C:\VLT` on Windows):

| Command | What it does |
|---|---|
| `vault status` | What's new, changed, out of date, or checked out |
| `vault get` | Update the files you have here to their latest versions. `vault get <folder or file>` downloads those too, and `vault get .` everything in the current folder. Your local changes are never overwritten unless you add `--force`, and even then they're backed up. |
| `vault checkout <files>` | Check files out to edit them. Everyone else sees who has them. `--force` takes over a check-out on another computer: yours, or anyone's if you're a lead there. |
| `vault checkin <files> -m "what changed"` | Check in changed and new files as one version |
| `vault undo <files>` | Give up a check-out. Local changes are backed up in `.vault/backup`. |
| `vault free` | Free up space: remove the copies here of files you haven't changed and don't have checked out. They stay in the vault, and `vault get` brings them back. |
| `vault resolve <files> --mine` | Settle a conflict (you changed a file here, and someone checked in a newer version since) by keeping yours: it's checked out to you as it is, to check in on top. `--vault` takes the vault's version instead, with yours backed up. |
| `vault history <file>` | Every version, with who changed it and why |
| `vault locks` | Who has what checked out |
| `vault title <file> "what it's called"` | Give a file a title, shown with its name: no new version, and no check-out. `vault status` and `vault history` show titles where they say more than the names do (a part number's), and `history` the names a file had. |

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

## The live site

YJSP, with Vault and Yorg, runs at https://lucazerega.tail07089c.ts.net, on an Oracle
Cloud VM, with its demo at https://lucazerega.tail07089c.ts.net/demo. How it's hosted, how to deploy a new version (`bash deploy/deploy.sh`), and how
to look after it are in [docs/deploying.md](docs/deploying.md). To run it for your own team, with your name, your
school's sign-in, and your data, see [docs/self-hosting.md](docs/self-hosting.md).

## License

The server and the web app (`server/`, `web/`) are under the GNU General Public License, version 3
([LICENSE](LICENSE)); the `vault` command, the SolidWorks add-in, and their library (`client/`) are under the MIT
license ([client/LICENSE](client/LICENSE)). What the repository uses and carries under others' terms, and why the
server's is the GPL, is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). [CONTRIBUTING.md](CONTRIBUTING.md) says how
to contribute, and [SECURITY.md](SECURITY.md) how to report a vulnerability.
