# Yorg design

Yorg is the team's test data (hotfires, cold flows), plotted, in the spirit of SpaceX's
Borg or Sift. It's one of the two apps on the team's site, beside Vault, and shares the
server, the database, sign-in and accounts, and the web app's frame with it, and nothing
else ([design.md](design.md) has those): its own tables (`yorg_*`), its own folder of
files (`YJSP_YORG_DIR`), its own API (`/api/yorg`), and its own pages (`/yorg`), with the
app switcher in the top bar between the two. Its code is `server/src/yjsp_server/yorg`
and `web/src/yorg`. The name is a placeholder: the web app says it in one place (`YORG`
in `web/src/yorg/index.tsx`).

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
  another test's data. A view's folder is a path of its own (`yorg_views.folder`,
  "Hotfires/HF-3", "" at the top), tidied by the server as a script's is (`FolderPath`),
  not one of the datasets' folders; the Views tab arranges them in a tree
  (`pathTree.ts`), each folder's views the most recently changed first. Renaming or
  moving a view sends its plots as they were saved, so changes to them on the page stay
  to be saved; a client from before folders, which sends none, leaves a view where it is.
- **Links** to plots (Copy link, beside Save view) send what's on a dataset's or view's
  page without saving a view, so views are kept for what's worth keeping. A link is the
  page's address on the site (`sitePath`: never the preview's, which only admins open)
  with its layout in `?plots=`: the JSON a saved view keeps, deflated
  (`CompressionStream("deflate-raw")`) and base64url-encoded (`share.ts`), about 500
  characters for a channel or two and 2 KB for 60. It's in the query, not after a `#`,
  because signing in comes back to a page's path and query; nothing is stored on the
  server. The page reads it as a saved view's layout is read (`readLayout`), so a link
  made before the layout grew still opens, and the recipient's own sign-in decides which
  tests they see. Its plots open as unsaved changes: a view's page shows the view changed,
  and a dataset's makes them this browser's layout for it (as Use with another dataset
  does). Once its plots are made, the page takes it out of the address, so a reload, or a
  view saved, starts from the page's own; one that can't be read (cut short) says so, over
  the page as it is without it. Copy link makes the link ahead, once the plots have
  settled for 300 ms, so a click copies at once: Safari lets a page copy only while it
  handles the click. Where the browser won't copy (a site without HTTPS has no clipboard),
  it shows the link to copy by hand.
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
- **Yorg's preview** (`/yorg/dev/...`, admins): the site as it will be with what's new in
  it, so it can be tried as it'll look before everyone has it. `web/src/preview.ts` maps
  its paths to the site's (`/yorg/dev/datasets/5` is `/yorg/datasets/5`); `YorgPage` shows
  the same pages there, and the new ones (Models) only there, and the router sends
  links followed in the preview to their preview pages (a link marked `exact` leaves it).
  The top bar, a dataset's or view's Model button, and Help's cards show what's new in the
  preview. Scripts and a page's Python were in it, and are everyone's now. They take what the page plots (`analysis.ts`: its tests, the channels
  plotted, the time in view): the page's Python starts on them (`starterScript`), a
  model's run window is that time.
  Releasing a feature is showing it outside the preview too (and its API to everyone).
