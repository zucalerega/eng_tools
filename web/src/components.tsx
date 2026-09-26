import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from "react";
import type { Account, Lock } from "./api";
import { formatAgo, formatTime } from "./format";
import { kindOf, opensInSolidWorks } from "./paths";

const KIND_LABELS = { part: "Part", assembly: "Assembly", drawing: "Drawing", model: "3D model", file: "File" };

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
export function LockLabel({ lock, me, short = false }: { lock: Lock; me: Account | null; short?: boolean }) {
    const who = lock.user.id === me?.id ? "you" : lock.user.name;
    return (
        <span className={`lock ${lock.user.id === me?.id ? "lock-mine" : ""}`}>
            {short ? `${who} on ${lock.host}` : `Checked out by ${who} on ${lock.host}`}
            {short ? null : (
                <>
                    {", "}
                    <Time at={lock.since} />
                </>
            )}
        </span>
    );
}

/**
 * Opens the file in SolidWorks on this computer through the cvc: link that the add-in's installer
 * registers. The add-in (or its helper) gets the latest version, and the parts it uses, first.
 */
export function OpenInSolidWorks({ path, compact = false }: { path: string; compact?: boolean }) {
    if (!opensInSolidWorks(path)) {
        return null;
    }
    const link = "cvc://open?" + new URLSearchParams({ server: window.location.origin, path }).toString();
    return (
        <a
            className={compact ? "button button-small" : "button button-primary"}
            href={link}
            title="Needs the CVC add-in for SolidWorks on this computer"
        >
            Open in SolidWorks
        </a>
    );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "error"; children: ReactNode }) {
    return (
        <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
            {children}
        </div>
    );
}

/** A modal question: the page underneath waits until it's answered. */
export function Dialog({
    title,
    children,
    confirm,
    onConfirm,
    onCancel,
    busy = false,
    danger = false,
}: {
    title: string;
    children: ReactNode;
    confirm: string;
    onConfirm: () => void;
    onCancel: () => void;
    busy?: boolean;
    danger?: boolean;
}) {
    const heading = useId();
    const cancel = useRef<HTMLButtonElement>(null);
    const escape = useEffectEvent((event: KeyboardEvent) => {
        if (event.key === "Escape" && !busy) {
            onCancel();
        }
    });
    // Once, when it opens: focusing again on every render would pull focus out of its fields.
    useEffect(() => {
        cancel.current?.focus();
        const listener = (event: KeyboardEvent) => escape(event);
        window.addEventListener("keydown", listener);
        return () => window.removeEventListener("keydown", listener);
    }, []);
    return (
        <div className="dialog-backdrop">
            <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={heading}>
                <h2 id={heading}>{title}</h2>
                <div className="dialog-body">{children}</div>
                <div className="dialog-actions">
                    <button type="button" ref={cancel} onClick={onCancel} disabled={busy}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className={danger ? "button-danger" : "button-primary"}
                        onClick={onConfirm}
                        disabled={busy}
                    >
                        {busy ? "Working…" : confirm}
                    </button>
                </div>
            </div>
        </div>
    );
}
