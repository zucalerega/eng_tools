import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { Link } from "../router";

// What Piper does, and how: one page, from the top bar's Help. Its topics go down the page, and the contents beside
// them keep to the one you're reading.

interface Topic {
    title: string;
    body: ReactNode;
}

/** A topic's id, for its link in the contents (and in the address): "Test data from Yorg" is help-test-data-from-yorg. */
const idOf = (title: string) =>
    `help-${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`;

function Keys({ rows }: { rows: [ReactNode, string][] }) {
    return (
        <dl className="piper-help-keys">
            {rows.map(([key, what]) => (
                <div key={what}>
                    <dt>{key}</dt>
                    <dd>{what}</dd>
                </div>
            ))}
        </dl>
    );
}

const TOPICS: Topic[] = [
    {
        title: "Getting started",
        body: (
            <ul>
                <li>
                    <Link to="/piper">New diagram</Link> makes one, empty or from an example (a pressure-fed engine's
                    feed system) to change or learn from, in the folder you're in.
                </li>
                <li>
                    The diagrams are in folders, as Yorg&apos;s datasets are. <em>New folder</em> makes one where you
                    are; open a folder to see what&apos;s in it, and the way back up is above its name. Each folder says
                    how many diagrams it holds, and can be renamed, or deleted once it&apos;s empty.
                </li>
                <li>
                    Drag a diagram (or a folder) onto a folder, or onto a folder in the way back up, to move it there.
                    Or check diagrams, then <em>Move to…</em>; dragging one of those checked takes them all. Checked
                    ones of yours are deleted together with <em>Delete…</em>, to{" "}
                    <Link to="/piper/deleted">Deleted diagrams</Link>, where they can be checked and restored together.
                </li>
                <li>
                    <em>Find diagrams</em> looks in every folder, and says which folder each is in: names, folders,
                    descriptions, and parts&apos; tags (<code>PT-101</code> finds the diagrams it&apos;s on).
                </li>
                <li>
                    A diagram opens to be looked at: the drawing in the middle, and on the right whatever's selected, as
                    it is. <em>Edit</em>, at the top, makes it yours to change, with the library of parts on the left; a
                    diagram you've just made opens ready to edit. With nothing selected, the right side is the diagram's
                    fluids and colors.
                </li>
                <li>
                    Everyone can open and change every diagram. It saves itself a second after each change, and every
                    change is kept in its history.
                </li>
            </ul>
        ),
    },
    {
        title: "Parts",
        body: (
            <ul>
                <li>
                    Drag a part from the library onto the drawing, or click it and then click where it goes (Shift-click
                    to place several). Double-click it to put it in the middle of the view.
                </li>
                <li>
                    Find a part by any of its names: <em>MOV</em>, <em>PRV</em>, <em>COPV</em>, <em>cav</em>,{" "}
                    <em>3x2</em>, <em>thermocouple</em>. Valves (ball, solenoid, pneumatic, motorized, needle, check,
                    relief, regulators, burst discs, quick disconnects, and 3/2 and 5/2 solenoid valves), tanks, bottles
                    and COPVs, orifices and venturis, flow meters, filters, diffusers, instruments (PT, TC, RTD, load
                    cells...), engines, pumps, vents, tees, manifolds, a box for anything else (a DAQ, a test stand),
                    notes, regions, a legend, a title block, and pictures.
                </li>
                <li>
                    A <em>Picture</em> shows a PNG or a JPEG of your own (an injector, a TCA, a photo of the stand), up
                    to 5 MB: drop the file on the drawing, or place one from the library and choose it on the right (
                    <em>Replace…</em> changes it). Drag its square corner to size it: it keeps its shape. It's kept in
                    Piper with the diagram, and the exports (PDF, SVG, PNG) have it in them.
                </li>
                <li>
                    Each new part is tagged with the next number free (<code>PT-3</code> after <code>PT-2</code>),
                    beside it, where you drag it. Double-click a part to type its tag.
                </li>
                <li>
                    A part can link to pages about it: an FMV to its Notion page, a COTS valve to its spec sheet. While
                    you're editing, select it and click <em>+ Add a link</em> under its tag, on the right: a name (
                    <em>Notion</em>), and its address. Anyone looking at the diagram selects the part and clicks a link
                    to open it, in a tab of its own; a part with links has a small chain mark at its top right. Only web
                    pages (<code>https://</code>, <code>http://</code>) and email (<code>mailto:</code>) can be linked.
                    The <em>×</em> beside a link removes it.
                </li>
                <li>
                    An instrument is a bubble with the letter of what it measures in it, whatever its tag says (
                    <code>P</code> for pressure, <code>T</code> for temperature, <code>F</code> for flow, <code>W</code>{" "}
                    for a load cell), and its whole tag (<code>PT-101</code>) at its side. A duplicated or triplicated
                    transducer (two or three on one tap) is two or three bubbles side by side, A, B, and C: set{" "}
                    <em>Transducers</em>, or place one from the library. Each reads its own test channel: those its{" "}
                    <em>Test channel</em> names (separated by commas), or its tag's with A, B, and C after it (
                    <code>PT-101A</code>, <code>PT-101B</code>).
                </li>
                <li>
                    Valves are small on their lines, as P&IDs draw them: a bowtie body, with what works it on a short
                    stem: a handle, or a box with <code>S</code> for a solenoid, <code>P</code> for pneumatic, or{" "}
                    <code>M</code> for a motor. A regulator's line from its diaphragm goes to the pressure it holds; an
                    orifice plate sits in its pipe; a vent is the spray of what it lets go, in its line's color; a pump
                    stands on its base, its discharge leaving its top.
                </li>
                <li>
                    The <em>3/2</em> and <em>5/2 solenoid valves</em> are drawn as pneumatic schematics draw them (ISO
                    1219): a box for each of the valve's two positions, with its flow paths (arrows) and its shut ports
                    (a T), the solenoid at its left end and the spring that returns it at its right. Its ports are on
                    the box it rests in, numbered as ISO 5599 numbers them: a 3/2's supply (1) and exhaust (3) below,
                    what it feeds (2) above; a 5/2's supply (1) below its middle, what it feeds (4 and 2) above, and its
                    exhausts (5 and 3) below. The position its state puts it in is tinted in that state's color: at
                    rest, its normal state's (a 3/2 is normally closed, its supply shut, or normally open; a 5/2 has no
                    normal state); with a test, open or closed.
                </li>
                <li>
                    A <em>Manifold</em> takes its supply at one end and gives it out along its top to its{" "}
                    <em>Outlets</em> (2 to 8, on the right); its far end is a port too. Take an outlet away and a line
                    on it stays, ending where the outlet was. A <em>Diffuser</em> goes into a line, as a tank's
                    pressurant inlet has one, its arrows the way the flow leaves it.
                </li>
                <li>
                    Drag to move, <kbd>R</kbd> to turn a quarter, <kbd>F</kbd> to flip. Drag on an empty spot to select
                    everything in a box; Shift-click adds to what's selected. Select several to line them up or space
                    them evenly.
                </li>
                <li>
                    Drag the round handle at a selected part's corner to make it any size from a quarter of its own to
                    four times, in steps of 5% (hold Alt for 1%), or type its <em>Size</em> on the right, in percent;
                    its ports stay on the grid, so its lines stay straight (drawn very small, ports close together go
                    just off it rather than meet). <em>Label size</em>, in percent too, makes its tag and properties any
                    size of their own; left empty, they're the diagram's.
                </li>
                <li>
                    A <em>Text</em> note is sized to its words until you drag its square corner handle: then it's a
                    block of that width and height, its words wrapped to it. Its weight (bold), slant (italic), font
                    (sans serif, serif, or monospace, which print as Helvetica, Times, and Courier), alignment, and a
                    box around it are on the right.
                </li>
                <li>
                    Dragged together, parts take the lines between them along as they were, and a tee comes too when
                    everything on its lines moves; lines to parts left behind follow their ends.
                </li>
            </ul>
        ),
    },
    {
        title: "Finding a part",
        body: (
            <ul>
                <li>
                    <em>Find a tag</em>, in the toolbar (or <kbd>Ctrl</kbd>+<kbd>F</kbd>), finds a part or a line by its
                    tag (<code>PUREG</code>, <code>PT-101</code>), whatever its case and with or without its dashes, or
                    by what it is or holds (<em>regulator</em>, <em>LOX</em>). It looks through all the diagram's pages,
                    and says which page each is on. Pick one, or press <kbd>Enter</kbd> for the first: the drawing goes
                    to it, on its page, selected.
                </li>
                <li>
                    A search on the <Link to="/piper">diagrams</Link> finds the diagrams a tag is on, and each opens at
                    it.
                </li>
            </ul>
        ),
    },
    {
        title: "Pages and sheets",
        body: (
            <ul>
                <li>
                    A diagram can have pages, as a P&ID's sheets: the vehicle on one, the ground systems on another.
                    They're the tabs at the foot of the drawing. <em>+</em> adds one; a page's <em>⋯</em> menu (or a
                    double-click on its tab) renames it, moves it left or right, or deletes it. Undo brings a deleted
                    page back. The fluids, colors, and label size are the diagram's, the same on every page.
                </li>
                <li>
                    <em>Printed sheet</em>, in a page's panel (with nothing selected), picks the paper it prints on: its
                    outline shows on the drawing, with the sheet's border and the corner the title block takes, and the
                    page prints just there, at that scale, however the drawing changes. <em>Landscape</em> turns it, and{" "}
                    <em>Fit the sheet to the page</em> moves it to what's on the page now. A page without one is fitted
                    to the PDF's paper.
                </li>
                <li>
                    An <em>Off-page connector</em> says where a line goes on: pick the page in <em>To page</em>, and the
                    part it arrives at in <em>At</em> (its connector there, say). It's written <code>TO</code> and the
                    page's name until you write its words yourself. <em>Go to</em>, or a double-click on it, goes there;
                    the part it arrives at lists it under <em>Comes from</em>, to go back.
                </li>
                <li>
                    Once a diagram is saved with pages, a tab opened before Piper had them can't save it (it would keep
                    only one page): it says to reload, which gets the new Piper.
                </li>
            </ul>
        ),
    },
    {
        title: "Lines",
        body: (
            <ul>
                <li>
                    A part shows its ports (the dots) when the pointer's on it. Drag from one to another part's port to
                    draw a line, to a line to tee into it, or anywhere to end it there. Dropped on a part, it goes to
                    that part's nearest port.
                </li>
                <li>
                    The line tool (<kbd>L</kbd>) draws from anywhere, a line included.
                </li>
                <li>
                    A line routes itself: out of each port the way it faces, then the shortest way, with the fewest
                    bends, around parts. Moving a part routes its lines again.
                </li>
                <li>
                    Drag a line's segment to move it: the line keeps its bends from then on, and follows its ends when
                    they move. <em>Route automatically</em> (on the right) puts it back; on a line that routes itself,{" "}
                    <em>Route again</em> tidies one that's gone wrong. Drag a selected line's end to another port.
                </li>
                <li>Lines that cross without joining hop over each other. A tee shows its dot.</li>
                <li>
                    A line's type: pipe, tubing, flex hose, pneumatic, electrical, or data. Flow arrows show which way
                    it flows.
                </li>
            </ul>
        ),
    },
    {
        title: "Snapping",
        body: (
            <ul>
                <li>
                    Everything sits on a grid, and so does every part's ports: lines between parts lined up are
                    straight.
                </li>
                <li>
                    A part being dragged lines its ports up with the ports its lines go to, and its center with other
                    parts', and shows a gold guide where it did.
                </li>
                <li>
                    Hold <kbd>Alt</kbd> to drag freely, off the grid.
                </li>
            </ul>
        ),
    },
    {
        title: "Into a line",
        body: (
            <ul>
                <li>
                    Drop a valve (or an orifice, a filter, a flow meter: anything with two ports facing apart) on a
                    line, and it goes into it, turned the line's way. The line is highlighted gold before you let go.
                </li>
                <li>Delete it, and the line joins up again.</li>
                <li>
                    Delete a part with lines to other places, and the lines stay, ending where it was, to draw on to
                    something else.
                </li>
            </ul>
        ),
    },
    {
        title: "Properties and tags",
        body: (
            <ul>
                <li>
                    Select a part to say what it is: a valve's body, actuation, normal state, size, Cv, and MAWP; a
                    tank's fluid, volume, MEOP, and MAWP; an orifice's diameter and discharge coefficient; an
                    instrument's range and DAQ channel. Every part that holds pressure, and every line, has its MAWP.
                    Write values with their units (<code>0.062 in</code>).
                </li>
                <li>
                    The eye beside a property shows it under the part's tag on the drawing. <em>Add a field</em> gives a
                    part (or a line) anything else the team wants to keep: a part number, a torque.
                </li>
                <li>A tag two parts share is marked, in the drawing and on the right.</li>
            </ul>
        ),
    },
    {
        title: "Fluids and states",
        body: (
            <ul>
                <li>
                    Each line carries a fluid, drawn in its color: LOX in blue, RP-1 in red, nitrogen in green, helium
                    in purple, combustion gas (HOT GAS) in rose... A line drawn from a run takes its fluid.{" "}
                    <em>Carry it along its run</em> sets the fluid on every line it reaches through valves, fittings,
                    and instruments.
                </li>
                <li>
                    Lines don't write their fluid on themselves unless you say so: the eye beside a line's fluid shows
                    its label, and with nothing selected, <em>Show on every line</em> or <em>Hide on every line</em>{" "}
                    does it for all of them. A label that's the same along a run (its fluid, or a pipe's tag) is written
                    once, on the run's longest stretch, not on every piece its valves cut it into: moving a part along
                    it moves the label, rather than adding another.
                </li>
                <li>
                    A tank holds a fluid too: a liquid fills its lower part, a gas all of it, with the label inside.
                </li>
                <li>
                    Valves are drawn by their normal state: normally open (NO) green, normally closed (NC) red, and a
                    double-acting valve that fails in place (FIP) slate blue. The color says it, so it isn't written
                    beside them too; <em>Show on every valve</em> (with nothing selected) writes it, or the eye beside
                    one valve's state.
                </li>
                <li>
                    With nothing selected, the right side changes the diagram's fluids (their colors, labels, and names,
                    and whether each is a gas), adds its own, sets its valves' colors, and sets its <em>Label size</em>,
                    in percent of the standard (100), from half to three times. The legend (in the library's Notes)
                    lists what its lines carry and its valves' states.
                </li>
                <li>
                    The team's color schemes are on <Link to="/piper/schemes">Schemes</Link>: each one's fluids and
                    valve state colors, defined by the team. Anyone can make one; only whoever made it, or an admin, can
                    change or delete it. New diagrams start in the team's default (YJSP standard, an admin's to pick and
                    change); <em>Colors from</em>, with nothing selected, gives a diagram another's. When the scheme
                    changes, the diagram says so: <em>Take its colors again</em>.
                </li>
            </ul>
        ),
    },
    {
        title: "Test data from Yorg",
        body: (
            <ul>
                <li>
                    <em>Test data</em> reads the diagram against a test in <Link to="/yorg">Yorg</Link>: each instrument
                    shows its channel's value, and each valve its state (open green, closed red, anything else amber),
                    in a badge on a line to it.
                </li>
                <li>
                    A part reads the channel named as its tag (<code>PT-101</code> reads PT-101), or the one in its{" "}
                    <em>Test channel</em>: type it, or pick it from the test's channels, which narrow to what you type.
                    Names match whatever their case, then ignoring spaces, dashes, and underscores. Parts with no
                    channel in the test are listed.
                </li>
                <li>
                    Drag the timeline, or play the test (at a tenth of its speed up to ten times it). The ticks on it
                    are the test's events: click one to go there.
                </li>
                <li>
                    Select an instrument to see its channel over the whole test. <em>Plot in Yorg</em> opens the test in
                    Yorg with those channels plotted.
                </li>
                <li>
                    The page's address has the test and the time: copy it to send someone that moment. The diagram opens
                    to them again in this browser, until you close <em>Test data</em>.
                </li>
            </ul>
        ),
    },
    {
        title: "Editing, one at a time",
        body: (
            <ul>
                <li>
                    One person edits a diagram at a time, so no one's changes go over anyone else's. <em>Edit</em> makes
                    it yours: until you're done, no one else can change it, and the diagrams list and everyone who has
                    it open see that you're editing it. <em>Done editing</em> saves what&apos;s left and lets anyone
                    edit it.
                </li>
                <li>
                    While someone else is editing it, it says who, and <em>Edit</em> waits until they're done. You can
                    still look at it, move around it, select parts to read them, see a test on it, and export it; what
                    they save shows within half a minute, and as soon as you come back to the tab.
                </li>
                <li>
                    Closing the tab, or going to another page, lets it go at once. Left open with nothing done in it,
                    it's let go about 25 minutes after the last click or key (back at it, you go on editing, if no one
                    else has started); a laptop shut or a browser that crashed lets it go ten minutes later.
                </li>
                <li>
                    An admin can <em>Take over</em> from whoever's editing it. Their changes are saved as they make
                    them; a change of theirs after that isn't saved over yours. They're told, and can save theirs as a
                    new diagram, or load yours.
                </li>
            </ul>
        ),
    },
    {
        title: "Simulation",
        body: (
            <ul>
                <li>
                    <em>Simulation</em>, in the editor's bar (for admins, while it's tried out), makes the P&amp;ID a
                    model of the system, simulated with <a href="https://github.com/saakethramoju/FullFlow">FullFlow</a>{" "}
                    against a test from Yorg, to tune it until it matches what was measured. What it adds shows only
                    while it's on: turn it off, and the editor is as it was.
                </li>
                <li>
                    The P&amp;ID is the model, drawn as any diagram is. Tanks, bottles, the engine, and vents hold the
                    pressures; valves, regulators, orifices, and venturis carry the flow between them; lines and tees
                    join into one point. Whether a part carries liquid or gas comes from its lines' fluids, so give each
                    run of lines its fluid (<em>Carry along its run</em> does the rest).
                </li>
                <li>
                    Select a part to set it up in the model, in the inspector's <em>Simulation</em> box, while you're
                    editing the diagram: what it is (a bottle as a supply, or a vessel that blows down), its CdA,
                    opening time, a tank's volume and fill. Settings marked <em>tune</em> are knobs. A liquid line can
                    be modeled as a line, with its friction and its liquid's inertia; a gas line's box sets the tubing
                    it's part of.
                </li>
                <li>
                    Its channels come from the P&amp;ID: a valve's command is its Test channel (or its tag); a pressure
                    transducer reads the pressure where it taps (a tank's, the point between two valves); a thermocouple
                    tapping a tank above its liquid reads its ullage; and a flow meter, the flow through what it's in
                    line with. A tank's, a supply's, or the engine's transducer drives it; the others are compared.
                    Uncheck a channel in its part's <em>Simulation</em> box to leave it out and set the conditions
                    yourself: the part then does what its settings say (a valve stays where they have it, a tank holds
                    the pressure set on it).
                </li>
                <li>
                    In its panel, pick the test, the run's window (<em>◷</em> takes the time on the timeline), the time
                    step, and the solver, then <em>Run</em>. Each compared channel is plotted with the model, with how
                    far apart they are. At the time on the timeline, each instrument's badge on the drawing shows what
                    the test measured, then the model's value in gold, in the diagram's units; a tank shows its
                    pressure, and a valve or an orifice what flows through it, while anything does, in gold alone. The
                    panel lists what keeps the model from running, each with <em>Go to</em>.
                </li>
                <li>
                    <em>Tune…</em> fits the knobs you pick (running the model again and again), or anchors each to a
                    sensor (one run, the knob moved at every time step to match it); <em>Apply to the P&amp;ID</em> puts
                    what it found on the parts, once you're editing it. Runs, fits, and anchoring don't change the
                    drawing, so you can run them while it's only looked at. <em>Script</em> shows the FullFlow code that
                    runs, and <em>How it's modeled</em> how each part is built of FullFlow's components.
                </li>
                <li>
                    <em>New diagram</em> has three P&amp;IDs to simulate: a cold flow, a pressurized flow, and Vespula's
                    prop system, with its run's data as a test in Yorg.
                </li>
            </ul>
        ),
    },
    {
        title: "Saving and history",
        body: (
            <ul>
                <li>
                    A diagram saves itself a second after each change while you're editing it. If it was saved from
                    another window of yours after you opened it here, it stops and asks: keep yours (saved over the
                    other, which stays in the history), save yours as a new diagram, or load the other.
                </li>
                <li>
                    Beside its name, <em>Not saved</em> says why: out of reach or signed out, it tries again on its own
                    (sign in again in another tab); too big, and your next change (deleting something) is saved. Keep
                    the page open until it says <em>Saved</em>.
                </li>
                <li>
                    <em>History</em> lists its revisions, each one person's changes (up to half an hour of them).
                    <em> Look</em> shows one; <em>Restore</em> makes it the drawing again, as a new revision.{" "}
                    <em>Name</em> one (<code>Rev B, for HF-3</code>) to keep it as it is.
                </li>
                <li>
                    Release one for a design review or before a test: <em>Release…</em> on a revision, say what it's
                    for, and pick its approvers (at least one besides you). Each approves it or rejects it, saying why;
                    once they all approve, it's the diagram's next release, Rev A, then B..., and it never changes.
                    Editing goes on in the revisions after it, and the diagram's name says <em>Draft after Rev A</em>.
                </li>
                <li>
                    One release waits at a time, each of a revision after the last released, and whoever asked can
                    withdraw it. A PDF on a drawing sheet lists the releases, with who approved each, and its title
                    block says which revision it is (<code>A</code>, or <code>7 (after A)</code>).
                </li>
                <li>
                    Whoever made a diagram, or an admin, can delete it: it waits in{" "}
                    <Link to="/piper/deleted">Deleted diagrams</Link>, with its history, to be restored. Deleted while
                    you have it open, it says so; restore it there, and what you changed is saved.
                </li>
            </ul>
        ),
    },
    {
        title: "Importing from Visio",
        body: (
            <ul>
                <li>
                    <em>Import Visio…</em> on the <Link to="/piper">diagrams</Link> asks for the drawing (or drop a
                    .vsdx on them), then shows it, with <em>Choose another…</em> if it's the wrong one. <em>Import</em>{" "}
                    makes a diagram of it, in the folder you're in, its pages as Visio has them.
                </li>
                <li>
                    Its valves, regulators, relief valves, orifices, quick disconnects, and sensors become Piper's
                    parts: by the stencil they're from (a <em>Powered valve</em>, a <em>3/2 valve</em>), or, drawn by
                    hand, by what their tags say (<code>PRV</code> a relief valve, <code>FTPT</code> a pressure
                    transducer, <code>FO-1</code> an orifice). Each is tagged with its label, beside it or grouped with
                    it, given its set pressure (<code>S.P. 145 PSI</code>), and worked as its actuator's letter says (S
                    a solenoid, P air).
                </li>
                <li>
                    Everything else is drawn as Visio drew it, as a <em>figure</em>: the vehicle and its tanks, a
                    manifold's box, the drawing's key and title block, its words in their colors and sizes. A figure is
                    drawn under the lines; click its edge to select it. The import lists the symbols Piper has no part
                    for, to replace with parts from the library or keep. A figure isn't simulated: put Piper's tanks in
                    place of drawn ones to simulate them.
                </li>
                <li>
                    Connectors become lines along the routes they had, on the parts' ports where they were glued, and
                    they follow the parts when you move them. A line carries the fluid its words name, else what a tank
                    it's drawn from holds, else what the drawing's key says lines in its color carry (
                    <code>Kerosene (Jet-A)</code>), else its color becomes a fluid of the diagram's own, to rename. The
                    key's line sizes (<code>3/8" Line</code>) size the lines dashed like them, and its{" "}
                    <em>Normally open</em> and <em>Normally closed</em> valves color the valves filled like them.
                </li>
                <li>
                    Words stay as notes, in their sizes. A slanted line that joins nothing (a vehicle's outline) is
                    drawn, not a pipe: Piper's lines go level and upright.
                </li>
                <li>
                    Piper reads Visio 2013 and later's .vsdx files. Save an older .vsd (or a .vdx) as a .vsdx in Visio
                    first.
                </li>
            </ul>
        ),
    },
    {
        title: "Exports",
        body: (
            <ul>
                <li>
                    <em>Export, PDF</em> saves the drawing as a PDF, a page for each of its pages: on its printed sheet,
                    if it has one, else on the paper you choose (Tabloid, Letter, ANSI D, A3, A4, or its own size),
                    turned its way. On a drawing sheet, as a Visio P&ID is: a border with its zones (numbered across,
                    lettered up), the diagram's named revisions, and a title block (its name, folder, revision, who drew
                    it, when, and which sheet of how many it is), unless the page has a title block of its own. It's
                    vector: sharp at any size, its tags text you can search.
                </li>
                <li>
                    <em>SVG</em> and <em>PNG</em> save the page shown as an image; <em>Print</em> prints it. Exports are
                    drawn in the light colors, as on paper. A PDF can be in black and white, for a printer without
                    color: lines in ink, normally closed valves filled, normally open ones white.
                </li>
                <li>
                    Any of them can have a legend (<em>With a legend</em>, in its dialog; it's asked the next time as
                    you left it): every kind of part on the page, with its symbol and its name, under its category
                    (valves, tanks and vessels, instruments...), then each type of line in its weight and dashes, each
                    fluid in its color, and the colors of its valves' normal states. It's beside the drawing, to its
                    right, in columns as tall as the drawing; in a PDF, beside each page, fitted on the paper with it. A
                    page whose printed sheet is set keeps its layout: its legend is on a sheet of its own after it, at
                    its scale. In black and white, it leaves out the fluids, whose lines are all ink.
                </li>
                <li>
                    <em>Parts list (CSV)</em>: every part's tag, what it is, its normal state, fluid, test channel, and
                    properties, and every line's tag, fluid, and ends, on all its pages (with each one's page, if
                    there's more than one). Filter it in a spreadsheet for a valve list or an instrument list.
                </li>
                <li>
                    <em>Parts</em>, in the toolbar, shows the same list under the drawing: a table for each kind of part
                    (ball valves, pressure transducers, tanks...), with how many there are and the specs any of them has
                    (MAWP, size, Cv, range, channel), then the lines, from all its pages. Click a tag to go to its part,
                    on its page.
                </li>
            </ul>
        ),
    },
    {
        title: "Keys",
        body: (
            <Keys
                rows={[
                    [<kbd key="v">V</kbd>, "Select and move"],
                    [<kbd key="l">L</kbd>, "Draw lines"],
                    [
                        <>
                            <kbd>Delete</kbd> or <kbd>Backspace</kbd>
                        </>,
                        "Delete what's selected",
                    ],
                    [
                        <>
                            <kbd>R</kbd>, <kbd>Shift</kbd>+<kbd>R</kbd>
                        </>,
                        "Turn a quarter, clockwise or back",
                    ],
                    [<kbd key="f">F</kbd>, "Flip"],
                    [
                        <>
                            <kbd>Ctrl</kbd>+<kbd>Z</kbd>, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>
                        </>,
                        "Undo, redo",
                    ],
                    [
                        <>
                            <kbd>Ctrl</kbd>+<kbd>C</kbd>, <kbd>X</kbd>, <kbd>V</kbd>, <kbd>D</kbd>
                        </>,
                        "Copy, cut, paste (between diagrams too), duplicate",
                    ],
                    [
                        <>
                            <kbd>Ctrl</kbd>+<kbd>A</kbd>
                        </>,
                        "Select everything",
                    ],
                    [
                        <>
                            <kbd>Ctrl</kbd>+<kbd>F</kbd>
                        </>,
                        "Find a part on the drawing by its tag",
                    ],
                    ["Arrows (Shift: five steps)", "Nudge what's selected"],
                    ["Wheel; Ctrl or ⌘ + wheel", "Scroll; zoom"],
                    [
                        <>
                            <kbd>Space</kbd>+drag, or the middle button
                        </>,
                        "Move the view",
                    ],
                    [
                        <>
                            <kbd>+</kbd>, <kbd>−</kbd>, <kbd>0</kbd>
                        </>,
                        "Zoom in, out, to the whole drawing",
                    ],
                    [<kbd key="alt">Alt</kbd>, "While dragging: no snapping"],
                    [<kbd key="esc">Esc</kbd>, "Stop placing or drawing; select nothing"],
                ]}
            />
        ),
    },
];

