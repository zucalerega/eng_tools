import { useEffect, useState } from "react";
import { api, type AssistantSpending } from "../../api";
import { Notice, Time } from "../../components";

// Admin > People's card for Claude, which answers people's questions in Help: what its answers have cost, of the budgets
// the server gives it (each month, in all, or both), and on whose questions (assistant.py), and how long the server
// keeps the help loaded for it. The server keeps no one's questions, only their cost.

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

// How long the help may be kept loaded after a question, in hours: 1 is just the hour Anthropic keeps it.
const KEEP_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];

export function ClaudeSpending() {
    const [spending, setSpending] = useState<AssistantSpending | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        api.assistantSpending().then(setSpending, (error: Error) => setProblem(error.message));
    }, []);
    if (problem) {
        return <p className="muted">Couldn't load what Claude has cost: {problem}</p>;
    }
    if (!spending) {
        return null;
    }
    const monthly = spending.monthly_budget > 0;
    const inAll = spending.budget > 0;
    return (
        <section className="tracker claude" aria-labelledby="claude-title">
            <div className="tracker-head">
                <h2 id="claude-title">Claude</h2>
            </div>
            {!spending.available && (
                <Notice tone={monthly || inAll ? "warning" : "info"}>
                    {spending.reason}. Its settings are <code>YJSP_ANTHROPIC_API_KEY</code>,{" "}
                    <code>YJSP_ASSISTANT_MONTHLY_BUDGET</code>, <code>YJSP_ASSISTANT_BUDGET</code>, and{" "}
                    <code>YJSP_ASSISTANT_DAILY_LIMIT</code>, in the server&apos;s <code>.env</code>.
                </Notice>
            )}
            <dl className="stat-tiles">
                {monthly && (
                    <>
                        <div>
                            <dt>This month</dt>
                            <dd>{usd.format(spending.month_spent)}</dd>
                        </div>
                        <div>
                            <dt>Left of {usd.format(spending.monthly_budget)} this month</dt>
                            <dd>{usd.format(Math.max(0, spending.monthly_budget - spending.month_spent))}</dd>
                        </div>
                    </>
                )}
                {(inAll || !monthly) && (
                    <div>
                        <dt>Spent in all</dt>
                        <dd>{usd.format(spending.spent)}</dd>
                    </div>
                )}
                {inAll && (
                    <div>
                        <dt>Left of {usd.format(spending.budget)} in all</dt>
                        <dd>{usd.format(Math.max(0, spending.budget - spending.spent))}</dd>
                    </div>
                )}
                <div>
                    <dt>Last 24 hours</dt>
                    <dd>{usd.format(spending.today)}</dd>
                </div>
                <div>
                    <dt>A person&apos;s daily limit</dt>
                    <dd>{usd.format(spending.daily_limit)}</dd>
                </div>
            </dl>
            <p className="tracker-note muted">
                {spending.model}, at {spending.effort} effort.{" "}
                {monthly && (
                    <>{!inAll && <>{usd.format(spending.spent)} in all. </>}A month starts on the 1st, at 00:00 UTC. </>
                )}
                {spending.feedback_spent > 0 && (
                    <>
                        Its looks at bug reports and feature requests cost {usd.format(spending.feedback_spent)} this
                        month.{" "}
                    </>
                )}
                {!spending.keep_warm && (
                    <>
                        The first question in an hour costs the most, as Claude reads all of the help; for the rest of
                        the hour it reads it for much less.
                    </>
                )}
            </p>
            {spending.keep_warm && (
                <KeepLoaded
                    spending={spending}
                    onChange={(keep_hours) => setSpending((now) => now && { ...now, keep_hours })}
                />
            )}
            {spending.people.length === 0 ? (
                <p className="muted">No one has asked Claude anything yet.</p>
            ) : (
                <div className="claude-list">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Questions</th>
                                <th>Spent</th>
                                <th>Last asked</th>
                            </tr>
                        </thead>
                        <tbody>
                            {spending.people.map((person) => (
                                <tr key={person.user.id}>
                                    <td>{person.user.name}</td>
                                    <td>{person.questions}</td>
                                    <td>{usd.format(person.spent)}</td>
                                    <td>
                                        <Time at={person.last_asked_at} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

/** How long the server keeps the help loaded for Claude: around the clock, or for some hours after each question. */
function KeepLoaded({ spending, onChange }: { spending: AssistantSpending; onChange: (hours: number | null) => void }) {
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const hours = spending.keep_hours;
    // With whatever the server has, as an admin may set any number of hours through the API.
    const choices =
        hours === null || KEEP_HOURS.includes(hours) ? KEEP_HOURS : [...KEEP_HOURS, hours].sort((a, b) => a - b);

    async function keep(chosen: number | null) {
        setBusy(true);
        setProblem(null);
        try {
            onChange((await api.keepHelpLoaded(chosen)).keep_hours);
        } catch (error) {
            setProblem((error as Error).message);
        } finally {
            setBusy(false);
        }
    }
    return (
        <div className="keep-loaded">
            <label className="field">
                Keep the help loaded
                <select
                    value={hours ?? "always"}
                    disabled={busy}
                    onChange={(event) => {
                        const value = event.target.value;
                        void keep(value === "always" ? null : Number(value));
                    }}
                >
                    <option value="always">Always</option>
                    {choices.map((each) => (
                        <option key={each} value={each}>
                            For {each === 1 ? "an hour" : `${each} hours`} after a question
                        </option>
                    ))}
                </select>
            </label>
            {problem && <Notice tone="error">{problem}</Notice>}
            <p className="muted tracker-note">
                {hours === null
                    ? "The server reads the help again whenever nothing has for 50 minutes, so every question reads it for much less."
                    : hours === 1
                      ? "Anthropic keeps the help loaded for an hour after each question: a question in that hour reads it for much less, and the first after it pays to have all of it read."
                      : `The server keeps the help loaded for ${hours} hours after each question, reading it again meanwhile: a question then reads it for much less, and the first after that pays to have all of it read.`}{" "}
                Keeping it loaded cost {usd.format(spending.keep_warm_spent)} this month
                {spending.month_questions > 0 && (
                    <>
                        , and {spending.month_questions_loaded} of {spending.month_questions} questions found it loaded
                    </>
                )}
                .
            </p>
        </div>
    );
}
