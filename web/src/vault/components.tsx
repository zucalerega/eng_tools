import type { Account } from "../api";
import { Time } from "../components";
import { formatTime } from "../format";
import { Link } from "../router";
import type { Lock, VaultFile } from "./api";
import { on } from "./checkouts";
import { caliperUrl, fileUrl, kindOf, opensInCaliper, opensInSolidWorks, sheetFormat, titleBeside } from "./paths";

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

/**
 * A file's name, a link to its page, with its title under it where the title says more than the name does: once
 * someone named it, or its name is a part number (titleBeside). label: the name as the list has it (a path, say).
 */
export function FileName({ file, label = file.name }: { file: VaultFile; label?: string }) {
    const title = titleBeside(file);
    if (!title) {
        return (
            <Link to={fileUrl(file.id)} className="name">
                <FileIcon name={file.name} />
                {label}
            </Link>
        );
    }
    // The name itself (a part number) stays whole, though a path before it may wrap.
    const at = label.length - file.name.length;
    return (
        <span className="file-name">
            <Link to={fileUrl(file.id)} className="name">
                <FileIcon name={file.name} />
                <span>
                    {label.slice(0, at)}
                    <span className="file-name-whole">{label.slice(at)}</span>
                </span>
            </Link>
            <span className="file-title">{title}</span>
        </span>
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

const CALIPER_TITLES = {
    drawing: "See its sheets, in the browser",
    dxf: "See it in the browser: zoom in, and measure it",
    model: "See it in 3D, in the browser: turn it, cut it, measure it",
};

/**
 * Caliper, the browser's viewer, for a part, an assembly, or a STEP, IGES, or STL file in 3D, or a drawing or a DXF file
 * flat: right beside Open in SolidWorks.
 */
export function OpenInCaliper({ file, compact = false }: { file: { id: number; name: string }; compact?: boolean }) {
    if (!opensInCaliper(file.name)) {
        return null;
    }
    return (
        <Link
            className={compact ? "button button-small" : "button"}
            to={caliperUrl(file.id)}
            aria-label="Open in Caliper"
            title={CALIPER_TITLES[sheetFormat(file.name) ?? "model"]}
        >
            {compact ? "Caliper" : "Open in Caliper"}
        </Link>
    );
}
