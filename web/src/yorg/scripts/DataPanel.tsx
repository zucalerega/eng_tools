import { useState } from "react";
import type { Dataset } from "../api";
import { dataset as loadDataset } from "../data";
import { datasetUrl } from "../pages";
import { channelCode, testRef } from "./complete";

// The tests a script works on, beside it: attach one or more (the first is the one yorg.channel() takes from unless
// told another), see their channels, and click one to put it in the code at the cursor.

interface Props {
    datasets: Dataset[]; // every test there is (ready)
    attached: number[]; // the script's, the first first
    onChange: (attached: number[]) => void;
    onChannel: (channel: string, test: string | number | null) => void; // test: as testRef has it (null: the first)
}

export function DataPanel({ datasets, attached, onChange, onChannel }: Props) {
    const [find, setFind] = useState("");
    const wanted = find.trim().toLowerCase();
    const nameOf = (id: number) => datasets.find((one) => one.id === id)?.name ?? `Test ${id}`;
    // Tests in two folders can have one name: those show their ids too.
    const shared = (name: string) => datasets.filter((one) => one.name.toLowerCase() === name.toLowerCase()).length > 1;
    const labelOf = (id: number) => (shared(nameOf(id)) ? `${nameOf(id)} (${id})` : nameOf(id));
    const tests = attached.map((id) => ({ id, name: nameOf(id), channels: [] }));
    const others = datasets.filter((one) => !attached.includes(one.id));
    return (
        <aside className="scripts-data" aria-label="Data">
            <p className="muted scripts-data-help">
                The tests the script works on. Click a channel to put it in the code; in quotes, type a few letters of
                one.
            </p>
            <label className="field">
                Attach a test
                <select
                    value=""
                    onChange={(event) => event.target.value && onChange([...attached, Number(event.target.value)])}
                >
                    <option value="">{others.length ? "Pick one" : "Every test is attached"}</option>
                    {others.map((one) => (
                        <option key={one.id} value={one.id}>
                            {labelOf(one.id)}
                        </option>
                    ))}
                </select>
            </label>
            {attached.length > 0 && (
                <input
                    className="scripts-find"
                    type="search"
                    placeholder="Find a channel"
                    aria-label="Find a channel"
                    value={find}
                    onChange={(event) => setFind(event.target.value)}
                />
            )}
            {attached.length === 0 && <p className="muted">No test attached yet.</p>}
            {attached.map((id, index) => {
                const name = labelOf(id);
                const ref = testRef(tests, index);
                const loaded = loadDataset(id);
                const channels =
                    loaded.status === "ready"
                        ? loaded.value.channels.filter((one) => !wanted || one.name.toLowerCase().includes(wanted))
                        : [];
                return (
                    <section key={id} className="scripts-test" aria-label={name}>
                        <div className="scripts-test-head">
                            <a
                                href={datasetUrl(id)}
                                target="_blank"
                                rel="noreferrer"
                                title="Open the test (in a new tab)"
                            >
                                {name} ↗
                            </a>
                            {index === 0 ? (
                                <span
                                    className="scripts-first"
                                    title="yorg.channel() takes from it unless told another"
                                >
                                    first
                                </span>
                            ) : (
                                <button
                                    type="button"
                                    className="button-small"
                                    onClick={() => onChange([id, ...attached.filter((one) => one !== id)])}
                                >
                                    Make first
                                </button>
                            )}
                            <button
                                type="button"
                                className="button-small scripts-detach"
                                aria-label={`Detach ${name}`}
                                title="Detach it from the script"
                                onClick={() => onChange(attached.filter((one) => one !== id))}
                            >
                                ×
                            </button>
                        </div>
                        {loaded.status === "loading" && <p className="muted">Loading its channels…</p>}
                        {loaded.status === "failed" && <p className="muted">{loaded.error}</p>}
                        {loaded.status === "ready" && channels.length === 0 && (
                            <p className="muted">{wanted ? "No channel has that." : "It has no channels."}</p>
                        )}
                        <ul className="scripts-channels">
                            {channels.map((channel) => (
                                <li key={channel.name}>
                                    <button
                                        type="button"
                                        title={channelCode(channel.name, ref)}
                                        onClick={() => onChannel(channel.name, ref)}
                                    >
                                        <span>{channel.name}</span>
                                        <span className="muted">
                                            {channel.kind === "state" ? "state" : channel.unit}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                );
            })}
        </aside>
    );
}
