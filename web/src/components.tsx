import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Account, Lock, VaultFile } from "./api";
import { formatAgo, formatTime } from "./format";
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
        <span className={`file-icon file-icon-${kind}`} title={KIND_LABELS[kind]} aria-hidden="true">
            {{ part: "P", assembly: "A", drawing: "D", model: "3D", file: "·" }[kind]}
        </span>
    );
}

export function FolderIcon() {
    return <span className="file-icon file-icon-folder" aria-hidden="true" />;
}

export function Time({ at }: { at: string }) {
    return (
        <time dateTime={at} title={formatTime(at)}>
            {formatAgo(at)}
        </time>
    );
}

/** "Checked out by Alice on ALICE-PC, 2 hours ago" (or by you). */
export function LockLabel({ lock, me }: { lock: Lock; me: Account | null }) {
    return (
        <span className={`lock ${lock.user.id === me?.id ? "lock-mine" : ""}`}>
            Checked out by {lock.user.id === me?.id ? "you" : lock.user.name} on {lock.host}, <Time at={lock.since} />
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
            Checked out by {mine ? "you" : lock.user.name} on {lock.host}
        </span>
    );
}

/**
 * A link that SolidWorks on this computer follows, through the cvc: links the add-in's installer
 * registers: open a vault file (after getting its latest version and the parts it uses), or start a
 * new part or assembly there.
 */
export const solidWorksLink = (action: "open" | "new", path: string, more: Record<string, string> = {}): string =>
    `cvc://${action}?` + new URLSearchParams({ server: window.location.origin, path, ...more }).toString();

/** A link that sets the add-in up for this vault: SolidWorks starts, and the browser asks you to let it in. */
export const connectLink = (): string =>
    "cvc://connect?" + new URLSearchParams({ server: window.location.origin }).toString();

export function OpenInSolidWorks({ path, compact = false }: { path: string; compact?: boolean }) {
    if (!opensInSolidWorks(path)) {
        return null;
    }
    return (
        <a
            className={compact ? "button button-small" : "button button-primary"}
            href={solidWorksLink("open", path)}
            title="Needs the Vault add-in for SolidWorks on this computer: see SolidWorks, at the top"
        >
            Open in SolidWorks
        </a>
    );
}

/** A menu's open state: it closes on a click outside the element the ref is on, or on Escape. */
export function usePopover<T extends HTMLElement>(): [boolean, (open: boolean) => void, RefObject<T | null>] {
    const [open, setOpen] = useState(false);
    const within = useRef<T>(null);
    useEffect(() => {
        if (!open) {
            return;
        }
        const close = (event: MouseEvent | KeyboardEvent) => {
            const outside = event instanceof MouseEvent && !within.current?.contains(event.target as Node);
            if (outside || (event instanceof KeyboardEvent && event.key === "Escape")) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", close);
        document.addEventListener("keydown", close);
        return () => {
            document.removeEventListener("mousedown", close);
            document.removeEventListener("keydown", close);
        };
    }, [open]);
    return [open, setOpen, within];
}

/** A button with a menu of actions under it. */
export function MenuButton({
    label,
    items,
    primary = false,
}: {
    label: string;
    items: { label: string; onSelect: () => void }[];
    primary?: boolean;
}) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    return (
        <div className="popover" ref={within}>
            <button
                type="button"
                className={`menu-button ${primary ? "button-primary" : ""}`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                {label}
            </button>
            {open && (
                <div className="menu" role="menu" aria-label={label}>
                    {items.map((item) => (
                        <button
                            key={item.label}
                            type="button"
                            role="menuitem"
                            className="menu-item"
                            onClick={() => {
                                setOpen(false);
                                item.onSelect();
                            }}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "error"; children: ReactNode }) {
    return (
        <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
            {children}
        </div>
    );
}

/**
 * A modal question: the page underneath waits until it's answered, and Enter confirms. With link, confirming
 * follows confirmHref (a cvc: link for SolidWorks, say), and there's nothing to confirm without one.
 */
export function Dialog({
    title,
    children,
    confirm,
    onConfirm,
    onCancel,
    busy = false,
    danger = false,
    disabled = false,
    link = false,
    confirmHref,
}: {
    title: string;
    children: ReactNode;
    confirm: string;
    onConfirm: () => void;
    onCancel: () => void;
    busy?: boolean;
    danger?: boolean;
    disabled?: boolean;
    link?: boolean;
    confirmHref?: string;
}) {
    const heading = useId();
    const dialog = useRef<HTMLFormElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const escape = useEffectEvent((event: KeyboardEvent) => {
        if (event.key === "Escape" && !busy) {
            onCancel();
        }
    });
    // Once, when it opens (unless one of its fields took focus): focusing again on every render would
    // pull focus out of its fields.
    useEffect(() => {
        if (!dialog.current?.contains(document.activeElement)) {
            cancel.current?.focus();
        }
        const listener = (event: KeyboardEvent) => escape(event);
        window.addEventListener("keydown", listener);
        return () => window.removeEventListener("keydown", listener);
    }, []);
    const className = danger ? "button-danger" : "button-primary";
    return (
        <div className="dialog-backdrop">
            <form
                className="dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={heading}
                ref={dialog}
                onSubmit={(event) => {
                    event.preventDefault();
                    if (link && confirmHref) {
                        window.location.assign(confirmHref);
                        onConfirm();
                    } else if (!link && !busy && !disabled) {
                        onConfirm();
                    }
                }}
            >
                <h2 id={heading}>{title}</h2>
                <div className="dialog-body">{children}</div>
                <div className="dialog-actions">
                    <button type="button" ref={cancel} onClick={onCancel} disabled={busy}>
                        Cancel
                    </button>
                    {link && confirmHref ? (
                        <a className={`button ${className}`} href={confirmHref} onClick={onConfirm}>
                            {confirm}
                        </a>
                    ) : (
                        <button
                            type="button"
                            className={className}
                            onClick={onConfirm}
                            disabled={busy || disabled || link}
                        >
                            {busy ? "Working…" : confirm}
                        </button>
                    )}
                </div>
            </form>
        </div>
    );
}
