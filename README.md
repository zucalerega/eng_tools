# YJSP Eng Tools

The Yellow Jacket Space Program's engineering tools, on one site: **Vault** (`/vault`), for
the team's SolidWorks and STEP files, and **[Yorg](#yorg-test-data)** (`/yorg`), for its test
data. The site's address on its own shows both (the mark at the top left goes back to it),
and the switcher beside it goes between them.

> **Status:** early development. The server, the web app, and Vault's `vault` command-line
> tool work and are tested. Vault's SolidWorks add-in had its first run in SolidWorks
> in September 2026, and is for SolidWorks 2026 since October 2026. See [docs/design.md](docs/design.md) for how the site works, and
> [docs/vault.md](docs/vault.md) and [docs/yorg.md](docs/yorg.md) for each app and its
> roadmap.

## Signing in

Sign in with your Georgia Tech account, on GT's own login page: it gets you both apps, and
it's how new people join. Anyone with a GT account can, unless an admin turns on the
whitelist (Admin > Whitelist, from the account menu at the top right): then only GT emails
on it, and people an admin invites, can, and anyone else who signs in is told to ask an
admin to add theirs. Admins put the team's emails on the whitelist by uploading a roster's
CSV, or one at a time, and see who on it has joined.

Google signs in to accounts already there: one made with Google before, or an admin's
invite. Someone without a GT account (a mentor, say) joins by an invite to the address they
use with Google (Admin > People). Admin > People also shows how many people used the site
each day this past month and how long they spent on it, who has the SolidWorks add-in (on
how many computers and which versions, and how many people in all), how hard the server is working
(whether the site is overloaded), how many people there are and how many are on now, and
when each joined and was last on. Change the name everyone sees you by
from your account menu.

Joined with Google? Keep signing in with Google for now. Signing in with Georgia Tech finds
your account only if its email is your GT address; otherwise it makes a new, empty one,
and what you have checked out stays with the old one.

## Vault: CAD files

Version control for the team's SolidWorks and STEP files: check out, check in, version
history, and per-folder permissions, from SolidWorks, the command line, or the web. It
replaces Kenesto.

- **Check out a file before you edit it.** While it's checked out, everyone else
  can open it read-only. Check it back in with a comment to save a new version.
- **Every version is kept.** See who changed what and why, and download any old
  version.
- **Assemblies stay consistent.** An assembly is checked in together with the new
  or changed parts it uses. Getting an assembly brings its parts along.
- **Drawings stay with what they show.** A drawing is checked in only if it shows a
  part or assembly in the vault, and only if it's named after it (`Fin.SLDDRW`, or
  `Fin - machining.SLDDRW`, for `Fin.SLDPRT`), so it sits next to it in its folder.
  Check drawings in from SolidWorks: the `vault` command can't read what a drawing shows.
- **Access is per folder:** viewer, editor, or lead, plus admins. Subteams can own
  their folders.
- **See everything on the web:** browse the vault with a folder tree beside the files;
  search by name and filter by kind, status, date, and person, and sort by name, date,
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
  part on its own. Nothing in it changes a file. STEP and IGES files open as they are.
  SolidWorks parts and assemblies show the 3D model Vault for SolidWorks makes of each
  version it checks in; for any other version, the server reads the 3D view SolidWorks
  saved in the file (SolidWorks 2015 to 2026), in the configuration it was saved in. An
  assembly shows each of its parts that's in the vault, read from the part's own file, even
  if it was uploaded in the web app; Caliper lists the parts it couldn't find. If it can't
  read a file (one from SolidWorks 2014 or older, say), Caliper says why: open the file in
  SolidWorks and click Make 3D view on the Vault tab.
- **Check out and in on the web** too, to change a file without SolidWorks (a PDF, a STEP
  file, or on a computer without the add-in): Check out on its page (or for files picked
  in a folder), download it and change it, then Check in… with the new version, or
  upload it into its folder. A check-out there is "in the web app"; in SolidWorks, the
  Vault tab offers to move it to that computer when you start changing the file. An
  assembly checked in on the web doesn't list its parts until it's next checked in from
  SolidWorks; a drawing stays linked to what it shows.
- **SolidWorks in one download:** the web app's SolidWorks page offers `Vault-Setup.exe`,
  which installs the add-in, and a button that connects it to the vault.
