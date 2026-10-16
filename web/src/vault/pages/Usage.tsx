import { useEffect, useState } from "react";
import { api, type Usage, type UsageDay } from "../../api";
import { formatDuration } from "../../format";

// Admin > People's tracker: how many people used the site each day for the last month, and how long they had the web
// app open and worked in SolidWorks, as the server counts them (usage.py), in this browser's time zone.

const DAYS = 30;
const LABEL_EVERY = 7; // days between the dates under the chart, counting back from today

type Measure = "people" | "time";

// Time on the site, in its parts, bottom to top in each column: a part is a color of its own in the chart.
const PARTS = [
    { key: "site_seconds", label: "Web app", where: "on the web app", className: "bars-bar-site" },
    { key: "solidworks_seconds", label: "SolidWorks", where: "in SolidWorks", className: "bars-bar-solidworks" },
] as const;

/** A day's time on the site: on the web app and in SolidWorks, together. */
const timeOf = (day: UsageDay) => day.site_seconds + day.solidworks_seconds;

export function SiteUsage() {
    const [usage, setUsage] = useState<Usage | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [measure, setMeasure] = useState<Measure>("people");
    useEffect(() => {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        api.usage(DAYS, zone).then(setUsage, (error: Error) => setProblem(error.message));
    }, []);
    if (problem) {
        return <p className="muted">Couldn't load how the site is used: {problem}</p>;
    }
    if (!usage) {
        return null;
    }
    const today = usage.days[usage.days.length - 1]!;
    const first = usage.days[0]!.day;
    return (
        <section className="tracker" aria-labelledby="usage-title">
            <div className="tracker-head">
                <h2 id="usage-title">Activity</h2>
                <div className="segmented" role="group" aria-label="Show">
                    <button type="button" aria-pressed={measure === "people"} onClick={() => setMeasure("people")}>
                        Active people
                    </button>
                    <button type="button" aria-pressed={measure === "time"} onClick={() => setMeasure("time")}>
                        Time on the site
                    </button>
                </div>
            </div>
            <dl className="stat-tiles">
                <div>
                    <dt>Active today</dt>
                    <dd>{today.people}</dd>
                </div>
                <div>
                    <dt>Active in the last {DAYS} days</dt>
                    <dd>{usage.people}</dd>
                </div>
                <div>
                    <dt>Time on the site today</dt>
                    <dd>{duration(timeOf(today))}</dd>
                </div>
                <div>
                    <dt>Time on the site, in all</dt>
                    <dd>{duration(usage.total_site_seconds + usage.total_solidworks_seconds)}</dd>
                </div>
            </dl>
            <DailyBars usage={usage} measure={measure} />
            <p className="muted tracker-note">
                Active: used the web app, the add-in, or the command line that day. Time on the site: the web app open
                in a browser, and SolidWorks in front, with someone at the computer, and the add-in signed in.
                {usage.since !== null && usage.since > first && ` Counted since ${formatDay(usage.since)}.`}
                {usage.solidworks_since !== null &&
                    usage.solidworks_since > first &&
                    ` Time in SolidWorks counted since ${formatDay(usage.solidworks_since)}.`}
            </p>
        </section>
    );
}

