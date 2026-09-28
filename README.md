# CVC

CAD version control for the team's SolidWorks and STEP files: check out, check in,
version history, and per-folder permissions, from SolidWorks, the command line, or
the web. It replaces Kenesto. People know it as **Vault**: that's its name in the web
app and in SolidWorks, in the Yellow Jacket Space Program's colors. The code, the `cvc`
command, and this repository keep the name CVC. The same server also runs
[Yorg](#yorg-test-data), which plots the team's test data.

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
- **See everything on the web:** browse the vault with a folder tree beside the files;
  search by name and filter by kind, status, date, and person, and sort by name, date,
  or size; see what each assembly contains and which assemblies each part is in, at every
  level, and whether each file is checked in, who created it, and who changed it last;
  see each file's history and drawings and who has what checked out;
  download any version; follow the activity as it happens; start new parts,
  assemblies, and drawings, which SolidWorks makes on your computer; and organize the
  vault: new folders, uploads (files, whole folders, or what's in a zip, by dropping them
  on the page), moving or renaming, which every computer's copies follow, and deleting,
  to a trash each folder keeps. Admins and folder leads can switch on admin mode to
  release someone's check-out or revert a file they have checked out.
- **SolidWorks in one download:** the web app's SolidWorks page offers `Vault-Setup.exe`,
  which installs the add-in, and a button that connects it to the vault.

## Yorg: test data

The same site has a second app, **Yorg** (the switcher is at the top left), for the
team's test data: upload a CSV from a hotfire or cold flow, and plot its channels
together on one time axis.

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
- **Save a view** for everyone, and open it with another test's data: the same plots,
  with that test's channels of the same names. A dataset's views are listed on its page
  (Saved views); open one and Save as a new view to keep your changes. Export the plots
  as an image (labels and all), or the samples in view as CSV.

## Layout

| Path | What | Status |
|---|---|---|
| `server/` | API server: Python, FastAPI, SQLAlchemy; Docker image | working |
| `client/` | C# workspace library and `cvc` CLI | working |
| `client/src/Cvc.SolidWorks` | SolidWorks 2025 add-in ([install](client/src/Cvc.SolidWorks/README.md)) | working |
| `client/src/Cvc.Setup` | `Vault-Setup.exe`, the add-in's installer | working |
| `web/` | Web app: TypeScript, React, Vite; served by the server | working |
| `server/src/cvc_server/yorg`, `web/src/yorg` | Yorg, the test data app | working |
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
cd client && dotnet run --project src/Cvc.Cli -- init ~/VLT --server http://localhost:8000
```

In the workspace (`C:\VLT` on Windows):

| Command | What it does |
|---|---|
| `cvc status` | What's new, changed, out of date, or checked out |
| `cvc get` | Update the files you have here to their latest versions. `cvc get <folder or file>` downloads those too, and `cvc get .` everything in the current folder. Your local changes are never overwritten unless you add `--force`, and even then they're backed up. |
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
