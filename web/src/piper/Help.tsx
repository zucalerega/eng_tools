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
                    feed system) to change or learn from. Give it a folder to keep it with others: pick one there is
                    from the list, or type a new one (<code>Vespula/GSE</code>).
                </li>
                <li>
                    The diagrams are in their folders, as Yorg&apos;s saved views are: each folder says how many it has,
                    and a click shuts it or opens it. Drag a diagram onto a folder to move it there, or onto{" "}
                    <em>Drop here to take it out of its folder</em>, above the list, to put it at the top. Rename,
                    move, or describe, in the editor, moves it too.
                </li>
                <li>
                    A diagram opens to the editor: the library of parts on the left, the drawing in the middle, and on
                    the right whatever's selected, to name and describe. With nothing selected, it's the diagram's
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
                    <em>thermocouple</em>. Valves (ball, solenoid, pneumatic, motorized, needle, check, relief,
                    regulators, burst discs, quick disconnects), tanks, bottles and COPVs, orifices and venturis, flow
                    meters, filters, instruments (PT, TC, RTD, load cells...), engines, pumps, vents, tees, a box for
                    anything else (a DAQ, a test stand), notes, regions, a legend, and a title block.
                </li>
                <li>
                    Each new part is tagged with the next number free (<code>PT-3</code> after <code>PT-2</code>). An
                    instrument's tag is in its bubble; others' are beside them, where you drag them. Double-click a part
                    to type its tag.
                </li>
                <li>
                    Drag to move, <kbd>R</kbd> to turn a quarter, <kbd>F</kbd> to flip. Drag on an empty spot to select
                    everything in a box; Shift-click adds to what's selected. Select several to line them up or space
                    them evenly.
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
                    they move. <em>Route automatically</em> (on the right) puts it back. Drag a selected line's end to
                    another port.
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
                    Select a part to say what it is: a valve's body, actuation, normal state, size, Cv, and rating; a
                    tank's fluid, volume, and MEOP; an orifice's diameter and discharge coefficient; an instrument's
                    range and DAQ channel. Write values with their units (<code>0.062 in</code>).
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
                    Each line carries a fluid, drawn in its color with its label: LOX in blue, RP-1 in red, nitrogen in
                    green, helium in purple... A line drawn from a run takes its fluid. <em>Carry it along its run</em>{" "}
                    sets the fluid on every line it reaches through valves, fittings, and instruments.
                </li>
                <li>
                    A tank holds a fluid too: a liquid fills its lower part, a gas all of it, with the label inside.
                </li>
                <li>Valves are drawn by their normal state: normally open (NO) green, normally closed (NC) red.</li>
                <li>
                    With nothing selected, the right side changes the diagram's fluids (their colors, labels, and
                    names), adds its own, and sets its valves' colors. The legend (in the library's Notes) lists what
                    its lines carry and its valves' states.
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
                    shows its channel's value beside it, and each valve its state: open green, closed red, anything else
                    amber.
                </li>
                <li>
                    A part reads the channel named as its tag (<code>PT-101</code> reads PT-101), or the one in its{" "}
                    <em>Test channel</em>. Names match whatever their case, then ignoring spaces, dashes, and
                    underscores. Parts with no channel in the test are listed.
                </li>
                <li>
                    Drag the timeline, or play the test (at a tenth of its speed up to ten times it). The ticks on it
                    are the test's events: click one to go there.
                </li>
                <li>
                    Select an instrument to see its channel over the whole test. <em>Plot in Yorg</em> opens the test in
                    Yorg with those channels plotted.
                </li>
                <li>The page's address has the test and the time: copy it to send someone that moment.</li>
            </ul>
        ),
    },
    {
        title: "Saving and history",
        body: (
            <ul>
                <li>
                    A diagram saves itself a second after each change. If someone else saved it while you had it open,
                    it stops and asks: keep yours (saved over theirs, which stays in the history), save yours as a new
                    diagram, or load theirs.
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
                    .vsdx on them), then shows it, with <em>Choose another…</em> if it's the wrong one, and the folder
                    to put it in. <em>Import</em> makes a diagram of each of its pages.
                </li>
                <li>
                    Visio's P&ID shapes (its valves, vessels, pumps, instruments...) become Piper's parts, tagged with
                    their text when it's a tag (<code>PT 101</code> is PT-101). Connectors become lines between the
                    ports nearest where they were glued, routed Piper's way. A line's text says its fluid (
                    <code>LOX</code>), else what it's drawn from does, else its color becomes a fluid of the diagram's
                    own, to rename.
                </li>
                <li>
                    Text stays as notes; a shape Piper has no part for becomes a box with its text, and the import says
                    which, to replace with parts or keep.
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
                    <em>Export, PDF</em> saves the drawing as a PDF on the paper you choose (Tabloid, Letter, ANSI D,
                    A3, A4, or its own size), turned its way. On a drawing sheet, as a Visio P&ID is: a border with its
                    zones (numbered across, lettered up), the diagram's named revisions, and a title block (its name,
                    folder, revision, who drew it, and when), unless the drawing has a title block of its own. It's
                    vector: sharp at any size, its tags text you can search.
                </li>
                <li>
                    <em>SVG</em> and <em>PNG</em> save it as an image; <em>Print</em> prints it. Exports are drawn in
                    the light colors, as on paper.
                </li>
                <li>
                    <em>Parts list (CSV)</em>: every part's tag, what it is, its normal state, fluid, test channel, and
                    properties, and every line's tag, fluid, and ends. Filter it in a spreadsheet for a valve list or an
                    instrument list.
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
