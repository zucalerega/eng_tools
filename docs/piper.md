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
  approved) sees every diagram, makes them, and changes them: a P&ID is the team's, and its
  history keeps every change, so nothing anyone does to one is lost. Only whoever made one, or
  an admin, deletes it, which hides it with everything kept, until they restore it. A diagram's
  folder is a path of its own (`piper_diagrams.folder`, "Vespula/GSE", "" at the top), tidied
  as Yorg's views' folders are (`FolderPath`, now the site's, in `api/schemas.py`), and the
  Diagrams page arranges them in a tree (the site's `pathTree.ts`, which Yorg's views and
  scripts use too), as Yorg's Views tab does: each folder with how many it has, and a diagram
  dragged onto a folder (or onto the top) moved there, by anyone, as anyone may change one. A
  folder is picked from those there are, or typed new, with the site's `FolderPicker`, as a
  view's or a script's is. Its search looks in names, folders, descriptions, and the tags of the
  drawings' parts and lines, so PT-101 finds the diagrams it's on. A new diagram starts empty or
  from an example (`example.ts`: a pressure-fed engine's feed system, built with the editor's own
  changes), and Duplicate copies one.
- **The drawing** is plain JSON (`web/src/piper/drawing.ts`): its parts, lines, fluids, and
  style. The server keeps it as the web app sends it, after checking only what it needs
  (`schemas.py`): an object with lists of parts and lines, each with an id no other has, a
  part with its kind and a finite place, a line with its two ends; no NaN, no text that isn't
  Unicode, nothing nested more than 50 deep, and at most 2 MB of JSON (422 `invalid_drawing`,
  saying what's wrong in words, or 413 `too_large`). It notes what the list shows and searches
  (how many parts and lines, their tags, the lines' fluids). What a part is (a ball valve, its
  ports, its properties) is the web app's: the server never needs to know. `readDrawing` reads
  any drawing back, filling in what an older one lacks and leaving out what can't be read (a
  line to a part that isn't there), and a kind it doesn't know is drawn as a dashed box and kept.
- **Saving** is automatic: a second after the last change, the web app sends the whole drawing
  with the version it was changed from (`PUT /api/piper/diagrams/{id}/drawing`). The server
  takes it only if the diagram is still at that version (one `UPDATE ... WHERE version = ?`,
  the transaction's first write, so saves of a diagram go one at a time and only one from each
  version is taken), and gives it the next; otherwise someone saved since, and the 409
  `changed` says who, when, and the version it's at (`details`: `updated_by`, `updated_at`,
  `version`, from the latest revision, so a rename doesn't name the renamer). The page then
  stops saving and asks: keep yours (saved over theirs, as a revision of its own, so theirs
  stays in the history), save yours as a new diagram, or load theirs. A diagram deleted since
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
  is (a solenoid valve: a valve, a globe body, a solenoid, NC). Valves (ball, gate, globe,
  needle, butterfly, plug, solenoid, pneumatic, motorized, check, three-way, angle, relief,
  regulator, burst disc, quick disconnect); vessels (tanks, spheres, bottles and COPVs,
  dewars); flow elements (orifices, venturis, cavitating venturis, flow meters, filters);
  instruments (pressure transducers, gauges, and switches, thermocouples, RTDs, load cells,
  flow, level, position, and differential pressure sensors, as ISA bubbles); equipment
  (engines, pumps, igniters, heat exchangers, vents, and a box for what has no symbol);
  fittings (tees, caps, reducers, flex hoses); and notes (text, regions, off-page connectors, a
  legend, a title block). The library's search finds a part by any of its names (MOV, PRV,
  COPV, cav...). A part is dragged from it onto the drawing, clicked and then placed with a
  click (Shift-click to place more), or double-clicked into the middle of the view.
- **Tags** name parts and lines: a new part gets its kind's prefix and the next number free
  (BV-3, PT-7), and a tag two parts share is marked. An instrument's tag is in its bubble, its
  letters over its number, as ISA draws them; anything else's beside it: under a part in a line
  going across, beside one in a line going down, under or beside others, or where it's dragged.
  Double-clicking a part goes to its tag (or its words, for a note).
- **Properties**: each kind has its own (a valve's body, actuation, normal state, size, Cv,
  rating, and model; a tank's fluid, volume, MEOP, and material; an orifice's diameter and
  discharge coefficient; an instrument's range, output, DAQ channel, and test channel; a
  line's fluid, type, size, wall, material, length, and rating), and any part or line can have
  more, named as the team likes. Values are text, with their units ("0.062 in"), as people
  write them. Any of them can show under the part's tag (the eye beside it).
- **Lines** connect ports. Dragging from a port (the dots on a part under the pointer) draws
  one: to another port, onto a part (its nearest port), onto another line (a tee, joined at a
  junction's dot), or to a point. The line tool draws from anywhere, a line included. A line is
  routed for itself (`route.ts`): out of each port the way it faces, then the shortest way with
  the fewest bends (a bend costs three grid squares of length) that doesn't cross a part, and
  keeps off other lines (running along one costs three times its length), by A* over the lines
  through its ends and just clear of the parts' sides. Its bends are kept in the drawing, so it
  stays as it is until its ends move: moving a part routes its lines again (a line between two
  parts moved together moves with them). Dragging a line's segment moves it, on the grid, and
  routes that line by hand from then on: moving its parts then moves only the bends next to
  them, and an end that comes to face away from its line is routed back around to it, never
  through its part (`mendEnds`). Route automatically puts a line back. Dragging a selected
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
- **Fluids** color lines: each line has one, drawn in its color with its label (LOX, RP-1,
  GN2...) where there's room beside its longest segment, and Carry along its run sets it on
  every line it reaches through valves, fittings, and instruments, up to tanks and engines. A
  line drawn from a run takes its fluid, and one from a tank what the tank holds (not from its
  top, which is its ullage, unless it holds a gas). A tank shows what it holds: a liquid in its
  lower part, a gas filling it, with the label inside. The standard fluids are in `fluids.ts`
  (oxidizers blue, fuels red, nitrogen green, helium purple...); a diagram can change their
  colors, labels, and names, and add its own, keeping only what differs; the legend shows those
  its lines and vessels use, and its valves' states.
- **States**: a valve's normal state colors its body: open (NO) green and closed (NC) red, or a
  diagram's own colors, which the legend shows.
- **Undo and redo** go back through the drawing's changes in this tab (200 of them); a drag is
  one change, and typing in one field, a second or two at a time, is one. Copy and paste go
  through the clipboard, as JSON, so parts and the lines between them go from one diagram to
  another (a line to a part left behind ends where it was), and pasted tags that are taken get
  the next free number. Several parts line up by their edges or centers, or space evenly.
- **Exports** are drawn in the light colors, as on paper:
  - **PDF** (`pdf.ts`): the drawing's SVG turned into PDF's own operators, so it's vector: its
    paths (arcs and curves as Béziers), shapes, and text in PDF's standard Helvetica (nothing
    embedded; its words text that can be searched and copied, each once: a label's halo is
    marked as having no words of its own). On the paper chosen (Tabloid, Letter, ANSI D, A3,
    A4, or the drawing's own size), landscape unless the drawing's plainly tall, and on a
    drawing sheet as Visio's P&IDs are: a border with its zones between its two lines (numbered
    from the right, lettered from the foot, about 4¼ inches each, as ANSI's sheets have them),
    the diagram's named revisions, and a title block (the team, the diagram's name, folder,
    number, revision, who made it, when it was saved), unless the drawing has a title block of
    its own. The drawing's fitted inside the border, clear of that corner. Tested by its
    structure (every object where the cross-reference table says) and by MuPDF rendering it.
  - **SVG** and **PNG** (at twice its size): the drawing alone. **Print** prints the SVG.
  - **Parts list** (CSV): each part's tag, what it is, normal state, fluid, test channel, every
    property, and notes, and each line's tag, type, fluid, properties, and the tags it joins: a
    valve list or an instrument list, filtered in a spreadsheet.

## Importing from Visio

`visio.ts` reads a Visio drawing in the browser and the page saves each of its pages as a
diagram (Import Visio on the Diagrams page, which asks for the file first, as Yorg's Upload data
does, or a file dropped on it; the dialog shows the file, to change, and the folder). A .vsdx
(Visio 2013 on) is a zip of XML (read with the site's `zip.ts`, which Vault's uploads use too):
each page's shapes, the masters (stencil shapes) they're instances of, and which connector is
glued to which shape.

- **Shapes** become parts by their masters' names (Visio's P&ID stencils' "Gate valve",
  "Vessel", "Indicator"..., and the words people use, `NAMES`), turned and flipped as Visio had
  them, a hundred units to the inch, or as many as draws their valves as big as Piper's.
  A shape's text is its tag when it's one (`PT 101`, PT over 101, `MOV-OX`), and a circle tagged
  as an instrument is one, by its tag's letters (P a pressure transducer, T a thermocouple...).
  Text that's only text is a note; other words a part had stay as a note under it; a container
  is a region; and a shape Piper has no part for is a box with its text, which the import names.
- **Connectors** become lines, routed Piper's way between the ports nearest where they were
  glued (a free one before one taken), or nearest their ends within reach, or to their points;
  glued to another connector, a tee. A line carries the fluid its text names, else what it's
  drawn from holds, else, for a colored line, a fluid of the diagram's own named for its color
  ("Red lines"), to rename. Its kind comes from its master (pneumatic, electrical) or its dashes;
  its arrows, size, and tag from Visio.
- A .vsd (before 2013) or a .vdx can't be read: the import says to save it as a .vsdx in Visio.

## Test data from Yorg

A diagram reads a test from Yorg: pick one of Yorg's datasets, and each instrument shows its
channel's value, and each valve its state (open green, closed red, anything else amber), at a
time on a timeline that plays the test (at a tenth of its speed to ten times it), with its
events (a sequence's steps) marked, to go to. Selecting a part shows its channel over the whole
test, and Plot in Yorg opens the test in Yorg with those channels plotted (in a tab of its
own). The test and the time are in the page's address (`?test=5&t=12.5`), so a link opens the
diagram at that moment of that test.

A part reads the channel named in its Test channel, or, without one, the channel named as its
tag: PT-101 reads PT-101 (`testdata.ts`). Names match whatever their case, then ignoring spaces,
dashes, and underscores. A state channel (Yorg numbers a switch's off 0 and on 1) is the
valve's state; a number channel is open where it isn't 0 (a command, or a position). A value's
the channel's last sample at the time, to the digits its file had. The parts that name a
channel the test hasn't are listed.

That's Piper's one tie to Yorg, and it's through Yorg's API, as any client's would be: Piper
asks `/api/yorg/datasets` for the tests, `/api/yorg/datasets/{id}` for a test's channels, and
their arrays for the samples (each fetched once), and makes Yorg's links to plots as Yorg does
(`?plots=`, a layout's JSON, deflated and base64url-encoded: the site's `packed.ts`, which both
use). It imports none of Yorg's code, and Yorg knows nothing of Piper.

## API

Piper's endpoints, all under `/api/piper`. Every one needs sign-in; how errors look, and the
site's own endpoints, are in [design.md](design.md#api).

| Endpoint | Purpose |
|---|---|
| `GET /api/piper/diagrams?q=&deleted=` | the diagrams, the most recently changed first, without their drawings; `q`: those whose name, folder, description, or tags have every word (or the deleted ones) |
| `POST /api/piper/diagrams` | a new diagram `{name, folder, description, drawing}` (`drawing` optional: an empty one) |
| `GET`/`PATCH`/`DELETE /api/piper/diagrams/{id}` | a diagram with its drawing (a deleted one too); rename, move, or describe it `{name, folder, description}`; delete it (restorable: whoever made it, or an admin, else 403 `not_yours`) |
| `POST /api/piper/diagrams/{id}/restore` | restore a deleted diagram (whoever made it, or an admin) |
| `PUT /api/piper/diagrams/{id}/drawing` | save its drawing `{drawing, version, fresh}`: 409 `changed` if it's no longer at `version` (`details`: `version`, `updated_by`, `updated_at`), 409 `deleted` if it's deleted; `fresh`: start a new revision even if the latest is yours |
| `GET /api/piper/diagrams/{id}/revisions` | its revisions, the latest first, without their drawings |
| `GET`/`PATCH /api/piper/diagrams/{id}/revisions/{number}` | a revision with its drawing; name it `{note}` ("": no name) |
| `POST /api/piper/diagrams/{id}/revisions/{number}/restore` | make a revision the drawing again `{version}`, as a new revision (409 `changed` as for a save) |

## Roadmap

1. **Piper** (first version, October 2026): diagrams with history, the library, lines routed
   and snapped, fluids and states, properties, Visio's drawings imported, exports (PDF on a
   drawing sheet), test data from Yorg, and a Help page (`Help.tsx`, `/piper/help`: keep it in
   step with the features). Next:
   - **Releasing a diagram**: locking one as the P&ID of record (for a test's procedures), so
     changes go into a new revision that's released in turn.
   - **Several people at once**: seeing who else has a diagram open, then editing together.
   - **The team's own parts**: kinds drawn and saved in Piper, beside the standard ones.
   - **A diagram as a Yorg model**: a P&ID's parts and lines as a system model to simulate,
     once Yorg's models are released.
   - **Sheets**: several sheets to a diagram, joined by off-page connectors, and a title block
     part filled in from the diagram's history.

## Open questions

- Should a part's channel be checked against the team's DAQ channel list, and where would
  that list live: in Yorg, or in Piper?
- Visio's own stencils differ by version and language; the import knows the English P&ID
  stencils' names. Drawings made with the team's own stencils may need their names added to
  `NAMES`.
