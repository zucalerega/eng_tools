# Piper design

Piper draws the team's fluid systems: P&IDs of the test stands, the vehicle's feed system, the
GSE, with the parts the team uses (valves, regulators, tanks, bottles, orifices, venturis,
pressure transducers, thermocouples...), each with its tag and its properties, its lines in their
fluids' colors, and its valves in the colors of their normal states. It's Visio for the team's
plumbing, with what Visio lacks: lines that stay on the ports they're drawn to and route around
parts, a valve dropped on a line put into it, every change kept in a history, and the drawing
read against a test's data from Yorg. Visio's own drawings import into it, and it saves PDFs on
a drawing sheet as Visio's P&IDs are. It's one of the three apps on the team's site, beside
Vault and Yorg, and shares the server, the database, sign-in and accounts, and the web app's
frame with them, and nothing else ([design.md](design.md) has those): its own tables
(`piper_*`), its own API (`/api/piper`), and its own pages (`/piper`). Its code is
`server/src/yjsp_server/piper` and `web/src/piper`.

## Diagrams

- **A diagram** is a drawing with a name, a folder, and a description. Everyone signed in (and
  approved) sees every diagram, makes them, and changes them, one person at a time: a P&ID is
  the team's, and its history keeps every change, so nothing anyone does to one is lost. Only
  whoever made one, or an admin, deletes it, which hides it with everything kept, until they
  restore it.
- **Folders** are their own, as Yorg's datasets' are (`piper_folders`, `folders.py`): each in
  another or at the top, its name unique in it whatever its case (409 `name_taken`), with no
  slashes. A diagram is in one by its id (`folder_id`, null at the top). Anyone makes, renames,
  and moves a folder (never into itself: 409 `cycle`), as anyone moves a diagram, and deletes
  one once it's empty (409 `not_empty`); the deleted diagrams that were in it go to the folder
  it was in, to be restored there. Before folders were their own (until migration 0027), a
  diagram's folder was a path (`folder`, "Vespula/GSE"); the API still gives it, and still takes
  one (`FolderPath`), the folders on it made where they aren't there yet (`folders.folder_at`),
  so clients from before work as they did.
- **The Diagrams page** works as Yorg's datasets' does: `/piper` and each folder's page
  (`/piper/folders/{id}`), with the way back up above its name, list a folder's own folders and
  diagrams; New folder, New diagram, and Import Visio (or a drawing dropped on the page) make
  theirs in the folder you're in. Diagrams and folders dragged onto a folder (or a folder in the
  way back up) move there; diagrams checked are moved together (Move to…, the site's
  `FolderDialogs.tsx`, which Yorg's datasets use too), and deleted together if they're all
  yours (or you're an admin), each all or nothing on the server. Deleted diagrams have their
  own page, where they're checked and restored together. Its search looks in every folder, in
  names, folders, descriptions, and the tags of the drawings' parts and lines, so PT-101 finds
  the diagrams it's on, each saying its folder, and a diagram found opens at what was searched
  for (`?find=PT-101`, as the editor's find goes to it). A new diagram
  starts empty or from an example (`example.ts`: a pressure-fed engine's feed system, built
  with the editor's own changes; for admins, Simulation's too, `sim/examples.ts`), and
  Duplicate copies one.
- **The drawing** is plain JSON (`web/src/piper/drawing.ts`): its pages, each with its id,
  name, parts, lines, and printed sheet, and the fluids, style, and simulation's units they
  share (format 4, whose parts can have links to pages about them, `links`; format 3 had parts
  and lines with their settings in a simulation, `sim`; format 2 had pages without them, and a
  drawing from before pages, format 1, has its parts and lines at the top, and is one page).
  The server keeps it as the web app sends it, after checking only what it needs
  (`schemas.py`): an object with up to 100 pages, each with an id no other page has and lists
  of parts and lines, each part and line with an id no other in the whole drawing has (an
  off-page connector names a part on another page by it), a part with its kind and a finite
  place, and its links, if it has any (at most 20, each an http, https, or mailto address of up
  to 2,000 characters with no spaces or control characters in it, and a name of up to 200: "Page
  1's part 3's link 2 isn't an http, https, or mailto link"), a line with its two ends; at most
  5,000 parts and 10,000 lines on all its pages; no
  NaN, no text that isn't Unicode, nothing nested more than 50 deep, and at most 2 MB of JSON
  (422 `invalid_drawing`, saying what's wrong in words, "Page 2's part 4 has no kind", or 413
  `too_large`). It notes what the list shows and searches (how many parts, lines, and pages,
  their tags, the lines' fluids) and the drawing's format. What a part is (a ball valve, its
  ports, its properties) is the web app's: the server never needs to know. `readDocument` reads
  any drawing back, filling in what an older one lacks and leaving out what can't be read (a
  line to a part that isn't there), and a kind it doesn't know is drawn as a dashed box and
  kept; the editor works on a page at a time (`pageOf`, `withPage`).
- **Pages** are a P&ID's sheets: tabs under the drawing (`PageTabs.tsx`) add, rename, move,
  and delete them, each a change undo goes back through (the editor's undo keeps the whole
  drawing and the page it was at). A page's **printed sheet** (`sheet`: a paper, which way it's
  turned, and the paper's top left and scale in the page's units) is set in its panel, fitted
  to what's on it inside the border and clear of the title block's corner as a PDF would fit
  it (`fitSheet`); the canvas outlines it (`sheetOutline`), and the PDF prints the page there,
  so the layout and scale stay put as the drawing changes. An **off-page connector** goes to a
  page, and a part on it (`props.page`, `props.part`, by id), and is written `TO` and the page's
  name (its box as wide as its words) until its words are changed; going there switches the
  page and shows the part, and the part it arrives at lists it. Deleting a page leaves its
  connectors going nowhere.
  Find, Parts, and the parts list look through every page. The server refuses a save in an
  older format than the diagram's drawing is in (409 `drawing_newer`, saying what it would
  lose): a tab still running the Piper from before pages would save one page and lose the
  others, one from before simulations would lose its parts' settings, and one from before links
  its parts' links. Restoring a revision from before them is deliberate, and allowed.
- **Editing** is one person at a time, so no one's save goes over anyone else's
  (`diagrams.take_lock`, `editing.ts`). A diagram opens to be looked at: the store takes no
  change (`readOnly`), the canvas only pans and selects, and the inspector's fields are only
  read. **Edit** (`POST .../lock`) holds it for you: the diagram notes who (`locked_by`), since
  when (`locked_at`), and when their editor last said so (`lock_seen_at`), and the server
  refuses anyone else's save or restore (409 `locked`, with `details.editing`: who, and
  since). Someone else editing it already: 409 `locked` to Edit too, unless an admin takes it
  over (`force`; anyone else 403 `admin_only`). The editor says you're still at it every minute
  (the same POST), except when nothing's been done in the tab for 15 minutes; the server lets
  go of a hold it hasn't heard about in 10 minutes (`LOCK_LAPSES`), so a tab left open, a
  laptop shut, or a browser that crashed never keeps a diagram from the team. Back at it, the
  next click or key says so again, and you go on if no one else has started. **Done editing**
  saves what's left, then lets go (`DELETE .../lock`); so do closing the tab and leaving the
  page (`pagehide`, a `keepalive` request). Anyone's diagram response carries `editing` (null
  when no one is, it's let go, or the diagram's deleted), so the list badges it, and a page that
  has it open asks `GET .../lock` (no drawing) every 20 seconds, and on coming back to the tab,
  for who's editing it and the version it's at, fetching the drawing when it's changed. A save
  by whoever holds it says they're still at it (and holds it again, if it had lapsed and no one
  took it); a save by someone not editing it (a tab from before editing, or the API) is taken
  if no one is. Who holds a diagram changes one at a time: each change starts with an UPDATE of
  its row (SQLite's write lock, Postgres' row lock). A diagram just made, or a copy, opens to
  edit (`?edit=1`).
