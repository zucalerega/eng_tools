import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Notice } from "../components";
import { formatDate } from "../format";
import { Link } from "../router";
import { tempoApi } from "./api";
import { DEFAULT_ENVIRONMENT, normalizeEnvironment } from "./examples";
import { environmentFileName } from "./filename";
import type { TempoEnvironmentRecord } from "./types";

export function EnvironmentsPage() {
    const [items, setItems] = useState<TempoEnvironmentRecord[]>([]);
    const [queryText, setQueryText] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState("");
    const [newDesc, setNewDesc] = useState("");
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    async function load(q: string) {
        setLoading(true);
        setError(null);
        try {
            setItems(await tempoApi.listEnvironments(q));
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to load environments.");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void load(queryText);
    }, [queryText]);

    async function createDefault() {
        if (!newName.trim()) {
            return;
        }
        setCreating(true);
        setError(null);
        try {
            const created = await tempoApi.createEnvironment({
                name: newName.trim(),
                description: newDesc.trim(),
                environment: DEFAULT_ENVIRONMENT,
            });
            setItems((prev) => [created, ...prev]);
            setNewName("");
            setNewDesc("");
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to create environment.");
        } finally {
            setCreating(false);
        }
    }

    function handleImportJson(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) {
            return;
        }
        void file.text().then(async (text) => {
            try {
                const env = normalizeEnvironment(text, DEFAULT_ENVIRONMENT);
                const baseName = file.name.replace(/(-environment)?\.json$/i, "") || "Imported environment";
                const created = await tempoApi.createEnvironment({
                    name: baseName,
                    description: `Imported from ${file.name}`,
                    environment: env,
                });
                setItems((prev) => [created, ...prev]);
            } catch (err: unknown) {
                setError(err instanceof Error ? err.message : "Failed to import environment JSON.");
            }
        });
    }

    function exportJson(item: TempoEnvironmentRecord) {
        const blob = new Blob([JSON.stringify(item.environment, null, 2) + "\n"], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = environmentFileName(item.name);
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    async function remove(item: TempoEnvironmentRecord) {
        if (!window.confirm(`Delete environment "${item.name}"?`)) {
            return;
        }
        try {
            await tempoApi.deleteEnvironment(item.id);
            setItems((prev) => prev.filter((e) => e.id !== item.id));
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to delete environment.");
        }
    }

    return (
        <div className="tempo-page">
            <header className="tempo-page-head">
                <div>
                    <h1>Test environments</h1>
                    <p className="muted">
                        Reusable valve and sensor configurations that can be loaded into any Tempo sequence test.
                    </p>
                </div>
                <div className="tempo-header-actions">
                    <button type="button" onClick={() => fileInputRef.current?.click()}>
                        Import JSON
                    </button>
                    <Link to="/tempo" className="button button-primary">
                        Open workspace
                    </Link>
                </div>
            </header>

            <section className="tempo-create-box">
                <input
                    type="text"
                    placeholder="New environment name…"
                    value={newName}
                    maxLength={200}
                    onChange={(e) => setNewName(e.target.value)}
                />
                <input
                    type="text"
                    placeholder="Description (optional)"
                    value={newDesc}
                    maxLength={500}
                    onChange={(e) => setNewDesc(e.target.value)}
                />
                <button
                    type="button"
                    className="button-primary"
                    disabled={creating || !newName.trim()}
                    onClick={() => void createDefault()}
                >
                    {creating ? "Creating…" : "Create environment"}
                </button>
            </section>

            <div className="tempo-search-bar">
                <input
                    type="search"
                    placeholder="Search environments…"
                    value={queryText}
                    onChange={(e) => setQueryText(e.target.value)}
                />
            </div>

            {error && <Notice tone="error">{error}</Notice>}

            {loading ? (
                <p className="muted">Loading environments…</p>
            ) : items.length === 0 ? (
                <p className="muted">No reusable environments saved yet.</p>
            ) : (
                <table className="tempo-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Description</th>
                            <th>Valves / Sensors</th>
                            <th>Owner</th>
                            <th>Updated</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((item) => (
                            <tr key={item.id}>
                                <td>
                                    <strong>{item.name}</strong>
                                </td>
                                <td className="muted">{item.description || "—"}</td>
                                <td>
                                    {item.environment.valves.length} valves · {item.environment.sensors.length} sensors
                                </td>
                                <td>{item.owner_name}</td>
                                <td>{formatDate(item.updated_at)}</td>
                                <td className="tempo-table-actions">
                                    <Link to={`/tempo?env=${item.id}`} className="button button-small">
                                        Load in workspace
                                    </Link>
                                    <button type="button" className="button-small" onClick={() => exportJson(item)}>
                                        Export JSON
                                    </button>
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

            <input ref={fileInputRef} type="file" accept=".json,application/json" hidden onChange={handleImportJson} />
        </div>
    );
}
