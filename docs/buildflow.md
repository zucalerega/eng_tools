# Buildflow design

Buildflow is each program's bill of design: Hopper, Elytra, Felicette 2, HETS, each with its
components, by subsystem, drawn on its vehicle, and how far each has come through four phases,
design (DCR, CoDR, PDR, CDR), build (drawings, procurement, manufacturing, inspection), test (TRR,
testing, QRR), and launch (integration, FRR, flight), with the people on it, its due dates, and
links to its CAD and drawings in Vault, its requirements and design documents, its P&IDs in Piper,
and its test data in Yorg. Its program page puts the vehicle on a black stage, as a launch
company's progress page does, each component a dot in the color of where it is in the phase picked,
and under it, in big letters, how many are through it: "18 component-level CDRs across the
vehicle". It's one of the four apps on the team's site, beside Vault, Yorg, and Piper, and shares
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

## The web app

`web/src/buildflow`: the programs (`Programs.tsx`), a program's bill of design (`Program.tsx`, and
`Panel.tsx` for a component beside it), its layout (`Layout.tsx`, admins'), and the help
(`Help.tsx`, `/buildflow/help`: keep it in step with the features).

- **The programs** (`/buildflow`): a card each, its vehicle's outline on black, how many components
  it has and are through CDR, and a bar for each phase: done, in progress, and blocked, of those
  that need it.
- **The stage** (a program's page, `/buildflow/programs/{id}`): the phases across the top, the one
  picked in gold with a rule after it, each with how many are done in it; the vehicle, drawn from its
  sections (`vehicle.ts`, `drawVehicle`: pure SVG paths, white on black, its joints, tanks' domes,
  and a stand's frame fainter), its components dots in the colors of where each is in the phase
  (`Vehicle.tsx`: gold done, orange in progress, red blocked, gray not started, a small ring when
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
- **Links to the site's own apps** (`links.ts`): an address on the site (or the site's own origin,
  pasted) is kept as its path, marked with its app, and named by what it goes to, from that app's
  API as any client would ask it (Vault's file, `GET /api/files/{id}`, with its title when that
  says more than its name; Piper's diagram, `GET /api/piper/diagrams/{id}/lock`, without its
  drawing; Yorg's dataset, `GET /api/yorg/datasets/{id}`). Buildflow imports none of their code.
  Its kind is guessed from where it goes (a P&ID, test data, CAD) until it's picked. Anything else
  opens in a tab of its own (`noopener noreferrer`).
- **The layout** (`/buildflow/programs/{id}/layout`, admins'; members are told it's admins'):
  the program's name and description; its drawing's sections (an engine, with 1 to 9 nozzles side by
  side; body tubes; tanks; couplers; transitions to another diameter; the nose cone; each with its
  length and diameter in any one unit, fins at its aft end, landing legs from it), and whether it's
  on a test stand, changed together, previewed, and saved with *Save the drawing*; the vehicle with
  its components' dots, which drag to move them, and *Place* for one that isn't on it, then a click
  where it goes (`toDrawing`); subsystems and components, renamed where they are, moved, added,
  removed and brought back; and milestones, by phase. *Archive…* takes the program off the list.

## API

Buildflow's endpoints, all under `/api/buildflow`. Every one needs sign-in; how errors look, and the
site's own endpoints, are in [design.md](design.md#api). Admins' endpoints are 403 `admin_only` to
anyone else.

| Endpoint | Purpose |
|---|---|
| `GET /api/buildflow/programs?archived=` | the programs, in their order, each with its `profile`, `component_count`, how many are where in each phase (`phases`), how many are through each phase's last milestone (`through`, `last_milestone`), and whether you can lay it out (`can_edit`); `archived=true`: the archived ones |
| `POST /api/buildflow/programs` | a new program `{name, description, template}` (`rocket`, `hopper`, `stand`, `blank`) (admins): its whole bill of design |
| `GET /api/buildflow/programs/{id}` | a program's bill of design: its `milestones` and `subsystems` in order, and its `components`, each with its `progress`, `links`, and `people`; and, for admins, the components `removed` from it |
| `PATCH /api/buildflow/programs/{id}` | rename it, describe it, draw it again (`profile`: `{sections, stand}`), or move it in the list (`position`) (admins); 409 `archived`, `name_taken` |
| `POST /api/buildflow/programs/{id}/archive`, `/restore` | archive it, or bring it back (admins) |
| `GET /api/buildflow/programs/{id}/activity?limit=50` | what's been done to it, the latest first: each `what`, who, when, and its component's name as it is now |
| `POST /api/buildflow/programs/{id}/milestones` | a new milestone `{phase, name, title, review, position}` (admins) |
| `PATCH`/`DELETE /api/buildflow/milestones/{id}` | rename it, say what it stands for, make it a review, or move it in its phase or to another, its links with it; delete one nothing's kept on (409 `milestone_in_use`) (admins) |
| `POST /api/buildflow/programs/{id}/subsystems`, `PATCH`/`DELETE /api/buildflow/subsystems/{id}` | a new subsystem `{name, position}`; rename or move one; delete one with no components, removed ones included (409 `not_empty`) (admins) |
| `POST /api/buildflow/programs/{id}/components` | a new component `{subsystem_id, name, description, bought, x, y}`, at the end of its subsystem (admins) |
| `GET`/`PATCH /api/buildflow/components/{id}` | a component; change what's sent of it: its `name`, `subsystem_id`, `bought`, `x` and `y` (null: off the drawing), and `position` are admins'; its `description` and `lead_id` (null: no one; 400 `not_a_member`) anyone's |
| `DELETE /api/buildflow/components/{id}`, `POST .../restore` | remove a component, keeping everything said of it, or bring it back (admins) |
| `PUT /api/buildflow/components/{id}/progress/{milestone}` | change its progress at a milestone `{status, due, done_on, note}`: what's sent; 409 `removed`, `archived` |
| `POST /api/buildflow/components/{id}/links`, `DELETE /api/buildflow/links/{id}` | a link `{phase, kind, url, title, milestone_id}` (400 `bad_link`); remove one |
| `PUT /api/buildflow/components/{id}/people` | who's on it in a phase `{phase, user_ids}`, in order (400 `not_a_member`) |

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
   - **A timeline**: the due dates of a phase on a calendar, for the build schedule.

## Open questions

- What do DCR and QRR stand for on the team? They're left without a title for admins to give.
- Should leads of a subsystem (not only admins) lay out their own subsystem's components?
