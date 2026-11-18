import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { Link } from "../router";

// What Buildflow does, and how: one page, from the top bar's Help. Its topics go down the page, and the contents beside
// them keep to the one you're reading.

interface Topic {
    title: string;
    body: ReactNode;
}

/** A topic's id, for its link in the contents (and in the address): "The vehicle" is help-the-vehicle. */
const idOf = (title: string) =>
    `help-${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`;

const TOPICS: Topic[] = [
    {
        title: "Getting started",
        body: (
            <ul>
                <li>
                    Buildflow is each program&apos;s <em>bill of design</em>: Hopper, Elytra, Felicette 2, HETS, each
                    with its components, on its vehicle, and how far each has come through design, build, test, and
                    launch.
                </li>
                <li>
                    <Link to="/buildflow">Programs</Link> lists them, each with its vehicle and a bar for each phase:
                    how many of its components are done in it, under way, and held up. Open one to see its bill of
                    design.
                </li>
                <li>
                    Admins lay each program out once, as the team plans the vehicle: its drawing, its subsystems and
                    components, and the milestones each goes through. Everyone keeps its progress up as the work goes
                    on.
                </li>
            </ul>
        ),
    },
    {
        title: "The vehicle",
        body: (
            <ul>
                <li>
                    A program&apos;s page starts with its vehicle, in white on black, and its components on it as dots.
                    Across the top are the phases: <em>Design</em>, <em>Build</em>, <em>Test</em>, and <em>Launch</em>.
                    The dots take the colors of where each component is in the phase picked: gold when it&apos;s done
                    (through every milestone it needs in that phase), orange when it&apos;s under way, red when
                    it&apos;s blocked, gray when it hasn&apos;t started, and a small ring when it needs nothing in that
                    phase.
                </li>
                <li>
                    Under the vehicle, in big letters, is how many components are through the phase: in design, how many
                    have passed their CDR (&quot;18 component-level CDRs across the vehicle&quot;); then how many are
                    built, through their QRR, and flown. Under that, how many are in each color.
                </li>
                <li>
                    Click a dot (or Tab to it and press Enter) to open its component beside the page. The phase and the
                    component you&apos;ve picked are in the page&apos;s address, so a link to it opens it the same way.
                </li>
            </ul>
        ),
    },
    {
        title: "The bill of design",
        body: (
            <ul>
                <li>
                    Under the vehicle is the bill: every component, by subsystem, with its lead, a chip for each
                    milestone (DCR, CoDR, PDR, CDR in design, and so on), and what&apos;s due next. Hover over a chip
                    for its status and dates.
                </li>
                <li>
                    Click a chip to set the component&apos;s status at that milestone: <em>Not started</em>,{" "}
                    <em>In progress</em>, <em>Done</em> (<em>Passed</em>, for a review), <em>Blocked</em>, or{" "}
                    <em>Not needed</em> (a bought part&apos;s design reviews, say). <em>Dates, notes, links…</em> opens
                    the component at that milestone. A chip with a red edge is late: due before today, and not done.
                </li>
                <li>
                    A component bought rather than made is marked <em>COTS</em> (off the shelf).
                </li>
                <li>
                    A small tag with a number beside a component&apos;s name says the site found deals on eBay for it
                    (its dot on the vehicle has a speck of gold too). Click it to open the component, whose panel lists
                    them under <em>On eBay</em>: each listing&apos;s price, why it would do, and a link to it. ✕ hides
                    one that won&apos;t do, for everyone. Deals are searched for a component until it&apos;s procured,
                    by the part numbers in what it is (<code>Swagelok SS-43GS4</code>) or, for a part the team makes, by
                    the stock it names (&quot;6061-T6 aluminum, 8 in OD, 0.125 in wall&quot;).
                </li>
            </ul>
        ),
    },
    {
        title: "A component",
        body: (
            <ul>
                <li>
                    A component opens beside the page, from its dot or its name in the bill: what it is, its lead
                    (who&apos;s responsible for it), and a section for each phase. Anyone signed in keeps these up;
                    every change is in the program&apos;s <em>Recent activity</em>, with who made it.
                </li>
                <li>
                    Each milestone has its status; when it&apos;s due (for a review, the day it&apos;s held); the day it
                    was done, once it is (today, unless you change it); and a note: a review&apos;s actions, or
                    what&apos;s holding it up.
                </li>
                <li>
                    <em>Not needed: skip what&apos;s not started</em> marks every milestone in the phase that
                    hasn&apos;t started as not needed, as for a part that&apos;s bought, not designed.
                </li>
                <li>
                    Each phase says who&apos;s on it: designing it, making it (who&apos;s manufacturing it), testing it,
                    flying it. Add someone from the list, or take them off with ✕. Only people who&apos;ve joined the
                    site are on the list.
                </li>
            </ul>
        ),
    },
    {
        title: "Links",
        body: (
            <ul>
                <li>
                    Each phase has its links: the component&apos;s CAD and drawings in Vault, its requirements, design
                    documents, reviews&apos; slides, P&IDs in Piper, test data in Yorg, procedures.{" "}
                    <em>+ Add a link</em> takes an address, what kind of link it is, and a name if you like. A link{" "}
                    <em>On</em> a milestone (a CDR&apos;s slides, a TRR&apos;s procedure) is shown with it.
                </li>
                <li>
                    For a page of the site, copy its address: a file in Vault (<code>/vault/file/12</code>), a diagram
                    in Piper (<code>/piper/diagrams/3</code>), a test in Yorg (<code>/yorg/datasets/7</code>). It&apos;s
                    kept as its path, marked with its app, and named by what it goes to: the file&apos;s name, the
                    diagram&apos;s, the test&apos;s. Its kind is guessed from where it goes. Anything else is an{" "}
                    <code>http</code> or <code>https</code> address (Notion, Google Drive), which opens in a tab of its
                    own.
                </li>
                <li>✕ beside a link removes it.</li>
            </ul>
        ),
    },
    {
        title: "The build plan",
        body: (
            <ul>
                <li>
                    <em>Build plan</em>, on a program&apos;s page, plans its build: each component&apos;s lead time (how
                    long it takes to get once it&apos;s ordered, or to make once it&apos;s started), the day it has to
                    be ready by, and what it needs first (what has to be ready before it can start).
                </li>
                <li>
                    From those it works out the day to order or start each one by, and draws it on a calendar, the
                    soonest first, so the long leads (six weeks or more) come to the top. A bar runs from the day to
                    order or start it by to the day it has to be ready, in the color of where it is in the build phase;
                    one at risk is ringed in red, with a red line where it&apos;d be ready as things stand.
                </li>
                <li>
                    Across the top: what to order or start now (its day&apos;s passed), what&apos;s late, what&apos;s at
                    risk (it won&apos;t be ready in time: waiting on what it needs, or started too late), the long
                    leads, what&apos;s waiting on others, and what isn&apos;t planned yet.
                </li>
                <li>
                    Type a component&apos;s lead time in weeks and its ready-by day in the plan&apos;s table, or on its
                    panel in the build phase. <em>What ... needs first</em> picks the components it needs; one that
                    needs it, however far along, can&apos;t be picked, as neither could ever start.
                </li>
                <li>
                    A component is ready once it&apos;s through the build phase. The bill marks a long lead not ready
                    yet with <em>Long lead</em>.
                </li>
            </ul>
        ),
    },
    {
        title: "The BOM",
        body: (
            <ul>
                <li>
                    <em>BOM</em>, on a program&apos;s page, is its bill of materials: the parts to buy, read in from the
                    team&apos;s own BOM spreadsheet. <em>Read in a spreadsheet…</em> takes an Excel workbook (.xlsx) or
                    a CSV file (an older .xls: save it as .xlsx first; from Google Sheets: download it as .xlsx or CSV).
                </li>
                <li>
                    It guesses which column says what from its headers: the part number, the description, the component
                    it&apos;s for, how many, the vendor, the cost each, the lead time (in weeks or days), a link, and
                    where it is. Fix any it got wrong, and the row the headers are in, and check the lines as
                    they&apos;ll come in.
                </li>
                <li>
                    <em>Lines are for</em>: the component each one&apos;s <em>Component</em> column names (by its name
                    here), none yet, or one component (its BOM alone, the rest staying as they are). A name no component
                    has comes in for none, and the dialog says which.
                </li>
                <li>
                    Read it in again whenever the spreadsheet changes: the BOM becomes what it says, and a part already
                    on it keeps where it is (to order, ordered, received) and its note, unless the spreadsheet says.
                </li>
                <li>
                    Each part&apos;s day to order it by is the day its component&apos;s build has to start (from its
                    lead time and ready-by day, on the build plan), less the part&apos;s own lead time. The page counts
                    what to order now and the long leads (six weeks or more), and the cost in all. Set where each part
                    is, and a note (a PO, a tracking number), right there. A component&apos;s panel lists its parts, in
                    its build phase.
                </li>
            </ul>
        ),
    },
    {
        title: "Reviews",
        body: (
            <ul>
                <li>
                    A review can cover several components at once: a subsystem&apos;s PDR, say, for its eight
                    components. <em>New review</em>, under the bill, takes the milestone it&apos;s held at (one
                    that&apos;s a review: DCR, CoDR, PDR, CDR, TRR, QRR, FRR), a name, its day, and the components it
                    covers; <em>All of</em> a subsystem picks every one in it.
                </li>
                <li>
                    Its day is each component&apos;s date at that milestone, and moving it moves them all. Those through
                    it already (passed, or not needed) keep theirs. <em>Pass…</em>, on its page, passes each of its
                    components there, on its day.
                </li>
                <li>
                    Each component&apos;s progress is still its own. On the review&apos;s page, set one apart (back{" "}
                    <em>In progress</em>, say) and write its actions beside it, under <em>Actions, outcome</em>: the
                    same note its panel shows at the milestone.
                </li>
                <li>
                    Its files are links: paste the address of its slides, its package, or its minutes (from SharePoint,
                    its <em>Copy link</em>), with a name. Take its notes on its page, as it goes: <em>Edit notes</em>,
                    in Markdown (<code>-</code> for a list), then <em>Save notes</em>.
                </li>
                <li>
                    A component&apos;s chip on the bill says which review it&apos;s in there, and its menu goes to it,
                    as its panel does. <em>Remove…</em> keeps a review, to bring back from <em>Removed reviews</em>.
                </li>
            </ul>
        ),
    },
    {
        title: "What's coming up",
        body: (
            <ul>
                <li>
                    <em>Coming up</em>, under the bill, lists the milestones with due dates that aren&apos;t done yet:
                    what&apos;s late first, in red, then the next ones. Click one to open its component there.
                </li>
                <li>
                    <em>Recent activity</em> is what&apos;s been done to the program lately, and by whom.
                </li>
            </ul>
        ),
    },
    {
        title: "The shop",
        body: (
            <ul>
                <li>
                    <Link to="/buildflow/shop">Shop</Link>, in the top bar, is the queue of parts the team needs
                    machined, as the machining tracker was. The cards across the top say how many hours of work each
                    machine has waiting, and how many people can run it.
                </li>
                <li>
                    <em>Add part</em> queues one: what it is, what it&apos;s for (a program, and one of its components,
                    or neither), the machine, the material, how many, about how many hours they&apos;ll all take, links
                    to its drawing and CAD (a web address, or a page here like <code>/vault/file/12</code>), who asked
                    for it (you, unless you say), who&apos;s making it, and when it&apos;s needed by. Anyone can change
                    a part, or move it along: queued, in progress, blocked (say why in its note), done.
                </li>
                <li>
                    A part for a component shows on the component&apos;s panel, in its build phase, under{" "}
                    <em>In the shop</em>, and what becomes of it shows in the program&apos;s recent activity.{" "}
                    <em>Queue a part for it</em>, there, starts one already for that component, with its drawing and CAD
                    links.
                </li>
                <li>
                    <em>Remove</em> takes a part off the queue, and keeps it: <em>Show parts taken off the queue</em>,
                    at the bottom, puts it back.
                </li>
                <li>
                    <em>Who&apos;s trained</em> is how far each person is trained on each machine: 0 not trained, 1
                    supervised only, 2 runs it on their own, 3 trains others. Set your own there; admins can set
                    anyone&apos;s. Those at 2 or 3 are who <em>can make</em> a part on that machine, in the queue, and
                    are offered first as its machinist.
                </li>
                <li>
                    Admins keep the list of machines, under <em>Machines</em>: add one, rename it, or retire it, which
                    stops new parts going on it and keeps those made on it. <em>Export CSV</em> saves the queue and
                    who&apos;s trained as a spreadsheet.
                </li>
            </ul>
        ),
    },
    {
        title: "Laying out a program",
        body: (
            <ul>
                <li>
                    Admins make programs: <em>New program</em> on <Link to="/buildflow">Programs</Link> takes a name,
                    and what to start from: a rocket, a hopper, or a test stand (each with its drawing, subsystems, and
                    components, to change), or nothing but the milestones.
                </li>
                <li>
                    <em>Layout</em>, on a program&apos;s page, is where admins change it. The vehicle is drawn from its
                    sections, from the aft end to the nose: an engine (with as many nozzles side by side as it has),
                    body tubes, tanks (their domes drawn inside), couplers, transitions to another diameter, and the
                    nose cone, each with its length and diameter in any one unit; fins at a section&apos;s aft end,
                    landing legs from it, and a test stand&apos;s frame under it all; the preview shows the drawing as
                    it&apos;ll be saved. The name, the description, and the sections are saved together: a bar at the
                    foot of the window says what isn&apos;t saved yet, with <em>Save</em> and <em>Undo changes</em>.
                    Everything else on the page is saved as it&apos;s changed.
                </li>
                <li>
                    Drag a component&apos;s dot to move it on the drawing. One that isn&apos;t on it goes on with{" "}
                    <em>Place</em>, then a click where it goes; <em>Off the drawing</em> takes one off.
                </li>
                <li>
                    Subsystems and their components are renamed where they are, moved up and down, and added. A
                    component moves to another subsystem with its list, and is marked <em>Off the shelf</em> when
                    it&apos;s bought. <em>Remove</em> takes a component off the program, keeping everything said of it:
                    it&apos;s under <em>Removed</em>, to <em>Bring back</em>. A subsystem is deleted only once nothing
                    is in it.
                </li>
                <li>
                    Milestones are each program&apos;s own: renamed, said what they stand for, marked as reviews, moved,
                    added, and deleted. One with anything kept on it (a status, a date, a note, a link) can&apos;t be
                    deleted, so nothing is lost: rename it instead.
                </li>
                <li>
                    <em>Archive…</em> takes a program off the list, kept as it was, for a vehicle that&apos;s flown or
                    been set aside; nothing on it can change until an admin brings it back (
                    <em>Show archived programs</em>).
                </li>
            </ul>
        ),
    },
];

export function HelpPage() {
    const ids = TOPICS.map((topic) => idOf(topic.title));
    const [current, setCurrent] = useState(ids[0]);
    const key = ids.join(" ");

    useEffect(() => {
        // Come with a topic in the address (/buildflow/help#help-links): to it.
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
        <section className="bf-help">
            <div className="page-head">
                <h1>Help</h1>
            </div>
            <p className="bf-lead muted">
                Follow each program&apos;s components through design, build, test, and launch, on its vehicle, and keep
                their progress, people, and links up as the team works.
            </p>
            <div className="bf-help-layout">
                <nav className="bf-help-contents" aria-label="Contents">
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
                <div className="bf-help-topics">
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