- **Bringing files over from Kenesto:** upload the project folders as they are (the web
  app takes whole folders), so `09_Hopper` stays `09_Hopper`. Assemblies from there still
  name their parts where Kenesto had them (`K:\Yellow Jacket Space Program\Project
  CAD\09_Hopper\Stringer.SLDPRT`), and the web app can't read that. So open them from
  the Vault pane in SolidWorks, or with Open in SolidWorks on the web: the add-in reads the
  paths from the files, gets the vault's files whose paths end the same way, and shows
  SolidWorks where they are. It says which parts aren't in the vault. Check an assembly
  out, save it, and check it in to store the vault's paths in it for good; while it still
  uses files the vault doesn't have, checking it in lists them, to upload them or take them
  out of it. Once the team works from the vault, disconnect Kenesto's drive, so no one
  opens a part from there.

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
  dataset that has the channels it uses, and plots like any channel.
- **Scale, label, and line up:** a channel's settings rename it and set its color, a
  scale and offset (volts to psi, psi to bar) with its unit, its axis, and lines or
  steps. Set T0 (type a time of day or a Unix time, click the plot, or pick an event like
  MOV OPEN) and time reads T−10, T0, T+15; drag its line to move it. Unix-time data reads
  as time of day in UTC (or your computer's zone, in Options) until then. Add markers
  (drag them to move them) and fix an axis's range. Compare with another dataset to
  overlay two tests, shifted in time to line them up.
- **Masks:** Mask makes a test on channels, like the main valve open or a pressure over
  its redline: pick a channel, a comparison, and a value (a valve's OPEN, by name), or
  write one like a calculated channel (`and([MOV-OX] == 1, [PT-CHAMBER] > 450)`). A mask
  shades the plots where it holds, and can hide data everywhere else (Hide, in the list
  on the left); a compared test is masked by its own channels.
- **Split a file into its tests:** Split makes a dataset of each test in a file of
  several: where a mask holds (from a second before each valve opening to two after, say,
  with chatter joined and blips left out), cut at times you type or at your markers. Each
  test's time can start where its valve opened. They go in a new folder next to the file,
  which stays as it was.
- **Labels:** Label (or L), then click a plot: a label with an arrow to the data there.
  Drag the label to move it, or the arrow's tip to point it somewhere else; double-click
  it to change the words, or right-click it for more.
- **Measure:** Measure (or D), then click two points on a plot: the time between them,
  the change, and the slope (per second). Click on a channel and the second point stays
  on it; Esc clears the measurement.
- **Save a view** for everyone, and open it with another test's data: the same plots,
  with that test's channels of the same names. A dataset's views are listed on its page
  (Saved views); open one and Save as a new view to keep your changes. Views go in
  folders of their own, as scripts do: picked from a list of those there are when you
  save one (or a new path typed, like `Hotfires/HF-3`), or later with More > Rename or
  move; the Views tab shows them in their folders, finds them by a word, and moves yours
  into another folder (or out of one) when you drag it there. Export the plots as an image (labels and all), or the
  samples in view as CSV.
- **Copy link** (beside Save view, on a dataset's or a view's page) to send someone what's
  on screen without saving a view: the plots, the tests compared and their shifts, the time
  in view, T0, and the rest. Whoever opens it sees those plots as unsaved changes, and can
  Save view to keep them; on a dataset's page they become the plots their browser keeps for
  it. A link made in the preview opens the site's page, so it works for everyone.
- **Yorg's preview (admins):** `/yorg/dev/...` is Yorg as it will be with what's new in
  it: the same data, views, scripts, and help, with Models in its top bar, and Model on a
  dataset's page. Everyone else's Yorg stays as it is; admins go in with Preview, top right
  (no one else sees it).
- **System models (in the preview while it's being tried out):** draw a test stand's feed
  system as a P&ID: tanks (at a fixed pressure, or under a gas ullage), junctions,
  outlets, and the lines, valves, orifices, and cavitating venturis between them; and on
  the gas side (dashed), gas supplies, gas junctions, regulators, gas valves, and gas
  orifices: press lines into a tank's ullage, and vents out of it. Link its valves to
  their command channels, what it follows (a tank's pressure, a chamber's, a liquid's
  temperature, whose density and vapor pressure then follow it through the run) to theirs,
  and its sensors to what they measured; a tank, a junction, or a gas junction starts from
  its sensors' values at the run's start (pressure, gas and wall temperatures). Every part
  is built of FullFlow's components, with ThermoProp's properties: a gas is real unless you
  set it ideal (at bottle pressures the difference shows), and a liquid has its density at
  each node's pressure. Run it against a test (FullFlow simulates it on the server)
  over a window from T0 (the one set on the dataset's plots) to see each sensor's measured
  and modeled values together, with how far apart they are (RMS and bias). Then tune the
  settings marked tune (CdAs, a line's friction factor and fittings' K, a valve's opening
  time, a regulator's set pressure and droop, a venturi's recovery, an ullage's wall hA
  and its collapse factor, and a vessel's wall hA: a gas junction that's a COPV or a
  bottle, set to hold its gas in a vessel), or let **Tune…** match them to the test, one
  of two ways it puts side by side. **Fit**: the server runs the model again and again,
  turning the knobs you pick until it matches best, and you apply what it found (or not).
  **Anchor**: pair a knob with a sensor, and in one run FullFlow moves the knob in every
  time step until the sensor reads what was measured; you see each knob through the run,
  and apply the median (or not). Give an anchor a span where its knob counts, such as a
  valve's CdA while it's open. What anchoring can't settle is fitted: knobs you pick to
  fit alongside the anchors, and any knob FullFlow couldn't anchor (unless you turn that
  off), the working anchors held in each of the fit's runs.
  The **Steady** solver settles the lines, junctions, and regulators at once in each time
  step, with the tanks (and gas junctions linked to a pressure transducer) at the pressure
  measured: much faster, and without inertia, so a steady anchor can start anywhere.
  Models are saved for every admin, run against any test with the same channel names, and
  go to and from files. **Start from an example** has a cold flow, a pressurized flow, and
  Vespula's prop system (Saaketh's FullFlow model) with its run's data, which it uploads
  to Yorg the first time: built of the same FullFlow components, a run of it is Saaketh's
  run again.
  **Script** shows the model as the FullFlow code that runs it, written from the P&ID, and
  the code of Yorg's own it imports. Change it (say, to add a FullFlow component Yorg's
  parts don't have, or to model a part another way) and **Run in browser** runs your
  script in your browser: FullFlow installs there the first time (a minute or two), and it
  runs several times slower than the server. A changed script isn't saved.
  **Reference** explains what FullFlow is and how it models a system and solves it.
- **Scripts:** a Python notebook. Its cells run
  one at a time in the notebook's variables, so the cell that loads the data runs once and
  the ones after it as often as you change them: Shift+Enter runs a cell and goes on, Run all
  runs them in order and stops at one that fails, and each cell's output is under it. Text
  cells are Markdown. After Escape, Jupyter's keys move between cells and add, delete, and
  turn them into text or code (the keyboard button in the notebook's bar lists them). A script
  works on the tests attached to it (Data, beside it): their channels are listed there, and a
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
  (picked from a list, or dragged onto one in the list of scripts), with their tests, as .py code with a `# %%` line starting each cell (as VS Code and
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

## Layout

| Path | What | Status |
|---|---|---|
| `server/` | The server: Python, FastAPI, SQLAlchemy; Docker image. The site (sign-in, accounts) at the top of `src/yjsp_server`, Vault in `vault/`, Yorg in `yorg/` | working |
| `web/` | The web app: TypeScript, React, Vite; served by the server. The frame at the top of `src`, Vault's pages in `src/vault`, Yorg's in `src/yorg` | working |
| `client/` | Vault's clients, in C#: the workspace library and the `vault` CLI | working |
| `client/src/Vault.SolidWorks` | Vault's SolidWorks 2026 add-in ([install](client/src/Vault.SolidWorks/README.md)) | working |
| `client/src/Vault.Setup` | `Vault-Setup.exe`, the add-in's installer | working |
| `deploy/` | The deploy script, the one-time move to YJSP, and the live server's service files | working |
| `docs/` | The site's design ([design.md](docs/design.md)), each app's ([vault.md](docs/vault.md), [yorg.md](docs/yorg.md)), and [hosting and deploying](docs/deploying.md) | |

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

Vault's command line. On Windows, download `vault.exe` (the `vault-windows` artifact of
any CI run). It runs without installing anything. Otherwise you need the
[.NET 10 SDK](https://dotnet.microsoft.com/download). With the server running, sign in
through your browser, create a workspace, and work in it:

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
Cloud VM. How it's hosted, how to deploy a new version (`bash deploy/deploy.sh`), and how
to look after it are in [docs/deploying.md](docs/deploying.md).
