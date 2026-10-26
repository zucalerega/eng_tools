import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { Link } from "../router";

// What Yorg does, and how: one page, from the top bar's Help. Its topics go down the page, and the contents beside
// them keep to the one you're reading.

interface Topic {
    title: string;
    body: ReactNode;
}

/** A topic's id, for its link in the contents (and in the address): "Time and T0" is help-time-and-t0. */
const idOf = (title: string) =>
    `help-${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`;

function Keys({ rows }: { rows: [ReactNode, string][] }) {
    return (
        <dl className="yorg-help-keys">
            {rows.map(([key, what]) => (
                <div key={what}>
                    <dt>{key}</dt>
                    <dd>{what}</dd>
                </div>
            ))}
        </dl>
    );
}

export function HelpPage() {
    const topics: Topic[] = [
        {
            title: "Getting data in",
            body: (
                <>
                    <ul>
                        <li>
                            <Link to="/yorg">Upload data</Link>, or drop CSV files on the datasets page (up to 2 GB
                            each). They go in the folder you're in.
                        </li>
                        <li>
                            Yorg works out the layout: the delimiter (commas, tabs, semicolons, spaces; decimal commas
                            too), notes above the names, and the time column: seconds, ms, µs, ns, Unix times, dates, or
                            times of day.
                        </li>
                        <li>
                            Units: <code>PT-1 (psi)</code>, a row of units under the names, units with every value (
                            <code>23.958 V</code>), or a name ending in one (<code>Pressure PSI</code>).
                        </li>
                        <li>
                            Text columns are states. Valves read closed = 0 and open = 1 however the log writes them
                            (fault and the like come after). Mostly empty text is events, a sequence's steps, shown as
                            markers.
                        </li>
                        <li>
                            Guessed wrong? A dataset's <em>About</em> page says how it was read and what was left out;
                            its Read settings choose the time column, its format, the names' row, or the delimiter.
                        </li>
                    </ul>
                </>
            ),
        },
        {
            title: "Organizing",
            body: (
                <>
                    <ul>
                        <li>
                            <em>New folder</em> for a campaign or a test day; drag datasets onto a folder (or one in the
                            path at the top), or check some and <em>Move to…</em>
                        </li>
                        <li>
                            Check datasets and <em>Delete…</em> to delete them together: your own, or anyone&apos;s if
                            you&apos;re an admin.
                        </li>
                        <li>
                            <em>Find datasets</em> looks in every folder. Deleted datasets wait in{" "}
                            <Link to="/yorg/deleted">Deleted datasets</Link>: <em>Restore</em> one, or check several and{" "}
                            <em>Restore</em> them together, back in their folders.
                        </li>
                    </ul>
                </>
            ),
        },
        {
            title: "Plotting",
            body: (
                <>
                    <ul>
                        <li>
                            Click a channel to plot it on the selected plot, and again to take it off; shift-click for a
                            plot of its own; or drag it onto a plot.
                        </li>
                        <li>
                            Each unit gets its own axis, so thrust, pressures, and valves share a plot, each on its
                            scale. Drag a legend row onto another axis, or <em>A new axis</em>.
                        </li>
                        <li>
                            Click a channel's name in a legend for its settings: name, color, scale and offset (psi to
                            bar), unit, axis, lines or steps.
                        </li>
                        <li>
                            <em>Axes</em>, on a plot: each axis's title, range, and side. Plots share the window's
                            height; drag a plot's bottom edge to size it (double-click it to share again).
                        </li>
                        <li>
                            <em>Compare with another dataset</em>, under the channels, overlays another test; shift it
                            in time to line them up.
                        </li>
                    </ul>
                </>
            ),
        },
        {
            title: "Moving around",
            body: (
                <>
                    <Keys
                        rows={[
                            ["Drag", "zoom to that time"],
                            ["Shift-drag", "zoom to a box"],
                            ["Right-drag", "pan (or Ctrl-drag)"],
                            ["Wheel", "zoom time; on an axis, zoom it"],
                            ["Drag an axis", "move it up or down"],
                            ["Double-click", "show everything"],
                            ["Right-click", "marker, label, or T0 there"],
                            [
                                <>
                                    <kbd>←</kbd> <kbd>→</kbd>
                                </>,
                                "pan (Shift: further)",
                            ],
                            [
                                <>
                                    <kbd>↑</kbd> <kbd>↓</kbd>
                                </>,
                                "zoom in and out",
                            ],
                            [
                                <>
                                    <kbd>Home</kbd> <kbd>Backspace</kbd>
                                </>,
                                "everything; back",
                            ],
                            [
                                <>
                                    <kbd>M</kbd> <kbd>T</kbd> <kbd>L</kbd> <kbd>D</kbd>
                                </>,
                                "marker, T0, label, measure",
                            ],
                        ]}
                    />
                </>
            ),
        },
        {
            title: "Time and T0",
            body: (
                <>
                    <ul>
                        <li>
                            Unix-time data reads as time of day in UTC. <em>Options → Time reads</em> switches to your
                            computer's time zone, or to time from T0.
                        </li>
                        <li>
                            Set T0 from the <em>T0</em> menu: type a time of day (<code>21:15:03.25</code>), a Unix
                            time, or <code>T+12</code>; click a plot; or pick an event like MOV OPEN. Drag its line to
                            move it. Time then reads T−10, T0, T+15.
                        </li>
                        <li>
                            The window's boxes take times the same way: <code>T-10</code> to <code>T+15</code>, or{" "}
                            <code>21:15:00</code> to <code>21:16:00</code>.
                        </li>
                        <li>The legend reads every channel at the cursor, and the cursor's time shows bottom right.</li>
                    </ul>
                </>
            ),
        },
        {
            title: "Marking up",
            body: (
                <>
                    <ul>
                        <li>
                            <em>Marker</em> (<kbd>M</kbd>): a named line across the plots; drag it to move it.
                        </li>
                        <li>
                            <em>Label</em> (<kbd>L</kbd>), then click a plot: words with an arrow to the data. Drag the
                            label or its arrow's tip; double-click to change it.
                        </li>
                        <li>
                            <em>Measure</em> (<kbd>D</kbd>), then click two points on a plot: the time between them, the
                            change, and the slope. Click on a channel and the second point stays on it.
                        </li>
                        <li>
                            <em>Mask</em>: a test on channels (<em>MOV-OX is OPEN</em>, <em>PT-CHAMBER is above 450</em>
                            ). It shades the plots where it holds, and can hide data everywhere else.
                        </li>
                    </ul>
                </>
            ),
        },
        {
            title: "Calculated channels",
            body: (
                <>
                    <ul>
                        <li>
                            <em>New calculated channel</em>, under a dataset's channels: for the whole team, in every
                            dataset that has the channels it uses.
                        </li>
                        <li>
                            Channels in brackets, <code>[LC-1] + [LC-2]</code>; <code>+ - * / ^</code>; comparisons give
                            1 or 0.
                        </li>
                        <li>
                            <code>min max avg</code>, <code>if(test, a, b)</code>, <code>where(test, x)</code>,{" "}
                            <code>and or not between</code>, <code>ddt(x)</code> (per second), <code>integral(x)</code>,{" "}
                            <code>smooth(x, seconds)</code>, and the usual math; <code>t</code> is time.
                        </li>
                        <li>
                            O/F while fuel flows: <code>where([FM-FU] &gt; 0.05, [FM-OX] / [FM-FU])</code>
                        </li>
                    </ul>
                </>
            ),
        },
        {
            title: "Splitting a file into tests",
            body: (
                <>
                    <ul>
                        <li>
                            <em>Split</em> makes a dataset of each test in a file: where a mask holds (with seconds
                            before and after, close runs joined, blips left out), and at times or markers you choose.
                        </li>
                        <li>
                            Each test's time can start where its valve opened. They go in a new folder next to the file,
                            which stays as it was.
                        </li>
                    </ul>
                </>
            ),
        },
        {
            title: "Scripts",
            body: (
                <>
                    <ul>
                        <li>
                            Python in your browser, with NumPy, SciPy, pandas, matplotlib, and CoolProp:{" "}
                            <code>yorg.channel(&quot;PT-TANK&quot;)</code> is a channel of the test picked, and{" "}
                            <code>yorg.plot</code> draws on Yorg&apos;s plots.
                        </li>
                        <li>
                            A script is a notebook: load the data in one cell, then change and run the ones after it
                            without loading it again (Shift+Enter runs a cell). The editor suggests as you type, what
                            your variables have too, and the keyboard button lists its keys.
                        </li>
                        <li>
                            The <em>Reference</em>, beside the notebook (the book, in a page&apos;s Python), says what
                            the <code>yorg</code> module has, with an example of each to put in your code.
                        </li>
                        <li>
                            Python stays open while this tab does, with what it has imported and the channels it has,
                            and gets a script&apos;s slow imports ready while you read it. The output says what
                            it&apos;s doing, for how long, and after a run, where the time went.
                        </li>
                        <li>
                            Scripts are kept for everyone, in folders: anyone can open and run one, and only whoever
                            saved it (or an admin) changes it; <em>Save as…</em> keeps a copy of your own. Upload .py
                            files, or start from the examples. Pick a script&apos;s folder from the list above it (or
                            type a new one), or drag a script onto a folder in the list of scripts.
                        </li>
                        <li>
                            <em>Python</em> on a dataset&apos;s or view&apos;s page: a notebook beside its plots, on
                            what they show. <code>yorg.window</code> is the time in view, and <code>yorg.plot</code>{" "}
                            draws on the page&apos;s plots.
                        </li>
                    </ul>
                </>
            ),
        },
        {
            title: "Views, links, and exports",
            body: (
                <>
                    <ul>
                        <li>
                            <em>Save view</em> keeps the plots for everyone. A dataset's views are under{" "}
                            <em>Saved views</em> on its page; open one with another test's data for the same plots of
                            its channels.
                        </li>
                        <li>
                            Views go in folders: pick one from the list when you save one, or type a new one (
                            <code>Hotfires/HF-3</code>); later, <em>More</em> and <em>Rename or move</em>. The{" "}
                            <em>Views</em> tab shows them in their folders: drag one of yours onto a folder to move it,
                            or to the top, out of its folder.
                        </li>
                        <li>
                            <em>Copy link</em>, beside <em>Save view</em>, sends someone the plots as they are (tests
                            and their shifts, time in view, T0, and the rest) without saving a view. They open as
                            unsaved changes, for whoever opens them to <em>Save view</em> or not.
                        </li>
                        <li>
                            <em>Export</em>: an image of the plots (labels included), or the data in view as CSV
                            (without what masks hide).
                        </li>
                    </ul>
                </>
            ),
        },
    ];
    const ids = topics.map((topic) => idOf(topic.title));
    const [current, setCurrent] = useState(ids[0]);
    const key = ids.join(" ");

    useEffect(() => {
        // Come with a topic in the address (/yorg/help#help-plotting): to it.
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
        <section className="yorg-page yorg-help">
            <div className="page-head">
                <h1>Help</h1>
            </div>
            <p className="lead muted">
                Upload a CSV from a hotfire or cold flow, and plot its channels together on one time axis. Everyone
                signed in sees every dataset, view, and calculated channel; only whoever added a dataset (or an admin)
                changes it. Stuck? <strong>Help</strong>, the question mark at the top right, has troubleshooting for
                the whole site, and Claude, to ask.
            </p>
            <div className="yorg-help-layout">
                <nav className="yorg-help-contents" aria-label="Contents">
                    <ul>
                        {topics.map((topic, index) => (
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
                <div className="yorg-help-topics">
                    {topics.map((topic, index) => (
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