/** One column a day, today last, with what the hovered day had. */
function DailyBars({ usage, measure }: { usage: Usage; measure: Measure }) {
    const [hovered, setHovered] = useState<number | null>(null);
    const value = (day: UsageDay) => (measure === "people" ? day.people : timeOf(day));
    const counted = (day: UsageDay) => usage.since !== null && day.day >= usage.since; // ISO dates sort as dates
    const top = measure === "people" ? niceTop(Math.max(...usage.days.map(value)), 1) : timeTop(usage.days);
    const tick = (amount: number) => (measure === "people" ? String(amount) : amount ? formatDuration(amount) : "0");
    const count = usage.days.length;
    const shown = hovered === null ? null : usage.days[hovered]!;
    const height = (day: UsageDay) => (counted(day) ? (value(day) / top) * 100 : 0); // % of the plot
    return (
        <div className="bars">
            {/* Kept, empty, for people, so the chart stays put as it switches. */}
            <ul className="bars-legend">
                {measure === "time" &&
                    PARTS.map((part) => (
                        <li key={part.key}>
                            <span className={`bars-swatch ${part.className}`} aria-hidden="true" />
                            {part.label}
                        </li>
                    ))}
            </ul>
            <div className="bars-plot" onMouseLeave={() => setHovered(null)}>
                {[top, top / 2, 0].map((amount) => (
                    <div key={amount} className="bars-grid" style={{ bottom: `${(amount / top) * 100}%` }}>
                        <span>{tick(amount)}</span>
                    </div>
                ))}
                <div className="bars-columns" aria-hidden="true">
                    {usage.days.map((day, index) => (
                        <div key={day.day} className="bars-slot" onMouseEnter={() => setHovered(index)}>
                            {height(day) > 0 && (
                                <div
                                    className={index === hovered ? "bars-stack bars-stack-hovered" : "bars-stack"}
                                    style={{ height: `${height(day)}%` }}
                                >
                                    {measure === "people" ? (
                                        <div className="bars-bar" />
                                    ) : (
                                        PARTS.map(
                                            (part) =>
                                                day[part.key] > 0 && (
                                                    <div
                                                        key={part.key}
                                                        className={`bars-bar ${part.className}`}
                                                        style={{ flexGrow: day[part.key] }}
                                                    />
                                                ),
                                        )
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
                {shown && hovered !== null && (
                    <div
                        className="bars-tip"
                        role="status"
                        style={{
                            left: `${((hovered + 0.5) / count) * 100}%`,
                            bottom: `calc(${height(shown)}% + 0.5rem)`, // just above its column
                            translate: hovered < count / 4 ? "-15% 0" : hovered > (count * 3) / 4 ? "-85% 0" : "-50% 0",
                        }}
                    >
                        <strong>{hovered === count - 1 ? "Today" : formatDay(shown.day, true)}</strong>
                        {counted(shown) ? (
                            <>
                                <span>{shown.people === 1 ? "1 person" : `${shown.people} people`}</span>
                                <span>{duration(timeOf(shown))} on the site</span>
                                {timeOf(shown) > 0 &&
                                    PARTS.map((part) => (
                                        <span key={part.key}>
                                            <span className={`bars-swatch ${part.className}`} aria-hidden="true" />
                                            {duration(shown[part.key])} {part.where}
                                        </span>
                                    ))}
                            </>
                        ) : (
                            <span>Not counted yet</span>
                        )}
                    </div>
                )}
            </div>
            <div className="bars-axis" aria-hidden="true">
                {usage.days.map(
                    (day, index) =>
                        (count - 1 - index) % LABEL_EVERY === 0 && (
                            <span key={day.day} style={{ left: `${((index + 0.5) / count) * 100}%` }}>
                                {index === count - 1 ? "Today" : formatDay(day.day)}
                            </span>
                        ),
                )}
            </div>
            <table className="visually-hidden">
                <caption>Each day's use of the site</caption>
                <thead>
                    <tr>
                        <th>Day</th>
                        <th>Active people</th>
                        <th>Time on the web app</th>
                        <th>Time in SolidWorks</th>
                    </tr>
                </thead>
                <tbody>
                    {usage.days.map((day) => (
                        <tr key={day.day}>
                            <td>{formatDay(day.day, true)}</td>
                            <td>{counted(day) ? day.people : "not counted yet"}</td>
                            <td>{counted(day) ? duration(day.site_seconds) : "not counted yet"}</td>
                            <td>{counted(day) ? duration(day.solidworks_seconds) : "not counted yet"}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** "3 h 20 min", or "none". */
function duration(seconds: number): string {
    return seconds > 0 ? formatDuration(seconds) : "none";
}

/** A day the server named (2026-10-14) as this browser says it: "Oct 14", or "Wed, Oct 14". */
function formatDay(day: string, withWeekday = false): string {
    const [year, month, date] = day.split("-").map(Number);
    return new Date(year!, month! - 1, date!).toLocaleDateString("en", {
        weekday: withWeekday ? "short" : undefined,
        month: "short",
        day: "numeric",
    });
}

/** The chart's top: at least the most, and round, in steps of the unit, so that its middle is round too. */
function niceTop(most: number, unit: number): number {
    const units = Math.max(most / unit, 1);
    const scale = 10 ** Math.floor(Math.log10(units));
    const step = [1, 2, 4, 5, 10].find((each) => each * scale >= units)!;
    return Math.max(step * scale, 2) * unit;
}

/** For time on the site: round minutes up to most of an hour, round hours past it. */
function timeTop(days: UsageDay[]): number {
    const most = Math.max(...days.map(timeOf));
    return most <= 50 * 60 ? Math.max(niceTop(most, 60), 10 * 60) : niceTop(most, 3600);
}