export function HelpPage() {
    const ids = TOPICS.map((topic) => idOf(topic.title));
    const [current, setCurrent] = useState(ids[0]);
    const key = ids.join(" ");

    useEffect(() => {
        // Come with a topic in the address (/piper/help#help-lines): to it.
        const asked = window.location.hash.slice(1);
        if (asked && key.split(" ").includes(asked)) {
            document.getElementById(asked)?.scrollIntoView?.({ block: "start" });
            setCurrent(asked);
        }
        // The contents keep to the topic being read: the first one in the top part of the window.
        if (typeof IntersectionObserver === "undefined") {
            return;
        }
        const showing = new Map<string, boolean>();
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    showing.set(entry.target.id, entry.isIntersecting);
                }
                const first = key.split(" ").find((id) => showing.get(id));
                if (first) {
                    setCurrent(first);
                }
            },
            { rootMargin: "-80px 0px -55% 0px" },
        );
        for (const id of key.split(" ")) {
            const section = document.getElementById(id);
            if (section) {
                observer.observe(section);
            }
        }
        return () => observer.disconnect();
    }, [key]);

    /** To a topic, smoothly, and into the address so the link can be shared. */
    function goTo(event: MouseEvent, id: string) {
        event.preventDefault();
        document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        window.history.replaceState(window.history.state, "", `#${id}`);
        setCurrent(id);
    }

    return (
        <section className="piper-help">
            <div className="page-head">
                <h1>Help</h1>
            </div>
            <p className="lead muted">
                Draw the team's fluid systems as P&IDs, with the parts it uses, lines in their fluids' colors, valves in
                their states' colors, and every part's tag and properties; then read a test from Yorg on them.
            </p>
            <div className="piper-help-layout">
                <nav className="piper-help-contents" aria-label="Contents">
                    <ul>
                        {TOPICS.map((topic, index) => (
                            <li key={ids[index]}>
                                <a
                                    href={`#${ids[index]}`}
                                    aria-current={current === ids[index] ? "true" : undefined}
                                    onClick={(event) => goTo(event, ids[index]!)}
                                >
                                    {topic.title}
                                </a>
                            </li>
                        ))}
                    </ul>
                </nav>
                <div className="piper-help-topics">
                    {TOPICS.map((topic, index) => (
                        <section key={ids[index]} id={ids[index]} aria-labelledby={`${ids[index]}-title`}>
                            <h2 id={`${ids[index]}-title`}>{topic.title}</h2>
                            {topic.body}
                        </section>
                    ))}
                </div>
            </div>
        </section>
    );
}
