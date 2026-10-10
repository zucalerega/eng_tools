import type { Account } from "../api";
import { Time } from "../components";
import { formatTime } from "../format";
import type { Lock, VaultFile } from "./api";
import { on } from "./checkouts";
import { kindOf, opensInSolidWorks } from "./paths";

const KIND_LABELS = { part: "Part", assembly: "Assembly", drawing: "Drawing", model: "3D model", file: "File" };

/**
 * Vault's mark: a vault door (an octagon with a wheel) crossed by a gold orbit, after the Yellow Jacket
 * Space Program's logo. The door takes the text color; the favicon in index.html and the server's
 * sign-in page draw the same shapes.
 */
export function VaultMark({ size = 30 }: { size?: number }) {
    return (
        <svg className="vault-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
            <g fill="none" stroke="currentColor">
                <polygon
                    points="54.2,41.2 41.2,54.2 22.8,54.2 9.8,41.2 9.8,22.8 22.8,9.8 41.2,9.8 54.2,22.8"
                    strokeWidth="5"
                />
                <circle cx="32" cy="32" r="12.5" strokeWidth="3" />
                <path d="M32 32V14.5M32 32L16.8 40.8M32 32l15.2 8.8" strokeWidth="3" />
            </g>
            <g fill="currentColor">
                <circle cx="32" cy="32" r="4.5" />
                <circle cx="32" cy="14.5" r="2.8" />
                <circle cx="16.8" cy="40.8" r="2.8" />
                <circle cx="47.2" cy="40.8" r="2.8" />
            </g>
            <path className="vault-orbit" d="M4 57Q42 52 60 5Q36 45 4 57Z" />
        </svg>
    );
}

export function FileIcon({ name }: { name: string }) {
    const kind = kindOf(name);
    return (
        <span
            className={`file-icon file-icon-${kind}`}
            title={KIND_LABELS[kind]}
            aria-hidden="true"
            data-letter={{ part: "P", assembly: "A", drawing: "D", model: "3D", file: "·" }[kind]}
        />
    );
}

export function FolderIcon() {
    return <span className="file-icon file-icon-folder" aria-hidden="true" />;
}

/** "Checked out by Alice on ALICE-PC, 2 hours ago" (or by you). */
export function LockLabel({ lock, me }: { lock: Lock; me: Account | null }) {
    return (
        <span className={`lock ${lock.user.id === me?.id ? "lock-mine" : ""}`}>
            Checked out by {lock.user.id === me?.id ? "you" : lock.user.name} {on(lock.host)}, <Time at={lock.since} />
        </span>
    );
}

/** In lists: "Checked in", or "Checked out by Alice on ALICE-PC" (since when is in its tooltip). */
export function StatusLabel({ file, me }: { file: VaultFile; me: Account | null }) {
    const lock = file.checked_out;
    if (!lock) {
        return <span className="checked-in">Checked in</span>;
    }
    const mine = lock.user.id === me?.id;
    return (
        <span className={`lock ${mine ? "lock-mine" : ""}`} title={`Since ${formatTime(lock.since)}`}>
            Checked out by {mine ? "you" : lock.user.name} {on(lock.host)}
        </span>
    );
}

/** The scheme of the links SolidWorks follows: the add-in's installer registers vault-open.exe for it. */
const LINK_SCHEME = "vault";

/**
 * A link that SolidWorks on this computer follows, through the links the add-in's installer registers: open a
 * vault file (after getting its latest version and the parts it uses), or start a new part or assembly there.
 */
export const solidWorksLink = (action: "open" | "new", path: string, more: Record<string, string> = {}): string =>
    `${LINK_SCHEME}://${action}?` + new URLSearchParams({ server: window.location.origin, path, ...more }).toString();

/** A link that sets the add-in up for this vault: SolidWorks starts, and the browser asks you to let it in. */
export const connectLink = (): string =>
    `${LINK_SCHEME}://connect?` + new URLSearchParams({ server: window.location.origin }).toString();

export function OpenInSolidWorks({ path, compact = false }: { path: string; compact?: boolean }) {
    if (!opensInSolidWorks(path)) {
        return null;
    }
    // In a table's rows, just "Open": the column has no room for more, and its tooltip says the rest.
    return (
        <a
            className={compact ? "button button-small" : "button button-primary"}
            href={solidWorksLink("open", path)}
            aria-label="Open in SolidWorks"
            title="Open in SolidWorks. Needs the Vault add-in on this computer: see SolidWorks, at the top"
        >
            {compact ? "Open" : "Open in SolidWorks"}
        </a>
    );
}