- **Saving** is automatic: a second after the last change, the web app sends the whole drawing
  with the version it was changed from (`PUT /api/piper/diagrams/{id}/drawing`). The server
  takes it only if the diagram is still at that version (one `UPDATE ... WHERE version = ?`,
  the transaction's first write, so saves of a diagram go one at a time and only one from each
  version is taken), and gives it the next; otherwise someone saved since, and the 409
  `changed` says who, when, and the version it's at (`details`: `updated_by`, `updated_at`,
  `version`, from the latest revision, so a rename doesn't name the renamer). With editing one
  at a time, that's a save from another window of yours, or from someone's tab after your hold
  lapsed. The page then stops saving and asks: keep yours (saved over theirs, as a revision of
  its own, so theirs stays in the history), save yours as a new diagram, or load theirs.
  Someone else editing it now (409 `locked`: an admin took it over, or it lapsed and someone
  took it) stops saving too, and the page is only looked at: save yours as a new diagram (which
  opens to edit), or load theirs. A diagram deleted since
  it was opened (409 `deleted`) stops saving too, and the page shows it deleted; restoring it
  there saves what wasn't. A save the server can't take as it is (400, 413 too big, 422
  `invalid_drawing`) isn't sent again until the next change, which may fix it; any other
  failure (out of reach, signed out) is tried again every few seconds. Either way the page
  says why beside the diagram's name. A tab closing with changes not yet saved asks first;
  leaving the page within the app saves them.
- **Revisions** are the history: each diagram's drawings, numbered from 1 (`piper_revisions`,
  the JSON zlib-compressed, as P&IDs compress about tenfold, and loaded only when asked for). A
  save amends the latest revision when it's the same person's, begun less than 30 minutes
  before, not named, and not a restore; otherwise it starts the next. So an afternoon's editing
  is a few revisions, not thousands, and one person's work never writes over another's in the
  history. Naming a revision ("Rev B, for HF-3") keeps it as it is: the next save starts
  another. Any revision opens to look at, and restoring one makes it the drawing again, as a
  new revision that says where it came from; the drawings after it stay in the history.
- **Releases** (`releases.py`, `piper_releases` and `piper_approvals`) make a revision the P&ID
  of record, for a design review or before a test. Anyone asks for a revision to be released,
  saying what it's for and naming its approvers, at least one besides themself (422
  `needs_approver`), all of them active members. Each approves it or rejects it with a comment;
  once every one has approved, it's released, with the diagram's next letter (A, B, ... Z, AA,
  as spreadsheets letter columns), and the diagram notes its latest release
  (`piper_diagrams.released`, `released_revision`). A rejection ends the request, and so does
  whoever asked (or an admin) withdrawing it. A revision released, or waiting to be, is kept as
  it is: a save never amends it (the next starts another revision) and its name stays (409
  `revision_released`, `release_pending`). A diagram has one release waiting at a time (409
  `release_pending`), each of a revision after the last released (409 `older_than_released`);
  only those named approve (403 `not_an_approver`), once (409 `already_decided`). Writes to a
  diagram's releases go one at a time: each starts with an UPDATE of the diagram's row, which
  takes SQLite's write lock (Postgres' row lock). The editor's name says "Rev B, released" or
  "Draft after Rev B"; a PDF on a sheet lists the releases (each one's letter, what it was for,
  when, and who approved it) where it listed named revisions, and its title block writes the
  revision printed as its letter, or its number after the latest release ("7 (after B)").

## The editor

`web/src/piper`: a diagram's page is the editor, the whole window under the top bar: the
library on the left, the drawing in the middle, and on the right what's selected (or, with
nothing selected, the diagram's fluids and colors). Its state is `store.ts`'s (`EditorStore`:
the drawing, what's selected, the view, what a drag would make of the drawing, and undo and
redo); the changes themselves are pure functions of a drawing (`edit.ts`), and so is what's
drawn (`DiagramView`), which the exports draw too. It's SVG, drawn by React: crisp at any zoom,
and what's under the pointer is what the pointer's on (each part, port, segment, and handle says
what it is, `data-hit`).

