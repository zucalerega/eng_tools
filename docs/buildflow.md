# Buildflow design

Buildflow is each program's bill of design: Hopper, Elytra, Felicette 2, HETS, each with its
components, by subsystem, drawn on its vehicle, and how far each has come through four phases,
design (DCR, CoDR, PDR, CDR), build (drawings, procurement, manufacturing, inspection), test (TRR,
testing, QRR), and launch (integration, FRR, flight), with the people on it, its due dates, and
links to its CAD and drawings in Vault, its requirements and design documents, its P&IDs in Piper,
and its test data in Yorg. Its program page puts the vehicle on a black stage, as a launch
company's progress page does, each component a dot in the color of where it is in the phase picked,
and under it, in big letters, how many are through it: "18 component-level CDRs across the
vehicle". Its shop (from the team's machining tracker) is the queue of parts to be machined, how
much work each machine has waiting, and who's trained to run it. It's one of the four apps on the
team's site, beside Vault, Yorg, and Piper, and shares
the server, the database, sign-in and accounts, and the web app's frame with them, and nothing
else ([design.md](design.md) has those): its own tables (`buildflow_*`), its own API
(`/api/buildflow`), and its own pages (`/buildflow`). Its code is `server/src/yjsp_server/buildflow`
and `web/src/buildflow`.

## Programs

- **A program** (`buildflow_programs`) is a vehicle or a test stand the team designs, builds,
  tests, and flies: its name (unique, whatever its case, archived ones too: 409 `name_taken`), a
  description, its vehicle's drawing (`profile`), and its place in the list (`position`). Everyone
  signed in (and approved) sees every program and keeps its progress; admins lay programs out
  (`programs.py`), as each one's bill of design is set up once, as the team plans the vehicle, and
  changes only as the plan does.
- **Its milestones** (`buildflow_milestones`) are the steps every component goes through, in four
  phases (`Phase`): each a short name ("CDR", unique in the program whatever its case), what it
  stands for ("Critical Design Review"), whether it's a review (held on a day, and passed) or work
  (done over weeks), and its place in its phase. Every program starts with the same fourteen
  (`templates.MILESTONES`): DCR, CoDR, PDR, CDR; Drawings, Procurement, Manufacturing, Inspection;
  TRR, Testing, QRR; Integration, FRR, Flight. DCR and QRR are said differently from team to team,
  so what they stand for is left for admins to say. Each program's are its own to change.
- **Its subsystems** (`buildflow_subsystems`) group its components: Propulsion, Fluids, Structures,
  Avionics, Recovery. **Its components** (`buildflow_components`) are each in one, in order, with a
  description, whether it's bought off the shelf rather than made (`bought`, COTS), its lead
  (`lead_id`, an active member), and where it is on the drawing (`x` from the aft end, `y` up from
  the centerline, in the drawing's units; both null: not on it).
- **A new program** starts from a layout (`templates.LAYOUTS`): a liquid rocket's (19 components in
  5 subsystems, drawn and placed), a hopper's (11 in 4), a test stand's (14 in 4, its DAQ and
  controls not on the drawing), or blank (the milestones alone).
- **Nothing said of a component is lost.** A component removed is kept (`removed_at`), with its
  progress, links, and people, and comes back at the end of its subsystem; a milestone goes only
  once nothing's kept on it (409 `milestone_in_use`: rename it instead), its blank progress with
  it; a subsystem goes only once no component is in it, removed ones included, as they keep it to
  come back to (409 `not_empty`); and a program is archived, never deleted: kept as it was, off the
  list, and changed by no one, its progress included (409 `archived`), until an admin brings it
  back.

## Progress

