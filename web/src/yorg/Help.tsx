import type { ReactNode } from "react";
import { inPreview } from "../preview";
import { Link, usePathname } from "../router";

// What Yorg does, and how: one page, from the top bar's Help.

function Card({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section aria-label={title}>
            <h2>{title}</h2>
            {children}
        </section>
    );
}

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
    const preview = inPreview(usePathname()); // what's new, in the preview until it's released
    return (
        <section className="yorg-page yorg-help">
            <div className="page-head">
                <h1>How Yorg works</h1>
            </div>
            <p className="lead muted">
                Upload a CSV from a hotfire or cold flow, and plot its channels together on one time axis. Everyone
                signed in sees every dataset, view, and calculated channel; only whoever added a dataset (or an admin)
                changes it.
            </p>
            <div className="yorg-help-grid">
                <Card title="Getting data in">
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
                </Card>

                <Card title="Organizing">
                    <ul>
                        <li>
                            <em>New folder</em> for a campaign or a test day; drag datasets onto a folder (or one in the
                            path at the top), or check some and <em>Move to…</em>
                        </li>
                        <li>
                            <em>Find datasets</em> looks in every folder. Deleted datasets can be restored (
                            <Link to="/yorg/deleted">Deleted</Link>).
                        </li>
                    </ul>
                </Card>

                <Card title="Plotting">
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
                </Card>

                <Card title="Moving around">
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
                </Card>

                <Card title="Time and T0">
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
                </Card>

                <Card title="Marking up">
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
                </Card>

                <Card title="Calculated channels">
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
                </Card>

                <Card title="Splitting a file into tests">
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
                </Card>

                {preview && (
                    <Card title="System models">
                        <ul>
                            <li>
                                <em>Models</em>: draw a test stand's feed system (tanks, lines, valves, orifices,
                                venturis; and on the gas side, supplies, regulators, gas valves) and link it to a test's
                                channels: commands drive its valves, pressures it follows, sensors it's compared with.
                            </li>
                            <li>
                                <em>Run</em> simulates it with FullFlow over a window from T0; each sensor is plotted
                                with the model, and how far apart they are. <em>Fit</em> turns the knobs you pick (CdAs,
                                losses, a regulator's set pressure) until it matches best.
                            </li>
                            <li>
                                A dataset&apos;s <em>Analyze</em> menu runs a model on it.
                            </li>
                        </ul>
                    </Card>
                )}
                {preview && (
                    <Card title="Scripts">
                        <ul>
                            <li>
                                Python in your browser, with NumPy, SciPy, pandas, matplotlib, and CoolProp:{" "}
                                <code>yorg.channel(&quot;PT-TANK&quot;)</code> is a channel of the test picked, and{" "}
                                <code>yorg.plot</code> draws on Yorg&apos;s plots.
                            </li>
                            <li>
                                Python stays open while this tab does, with what it has imported and the channels it
                                has, and gets a script&apos;s slow imports ready while you read it. The output says what
                                it&apos;s doing, for how long, and after a run, where the time went.
                            </li>
                            <li>
                                Scripts are kept for everyone in folders; upload .py files, or start from the examples.
                                <em>Scripts</em> on a dataset&apos;s or view&apos;s page opens one on what it plots.
                            </li>
                        </ul>
                    </Card>
                )}

                <Card title="Views and exports">
                    <ul>
                        <li>
                            <em>Save view</em> keeps the plots for everyone. A dataset's views are under{" "}
                            <em>Saved views</em> on its page; open one with another test's data for the same plots of
                            its channels.
                        </li>
                        <li>
                            <em>Export</em>: an image of the plots (labels included), or the data in view as CSV
                            (without what masks hide).
                        </li>
                    </ul>
                </Card>
            </div>
        </section>
    );
}
