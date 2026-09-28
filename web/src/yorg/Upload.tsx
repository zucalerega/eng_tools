import { useState } from "react";
import { Dialog } from "../components";
import { formatSize } from "../format";
import { yorg, type DatasetDetail } from "./api";

// Uploading test data: each file becomes a dataset, read on the server as soon as it's there.

export const DATA_FILES = ".csv,.tsv,.txt,.dat,.lvm";

interface Item {
    file: File;
    name: string;
    sent: number;
    state: "waiting" | "sending" | "reading" | "done" | "failed";
    result: DatasetDetail | null;
    error: string | null;
}

const baseName = (file: File) => file.name.replace(/\.[^.]+$/, "") || file.name;

export function UploadDialog({
    files,
    onClose,
    onDone,
}: {
    files: File[];
    onClose: () => void;
    onDone: (datasets: DatasetDetail[]) => void;
}) {
    const [items, setItems] = useState<Item[]>(() =>
        files.map((file) => ({ file, name: baseName(file), sent: 0, state: "waiting", result: null, error: null })),
    );
    const [busy, setBusy] = useState(false);
    const finished = items.every((item) => item.state === "done" || item.state === "failed");
    const update = (index: number, change: Partial<Item>) =>
        setItems((current) => current.map((item, i) => (i === index ? { ...item, ...change } : item)));

    async function send() {
        setBusy(true);
        const done: DatasetDetail[] = [];
        for (const [index, item] of items.entries()) {
            if (item.state === "done") {
                continue;
            }
            update(index, { state: "sending", sent: 0, error: null });
            try {
                const result = await yorg.upload(
                    item.file,
                    (sent) => update(index, sent >= item.file.size ? { sent, state: "reading" } : { sent }),
                    item.name.trim() || baseName(item.file),
                );
                done.push(result);
                update(index, { state: "done", sent: item.file.size, result });
            } catch (error) {
                update(index, { state: "failed", error: error instanceof Error ? error.message : String(error) });
            }
        }
        setBusy(false);
        const unreadable = done.filter((result) => result.status === "failed");
        if (unreadable.length === 0 && done.length === items.length) {
            onDone(done);
        }
    }

    return (
        <Dialog
            title={files.length === 1 ? "Upload test data" : `Upload ${files.length} files of test data`}
            confirm={finished ? "Done" : "Upload"}
            busy={busy}
            onConfirm={() =>
                finished ? onDone(items.flatMap((item) => (item.result ? [item.result] : []))) : void send()
            }
            onCancel={onClose}
        >
            <p className="muted">
                Each file becomes a dataset: a CSV (or tab- or semicolon-separated) file with a column of times and a
                column for each channel. Yorg works out the rest, and you can change how it reads a file afterwards.
            </p>
            <ul className="yorg-uploads">
                {items.map((item, index) => (
                    <li key={index}>
                        <label className="field">
                            {item.file.name} <span className="muted">{formatSize(item.file.size)}</span>
                            <input
                                aria-label={`Name for ${item.file.name}`}
                                value={item.name}
                                disabled={busy || item.state === "done"}
                                onChange={(event) => update(index, { name: event.target.value })}
                            />
                        </label>
                        {item.state !== "waiting" && (
                            <div className="yorg-upload-state">
                                <progress
                                    max={item.file.size || 1}
                                    value={item.state === "sending" ? item.sent : item.file.size}
                                />
                                <span role="status">
                                    {item.state === "sending" &&
                                        `Uploading: ${Math.floor((100 * item.sent) / (item.file.size || 1))}%`}
                                    {item.state === "reading" && "Reading it…"}
                                    {item.state === "done" &&
                                        (item.result?.status === "failed"
                                            ? `Uploaded, but it couldn't be read: ${item.result.error}`
                                            : `Read ${item.result?.channel_count ?? 0} channels`)}
                                    {item.state === "failed" && `Didn't upload: ${item.error}`}
                                </span>
                            </div>
                        )}
                    </li>
                ))}
            </ul>
        </Dialog>
    );
}
