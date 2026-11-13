import { useEffect, useState } from "react";
import { Notice } from "../components";
import { formatDate } from "../format";
import { Link } from "../router";
import { tempoApi } from "./api";
import type { TempoTestSummary } from "./types";

export function TestsPage() {
    const [tests, setTests] = useState<TempoTestSummary[]>([]);
    const [queryText, setQueryText] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    async function load(q: string) {
        setLoading(true);
        setError(null);
        try {
            setTests(await tempoApi.listTests(q));
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to load saved tests.");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void load(queryText);
    }, [queryText]);

    async function remove(item: TempoTestSummary) {
        if (!window.confirm(`Delete saved test "${item.name}"?`)) {
            return;
        }
        try {
            await tempoApi.deleteTest(item.id);
            setTests((prev) => prev.filter((t) => t.id !== item.id));
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to delete test.");
        }
    }

    return (
        <div className="tempo-page">
            <header className="tempo-page-head">
                <div>
                    <h1>Saved tests</h1>
                    <p className="muted">
                        Sequence tests stored on the Engineering Tools server with their exact Python source and test
                        environment.
                    </p>
                </div>
                <Link to="/tempo" className="button-primary">
                    Open workspace
                </Link>
            </header>

            <div className="tempo-search-bar">
                <input
                    type="search"
                    placeholder="Search saved tests by name or owner…"
                    value={queryText}
                    onChange={(e) => setQueryText(e.target.value)}
                />
            </div>

            {error && <Notice tone="error">{error}</Notice>}

            {loading ? (
                <p className="muted">Loading saved tests…</p>
            ) : tests.length === 0 ? (
                <p className="muted">No saved tests found. Save one from the Tempo workspace.</p>
            ) : (
                <table className="tempo-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Rev</th>
                            <th>Lines</th>
                            <th>Valves / Sensors</th>
                            <th>Owner</th>
                            <th>Updated</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {tests.map((item) => (
                            <tr key={item.id}>
                                <td>
                                    <Link to={`/tempo?test=${item.id}`}>
                                        <strong>{item.name}</strong>
                                    </Link>
                                </td>
                                <td>v{item.version}</td>
                                <td>{item.line_count}</td>
                                <td>
                                    {item.valve_count} valves · {item.sensor_count} sensors
                                </td>
                                <td>{item.owner_name}</td>
                                <td>{formatDate(item.updated_at)}</td>
                                <td className="tempo-table-actions">
                                    <Link to={`/tempo?test=${item.id}`} className="button-small">
                                        Open
                                    </Link>
                                    {item.can_change && (
                                        <button
                                            type="button"
                                            className="button-small button-danger"
                                            onClick={() => void remove(item)}
                                        >
                                            Delete
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
