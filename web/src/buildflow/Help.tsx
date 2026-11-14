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
                    landing legs from it, and a test stand&apos;s frame under it all. <em>Save the drawing</em> keeps
                    the sections; the preview shows them first.
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
