import { useEffect, useState } from "react";
import { Dialog, Notice } from "../components";
import { navigate } from "../router";
import { yorg, type DataFolder, type DatasetDetail, type PieceBody } from "./api";
import { maskRuns, useLoaded } from "./data";
import { folderUrl } from "./Datasets";
import { shiftOf, type Layout } from "./layout";
import { cutAt, edgeOf, readTimes, testsOf, type Finding, type Piece } from "./masks";
import { formatDuration } from "./scale";

// Splitting a file of several tests into a dataset for each: where a mask holds (each time a valve opens, say), cut
// at times you choose, or both. Each test's samples are copied out, into a folder; the file stays as it was.

const MOST = 200; // the server makes at most this many at once

/** Where each test's time counts from: where its mask starts holding, its start, or as in the file. */
type Zero = "edge" | "start" | "file";

const FINDING: Record<keyof Finding, string> = { before: "1", after: "2", join: "1", shortest: "0.5" };

const keyOf = (piece: Piece) => `${piece.start}:${piece.end}`;

export function SplitDialog({
    detail,
    layout,
    at,
    onClose,
}: {
    detail: DatasetDetail; // the first dataset: its times are the time axis's (plus its shift)
    layout: Layout; // its masks, markers, and T0
    at: (x: number) => string; // a time on the time axis, as the plots label it
    onClose: () => void;
}) {
    useLoaded();
    const shift = shiftOf(layout, detail.id);
    const masks = layout.masks;
    const [byMask, setByMask] = useState(masks.length > 0);
    const [maskId, setMaskId] = useState(masks[0]?.id ?? "");
    const [finding, setFinding] = useState(FINDING);
    const [cutText, setCutText] = useState("");
    const [atMarkers, setAtMarkers] = useState(false);
    const [zero, setZero] = useState<Zero>(masks.length > 0 ? "edge" : "start");
    const [prefix, setPrefix] = useState(`${detail.name} test`);
    const [folders, setFolders] = useState<DataFolder[] | null>(null);
    const [where, setWhere] = useState("new"); // "new", "here" (its dataset's folder), or a folder's id
    const [folderName, setFolderName] = useState(`${detail.name} tests`);
    const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [done, setDone] = useState<{ folder: number | null; count: number; place: string } | null>(null);

    useEffect(() => {
        yorg.folders().then(setFolders, () => setFolders([]));
    }, []);

    // The tests: where the mask holds (as tests), or the whole file; then cut at the times given.
    const span: [number, number] = [detail.t_min ?? 0, detail.t_max ?? 0];
    const mask = byMask ? (masks.find((one) => one.id === maskId) ?? null) : null;
    const runs = mask ? maskRuns(detail, [mask.expression]) : null;
    const numbers: Finding = {
        before: Number(finding.before),
        after: Number(finding.after),
        join: Number(finding.join),
        shortest: Number(finding.shortest),
    };
    const badNumber = Object.values(numbers).some((value) => !(value >= 0)); // NaN too
    const typed = readTimes(cutText);
    const cuts = [
        ...(typeof typed === "string" ? [] : typed.map((t) => t + (layout.t0 ?? 0) - shift)),
        ...(atMarkers ? layout.markers.map((marker) => marker.t - shift) : []),
    ];
    let why: string | null = null;
    let waiting = false;
    let found: Piece[] = [];
    if (byMask && !mask) {
        why = "Choose a mask.";
    } else if (badNumber) {
        why = "Seconds before, after, and between tests are numbers, 0 or more.";
    } else if (typeof typed === "string") {
        why = typed;
    } else if (runs?.status === "loading") {
        waiting = true;
    } else if (runs?.status === "failed") {
        why = `${mask!.name} can't be worked out for ${detail.name}: ${runs.error}`;
    } else {
        const whole: Piece[] = [{ start: span[0], end: span[1], run: null }];
        found = cutAt(runs?.status === "ready" ? testsOf(runs.value, span, numbers) : whole, cuts);
        if (!byMask && found.length === 1) {
            why = "That's the whole file: give times to cut it at.";
            found = [];
        } else if (found.length === 0) {
            why = `${mask?.name ?? "The mask"} never holds in ${detail.name}.`;
        }
    }
    const zeroOf = (piece: Piece): number | null =>
        zero === "file" ? null : zero === "edge" ? (edgeOf(piece) ?? piece.start) : piece.start;
    const nameOf = (index: number) => `${prefix.trim()} ${index + 1}`;
    const making: PieceBody[] = found
        .map((piece, index) => ({ piece, index }))
        .filter(({ piece }) => !skipped.has(keyOf(piece)))
        .map(({ piece, index }) => ({ name: nameOf(index), start: piece.start, end: piece.end, zero: zeroOf(piece) }));

    const byId = new Map((folders ?? []).map((folder) => [folder.id, folder]));
    const placeOf = (id: number | null): string => {
        const names: string[] = [];
        for (let step = id; step !== null; step = byId.get(step)?.parent_id ?? null) {
            names.unshift(byId.get(step)?.name ?? "…");
        }
        return names.length > 0 ? names.join(" / ") : "Test data (the top)";
    };

    async function make() {
        setBusy(true);
        setProblem(null);
        let created: DataFolder | null = null;
        try {
            let folder: number | null;
            if (where === "new") {
                created = await yorg.addFolder(folderName.trim(), detail.folder_id);
                folder = created.id;
            } else {
                folder = where === "here" ? detail.folder_id : Number(where);
            }
            const made = await yorg.split(detail.id, making, folder);
            setDone({ folder, count: made.length, place: created?.name ?? placeOf(folder) });
        } catch (failure) {
            if (created) {
                await yorg.removeFolder(created.id).catch(() => undefined); // nothing went in it
            }
            setProblem(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    }

    if (done) {
        return (
            <Dialog
                title={`Made ${done.count} dataset${done.count === 1 ? "" : "s"}`}
                confirm="Open the folder"
                cancel="Close"
                onConfirm={() => navigate(folderUrl(done.folder))}
                onCancel={onClose}
            >
                <p>
                    They're in {done.place}. {detail.name} is as it was.
                </p>
            </Dialog>
        );
    }

    const width = span[1] - span[0] || 1;
    const place = (from: number, to: number) => ({
        left: `${((from - span[0]) / width) * 100}%`,
        width: `${Math.max(0.3, ((to - from) / width) * 100)}%`,
    });
    const timesLabel = layout.t0 === null ? "Cut at times (s)" : "Cut at times from T0 (s)";
    return (
        <Dialog
            title={`Split ${detail.name} into tests`}
            confirm={making.length > 0 ? `Make ${making.length} dataset${making.length === 1 ? "" : "s"}` : "Make them"}
            busy={busy}
            disabled={
                making.length === 0 ||
                making.length > MOST ||
                !prefix.trim() ||
                (where === "new" && !folderName.trim()) ||
                why !== null ||
                waiting
            }
            onConfirm={() => void make()}
            onCancel={onClose}
        >
            <div className="yorg-split">
                <fieldset>
                    <legend>Where the tests are</legend>
                    <label className="check">
                        <input
                            type="radio"
                            name="split-by"
                            checked={byMask}
                            disabled={masks.length === 0}
                            onChange={() => {
                                setByMask(true);
                                setZero("edge");
                            }}
                        />
                        Where a mask holds
                        {masks.length > 0 && (
                            <select
                                aria-label="Mask"
                                value={maskId}
                                disabled={!byMask}
                                onChange={(event) => setMaskId(event.target.value)}
                            >
                                {masks.map((one) => (
                                    <option key={one.id} value={one.id}>
                                        {one.name}
                                    </option>
                                ))}
                            </select>
                        )}
                    </label>
                    {masks.length === 0 && (
                        <p className="muted">
                            To split where a valve's open, say, add a mask first (Mask, over the plots).
                        </p>
                    )}
                    {byMask && (
                        <div className="yorg-split-finding">
                            <Seconds
                                label="Start"
                                value={finding.before}
                                onChange={(before) => setFinding({ ...finding, before })}
                            >
                                s before it holds
                            </Seconds>
                            <Seconds
                                label="End"
                                value={finding.after}
                                onChange={(after) => setFinding({ ...finding, after })}
                            >
                                s after
                            </Seconds>
                            <Seconds
                                label="One test if less than"
                                value={finding.join}
                                onChange={(join) => setFinding({ ...finding, join })}
                            >
                                s apart
                            </Seconds>
                            <Seconds
                                label="Leave out tests shorter than"
                                value={finding.shortest}
                                onChange={(shortest) => setFinding({ ...finding, shortest })}
                            >
                                s
                            </Seconds>
                        </div>
                    )}
                    <label className="check">
                        <input
                            type="radio"
                            name="split-by"
                            checked={!byMask}
                            onChange={() => {
                                setByMask(false);
                                setZero("start");
                            }}
                        />
                        The whole file, cut at times
                    </label>
                </fieldset>
                <label className="field">
                    {timesLabel}
                    <input
                        value={cutText}
                        placeholder="120, 480.5"
                        aria-invalid={typeof typed === "string"}
                        onChange={(event) => setCutText(event.target.value)}
                    />
                </label>
                {layout.markers.length > 0 && (
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={atMarkers}
                            onChange={(event) => setAtMarkers(event.target.checked)}
                        />
                        And at the markers ({layout.markers.map((marker) => marker.label).join(", ")})
                    </label>
                )}
                <div className="yorg-row">
                    <label className="field">
                        Each test's time
                        <select value={zero} onChange={(event) => setZero(event.target.value as Zero)}>
                            {byMask && <option value="edge">From where its mask starts holding</option>}
                            <option value="start">From its start</option>
                            <option value="file">As in the file</option>
                        </select>
                    </label>
                    <label className="field">
                        Names
                        <input value={prefix} onChange={(event) => setPrefix(event.target.value)} />
                    </label>
                </div>
                <div className="yorg-row">
                    <label className="field">
                        Put them in
                        <select value={where} onChange={(event) => setWhere(event.target.value)}>
                            <option value="new">A new folder, next to {detail.name}</option>
                            <option value="here">
                                {placeOf(detail.folder_id)}, with {detail.name}
                            </option>
                            {(folders ?? [])
                                .filter((folder) => folder.id !== detail.folder_id)
                                .map((folder) => (
                                    <option key={folder.id} value={String(folder.id)}>
                                        {placeOf(folder.id)}
                                    </option>
                                ))}
                        </select>
                    </label>
                    {where === "new" && (
                        <label className="field">
                            The new folder's name
                            <input value={folderName} onChange={(event) => setFolderName(event.target.value)} />
                        </label>
                    )}
                </div>

                <div className="yorg-split-timeline" aria-hidden="true">
                    {runs?.status === "ready" &&
                        runs.value.length <= 1000 &&
                        Array.from({ length: runs.value.length / 2 }, (_, r) => (
                            <span
                                key={`run${r}`}
                                className="yorg-split-run"
                                style={{
                                    ...place(runs.value[2 * r]!, runs.value[2 * r + 1]!),
                                    background: mask!.color,
                                }}
                            />
                        ))}
                    {found.map((piece, index) => (
                        <span
                            key={keyOf(piece)}
                            className={`yorg-split-piece${skipped.has(keyOf(piece)) ? " yorg-split-skipped" : ""}`}
                            style={place(piece.start, piece.end)}
                        >
                            {index + 1}
                        </span>
                    ))}
                </div>
                {waiting && <p className="muted">Working out where {mask?.name} holds…</p>}
                {why && <p className="field-problem">{why}</p>}
                {found.length > MOST && (
                    <Notice tone="warning">
                        That's {found.length} tests: up to {MOST} can be made at once. Make tests of runs further apart,
                        or leave out short ones.
                    </Notice>
                )}
                {found.length > 0 && (
                    <div className="table-scroll yorg-split-list">
                        <table className="table" aria-label="Tests">
                            <thead>
                                <tr>
                                    <th />
                                    <th>Name</th>
                                    <th>From</th>
                                    <th>To</th>
                                    <th>Length</th>
                                </tr>
                            </thead>
                            <tbody>
                                {found.slice(0, MOST).map((piece, index) => {
                                    const key = keyOf(piece);
                                    return (
                                        <tr key={key}>
                                            <td>
                                                <input
                                                    type="checkbox"
                                                    aria-label={`Make ${nameOf(index)}`}
                                                    checked={!skipped.has(key)}
                                                    onChange={(event) => {
                                                        const next = new Set(skipped);
                                                        if (event.target.checked) {
                                                            next.delete(key);
                                                        } else {
                                                            next.add(key);
                                                        }
                                                        setSkipped(next);
                                                    }}
                                                />
                                            </td>
                                            <td>{nameOf(index)}</td>
                                            <td>{at(piece.start + shift)}</td>
                                            <td>{at(piece.end + shift)}</td>
                                            <td>{formatDuration(piece.end - piece.start)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
                {problem && <Notice tone="error">{problem}</Notice>}
            </div>
        </Dialog>
    );
}

function Seconds({
    label,
    value,
    onChange,
    children,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    children: string;
}) {
    return (
        <label className="yorg-seconds">
            {label}
            <input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} />
            {children}
        </label>
    );
}