- **System models** (Models, in the preview while it's tried out): a
  feed system as a P&ID, simulated with FullFlow (a network solver) and ThermoProp
  (fluid properties) against a test, to tune it until it matches. `yorg/system/catalog.py`
  lists the parts, their settings (SI units; some only when others are set a way, as an
  ullage's wall only with wall heat transfer), links (followed, starting the model, compared,
  or commanding a valve), and outputs; the web app draws its editor from it
  (`web/src/yorg/models`, parts between the same two nodes side by side) and `spec.py`
  checks a model with it (saving takes a half-drawn one;
  running needs liquid parts between tanks, junctions, and outlets and gas parts between
  gas supplies, gas junctions, tanks' ullages, and outlets; every connected set of liquid
  parts reaching a tank, whose liquid it carries, and every set of gas parts a supply or an
  ullage, of one gas). A part renamed (the press line, now a gas valve) is read under its
  new name. A run is a process of its own (`runner.py`, stopped after 10 minutes; two at a
  time, a new one of yours replacing the last), so a long simulation never slows the site:
  the server cuts the channels the model uses (valve commands, what it follows, what starts
  it) to the run's window, in SI units by their unit (`channels.py`), and the page asks how
  it's going. A run is kept from taking the site, one small machine (one CPU, 6 GB), down
  with it (`runs.py`): its process runs in its own folder (its home and temporary folder
  too), in a session of its own (stopping it stops whatever it started), with an
  environment of its own that has none of the server's settings or secrets, and the system
  holds it to 2 GB of memory (address space, which Linux enforces and macOS doesn't), CPU
  time a minute past its time limit, files of 1 GB, and no core dumps. So one gone wrong
  fails by itself (out of memory, it says so), and two at a time still leave the server
  2 GB. NumPy's and SciPy's OpenBLAS get one thread: each thread's stack and buffers count
  against the memory, and the server has one CPU. A watchdog, a thread of the server's from
  its first run until it stops, looks at the runs every 5 seconds and stops one past its
  time limit whether or not anyone's asking how it's going (its page closed): asked to
  stop, then killed 5 seconds later. A run still runs as the server's user, so it could
  read what the server can (its settings, the database, Vault's files): the server runs
  only scripts it wrote (below), and only admins start runs. A user of its own for runs
  would need more than `sudo` (the service's `NoNewPrivileges` rules that out, and the
  server couldn't stop another user's process): a systemd unit for each run. The FullFlow
  network is a script (`script.py` writes it from the checked model; see a model's script,
  below), written as FullFlow's own models are: FullFlow's components, each fluid's
  properties from ThermoProp through FullFlow's `Lookup`. Yorg adds only what joins a model
  to a test (`library.py`, `components.py`: the channels in,
  anchors, the results out). A fixed tank, supply, or outlet is a pressure that follows its
  channel (a `Sequence`); lines are `DarcyWeisbach` (fittings' K folded into f); liquid
  valves and orifices `DischargeCoefficient`s (a valve's position its discharge
  coefficient); venturis `CavitatingVenturi`s (continuous where they start to cavitate, the
  noncavitating Cd the cavitating one over sqrt(1 - R)); gas valves, orifices, and
  regulators `CompressibleOrifice`s, choked or not, with the gas constant, specific heat
  ratio, and enthalpy of where they flow from (a check valve's discharge coefficient 0
  where gas would flow back). Every one's discharge coefficient is eased off within 500 Pa
  of no pressure drop (`library.eased`): a flow that goes as the root of its pressure drop
  has no slope at none, and a junction between a shut valve and an orifice wouldn't settle;
  it's a part in a million off at 0.25 MPa. A regulator opens as far as the pressure where
  it flows to puts it (fully open at its droop below set pressure), solved with the rest in
  each step: FullFlow's `Actuator` moves once a step, a step behind the little volume of
  tubing after a regulator. A liquid junction is a `Volume` with no room: what flows in
  flows out. A gas junction is a `Volume` of gas, whose mass and energy FullFlow keeps as
  it iterates its pressure and temperature, gas flowing in bringing the enthalpy of where
  it came from. It holds its gas in tubing, or in a vessel (a COPV, a bottle) with a wall
  like an ullage's, below. A tank under an ullage is two `Volume`s, its liquid and its
  ullage's gas (the tank's volume less the liquid's, which FullFlow keeps the history of
  for the gas's boundary work), which a `Balance` holds at one pressure; its wall is a
  `Solid` that trades heat with the gas by `Convection` (left out at an hA of 0, unless
  the hA is anchored or a channel reads the wall's temperature: `script._wall`, the same
  for a vessel's). A vessel's wall keeps its gas warmer than it would be blowing down, so
  its hA is a knob, fitted or anchored to the vessel's temperature. Pressurant flowing into
  an ullage is divided by the collapse factor. A gas is real (ThermoProp's `Fluid`) or ideal
  (`IdealGas`), one in each connected set of gas lines (spec.py checks); real by default,
  since at bottle pressures the difference shows (nitrogen at 4200 psia is 12% less dense
  than ideal, and cools as it throttles). A liquid is its tank's (`Fluid`; RP-1
  ThermoProp's `Propellant`), at each node's pressure (never below where it boils, so a
  drained junction still holds liquid as far as the model knows) and its tank's
  temperature, which follows its channel if it's linked; a custom one has its density and
  vapor pressure given. Models saved with what had no FullFlow part of its own, an ullage's
  polytropic exponent or a regulator's response time, open without them
  (`catalog.RETIRED`). Commands step between 0 and 1 (by the command's open and closed
  values), each change a hair after the sample before it: a sample says what held since the
  one before, as FullFlow records a run, so a FullFlow run fed back as a test gets its
  commands when it had them. A rate limit opens a valve over its opening time. What starts
  from a channel (an ullage's pressure and temperatures, a gas junction's, a junction's
  pressure transducer) takes its value at the run's start, and the result says what it
  took; a run reads every channel the model is linked to that the test has (a fit and an
  anchored run need them all). All the outputs go to one `Recorder` component's exports,
  and components are added in the order values flow, so FullFlow's settling needs one pass
  per trial. Solved states have no bounds, as in FullFlow's own models: bounded, SciPy's
  trust region took steps the size of the distance to a bound, a third slower in every
  step. FullFlow's transient solver runs with two-point Jacobians and 1e-8 tolerances;
  results come back at up to 2,000 points. Built this way, the Vespula example is its
  FullFlow run again: every pressure, temperature, and flow to a few parts in a million
  (`test_the_vespula_example_is_its_fullflow_run`). A **fit** (`fit.py`, the same kind of
  process, stopped after 30 minutes with the best it found) is SciPy's least squares over
  the knobs picked, each on a 0-to-1 scale (a positive one as its logarithm over 1/30 to 30
  times its start, within its limits), each try a run of the model; each compared channel
  (averaged down to 300 points) counts the same, its errors over its swing. The page shows
  a fit's best run, and applies what it found only when asked. A **steady** run
  (`solver: steady`) is FullFlow's quasi-steady sweep (`SteadyState` over time): each step
  forces every dynamic part steady (a line's inertia, a gas junction's mass and energy),
  and tanks hold the pressure measured (or set), since one forced steady would let no
  liquid out. So does a gas junction linked to a pressure transducer (a bottle draining has
  no steady state), its temperature following its channel too, so steady, neither of their
  sensors can anchor a knob. There,
  SciPy's gradient test is off (as `Transient` has it), which stalled it. An **anchored
  run** (`POST /api/yorg/dev/anchors`, the same kind of process as a run) pairs knobs with
  compared sensors: each is FullFlow's `Sensor` (`components.Anchor`) whose balance
  FullFlow solves with the rest in each time step, moving the knob until the model reads
  what the sensor's channel measured (as a share of the channel's size, like the other
  residuals). Knobs are `State`s without bounds (bounded, SciPy's trust region crawls
  toward a CdA's bound of 0), so an anchor can take one past its limits, which the result
  notes. The channel is averaged over each time step (bins of `dt`, whose edges give a
  millionth of a step to times that are sums of `dt`) and read as a straight line between
  them, where FullFlow's `Sensor` holds the last sample. An anchor is off outside its span
  and for a step shorter than a third of `dt` (FullFlow lands on each valve command, and
  retries a hard step in halves), where FullFlow holds the knob: otherwise a knob that acts
  through what a tank holds (a collapse factor) would make up a whole step's difference at
  once. Where no value of a knob matches (a valve's CdA while it's shut; in a transient
  run, an anchor starting partway through with the model off from the test, whose line flow
  can't jump there in a step), FullFlow's solve of the step fails after SciPy has tried all
  it may, and FullFlow retries it in halves: the anchor is off for those, up to the end of
  the step it failed (anchored, each would fail as long again), so it holds the knob, and
  the result says for how much of the span. The result has each knob's history (`anchored`)
  and, from where it was anchored, its median and 10th and 90th percentiles (`anchors`),
  which the page applies only when asked. What anchoring can't settle is fitted, in the
  same process (`fit.tune`, with the fit's time limit): knobs picked to fit alongside the
  anchors, and, falling back (on unless asked not to), each knob whose anchor didn't work:
  it never matched, matched for under a quarter of its span, or settled past its limits.
  The fit is the one above, its runs anchoring the anchors that worked, compared with the
  sensors they don't use; the result is its best run, with its anchors, and the knobs it
  took over and why (`fit.fallback`). The browser compares each sensor with its output in
  the model's units (`units.ts`, like `channels.py`) and says the RMS and bias; the
  window's times, and the plots', read from the dataset's T0 in this browser. Saved models
  are JSON files in `YJSP_YORG_DIR/models`, so the models add no tables. The examples are
  built in the browser (`model.ts`). Vespula's prop system is Saaketh Ramoju's FullFlow
  model (github.com/saakethramoju/Vespula, `VESPULA_PROP_SYSTEM.py`) in Yorg's parts,
  linked to `vespula-run.csv`: that model's run as the repository's prop curves came from
  it (0.1 s steps, bang-bang off), made again with FullFlow 2.0.3 for every channel, its
  curves matching to 1 part in 10⁸. Picking it uploads the file as a dataset, unless one
  has its name. Built of the same FullFlow components and ThermoProp properties (real
  nitrogen, LOX, RP-1), a transient run of it is that run again, to a few parts in a
  million; the hi-flow switches and relief valves come from their channels, where Vespula
  works them out (a relief valve opens for single steps). FullFlow, ThermoProp, and
  FullPlot are GPL-3.0: fine for the team's own server, but if the site is ever given to
  others, the GPL applies to it.
- **A model's script** (the Models page's Script view): a run's code is a FullFlow script
  that `script.py` writes from the checked model and how it runs (window, time step,
  solver, anchors), so the page can show the code that runs, and change it. All that comes
  from the model goes in as a literal (a name as `repr`, a comment on one line): the server
  runs only code it wrote, the runner's `network.run` writing the script and running it
  (`exec`, the run's channels its `data`). Its variables are named for the parts. The script
  imports FullFlow and `yorg_models`: `library.py` (`Run`: the test's channels into the
  network, as `following`, `starting`, `command`, and `liquid`; the outputs recorded;
  knobs anchored; the network solved, and the result the page shows) and `components.py`,
  which import nothing of the server's, so a browser can have them. The page asks for the
  script (`POST /api/yorg/dev/script`, anchors checked as an anchored run's), for
  `yorg_models` and the versions of FullFlow and ThermoProp the server has
  (`GET /api/yorg/dev/library`), and for a run's channels as the runner gets them
  (`POST /api/yorg/dev/inputs`, a missing sample null). Run runs the script as it's shown:
  as written, on the server (with anchors, as an anchored run without the fit of what they
  don't settle); changed, in the tab's Python (Scripts, below), with FullFlow and
  ThermoProp installed from PyPI at the server's versions, `yorg_models` and the channels
  written to its files, and `data` read from them; the script reports the run's time as it
  goes, and its result as JSON. Unchanged, the browser's run is the server's to the last
  digit (`test_a_runs_script_is_what_it_runs` runs the page's script with the page's data).
  Installing takes a minute or two the first time, and importing FullFlow and ThermoProp
  a minute or more (CoolProp's and ThermoProp's data). A changed script isn't saved, and
  Tune (`Tune.tsx`: a fit or an anchored run, side by side in one dialog, each saying what
  it does) runs the P&ID's model. The Reference (`FullFlowReference.tsx`) is background:
  what FullFlow is, how each part is built of its components (with the knobs it has, from
  the catalog), how it models a system and solves it, and what a script is made of.
- **Scripts** (the Python window, everyone's):
  Python people write runs in the browser, never on the server (which runs only the model
  scripts it writes itself): Pyodide (CPython in WebAssembly, pinned
  in `web/src/yorg/scripts/worker.js`, from jsDelivr), in a module worker started from a
  `data:` URL inside an iframe sandboxed to scripts alone (Pyodide 314 runs only in module
  workers, and a sandboxed frame can't start one from a blob). The frame's origin is its
  own, so a script, whoever wrote or uploaded it, can't reach the site, its API, or the
  session: it gets only what it asks the page for in messages (`python.ts` answers
  read-only: the list of tests, a channel's samples, from the same store the plots use).
  The tab has one Python (`python.ts`), started when a page first wants it and kept while
  the tab is open, so leaving Scripts and coming back finds its imports done and the
  channels it had; nothing using it for 30 minutes stops it, to give its memory back
  (Pyodide with SciPy, pandas, and CoolProp loaded holds several hundred MB). It does one
  thing at a time: runs in the order asked for (Run while it starts, and the run waits),
  and, with none waiting, a script's slow imports ahead of its run: while a script is open,
  the page has Python import the slow packages it names (`tree.slowImports`, `yorg._warm`:
  NumPy, SciPy, pandas, matplotlib, CoolProp, SymPy; importing them does nothing else) and
  starts its channels coming from the server. That matters because Python is slow at a few
  things (measured on an M-series Mac; a team laptop is slower, and a background tab too):
  starting takes 1 to 4 s; SciPy, pandas, and matplotlib load and import in about 6 s; and
  CoolProp reads its whole fluid library the first time it's imported, about 21 s in
  WebAssembly against 1 s natively (no CoolProp setting avoids it; its calls are quick after
  that). The browser keeps Pyodide's files once downloaded (9 MB for Python and NumPy, 42 MB
  with those packages), even from the sandbox. Python keeps the channels it's been handed,
  by a key for each read of each channel (`inputs.channelKey`), up to 512 MB of samples
  beyond what a run uses: a run hands over only those it hasn't, and a test's channels share
  one time array, which goes once. Each step says what it is as it starts (the worker's
  `progress`: starting Python, loading packages, importing a module, which an import hook in
  `yorg.py` reports, taking channels, running the code), and the page shows it with how long
  it's been going and why the slow ones are slow (`progress.ts`); a run that's over says how
  long it took and where the time went, from the page (the server, waiting for Python) and
  the worker (packages, imports, channels), the rest being the script's own. A page can also
  give a run packages to install from PyPI (micropip, whose messages aren't the run's
  output), files to write, and code to run before and after its own, and code can report
  values back to the page (`report`): that's how the Models page runs a changed script.
  Stopping a run
  that Python has started ends the worker (a browser can interrupt Python only with a
  `SharedArrayBuffer`, which needs the whole site cross-origin isolated), and Python starts
  again without what it had. The tests can't run Pyodide (jsdom), so there Python is a
  stand-in (`web/tests/python.ts`) that says what a test tells it to: the page's side is
  tested, and `worker.js` and `yorg.py` are tried in a browser.
  A script works on the tests attached to it (`DataPanel.tsx`; kept with it), the first the
  one `yorg.channel()` takes from unless given `dataset=`. Before it runs, the page loads the
  channels it names in quotes: the first test's, and another's when the script names that
  test too (`tree.channelsToLoad`), so `yorg.channel("PT-TANK")` needs no `await`; any
  other comes with `await yorg.load(...)`. Tests' names needn't be unique (two folders can
  each have a "Cold flow 1"), so loaded channels go by test id, and code names a test by its
  id where two attached share a name (`complete.testRef`); a name two share is refused, not
  guessed. A script is a notebook (`Notebook.tsx`): cells, each run on its own in the
  notebook's variables (`yorg._namespace`, kept while Python stays open; a saved script's are
  its own, found again when it's opened again), so the cell that loads the data runs once
  and those after it as often as they're changed. Runs are numbered as a notebook numbers
  them ([3] beside the cell, and `<In [3]>` in a traceback, whose line is marked in its cell);
  "run all" is one batch (`RunRequest.batch`) that stops at a cell that fails, and stopping a
  running cell starts Python again and drops what's waiting, as it counted on what Python had.
  A cell's output is under it; one from before Python started again is dimmed and says so. The
  cells are kept as the script's code, a `# %%` line (with a title, and `[markdown]` for text)
  starting each (`cells.ts`, as VS Code, Spyder, and Jupytext write them): no new field in the
  API, a script downloads as a .py that runs as it is and opens as cells in those, and a script
  without marks is one cell and stays as it was. Text cells are Markdown, shown as React's
  elements (`Markdown.tsx`), never HTML from the text, and their links go only to the web, mail,
  or the site. Jupyter's keys work after Escape leaves a cell's code (↑ ↓, A and B, D D, M and
  Y, Enter). The editor is CodeMirror 6 (`CodeEditor.tsx`; the web app's only dependency beyond
  React, for what a textarea can't do: highlighting as Python reads, folding, many cursors,
  find and replace, and a list of suggestions; about 190 KB gzipped, in its own chunk that
  loads with Scripts), colored from the site's variables and code colors of its own
  (`editorTheme.ts`, `--code-*` in scripts.css). It suggests as you type: channels' names in
  quotes where a channel goes, tests' after `dataset=`, the module's after `yorg.`
  (`complete.ts`, with the Reference's words beside each); the code's own names and Python's
  words; and what the notebook's variables have, from jedi in the running Python
  (`yorg._complete`: `pt.` offers `t`,
  `values`, `si`...). Hovering a name shows its signature and docstring (`yorg._inspect`), and
  Python's own reading of the code (`yorg._check`) underlines a syntax error as it's typed.
  The editor asks Python only while it's otherwise idle, and waits for its answer 3 s at most,
  so a run never waits on the editor; Python gets jedi ready (about 2 s, and what it's
  slowest to learn the first time, NumPy's arrays) once it's been idle 4 s. Clicking a channel
  under Data puts in its `yorg.channel(...)` (its name, in a string) where you last typed.
  The page is laid out as an editor is: the scripts, the notebook, and beside it the tests
  attached (Data) or the `yorg` module's Reference (`Reference.tsx`), each pane under a head of
  the same height, the side panes staying in view as the notebook scrolls. The Reference
  (`docs.ts`) gives each of `yorg.py`'s public names its signature, a line, more, and an
  example; `tests/yorg-reference.test.tsx` holds it to `yorg.py`'s own names and signatures,
  so the two can't drift. A search shows the names it's in, or failing that, the entries it's
  in; Insert puts an example after the line the cursor's on, in the cell last written in. In
  the tests, CodeMirror runs in jsdom with its ranges measured as empty (`tests/setup.ts`), and
  code is set and read through CodeMirror (`tests/notebook.ts`). A notebook's plots let the
  wheel scroll the page, and zoom with Ctrl or ⌘ held (`Plot`'s `wheelScrolls`).
  A dataset's or view's page has Python of its own (`PythonDock.tsx`, its Python button):
  a notebook docked beside the plots (as wide as it's dragged), on the page's tests, whose
  cells run with the page's time in view, T0, and each test's shift as they are when a cell
  runs (`RunRequest.view`: `yorg.window`, `yorg.t0`, `yorg.shifts`), and whose `yorg.plot`s
  go on the page's own plots, under them, on its time axis: the Workspace's `extraPlots`,
  with its window, cursor, and marks, a Channel's times placed where its test is shifted to,
  and a × to take one off the page (running its cell again puts it back). Its notebook is
  the page's (`page-dataset-5`: its cells and runs kept in the tab, `stored.ts`), so it's as
  it was when the page is made again (a view saved, a file read again); it starts on what
  the page plots. Open in Scripts takes it, cells, tests, and variables, to the Scripts page to
  be kept. Its head says how Python is, and opens the Reference in the notebook's place (the
  notebook's hidden, not gone, meanwhile). The workspace's keys leave it alone (`.yorg-dock`),
  and it loads (with CodeMirror) only when it's opened. The
  `yorg` module (`yorg.py`, sent to the worker as text) gives channels as NumPy arrays with
  their units (`Channel.si()` for SI), and sends plots (drawn with Yorg's `Plot`),
  matplotlib figures (as PNGs), and files to save back to the page. Pyodide's own packages
  (NumPy, SciPy, pandas, matplotlib, CoolProp, ...) load from the imports a script has.
  Scripts are JSON
  files in `YJSP_YORG_DIR/scripts` (`yorg/saved.py`, as system models are): a name, a
  folder path, the code (its cells, marked), and who saved it (`created_by_id`). Anyone can
  open, run, and save one; only whoever saved it, or an admin, can change or delete it
  (`check_can_change`, as for a view), so saving another's keeps a copy of your own. Those
  saved while scripts were only admins' have no `created_by_id`, and only admins change
  them. REFPROP isn't there: it needs NIST's license, and would run
  on the server behind a property API.
- **Menus** (all of the app's, through `usePopover`) are fixed to the window where their
  button is, and moved or flipped to stay whole on screen, so neither a window edge nor
  a scrolling area cuts them off.

## API

Yorg's endpoints, all under `/api/yorg`. Every one needs sign-in; how errors look, and the
site's own endpoints, are in [design.md](design.md#api).

| Endpoint | Purpose |
|---|---|
| `GET /api/yorg/datasets?deleted=` | Yorg's datasets, newest first (or the deleted ones) |
| `POST /api/yorg/datasets?filename=&name=&description=&folder=` | upload a file of test data (the raw body) into a folder (or the top) and read it; one that can't be read comes back `failed`, with why |
| `POST /api/yorg/datasets/move` | move datasets `{datasets, folder_id}` into a folder (null: the top); all or none |
| `GET`/`POST /api/yorg/folders`, `PATCH`/`DELETE /api/yorg/folders/{id}` | folders of datasets `{name, parent_id}`; rename or move one; delete an empty one |
| `GET`/`PATCH`/`DELETE /api/yorg/datasets/{id}` | a dataset with its channels, events, and how it was read; rename it; delete it (restorable) |
| `POST /api/yorg/datasets/{id}/read`, `/restore` | read its file again another way `{time_column, time_format, sample_rate, header_row, delimiter}`; restore it |
| `POST /api/yorg/datasets/{id}/split` | make datasets of spans of it `{pieces: [{name, start, end, zero}], folder_id}`, all or none (422 if a span has no samples) |
| `GET /api/yorg/datasets/{id}/source`, `/data/{version}/{file}` | the file as uploaded; one of a read's arrays (little-endian float64) |
| `GET`/`POST /api/yorg/views`, `GET`/`PUT`/`DELETE /api/yorg/views/{id}` | saved plot layouts `{name, folder, description, datasets, config}` (`folder` optional: left out, a new view's at the top and a changed one stays put) |
| `GET`/`POST /api/yorg/formulas`, `PUT`/`DELETE /api/yorg/formulas/{id}` | calculated channels `{name, expression, unit, description}`; names are unique, whatever their case |

## Roadmap

7. **Yorg** (first version done, September 2026): upload, read, plot (an axis per
   unit), compare, views, links, exports, calculated channels, folders, labels, measuring,
   masks, splitting files into their tests, time from T0 or of day (UTC or local), and a
   Help page (`Help.tsx`, `/yorg/help`: keep it in step with the features). Next:
   statistics over a selected span (and over each test, from its mask),
   reading while the file is still uploading for very big files, and data streamed live
   from the test stand.

