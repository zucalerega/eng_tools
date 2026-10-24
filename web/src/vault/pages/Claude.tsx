import { useEffect, useState } from "react";
import { api, type AssistantSpending } from "../../api";
import { Notice, Time } from "../../components";

// Admin > People's card for Claude, which answers people's questions in Help: what its answers have cost, of the budget
// the server gives it, and on whose questions (assistant.py). The server keeps no one's questions, only their cost.

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

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
    return (
        <section className="tracker claude" aria-labelledby="claude-title">
            <div className="tracker-head">
                <h2 id="claude-title">Claude</h2>
            </div>
            {!spending.available && (
                <Notice tone={spending.budget > 0 ? "warning" : "info"}>
                    {spending.reason}. Its settings are <code>YJSP_ANTHROPIC_API_KEY</code>,{" "}
                    <code>YJSP_ASSISTANT_BUDGET</code>, and <code>YJSP_ASSISTANT_DAILY_LIMIT</code>, in the
                    server&apos;s <code>.env</code>.
                </Notice>
            )}
            <dl className="stat-tiles">
                <div>
                    <dt>Spent</dt>
                    <dd>{usd.format(spending.spent)}</dd>
                </div>
                <div>
                    <dt>Left of {usd.format(spending.budget)}</dt>
                    <dd>{usd.format(Math.max(0, spending.budget - spending.spent))}</dd>
                </div>
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
                {spending.model}, at {spending.effort} effort. The first question in an hour costs the most, as Claude
                reads all of the help; for the rest of the hour it reads it for much less.
            </p>
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
