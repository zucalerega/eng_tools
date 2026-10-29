import type { StorageSummary } from "./api";
import { formatSize } from "./format";

// How full the server's disk is: one bar, its parts kept apart by the surface, and a legend that says the same in
// words. What each app takes, the rest, and what's free. The site's home page shows it to everyone; Admin > People to
// admins, with what the database takes and the off-site backup.

const LOW_ON_SPACE = 0.1; // of the disk free, or less: say so

export function StorageBar({ storage, other }: { storage: StorageSummary; other?: string }) {
    const used = storage.total - storage.free;
    const parts = [
        { key: "vault", label: "Vault", bytes: storage.vault, about: "Every version of every file" },
        { key: "yorg", label: "Yorg", bytes: storage.yorg, about: "Test data, scripts, and models" },
        { key: "piper", label: "Piper", bytes: storage.piper, about: "Diagrams' revisions and pictures" },
        {
            key: "other",
            label: "Other",
            bytes: Math.max(0, used - storage.vault - storage.yorg - storage.piper),
            about: other ?? "The system, the rest of the database, and its backups",
        },
        { key: "free", label: "Free", bytes: storage.free, about: "What the server can still write" },
    ];
    const low = storage.free <= storage.total * LOW_ON_SPACE;
    return (
        <>
            <div className="storage-head">
                <h2>Storage</h2>
                <span>
                    {formatSize(used)} of {formatSize(storage.total)} used (
                    {Math.round((used / Math.max(storage.total, 1)) * 100)}%)
                </span>
                {low && <span className="storage-low">Running out of space</span>}
            </div>
            {/* The legend below says the same in words. */}
            <div className="storage-bar" aria-hidden="true">
                {parts
                    .filter((part) => part.bytes > 0)
                    .map((part) => (
                        <span
                            key={part.key}
                            className={`storage-${part.key}`}
                            style={{ flexGrow: part.bytes / Math.max(storage.total, 1) }}
                            title={`${part.label}: ${formatSize(part.bytes)}`}
                        />
                    ))}
            </div>
            <ul className="storage-legend">
                {parts.map((part) => (
                    <li key={part.key} title={part.about}>
                        <span className={`storage-swatch storage-${part.key}`} aria-hidden="true" />
                        {part.label} <strong>{formatSize(part.bytes)}</strong>
                    </li>
                ))}
            </ul>
        </>
    );
}