- **Parts** come from the library (`library/`): a kind for each symbol, as the ISA (5.1) and ISO
  (10628, 1219) standards draw them, with its size, its ports (where lines connect, each facing
  out of the part, all on the grid), its properties, the prefix of a new one's tag, and how
  it's drawn, in its own frame, centered; and presets, a kind set up as one of the team's parts
  is (a solenoid valve: a valve, a globe body, a solenoid, NC). Valves are small on their lines,
  as P&IDs draw them: a bowtie 22 long and 13 high between ports 40 apart, and its actuator on a
  14-unit stem, a handle or a 12-unit box with a letter, S for a solenoid, P for pneumatic, M for
  a motor; a regulator's sensing line runs from its diaphragm to the pipe it holds (after it,
  or before it for back pressure); an orifice's plate sits on a pipe that runs through it; a
  vent is the spray of what it lets go, three dashed rays from its line's end in the line's
  color; a pump stands on its base, its suction into its middle, its discharge leaving its top,
  and a solid triangle in it pointing the way it pumps. The 3/2 and 5/2 solenoid valves are
  ISO 1219's directional control valves, as pneumatic schematics draw them: a box 40 across
  and 30 high for each of their two positions, with its flow paths (arrows) and shut ports (a
  T), a solenoid at the left end and the spring that returns it at the right. Their ports are
  on the box of the position they rest in, numbered as ISO 5599 numbers them (1 the supply, 2
  and 4 what it feeds, 3 and 5 its exhausts), and the position a valve's state puts it in is
  tinted in that state's color (`DrawContext.state`): at rest, its normal state's (a 3/2 is
  normally closed, its supply shut and 2 exhausted, or normally open; a 5/2 has none); in a
  test, open (the position that feeds 2 from 1, or a 5/2 worked) or closed. Their tags are
  under their solenoids' ends, clear of their ports' lines (`tagX`, as a pump's is under its
  base). A manifold is a block that takes its supply at one end, its far end a port too, and
  gives it out to 2 to 8 outlets along its top (`outlets`), its bore drawn through it; a line
  on an outlet that's taken away stays, ending where the outlet was (`updatePart`). A diffuser
  goes into a line, as a tank's pressurant inlet has one: its body, a perforated face, and
  arrows spreading out from it. Valves (ball, gate, globe,
  needle, butterfly, plug, solenoid, pneumatic, motorized, check, three-way, angle, relief,
  regulator, burst disc, quick disconnect, 3/2 and 5/2 solenoid); vessels (tanks, spheres,
  bottles and COPVs, dewars); flow elements (orifices, venturis, cavitating venturis, flow
  meters, filters, diffusers);
  instruments (pressure transducers, gauges, and switches, thermocouples, RTDs, load cells,
  flow, level, position, and differential pressure sensors, each an ISA bubble with the first
  letter of what it measures in it whatever its tag says (P, T, F, W, L, Z, and PD for a
  pressure difference, as a PDF can't print a Δ; a generic instrument, its tag's first letter),
  and the whole tag at its side; duplicated and triplicated
  transducers, two or three bubbles side by side on one tap, A, B, C, each reading its own
  channel, `channelNames`); equipment
  (engines, pumps, igniters, heat exchangers, vents, and a box for what has no symbol);
  fittings (tees, manifolds, caps, reducers, flex hoses); and notes (text, regions, off-page connectors, a
  legend, a title block, pictures). The library's search finds a part by any of its names (MOV, PRV,
  COPV, cav...). A part is dragged from it onto the drawing, clicked and then placed with a
  click (Shift-click to place more), or double-clicked into the middle of the view. The drag
  is the pointer's own (`LibraryPanel` tells the canvas, `libraryDrop`), not the browser's
  drag-and-drop, which Firefox won't start from a button.