- **A component at a milestone** (`buildflow_progress`, one row from its first change; none is
  not started) has its status (`Status`: not started, in progress, done, blocked, or skipped, which
  the web app calls *Not needed*), when it's due (a review's day), when it was done, and a note (a
  review's actions, what's holding it up). A change says only what it changes (`ProgressIn`'s
  fields that are sent); done without a day is done today (the server's UTC day; the web app sends
  the person's own), and no longer done has no day, unless the change says one. Two people making a
  component's first progress at a milestone at once both get theirs: the second is applied over the
  first (`set_progress` tries again on the unique constraint).
- **Where a component is in a phase** (`progress.phase_state`, and `phaseState` in the web app,
  which agree): skipped when everything in it is (nothing to do in it), done when everything else is
  done, blocked when anything's blocked, in progress when anything's started or done, else not
  started. A program's summary (`progress.summarize`) counts its components in each phase so, and
  how many are through each phase's last milestone (`through`, `last_milestone`), for its card and
  its stage's caption.
- **People** (`buildflow_people`): who's on a component in each phase, in order: designing it,
  making it (the build phase's are who's manufacturing it), testing it, flying it. Only active
  members (400 `not_a_member`).
- **Links** (`buildflow_links`): pages about a component, each in a phase, or on a milestone (a
  CDR's slides, in its phase, and moving with it), with what it's a link to (`kind`: CAD, a drawing,
  a requirement, a design document, a review, a P&ID, test data, a procedure, or another link), a
  name, and an address: http or https to a host, or a page of the site's own (`/vault/file/12`),
  with no spaces or control characters in it. Never `javascript:` or `data:`, which would run in the
  site when someone opened it, nor `//host`, which a browser takes as another site (400 `bad_link`,
  `progress.check_address`). At most 100 on a component.
- **Activity** (`buildflow_events`): each change, in words ("CDR: passed; note changed",
  "Manufacturing: Dev, Ben", "Added CAD: LOX tank assembly"), with who made it and when, the latest
  first. A component's `updated_at` is its last change, its progress's included: what's been worked
  on lately.

## The build plan

Each component's lead time, the day it has to be ready by, and what it needs first make the program's
build plan: what to order (or start making) when, so the long leads are seen early, and what holds
up what. Anyone signed in keeps it, as they do progress.

- **A component's lead time** (`lead_days`, 0 to 3,650 days: from ordering it, or starting to make
  it, to having it) and **the day it has to be ready by** (`need_by`), each none until it's said,
  are changed as its description is (`programs.change_component`), and noted in the activity ("Lead
  time: 12 weeks", "Ready by Mar 1, 2027").
- **What it needs first** (`buildflow_needs`, `progress.set_needs`): the components that have to be
  ready before it can be started, on its program and not removed (409 `removed`). None of them may
  need it, however far along (400 `needs_cycle`, saying the way round): neither could ever start.
  A component removed keeps what it needs, as everything said of it.
- **Worked out in the web app** (`planning.ts`, which `buildflow-plan.test.ts` holds to it): the day
  to order or start it by is its ready-by day less its lead time. It's **ready** when it's through
  the build phase. **When it'll be ready as things stand**: once ready, it is; under way, by its day
  (or today, past it); not started, its lead time after the last of its start-by day, today, and
  when what it needs will be ready. From that: *late* (its day's passed, not ready), *late to start*
  (its start-by day's passed, not started), *at risk* (it won't be ready by its day), a *long lead*
  (six weeks or more, not ready), and what it's *waiting on* and *holds up*.
- The server keeps the numbers people say, and none it works out, so the plan's rules stay in one
  place, beside the phases' (`phaseState`), and the deals finder, say, could use the same lead times
  later.

## Bills of materials

Each program's BOM (`bom.py`) is its parts to buy, read in from the team's own BOM spreadsheet,
which stays the team's: Buildflow reads it in again as it changes, and keeps only what the
spreadsheet doesn't say. Anyone signed in keeps it, as they do progress.

- **A line** (`buildflow_bom_lines`): its part number and description (one at least: 422 without),
  the component it's for (one of the program's, not removed: 409 `removed`; none, for a line not
  matched to one yet), how many and in what unit, its vendor, its cost each (cents), its lead time
  (days), a link to where it's bought (`progress.check_address`, 400 `bad_link`), where it is
  (`BomStatus`: to order, ordered, received), and a note. At most 5,000 on a program.
- **Reading one in** (`PUT /programs/{id}/bom`): the program's whole BOM, or one component's,
  becomes the lines sent, in their order. A line already on it, by its key (its component, and its
  part number, or its description where it has none, whatever their case and spacing), is changed
  to what the import says, and keeps its note, and its status unless the import says one; the rest
  are added; those no longer in it go. The activity says how many of each.
- **The spreadsheet is read in the web app** (`sheets.ts`: a CSV file, by RFC 4180, its
  delimiter whichever its first line has most of; an Excel workbook (.xlsx) through the site's zip
  reader, `zip.ts`, its sheets' cells as text; an .xls refused, saying to save it as .xlsx), and
  its columns guessed from its headers (`billOfMaterials.ts`: *Part No.*, *Qty*, *Supplier*,
  *Unit Price*, *Lead Time (days)*, ...), each cell read as the server keeps it ("$412.50" in
  cents, "2-3 weeks" its longest, "1.5 ft" a quantity and its unit, "PO placed" ordered, a yes
  under *Ordered?* ordered). A row with nothing but a description, a section's title, isn't a part.
- **The day to order a part by** is the day its component's build has to start (its start-by day
  on the build plan, or its ready-by day if it has no lead time of its own), less the part's lead
  time; a part still to order past that is *to order now*, and one with a lead time of six weeks or
  more, not received, a long lead.

## Reviews

A design review is often held for several components at once: a subsystem's PDR covers its eight
components, and a system CDR more. A review (`reviews.py`) is one, held at one of the program's
review milestones, so its components' progress is set once, and its files and notes are in one
place. Anyone signed in keeps reviews, as they do progress.

- **A review** (`buildflow_reviews`): its program, its milestone (one that's a review: 400
  `not_a_review` for one that's work), a name ("Feed system PDR"), its day (`held_on`, none until
  it's set), the notes taken in it (Markdown, up to 50,000 characters), and who made and last
  changed it. **The components it covers** (`buildflow_review_components`) are the program's, not
  removed (409 `removed` for one that is); one removed from the program after stays in it, out of
  its rules, until it's brought back. **Its files** (`buildflow_review_links`): its slides, its
  package, its minutes, wherever they're kept (SharePoint, say), each a link as a component's are
  (`progress.check_address`, 400 `bad_link`), at most 50.
- **Its day is each component's date at its milestone** (each one's `due` there), but those through
  it already (done, or skipped) keep theirs. A new day moves them all; no day takes the review's
  old day off those that had it, and leaves a date of their own. A component added gets its day;
  one taken off keeps what it has.
- **Passing it** passes each component it covers at its milestone (done, on the day said, or the
  review's day, or today), but those through it already. Each component's progress is still its
  own, set on the review's page or the bill: one back with actions to close is in progress, its
  note saying what.
- Its changes go through `progress.change_progress`, the same rules as a change to one component,
  so the activity says each ("PDR: passed (Feed system PDR)"), and the review's own changes
  ("Feed system PDR: passed, 6 components").
- **Removed**, a review is kept, with its notes and files, off the program's list until anyone brings
  it back (409 `removed` to change it meanwhile); its components' progress stays as it is either
  way. A milestone a review's held at, removed or not, isn't deleted (409 `milestone_in_use`).

## The web app

`web/src/buildflow`: the programs (`Programs.tsx`), a program's bill of design (`Program.tsx`, and
`Panel.tsx` for a component beside it), its build plan (`Plan.tsx`, and `planning.ts`), its BOM (`Bom.tsx`, `billOfMaterials.ts`, and
`sheets.ts`), its reviews
(`Review.tsx`, and `reviews.ts`), its layout
(`Layout.tsx`, admins'), and the help (`Help.tsx`, `/buildflow/help`: keep it in step with the
features).

- **The programs** (`/buildflow`): a card each, its vehicle's outline on black, how many components
  it has and are through CDR, and a bar for each phase: done, in progress, and blocked, of those
  that need it.
- **The stage** (a program's page, `/buildflow/programs/{id}`): the phases across the top, the one
  picked in gold with a rule after it, each with how many are done in it; the vehicle, drawn from its
  sections (`vehicle.ts`, `drawVehicle`: pure SVG paths, white on black, its joints, tanks' domes,
  and a stand's frame fainter), its components dots in the colors of where each is in the phase
  (`VehicleView.tsx`: gold done, orange in progress, red blocked, gray not started, a small ring when
  it needs nothing in it), each a button that picks its component; the caption (`headline`: "18
  component-level CDRs across the vehicle" in design, then "7 of 19 components built", "through
  QRR", "flown"); and a legend, with how many are in each color. The phase and the component picked
  are in the address (`?phase=build&component=12`), kept there without a page of history for each.
- **The bill**: every component, by subsystem, with its lead, a chip for each milestone (its
  status's color and mark, a red edge when it's late: due before today, and not done), and what's
  due next. A chip's menu sets the status, or opens the component at that milestone. Then *Coming
  up* (what's due and not done, the late first) and *Recent activity*.
- **A component** opens beside the bill (beside it on a window 1300 pixels wide or more, over it on
  a narrower one): what it is, its lead, and a section for each phase (the phase picked open), each
  milestone's status, due date, done date, and note (saved as it's changed; a note when it's left),
  its people, and its links. *Not needed: skip what's not started* skips the phase's milestones
  that haven't started, as for a bought part's design reviews.
- **The build plan** (`/buildflow/programs/{id}/plan`, *Build plan* on the program's page,
  `Plan.tsx`): how many components are to order or start now, late, at risk, long leads, waiting on
  others, and not planned; and a table, the soonest to order or start first (or by subsystem), each
  component's lead time in weeks and its ready-by day (changed where they are), the day to order or
  start it by (red when it's passed), what it needs first (*What ... needs first*, the component
  picker, without itself), and its lane on a calendar: a bar from its start-by day to its ready-by
  day in the color of where it is in the build phase, taller for a long lead, ringed in red when
  it's at risk, with a red line where it'd be ready as things stand; today down the calendar, and
  the months across its head. *Hide what's ready* hides those through the build phase. A
  component's panel, in its build phase, has the same: its lead time and ready-by day, its start-by
  day, what it needs first (*Change…*), what it's waiting on, and what it holds up. The bill marks
  a long lead with a tag (*Long lead*).
- **The BOM** (`/buildflow/programs/{id}/bom`, *BOM* on the program's page, `Bom.tsx`): how many
  parts are to order now, long leads, to order, ordered, and received, and the cost in all; each
  part, by the day to order it by (or as the BOM has it), with its component, quantity, vendor, cost
  each, lead time, that day (red when it's passed), its status and note (set there), filtered by
  component (`?component=`) or status. *Read in a spreadsheet…*: its file, its sheet, its header
  row, which column says what (guessed), its lead times' unit, and whose lines they are (the
  component its *Component* column names, none yet, or one component's alone), with the lines as
  they'll come in, and the names no component has. A component's panel, in its build phase, lists
  its parts (*Parts*), the longest lead first, with how many are still to come.
- **Reviews**, under the bill: each with its milestone, its day (red once it's past and some of its
  components haven't passed), how many have passed, and its files; *New review* (its milestone, a
  name, its day, and its components, by subsystem, *All of* one at once); and *Removed reviews*.
  **A review's page** (`/buildflow/programs/{id}/reviews/{review}`): its name and day, changed where
  they are; its components, each one's status at the milestone (set there as on the bill) and its
  note there (*Actions, outcome*); *Pass…* and *Remove…*; its files, added by their address; and its
  notes, in Markdown (*Edit notes*, saved with *Save notes*; the browser asks before leaving them
  unsaved). A chip on the bill says the review its component's in there, and its menu goes to it,
  as a component's panel does at the milestone.
- **Links to the site's own apps** (`links.ts`): an address on the site (or the site's own origin,
  pasted) is kept as its path, marked with its app, and named by what it goes to, from that app's
  API as any client would ask it (Vault's file, `GET /api/files/{id}`, with its title when that
  says more than its name; Piper's diagram, `GET /api/piper/diagrams/{id}/lock`, without its
  drawing; Yorg's dataset, `GET /api/yorg/datasets/{id}`). Buildflow imports none of their code.
  Its kind is guessed from where it goes (a P&ID, test data, CAD) until it's picked. Anything else
  opens in a tab of its own (`noopener noreferrer`).
- **The layout** (`/buildflow/programs/{id}/layout`, admins'; members are told it's admins'):
  the program's name and description, and its drawing's sections (an engine, with 1 to 9 nozzles
  side by side; body tubes; tanks; couplers; transitions to another diameter; the nose cone; each
  with its length and diameter in any one unit, fins at its aft end, landing legs from it) and
  whether it's on a test stand, changed together, the drawing previewed, and saved at once with
  *Save*, in a bar kept at the foot of the window that says what isn't saved yet (the browser asks
  before the page is left with changes not saved); the vehicle with
  its components' dots, which drag to move them, and *Place* for one that isn't on it, then a click
  where it goes (`toDrawing`); subsystems and components, renamed where they are, moved, added,
  removed and brought back; and milestones, by phase. *Archive…* takes the program off the list.

## The shop

The shop (`shop.py`; `Shop.tsx`, at `/buildflow/shop`) is the team's machining tracker, moved into
Buildflow: the parts the team needs machined, in a queue, and how far each person's trained on each
machine. The tracker ran on one laptop behind a secret link, with no accounts; here, people sign in
as they do for everything else, names are accounts, and the site's backups keep it.

- **Machines** (`buildflow_machines`): the lathe, the mill, the waterjet, and the CNC to start (the
  tracker's), which admins rename, add to, and retire. One retired takes no new parts (409
  `machine_retired`), and keeps those made on it.
- **Parts** (`buildflow_shop_parts`): what it is, what it's for (a component, and so its program;
  or a program as a whole; or neither), the machine, its material, how many, the hours they'll take
  in all, links to its drawing and CAD (as a component's links are: an http or https address, or a
  page of the site's own, `/vault/file/12`; 400 `bad_link`), its status (queued, in progress,
  blocked, done), who asked for it (its responsible engineer: whoever adds it, unless they say), who's
  making it, when it's needed by, and a note. Anyone signed in adds, changes, and moves parts along,
  as in the tracker; one taken off the queue is kept, to put back, rather than deleted. The queue
  shows what's under way first, then what's held up, then what's waiting, then what's done, the one
  needed soonest first in each. A part can't newly be for a component that's removed (409
  `removed`), or in an archived program (409 `archived`); one for it already stays the shop's to
  finish.
- **Who's trained** (`buildflow_skills`): each person's level on each machine, 0 not trained, 1
  supervised only, 2 runs it on their own, 3 trains others. Each says their own; admins can say
  anyone's, and each level keeps who said it. Those at 2 or 3 (`RUNS_IT`) are who can make a
  machine's parts: the queue names them for each part, and the part's form offers them first as its
  machinist. Someone who's left the team (their account disabled) runs nothing.
- **Load**: for each machine that isn't retired, its parts not done, their hours added up (and how
  many have no estimate), and how many can run it, and train others on it: the cards across the top
  of the Shop page.
- **On the bill**: a component's panel, in its build phase, lists its parts in the shop and where
  each is (*In the shop*), with *Queue a part for it*, which starts one already for the component,
  named for it, with its drawing and CAD links. What becomes of a part (queued, each status, taken
  off and put back) is in its program's activity.
- The Shop page refreshes itself every 30 seconds while it's in view, and *Export CSV* saves the
  queue and who's trained as a spreadsheet, as the tracker's did.

## Deals

The site's deals finder (design.md, "Deals") asks each app what it wants found; Buildflow says its
components not yet procured (`wants.py`): through the build phase's milestone for buying
(Procurement, or one named for ordering, purchasing, or buying), else through the build phase.
A bought one is searched for by the part numbers in its description and its links' names, and by
what it is (its name and the start of its description); one the team makes, by the stock its
description names. Those through design (or needing none), bought off the shelf, and changed in
the last two weeks come first. A component stands for what its links go to in Vault (a file) and
Piper (a diagram found at a tag, `?find=PR-101`), so their deals are its own. The bill marks a
component with deals with a tag and how many beside its name (`DealMark`), and its dot with a
speck of gold; its panel lists them under *On eBay*, each hidden for everyone with ✕.

## API

Buildflow's endpoints, all under `/api/buildflow`. Every one needs sign-in; how errors look, and the
site's own endpoints, are in [design.md](design.md#api). Admins' endpoints are 403 `admin_only` to
anyone else.

| Endpoint | Purpose |
|---|---|
| `GET /api/buildflow/programs?archived=` | the programs, in their order, each with its `profile`, `component_count`, how many are where in each phase (`phases`), how many are through each phase's last milestone (`through`, `last_milestone`), and whether you can lay it out (`can_edit`); `archived=true`: the archived ones |
| `POST /api/buildflow/programs` | a new program `{name, description, template}` (`rocket`, `hopper`, `stand`, `blank`) (admins): its whole bill of design |
| `GET /api/buildflow/programs/{id}` | a program's bill of design: its `milestones` and `subsystems` in order, and its `components`, each with its `progress`, `links`, and `people`; its `reviews`; and, for admins, the components `removed` from it |
| `PATCH /api/buildflow/programs/{id}` | rename it, describe it, draw it again (`profile`: `{sections, stand}`), or move it in the list (`position`) (admins); 409 `archived`, `name_taken` |
| `POST /api/buildflow/programs/{id}/archive`, `/restore` | archive it, or bring it back (admins) |
| `GET /api/buildflow/programs/{id}/activity?limit=50` | what's been done to it, the latest first: each `what`, who, when, and its component's name as it is now |
| `POST /api/buildflow/programs/{id}/milestones` | a new milestone `{phase, name, title, review, position}` (admins) |
| `PATCH`/`DELETE /api/buildflow/milestones/{id}` | rename it, say what it stands for, make it a review, or move it in its phase or to another, its links with it; delete one nothing's kept on (409 `milestone_in_use`) (admins) |
| `POST /api/buildflow/programs/{id}/subsystems`, `PATCH`/`DELETE /api/buildflow/subsystems/{id}` | a new subsystem `{name, position}`; rename or move one; delete one with no components, removed ones included (409 `not_empty`) (admins) |
| `POST /api/buildflow/programs/{id}/components` | a new component `{subsystem_id, name, description, bought, x, y}`, at the end of its subsystem (admins) |
| `GET`/`PATCH /api/buildflow/components/{id}` | a component, with its `lead_days`, `need_by`, and `needs` (ids); change what's sent of it: its `name`, `subsystem_id`, `bought`, `x` and `y` (null: off the drawing), and `position` are admins'; its `description`, `lead_id` (null: no one; 400 `not_a_member`), `lead_days`, and `need_by` (null: none) anyone's |
| `GET /api/buildflow/programs/{id}/bom?component_id=` | its BOM, in its order (or one component's lines) |
| `PUT /api/buildflow/programs/{id}/bom` | read a BOM in `{lines, component_id, file}`: the whole BOM (`component_id` null) or one component's becomes `lines`, keeping each line's note and status already on it (unless sent); says how many were `added`, `changed`, and `removed`; 409 `removed`, `archived`; 400 `bad_link` |
| `POST /api/buildflow/programs/{id}/bom/lines`, `PATCH`/`DELETE /api/buildflow/bom/lines/{id}` | a line added by hand; change what's sent of one (`status`, `note`, and the rest); take one off |
| `PUT /api/buildflow/components/{id}/needs` | what has to be ready before it can be started `{component_ids}`: 400 `needs_cycle` for one that needs it; 409 `removed` |
| `DELETE /api/buildflow/components/{id}`, `POST .../restore` | remove a component, keeping everything said of it, or bring it back (admins) |
| `PUT /api/buildflow/components/{id}/progress/{milestone}` | change its progress at a milestone `{status, due, done_on, note}`: what's sent; 409 `removed`, `archived` |
| `POST /api/buildflow/components/{id}/links`, `DELETE /api/buildflow/links/{id}` | a link `{phase, kind, url, title, milestone_id}` (400 `bad_link`); remove one |
| `PUT /api/buildflow/components/{id}/people` | who's on it in a phase `{phase, user_ids}`, in order (400 `not_a_member`) |
| `GET /api/buildflow/programs/{id}/reviews?removed=` | its reviews, by their days, those with none last (`removed=true`: those removed); also in the program's bill, as `reviews` |
| `POST /api/buildflow/programs/{id}/reviews` | a review `{milestone_id, name, held_on, component_ids, notes}`: 400 `not_a_review`; 409 `removed`, `archived` |
| `GET`/`PATCH /api/buildflow/reviews/{id}` | a review, each with its `component_ids` and `files`; change what's sent of it: `name`, `held_on` (null: no day), `notes`, `component_ids` (every one it's to cover); 409 `removed` |
| `POST /api/buildflow/reviews/{id}/pass` | pass it `{done_on}`: each component it covers passes its milestone, but those through it already |
| `DELETE /api/buildflow/reviews/{id}`, `POST .../restore` | remove a review, keeping it, or bring it back |
| `POST /api/buildflow/reviews/{id}/files`, `DELETE .../files/{file}` | a file `{url, title}` (400 `bad_link`); remove one |
| `GET /api/buildflow/shop?removed=` | the shop: its `machines` (each `retired` or not), the `parts` in its queue (`removed=true`: those taken off it), who's `trained` (each with their `levels` by machine id), each machine's `load`, and whether you keep the machines (`can_edit_machines`) |
| `GET /api/buildflow/shop/parts?component_id=&program_id=&removed=` | the parts in the queue, or those for a component or a program |
| `POST /api/buildflow/shop/parts` | a part for the queue `{name, machine_id, component_id, program_id, material, quantity, hours, drawing, cad, status, requester_id, machinist_id, need_by, note}`: `requester_id` left out is you; 409 `machine_retired`, `removed`, `archived`; 400 `bad_link`, `not_a_member` |
| `PATCH /api/buildflow/shop/parts/{id}` | change what's sent of a part (`component_id` and `program_id` together: either sent, the other left out is none); 409 `removed` for one taken off the queue |
| `DELETE /api/buildflow/shop/parts/{id}`, `POST .../restore` | take a part off the queue, keeping it, or put it back |
| `PUT /api/buildflow/shop/skills/{user_id}` | someone's levels `{levels: {machine_id: 0-3}}`: your own, or anyone's (admins); machines left out stay as they were |
| `POST /api/buildflow/shop/machines`, `PATCH /api/buildflow/shop/machines/{id}` | a new machine `{name}`; rename one, or retire it or bring it back `{name, retired}` (admins); 409 `name_taken` |

## Roadmap

1. **Buildflow** (first version, November 2026): programs from layouts, the vehicle on its stage
   with each component's place in each phase, the bill with its chips, each component's progress,
   people, and links (the site's own named by what they go to), what's coming up, the activity,
   and admins' layout: the drawing's sections, placing components, subsystems, components, and
   milestones. Next:
   - **A picture of the vehicle**: a program drawn from its CAD (a side view exported from
     SolidWorks) rather than its sections, for a vehicle the sections don't draw well.
   - **Pickers for the other apps**: a file found in Vault, a diagram in Piper, a test in Yorg,
     from the panel, rather than its address pasted.
   - **The milestones' due dates on the build plan's calendar**, beside each component's lead time
     (the build plan, below, is the build schedule's calendar).
2. **The build plan** (November 2026): each component's lead time, ready-by day, and what it needs
   first; the day to order or start it by, on a calendar, with what's late, at risk, and a long
   lead. Next:
   - **A component's parts on its plan**: when a part's late, its component at risk.
   - **Long leads first for the deals finder**: a component with a long lead, not ordered, searched
     for first.
3. **Bills of materials** (November 2026): each program's BOM read in from the team's own Excel or CSV
   spreadsheets, and again as they change, its parts matched to components, with the day to order
   each by, the long leads, and where each is. Next:
   - **A BOM's parts for the deals finder**: those still to order, searched for by part number.
   - **A spreadsheet kept on SharePoint, read in by its link**, once the site can reach the team's
     Microsoft 365 (sign-in already does).
4. **Reviews** (November 2026): a review held for several components at once, at one of the
   program's reviews, its day each one's date there, passing it passing each one, with its files
   and the notes taken in it. Next:
   - **A review's actions** as items of their own (each with who's to close it and by when), rather
     than each component's note.
5. **The shop** (November 2026): the machining tracker's queue, machines, and training levels,
   with accounts for names, and parts for components on the bills of design. Next:
   - **Bringing the tracker's data over**, if it holds parts or levels worth keeping: its *Export
     CSV*, read in by an admin, names matched to accounts.
   - **Hours spent**, beside the estimate, to estimate the next ones better.
   - **The shop on the bill**: a component's parts on the bill itself, beside its Manufacturing
     milestone, and a part's being done offered as the milestone's.

## Open questions

- What do DCR and QRR stand for on the team? They're left without a title for admins to give.
- Should leads of a subsystem (not only admins) lay out their own subsystem's components?
- Should someone's level on a machine be theirs to say, as in the tracker, or a trainer's (level 3)
  to sign off? Each says their own for now, and admins can change anyone's.