- **Pictures** (`picture`): a PNG or a JPEG of the team's own (an injector, a TCA, a photo of
  the stand), drawn to its box in its own proportions (`preserveAspectRatio` meet), and sized by
  its corner handle keeping its shape (`resize.aspect`). Dropped on the drawing as a file (the
  canvas's one use of the browser's drag-and-drop), or chosen in the inspector, it's added to
  Piper (`POST /api/piper/images`) and the part names it by its SHA-256 (`props.image`, with its
  pixels' `imageWidth` and `imageHeight`). The server keeps pictures in the database
  (`piper_images`, `images.py`), so the nightly and off-site backups have them with the
  drawings: checked as a PNG or a JPEG by their own headers, not their names, up to 5 MB and
  25 megapixels (10,000 on a side, as a PDF of it decodes it in the browser), and never
  changed or deleted, as a revision may still show one; the same bytes added again are the
  same picture. It's sent with its name as its ETag, for the browser to keep (`immutable`).
- **Figures** (`figure`, `library/figures.tsx`): a shape drawn as it was in Visio, for what Piper
  has no part of its own for (a drawing's vehicle and tanks, a manifold's box, a key, a title
  block, a symbol from another stencil). Only an import makes one: the library has none. Its
  drawing is in its props (`figure`, JSON, in its own frame, its middle at 0, 0, at the size it
  was imported at): SVG path data of moves, lines, and Béziers only (`paths`, each with its
  fill, line, width, and dashes), words (`texts`: their lines from their first one's baseline,
  turned about it, each line's runs where they're set in another size, color, or weight), and
  ports where lines were glued to it (`ports`). What's read of it is checked (`figureOf`: path
  data of numbers and those letters only, colors as `#rrggbb`), as a drawing is anyone's to
  send. Black and white (and the near grays a drawing's white often is) are drawn in the
  page's ink and paper, so it reads on a dark page; other colors as they were. It's drawn
  under the lines (`behind`), as a vehicle is under its pipes, and clicked at its edge, so
  what's on it can be; resized by its corner, its drawing stretched to fit and its words kept
  upright. A tagged one (a symbol Piper has no part for, tagged beside it in Visio) is in the
  parts list, as a Figure; one without a tag isn't. A web app from before figures shows one as
  an unknown part's dashed box, and keeps it as it is.
- **Sizes**: a part's drawn at its kind's size, or from half of it to double (`scale`: 0.5,
  0.75, 1, 1.25, 1.5, 2), from the round handle at a selected part's corner or the inspector.
  Its frame's scaled (`toWorld`, `partTransform`), so its box, what's drawn, and where it's hit
  all are; its ports are put back on the grid (`portsOf`), and a line's drawn to its outline in
  line with its port, so lines between parts lined up stay straight. Not for what's sized by its
  width and height (boxes, regions, text blocks), tees, legends, or title blocks. Each part's
  label can be small, normal, or large of its own (`labelSize`; "" the diagram's).
- **Text** notes are sized to their words, or, once their corner handle's dragged, blocks of
  that width and height (`w`, `h`), their words wrapped to it at the spaces, from its top. A
  note's weight, slant, font (sans serif, serif, monospace), alignment, and border are its
  properties; a PDF writes them in PDF's standard fonts: Helvetica, Times, and Courier, each
  regular, bold, italic, and both (F1 to F12; Times measured as nine tenths of Helvetica,
  near enough to place it).
- **Tags** name parts and lines: a new part gets its kind's prefix and the next number free
  (BV-3, PT-7), and a tag two parts share is marked. An instrument's tag is at its side (its
  left, if a line leaves it to the right), and its bubble says what it measures; anything
  else's beside it: under a part in a line going across, beside one in a line going down, under
  or beside others, or where it's dragged.
  Labels are small beside the symbols (a tag 8 units high against a valve's 20), and a diagram
  makes them all smaller or larger (`style.labels`, `textSizes`). Double-clicking a part goes to
  its tag (or its words, for a note).
- **Properties**: each kind has its own (a valve's body, actuation, normal state, size, Cv,
  MAWP, and model; a tank's fluid, volume, MEOP, MAWP, and material; an orifice's diameter and
  discharge coefficient; an instrument's range, output, DAQ channel, and test channel; a
  line's fluid, type, size, wall, material, length, and MAWP). Every kind that holds pressure
  has a MAWP (`mawp`); drawings from before it called a valve's or line's "Pressure rating"
  `rating`, which `readDrawing` reads as its MAWP (a filter's `rating` is its microns, and
  stays). Any part or line can have
  more, named as the team likes. Values are text, with their units ("0.062 in"), as people
  write them. Any of them can show under the part's tag (the eye beside it).
- **Links**: a part can link to pages about it (`links`: each a name and an address), as the
  Elytra P&ID's FMV to its Notion page, or a COTS valve to its spec sheet. The inspector lists
  them under the tag, each opening in a tab of its own (`rel="noopener noreferrer"`) for anyone
  looking at the diagram, and, while it's yours to edit, adds them (**+ Add a link**: a name, and
  an address) and removes them; a link without a name is called by where it goes
  ("notion.so/yjsp/FMV"). The canvas marks a part with links at its top right, the mark's
  tooltip their names; clicking it selects the part. Exports leave the mark out. Only http,
  https, and mailto addresses are taken (`linkUrl`): never `javascript:` or `data:`, which
  would run in the site when one was opened. The server takes no other (`schemas.py`, 422
  `invalid_drawing`), and `readDrawing` (and a paste, `readClip`) leaves out any that isn't one,
  so a drawing sent another way, or a clipboard, can't put one in front of anyone.
- **Lines** connect ports. Dragging from a port (the dots on a part under the pointer) draws
  one: to another port, onto a part (its nearest port), onto another line (a tee, joined at a
  junction's dot), or to a point. The line tool draws from anywhere, a line included. A line is
  routed for itself (`route.ts`): out of each port the way it faces, then the shortest way with
  the fewest bends (a bend costs three grid squares of length) that doesn't cross a part, and
  keeps off other lines (running along one costs three times its length), by A* over the lines
  through its ends and just clear of the parts' sides. Its bends are kept in the drawing, so it
  stays as it is until its ends move: moving a part routes its lines again (`moveItems`). A
  line whose ends both move (on parts that moved, or free ends of a line that's selected) moves
  with them once, as it was; a free end moves only with its line; and a junction comes along
  when every line through it goes to what's moving, so a tee picked up with the parts around it
  stays a tee. A line with an end that stays is routed again, or follows its end if it was
  routed by hand, selected or not. Dragging a line's segment moves it, on the grid, and
  routes that line by hand from then on: moving its parts then moves only the bends next to
  them, and an end that comes to face away from its line is routed back around to it, never
  through its part (`mendEnds`). Route automatically puts a line back, and Route again routes
  one that routes itself afresh. Dragging a selected
  line's end moves it to another port. Where two lines cross without joining, the one across
  hops over the one down (`hops.ts`). A line's type (pipe, tubing, flex hose, pneumatic,
  electrical, data) is its weight and dashes; flow arrows say which way it flows.
- **Snapping**: parts' centers and ports, and lines' bends, are on a 10-unit grid, and every
  kind's ports are on it, so lines between parts lined up are straight. A part being dragged
  also lines its ports up with the ports its lines go to, and its center and ports with other
  parts', within a few pixels, and shows the gold guide it snapped to (`snap.ts`). Holding Alt
  drags freely.
- **Into a line**: a part with two ports facing apart (a valve, an orifice, a filter, a flow
  meter) dropped on a line goes into it, turned to the line's way, its first port toward where
  the line comes from, moved along it as far as it takes to fit on its segment, and the line
  becomes two (on a segment too short for it, routed around it). The line it'll go into is
  shown gold before it's dropped. Deleting it joins the line up again. Deleting a part with
  other lines leaves them, ending where its ports were, to be drawn on to something else; a
  junction left with two lines joins them, and one with one is that line's end.
- **Fluids** color lines: each line has one, drawn in its color, and its label (LOX, RP-1,
  GN2...) only where it's shown (`shown`), where there's room beside its longest segment: new
  lines don't show it, as a color on every line says it already, and the diagram's panel shows
  or hides it on every line at once. Half of a line split by a tee or a part doesn't repeat
  the other half's label, and a label that's the same along a run (`runLines`: on through
  valves, fittings, tees, and instruments' taps) is written once, on the run's longest stretch
  with room that no part covers, else its longest (`lineLabelPlaces`), so moving a part along it,
  which makes room on a piece, doesn't write it again. Carry along its run sets it on
  every line it reaches through valves, fittings, and instruments, up to tanks and engines. A
  line drawn from a run takes its fluid, and one from a tank what the tank holds (not from its
  top, which is its ullage, unless it holds a gas). A tank shows what it holds: a liquid in its
  lower part, a gas filling it, with the label inside. The standard fluids are in `fluids.ts`
  (oxidizers blue, fuels red, nitrogen green, helium purple, combustion gas rose...); a diagram
  can change their colors, labels, and names, and add its own, keeping only what differs; the
  legend shows those its lines and vessels use, and its valves' states.
- **Color schemes** (`piper_schemes`, `schemes.py`; the Schemes page, `Schemes.tsx`) are the
  team's own colors: each one's fluids (id, name, label, color, gas or not) and the colors of
  valves' states, made by anyone, changed and deleted by whoever made one or an admin (`can_change`;
  the seeded YJSP standard has no maker, so it's the admins'; the API says `can_edit`). One is the
  team's default, an admin's to pick ("YJSP standard", which 0025 seeds with Piper's colors as
  they were), and can't be deleted while it is (409 `scheme_default`). A diagram takes a
  scheme's colors into its drawing (`applyScheme`): its fluids become the diagram's own, over what
  it had, and its state colors the diagram's style, noted with the scheme's id and when it last
  changed (`style.scheme`, `style.schemeAt`). So a drawing is drawn, exported, and printed the
  same anywhere, from itself, and a change to the scheme reaches it only when someone takes
  the colors again: its panel says the scheme has changed (`schemeChanged`). New diagrams and
  Visio imports start in the team's default. A fluid's `gas` (a tank of it is full of it) is
  the diagram's, else the standard fluid's (`isGas`). A PDF can be in black and white
  (`monochrome`): every line in ink, normally closed valves filled in ink, normally open ones
  white, failing in place grey.
- **States**: a valve's normal state colors its body: open (NO) green, closed (NC) red, and
  fails in place (FIP: a double-acting valve, which stays where it was when its air or power
  goes) slate blue, or a diagram's own colors (`style`), which the legend shows. The state isn't
  written beside a valve unless it's shown (its eye, or the diagram's panel, for every valve).
- **Finding** a part on the drawing (the toolbar's find, Ctrl+F; `find.ts`): by its tag,
  whatever its case and with or without spaces, dashes, and underscores (as test channels
  match), then by what it is or holds; a line by its tag or fluid. The tag that's it first,
  then tags that start with it. Picked, the view frames it, with room around it, and it's
  selected (`commands.show`).
- **Parts** (`PartsPanel.tsx`), under the drawing: the parts list the CSV saves
  (`documentTable`, every page's, with each one's page when there's more than one), a table for
  each kind of part in the library's order (valves, instruments, vessels...), with how many and
  the columns any of them has, then the lines. A tag goes to its part, on its page.
- **Undo and redo** go back through the drawing's changes in this tab (200 of them); a drag is
  one change, and typing in one field, a second or two at a time, is one. Copy and paste go
  through the clipboard, as JSON, so parts and the lines between them go from one diagram to
  another (a line to a part left behind ends where it was), and pasted tags that are taken get
  the next free number. Several parts line up by their edges or centers, or space evenly.
- **Exports** are drawn in the light colors, as on paper:
  - **PDF** (`pdf.ts`): the drawing's SVG turned into PDF's own operators, so it's vector: its
    paths (arcs and curves as Béziers), shapes, and text in PDF's standard Helvetica (nothing
    embedded; its words text that can be searched and copied, each once: a label's halo is
    marked as having no words of its own; a line of words set in several ways, a figure's,
    placed as one, as SVG places it). On the paper chosen (Tabloid, Letter, ANSI D, A3,
    A4, or the drawing's own size), landscape unless the drawing's plainly tall, and on a
    drawing sheet as Visio's P&IDs are: a border with its zones between its two lines (numbered
    from the right, lettered from the foot, about 4¼ inches each, as ANSI's sheets have them),
    the diagram's named revisions, and a title block (the team, the diagram's name, folder,
    number, revision, who made it, when it was saved, which sheet of how many), unless the page
    has a title block of its own. A page for each of the diagram's (`pdfOfPages`): one with a
    printed sheet on its paper, where its outline shows; one without fitted inside the border,
    clear of that corner. Tested by its structure (every object where the cross-reference table
    says) and by MuPDF rendering it.
  - **SVG** and **PNG** (at twice its size): the page shown, alone, its pictures in it as data
    (`pictures.ts`; an SVG drawn as an image fetches nothing). **Print** prints its SVG.
  - **A legend** (`legend.tsx`), if its dialog's asked for one (the choice kept by the browser,
    `piper.legend`): every kind of part on the page, each once, by what it's called (`titleOf`),
    with its symbol drawn as the library draws it (no state's color, nothing in it) at up to four
    fifths of its size, under its category, in the library's order; then the types of line on
    it, each in its weight and dashes; its fluids (`fluidsUsed`), in their colors; and its
    valves' normal states. In columns, a heading never at a column's foot, in the drawing's
    units and at its labels' size, so it's drawn and printed as the drawing is. An image's is
    beside the drawing, to its right, from its top, its columns as tall as the drawing; a PDF's,
    beside each page, fitted on the paper with it. A page whose printed sheet is set keeps its
    layout, so its legend is a sheet of its own after it (`legendSheet`), on its paper and at its
    scale, from the top left of the border, above the title block's corner, and the sheets are
    numbered with it. In black and white, the fluids are left out: their lines are all ink.
  - **Pictures in a PDF** are its own images: a JPEG as it is (DCTDecode), a PNG decoded
    (`decodePng`: any color type and depth, its rows unfiltered; an interlaced one through a
    canvas) into its pixels and its transparency, a soft mask, each deflated.
  - **Parts list** (CSV): each part's tag, what it is, normal state, fluid, test channel, every
    property, and notes, and each line's tag, type, fluid, properties, and the tags it joins, on
    every page (and each one's page, last, when there's more than one): a valve list or an
    instrument list, filtered in a spreadsheet.

## Importing from Visio

Import Visio on the Diagrams page (which asks for the file first, as Yorg's Upload data does,
or a file dropped on it; the dialog shows the file, to change, and the folder) makes a diagram
of a Visio drawing, in the browser, saved as any diagram is, with its pages as Visio has them
(`visioDocument`: the fluids each page made are the diagram's, one for each). Its dialog then
says what became of each page's shapes: how many parts, lines, notes, and shapes drawn as in
Visio, and which symbols Piper has no part for (by their masters' names, or their tags).

**Reading the file** (`vsdx.ts`). A .vsdx (Visio 2013 on) is a zip of XML (read with the site's
`zip.ts`, which Vault's uploads use too): its document (the styles and the color table), its
masters (stencils' shapes), and its pages (each one's shapes and which connector is glued to
which shape), found by the package's relationships. Each foreground page's shapes are read as
Visio draws them, on the page:

- **A cell** a shape doesn't set is its master's shape's (an instance writes only what differs,
  a resized one its rows' new values too), else its style's (its line, fill, and text styles,
  each based on another, `ShapeSheet`), else Visio's default. A value of `Themed` counts as not
  set: the import doesn't read themes, so a themed shape takes its styles' values.
- **Sections** merge by index: an instance's geometry rows over its master's, one by one (a row
  changed, added, or deleted), and an instance's members are its master's members
  (`MasterShape`).
- **Groups** place their members in their frames: a shape's frame is its local pin put on its
  pin, flipped about it, and turned about it, and a 1-D shape's ends are in its group's frame.
- **Outlines**: each geometry section's rows become moves, lines, and cubic Béziers, on the page:
  arcs (ArcTo, by their bow), elliptical arcs, ellipses, relative rows, polylines, NURBS curves
  (sampled), and splines (through their control points). A section's closed pieces are filled,
  its open ones not, as Visio fills only what's closed. Hidden layers, guides, and NoShow
  sections are left out; a foreign shape (a picture) is kept as its box.
- **Words**: a shape's text (its master's, if it has none of its own) with its paragraphs and line
  breaks, fields as they show, and runs in each character format; its block placed and turned as
  its text transform says, aligned, inside its margins, and spaced as its paragraph says (Visio's
  single is 1.2 of its letters' size, else a size or a share of it, and space before and after).
  Flipping a shape moves its words but never mirrors them or turns them over, so they turn only
  as frames are turned (`Turn`).
- Too big a page (over 20,000 shapes, members included) or part (over 32 MB) is refused; a
  .vsd (before 2013) or a .vdx can't be read, and the import says to save it as a .vsdx in Visio.

**Making a diagram** (`visio.ts`). A page's scale is as many units to the inch as draw its
valves as long as Piper's (40), or a hundred where it has none. Its shapes, in Visio's order:

- **Symbols** become parts: by their masters' names (`NAMES`: Visio's P&ID stencils' and the
  team's, "Powered valve", "Regulator", "3/2 valve", "Relief valves", "Pressure Transducer"...),
  as the one symbol in a group of it and its labels, or, drawn by hand, by their tags' letters
  (`presetForTag`: what P&IDs end a tag with, PRV a relief valve, PNREG a regulator, FCK a check
  valve, PRQD a quick disconnect, FO-1 an orifice, FSWV or OVNT a valve; an instrument's, PT-101 or
  FTPT, by ISA's first letters or the team's last). A valve's worked as its actuator's letter
  says (S a solenoid, P air, M a motor), else its name (ISO 1219's 2/2, 3/2, and 5/2 valves are
  solenoids), else its tag (SV-, PV-). A plain bowtie is Piper's gate valve. Its tag is its
  label's (a tag, or a tag over a set pressure: "PNRV" over "S.P. 165 PSI"), which is its
  part's set pressure; a label beside a symbol rather than grouped with it is the nearest
  untagged one's, and a tag beside a shape drawn by hand says what it is (`attachLabels`). A
  tank's words naming a fluid are what it holds. It's turned and flipped as its frame is, unless
  the lines that meet an in-line part all meet it the other way (a stencil can draw a symbol
  standing up), and put on its lines: across them where they met it, along them between where
  they met it each side (not where an actuator's air line met its box). It's sized as it was
  drawn, of its kind's size; its tag is written where it was, unless that was in it (an
  instrument's, which Piper writes beside it), at about the size it was.
- **Words** alone are Piper's text, set as they were (size, weight, slant, font, alignment), if
  Piper's text can say them (dark, not see-through, level or a quarter turned); else a figure.
- **Groups** with a symbol in them (or a connector glued) are opened, each member placed for
  itself. **Everything else** is a figure, drawn as Visio drew it: a group whole, as one.
- **A key** (a drawing's legend): the shapes about a title ("Line KEY", "LEGEND"), near one another
  and joined to nothing, are drawn as one figure, and read (`keyOf`): the words just right of a
  line drawn in it name what lines in its color carry, or (a size: 1/4", 3/8") what lines
  dashed and weighted like it are, and what of (Polyurethane); the words beside a valve in it
  say which normal state its fill means (Normally open, NC, Fails in place). Without a key a
  valve's normal state isn't set: a preset's own would be a guess the drawing didn't make.
- **Connectors** become lines along the routes they had (`auto` false, their runs made exactly
  level or upright where they nearly were, hops left out), on the ports nearest where they were
  glued (a free one before one taken, not the one its other end is on; glued to a figure, a port
  of its own there, facing the way the line leaves it; glued to another connector, a tee), their
  bends following their ends to Piper's ports (`follow`). A connector glued at an end, or one
  joined to nothing that's level and upright and a connector's, colored, or ending on a part's
  port, is a line; a slanted one glued only to drawings (a vehicle's outline, glued to its nose)
  or joined to nothing, and a line that's drawing (a border's), are figures, as Piper's lines
  are always level and upright. A line carries the fluid its words name, else what a tank it's
  drawn from holds (not from its top, unless it holds a gas), else what the key says lines in
  its color carry (a shade of a key's color, the same hue, is the key's: a standard fluid if it
  names one no other color does, with the key's color, else one of the diagram's own, named as
  the key names it), else, colored, one of the diagram's own named for its color ("Red lines"),
  to rename. Its kind is its master's (pneumatic, electrical, data, tubing, hose), else a pipe:
  dashes alone say what a key says they do, its size; its arrows, tag, and size words are
  Visio's.

## Test data from Yorg

A diagram reads a test from Yorg: pick one of Yorg's datasets, and each instrument shows its
channel's value, and each valve its state (open green, closed red, anything else amber), at a
time on a timeline that plays the test (at a tenth of its speed to ten times it), with its
events (a sequence's steps) marked, to go to. Selecting a part shows its channel over the whole
test, and Plot in Yorg opens the test in Yorg with those channels plotted (in a tab of its
own). The test and the time are in the page's address (`?test=5&t=12.5`), so a link opens the
diagram at that moment of that test, and the browser keeps them for the diagram (`piper.test.<id>`
in its local storage, as `5@12.5`), so it opens to them again without them in its address (from
the diagrams' list) until Test data is closed, which unlinks it. A Test channel is typed, or
picked from the test's channels in a list of the page's own (`ChannelInput`): a datalist's is the
browser's, plain and white on Windows.

A part reads the channel named in its Test channel, or, without one, the channel named as its
tag: PT-101 reads PT-101 (`testdata.ts`). Names match whatever their case, then ignoring spaces,
dashes, and underscores. A state channel (Yorg numbers a switch's off 0 and on 1) is the
valve's state; a number channel is open where it isn't 0 (a command, or a position). A value's
the channel's last sample at the time, to the digits its file had. The parts that name a
channel the test hasn't are listed. A part's value is in a badge off its top right corner, or off
whichever other corner has less in the way (other parts, labels, lines: `badgePlacer`, in
`labels.ts`), on a leader to the part, in the badge's color. Leaders are drawn under the parts,
so a symbol's fill hides its end, and it seems to leave the symbol's outline. The drawing
decides where a badge goes, not its value, so it stays put as the test plays.

That's Piper's tie to Yorg, with Simulation (below), and it's through Yorg's API, as any
client's would be: Piper asks `/api/yorg/datasets` for the tests, `/api/yorg/datasets/{id}` for
a test's channels, and their arrays for the samples (each fetched once), and makes Yorg's links
to plots as Yorg does (`?plots=`, a layout's JSON, deflated and base64url-encoded: the site's
`packed.ts`, which both use). It imports none of Yorg's code, and Yorg knows nothing of Piper.

## Simulation

Simulation mode (the editor's Simulation, `?sim=1` in the address; for admins while it's tried
out, as Yorg's system models are) makes the P&ID a model of its fluid system, which Yorg runs
with FullFlow against one of its tests ([yorg.md](yorg.md), System models): a run, a fit of its
knobs, or knobs anchored to sensors, each a process on the server. Piper builds the model from
the drawing (`web/src/piper/sim/model.ts`, `buildModel`), keeps its settings in the drawing, and
shows what comes back; Yorg checks the model (`spec.py`) and runs it. Nothing of it shows
outside the mode: its panel (`SimPanel.tsx`) takes Test data's place, and the inspector gets a
Simulation box (`SimSection.tsx`). Runs, fits, and anchoring change nothing of the drawing, so
they go while it's only looked at; setting the model up and Apply to the P&ID change it, so
they wait for Edit, as every change does (the box's fields are only read, and Apply is off).

- **The model is the P&ID**, all its pages, joined by their off-page connectors (one going to
  the connector back, or to a tank or an outlet). Its nodes are points with a pressure: tanks
  (Yorg's `tank`, at a fixed pressure, or under a gas ullage once gas lines reach it), gas
  supplies and vessels (bottles, and tanks of a gas: a supply at a pressure, `source`, or a
  vessel that blows down, a `gas_junction` with a wall), outlets (the engine and vents, an
  engine one for each of its inlets with flow, as a model carries one liquid in each connected
  set of lines, all at its pressure), and the points between parts, where lines, tees, and
  plain connections join ports (a `junction` in liquid lines, a `gas_junction` of tubing in gas
  ones). Its edges carry flow between them, from a part's first port to its second: valves
  (relief valves, quick disconnects, and burst discs too, as they're set to be), check valves
  (a valve gas flows through only the way it points; in liquid lines, a valve, which lets flow
  back), regulators, orifices, cavitating venturis, and liquid lines modeled as lines (Yorg's
  `line`: friction, and the liquid's inertia). What each kind is comes from `ROLES`, the first
  of its choices unless its `sim.as` picks another; a pump, a three-way valve, a 3/2 or 5/2
  solenoid valve (`NOT_SIMULATED`), or a figure
  (only drawn: an imported drawing's tanks may be) isn't simulated, so the lines at it end
  there, as the model says (of a figure, where lines do). Lines that carry signals aren't in it.
- **Liquid or gas**: what flows through a part is what its lines' fluids say (Piper's fluids say
  which are gases), through what carries flow from point to point; failing that, what's on
  them (a regulator's gas, a venturi's liquid, a supply's or a vessel's gas). A tank's liquid
  is ThermoProp's for what it holds (LOX is Oxygen, RP-1 RP1; another is Custom, of the density
  and vapor pressure it's given), and an ullage's gas what its gas lines carry.
- **Settings** are kept in the drawing, in SI units by the keys of Yorg's catalog
  (`GET /api/yorg/models/catalog`): a part's on it (`sim.settings`), a line's modeled as a line
  on it (`sim.line`), and a gas point's on each of its lines (`sim.node`: the first that has
  each, so lines split or joined keep them); one the catalog no longer has is left out. What
  isn't set is the catalog's default, or what the P&ID says: a valve's position without a
  command, from its normal state (a relief valve's and a burst disc's, shut); a command's shut
  and open values, from its channel (a state's 0 and 1, a number's least and most). The
  model's ids are the P&ID's, so what's picked to tune survives other changes. The diagram's
  units (US or SI, gauge or absolute, and the atmosphere) are its document's `sim`, and say how
  a channel without units is read.
- **Channels** come from the P&ID, as Test data reads them (`channelNames`): a valve's command
  is its own; an instrument's pressure or temperature, that of the node it taps (a thermocouple
  tapping a tank above its liquid, its ullage's, unless it's set to read the liquid's or the
  wall's); and a flow meter, with no loss of its own, reads the flow of the one part it's in
  line with (set to be an orifice, it's that, with its own). Only the channels the test has are
  linked, by their names there, and the panel lists the parts with none. Whether a channel
  drives the model or is compared with it is the catalog's (a fixed tank follows its
  transducer; an ullage starts from it). A channel can be left out, for conditions of your own:
  unchecked in the Simulation box of its part or of what it sets, it's kept on the part whose
  channel it is (`sim.unlinked`: a valve, an instrument, a flow meter), and isn't linked
  (`Built.left` has it, for the box to check again), so what it would have set is the part's
  settings (a valve's position, a tank's pressure).
- **What the P&ID has to fix** is found before Yorg's checks (`Finding`): what a part carries,
  unsaid or mixed; two tanks joined with nothing between them; a regulator in liquid lines, a
  cavitating venturi in gas ones. Notes say what the model does that the drawing might not
  (a line that goes nowhere is capped, a liquid check valve lets flow back). Each names its
  parts, to go to; Yorg's own messages name parts by their tags.
- **Running**: the panel picks the test (the page's `?test=`, as Test data's), the window on
  the test's clock (◷ takes the timeline's time, and the timeline shades the window), the time
  step, and the solver, and asks Yorg to run (`POST /api/yorg/models/runs`), fit (`/fits`), or
  anchor (`/anchors`; `Tune.tsx` has the two side by side), then how it's going (`/runs/{id}`,
  every 0.6 s, a fit's every second). Results are plotted with the test's channels in the
  diagram's units (`Chart.tsx`, an SVG plot of Piper's own: a channel's samples drawn each
  pixel's lowest to highest, the model's line, and a cursor whose click moves the timeline),
  with RMS and bias; and the drawing shows the run at the timeline's time, a part's in one
  badge in the diagram's units (`live.ts`): an instrument's or a flow meter's, what the test
  measured, then the model's in gold (`Palette.model`, a darker gold on white paper, to read);
  a tank's or a vessel's pressure, unless an instrument on it shows it; the flow through what
  carries it, while there's any, unless a flow meter in line shows it. An outlet's pressure is
  what it was given, so it isn't shown. What a fit or an anchored run found goes onto the parts
  (`applyKnobs`) only when asked, where it's within its setting's limits. Script shows the
  FullFlow script the server runs for the run as it's set up (`POST /api/yorg/models/script`)
  and what it imports (`GET /api/yorg/models/library`), to read; How it's modeled
  (`Reference.tsx`) explains FullFlow, and how each part is built of its components. Results
  aren't kept: leaving the diagram leaves them.
- **Examples** (`sim/examples.ts`, on New diagram for admins): a cold flow, a pressurized flow,
  and Vespula's prop system with its run's data (`vespula-run.csv`), which New diagram adds to
  Yorg as a test the first time (`POST /api/yorg/datasets`, as Yorg's own upload adds one), and
  opens the diagram in Simulation mode on it, to edit, as any diagram just made opens. A transient run of Vespula's at 0.1 s steps is
  its FullFlow run again, every channel to a few parts in a million.

## API

Piper's endpoints, all under `/api/piper`. Every one needs sign-in; how errors look, and the
site's own endpoints, are in [design.md](design.md#api).

| Endpoint | Purpose |
|---|---|
| `GET /api/piper/diagrams?q=&deleted=` | the diagrams, the most recently changed first, without their drawings (with `parts`, `lines`, and `pages`, on all its pages); `q`: those whose name, folder, description, or tags have every word (or the deleted ones) |
| `POST /api/piper/diagrams` | a new diagram `{name, folder_id, description, drawing}` (`drawing` optional: an empty one; or `folder`, a path, whose folders are made where they aren't there) |
| `POST /api/piper/diagrams/move` | put diagrams in a folder `{diagrams, folder_id}` (null: the top), as anyone can: all of them, or none (404, 409 `deleted`) |
| `POST /api/piper/diagrams/delete`, `/restore` | delete, or restore, diagrams `{diagrams}`: all of them, or none (403 `not_yours`) |
| `GET`/`POST /api/piper/folders` | every folder, by name (each with its `parent_id` and `path`); a new one `{name, parent_id}` (409 `name_taken`) |
| `PATCH`/`DELETE /api/piper/folders/{id}` | rename or move one `{name, parent_id}` (409 `name_taken`, `cycle`); delete an empty one (409 `not_empty`) |
| `GET`/`PATCH`/`DELETE /api/piper/diagrams/{id}` | a diagram with its drawing (a deleted one too); rename, move, or describe it `{name, folder_id, description}` (or `folder`, a path); delete it (restorable: whoever made it, or an admin, else 403 `not_yours`) |
| `POST /api/piper/diagrams/{id}/restore` | restore a deleted diagram (whoever made it, or an admin) |
| `GET /api/piper/diagrams/{id}/lock` | the diagram without its drawing: who's editing it (`editing`: `by`, `since`; null if no one is), and its `version` |
| `POST /api/piper/diagrams/{id}/lock` | start editing it, or say you're still at it `{force}` (optional body): 409 `locked` if someone else is (`details.editing`), 409 `deleted`; `force`: an admin taking it over (else 403 `admin_only`) |
| `DELETE /api/piper/diagrams/{id}/lock` | done editing it: anyone can edit it now (nothing changes if it isn't yours) |
| `PUT /api/piper/diagrams/{id}/drawing` | save its drawing `{drawing, version, fresh}`: 409 `changed` if it's no longer at `version` (`details`: `version`, `updated_by`, `updated_at`), 409 `locked` if someone else is editing it (`details.editing`), 409 `deleted` if it's deleted, 409 `drawing_newer` if the drawing's in an older format than the diagram's (a page of a diagram with pages); `fresh`: start a new revision even if the latest is yours |
| `GET /api/piper/diagrams/{id}/revisions` | its revisions, the latest first, without their drawings |
| `GET`/`PATCH /api/piper/diagrams/{id}/revisions/{number}` | a revision with its drawing; name it `{note}` ("": no name) |
| `POST /api/piper/diagrams/{id}/revisions/{number}/restore` | make a revision the drawing again `{version}`, as a new revision (409 `changed` and `locked` as for a save) |
| `GET /api/piper/diagrams/{id}/releases` | its releases, the latest asked for first, each with its approvals and `can_withdraw` |
| `POST /api/piper/diagrams/{id}/releases` | ask for a revision to be released `{revision, approvers, note}` (approvers: accounts' ids): 422 `needs_approver`, 409 `release_pending`, `older_than_released` |
| `POST /api/piper/diagrams/{id}/releases/{release}/approve`, `/reject` | an approver's say `{comment}`: released with the next letter once all have approved; 403 `not_an_approver`, 409 `already_decided` |
| `POST /api/piper/diagrams/{id}/releases/{release}/withdraw` | take back a release that's waiting (whoever asked, or an admin, else 403 `not_yours`) |
| `GET`/`POST /api/piper/schemes` | the team's color schemes, its default first; a new one `{name, fluids, states}` |
| `PATCH`/`DELETE /api/piper/schemes/{id}` | change one (what's left out stays), or delete one: whoever made it, or an admin, else 403 `not_yours`; not the default, 409 `scheme_default`, to delete. Each scheme says `can_edit` and `can_delete` |
| `POST /api/piper/schemes/{id}/default` | make one the team's default (admins, else 403 `admin_only`) |
| `POST /api/piper/images` | add a picture, a PNG or a JPEG, as the raw request body (201: its `sha256`, `content_type`, `width`, `height`, `size`; the same bytes again, the same picture); 415 `not_an_image`, 413 `too_large` |
| `GET /api/piper/images/{sha256}` | a picture's bytes, with its name as its ETag (304 to `If-None-Match`) |

Simulation mode uses Yorg's system models' API (`/api/yorg/models`, [yorg.md](yorg.md#api)), as
any client would.

## Roadmap

1. **Piper** (first version, October 2026): diagrams with history, the library, lines routed
   and snapped, fluids and states, properties, Visio's drawings imported, exports (PDF on a
   drawing sheet), test data from Yorg, releases with approvers, pages with printed sheets and
   off-page connectors between them, pictures of the team's own, Simulation mode (FullFlow,
   for admins while it's tried out), and a Help page (`Help.tsx`, `/piper/help`: keep it in
   step with the features). Next:
   - **Several people at once**: one person edits a diagram at a time now, and everyone sees
     who; next, seeing who else has it open, then editing together.
   - **The team's own parts**: kinds drawn and saved in Piper, beside the standard ones.
   - **Simulation for everyone**, once admins have tried it out.
   - **A simulation's settings from a part's properties**: a valve's Cv as its CdA, an
     orifice's diameter and Cd, a tank's volume, a regulator's set pressure, a line's size and
     length, where they're set and the simulation's aren't.
   - **A title block part filled in from the diagram's history**: its releases, as the sheet's
     own title block lists them.

## Open questions

- Should a part's channel be checked against the team's DAQ channel list, and where would
  that list live: in Yorg, or in Piper?
- Visio's own stencils differ by version and language; the import knows the English P&ID
  stencils' names and the team's (`NAMES`), and the letters P&IDs tag with. A symbol drawn with
  another stencil, untagged, comes in as a figure: should its master's name be added, or should
  Claude (in the site's Help) be asked what the few left over are? Reading a whole drawing that
  way would cost a few dollars an import and could move its lines; naming what's left, a cent.
- Visio's themes aren't read: a themed shape takes its styles' colors. Should they be, for
  drawings made in Visio's default theme (its blue fills)?
- A tank drawn by hand (Vespula's, a block inside its vehicle, its words "LOX Tank 400 psi
  84.7 L") is imported as a figure: Piper's tank is a capsule of its own size (scaled at most
  double) with six ports, and the drawing's lines meet the block all along its sides. So
  Simulation mode leaves it out. Should Piper's tanks be drawn at any size, with ports where
  lines meet them, so an import can make one of it (its fluid, pressure, and volume from its
  words)?
