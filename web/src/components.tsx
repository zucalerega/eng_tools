import {
    useEffect,
    useEffectEvent,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
    type RefObject,
} from "react";
import { formatAgo, formatTime } from "./format";

export function Time({ at }: { at: string }) {
    return (
        <time dateTime={at} title={formatTime(at)}>
            {formatAgo(at)}
        </time>
    );
}

const EDGE = 8; // how close a menu comes to the window's edges

/**
 * Put a menu by the element it opens from, all of it in the window: under it (or over it, if there's more room
 * there, and scrolling if neither is enough), lined up with its right edge (or its left, for .menu-left) unless that
 * runs off a side. Fixed to the window, so a scrolling area around the button doesn't cut it off.
 */
export function placeMenu(menu: HTMLElement, from: HTMLElement): void {
    const anchor = from.getBoundingClientRect();
    Object.assign(menu.style, { position: "fixed", right: "auto", bottom: "auto", maxHeight: "", overflowY: "" });
    const { width, height } = menu.getBoundingClientRect();
    const gap = 6;
    let left = menu.classList.contains("menu-left") ? anchor.left : anchor.right - width;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - width));
    const below = window.innerHeight - EDGE - (anchor.bottom + gap);
    const above = anchor.top - gap - EDGE;
    let top = anchor.bottom + gap;
    if (height > below && above > below) {
        top = Math.max(EDGE, anchor.top - gap - height);
    }
    const room = top === anchor.bottom + gap ? below : above;
    if (height > room) {
        Object.assign(menu.style, { maxHeight: `${Math.max(room, 120)}px`, overflowY: "auto" });
    }
    Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
}

/** Put a menu at a point (where a right-click was), all of it in the window. */
export function placeMenuAt(menu: HTMLElement, x: number, y: number): void {
    Object.assign(menu.style, { position: "fixed", right: "auto", bottom: "auto", left: "0px", top: "0px" });
    const { width, height } = menu.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - EDGE - width));
    const top = y + height > window.innerHeight - EDGE ? Math.max(EDGE, y - height) : y;
    Object.assign(menu.style, { position: "fixed", left: `${left}px`, top: `${top}px` });
}

/**
 * A menu's open state: it closes on a click outside the element the ref is on, or on Escape. While it's open, the
 * .menu inside that element stays on screen (placeMenu), as it grows and as the page scrolls or resizes.
 */
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
    useLayoutEffect(() => {
        const wrapper = within.current;
        const menu = wrapper?.querySelector<HTMLElement>(":scope > .menu");
        if (!open || !wrapper || !menu) {
            return;
        }
        const place = () => placeMenu(menu, wrapper);
        place();
        window.addEventListener("resize", place);
        document.addEventListener("scroll", place, true);
        const growing = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
        growing?.observe(menu);
        return () => {
            window.removeEventListener("resize", place);
            document.removeEventListener("scroll", place, true);
            growing?.disconnect();
        };
    }, [open]);
    return [open, setOpen, within];
}

/** A button with a menu of actions under it (named, for screen readers, by name when its label is only a sign). */
export function MenuButton({
    label,
    items,
    primary = false,
    name,
    align = "right",
}: {
    label: string;
    items: { label: string; onSelect: () => void }[];
    primary?: boolean;
    name?: string;
    align?: "left" | "right"; // the menu's edge that lines up with the button's (left: it opens rightwards)
}) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    return (
        <div className="popover" ref={within}>
            <button
                type="button"
                className={`menu-button ${primary ? "button-primary" : ""}`}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={name}
                title={name}
                onClick={() => setOpen(!open)}
            >
                {label}
            </button>
            {open && (
                <div className={`menu ${align === "left" ? "menu-left" : ""}`} role="menu" aria-label={name ?? label}>
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
 * follows confirmHref (a link for SolidWorks, say), and there's nothing to confirm without one. Without confirm,
 * it only shows something, until it's closed.
 */
export function Dialog({
    title,
    children,
    confirm,
    onConfirm,
    onCancel,
    cancel = "Cancel",
    busy = false,
    danger = false,
    disabled = false,
    link = false,
    confirmHref,
    tall = false,
    wide = false,
}: {
    title: string;
    children: ReactNode;
    confirm?: string;
    onConfirm?: () => void;
    onCancel: () => void;
    cancel?: string; // "Close", when it's done
    busy?: boolean;
    danger?: boolean;
    disabled?: boolean;
    link?: boolean;
    confirmHref?: string;
    tall?: boolean; // it can be taller than the window: its body scrolls, its buttons stay in view
    wide?: boolean; // for choices side by side, or a table
}) {
    const heading = useId();
    const dialog = useRef<HTMLFormElement>(null);
    const cancelButton = useRef<HTMLButtonElement>(null);
    const escape = useEffectEvent((event: KeyboardEvent) => {
        if (event.key === "Escape" && !busy) {
            onCancel();
        }
    });
    // Once, when it opens (unless one of its fields took focus): focusing again on every render would
    // pull focus out of its fields.
    useEffect(() => {
        if (!dialog.current?.contains(document.activeElement)) {
            cancelButton.current?.focus();
        }
        const listener = (event: KeyboardEvent) => escape(event);
        window.addEventListener("keydown", listener);
        return () => window.removeEventListener("keydown", listener);
    }, []);
    const className = danger ? "button-danger" : "button-primary";
    return (
        <div className="dialog-backdrop">
            <form
                className={["dialog", tall && "dialog-tall", wide && "dialog-wide"].filter(Boolean).join(" ")}
                role="dialog"
                aria-modal="true"
                aria-labelledby={heading}
                ref={dialog}
                onSubmit={(event) => {
                    event.preventDefault();
                    if (confirm === undefined) {
                        return;
                    }
                    if (link && confirmHref) {
                        window.location.assign(confirmHref);
                        onConfirm?.();
                    } else if (!link && !busy && !disabled) {
                        onConfirm?.();
                    }
                }}
            >
                <h2 id={heading}>{title}</h2>
                <div className="dialog-body">{children}</div>
                <div className="dialog-actions">
                    <button type="button" ref={cancelButton} onClick={onCancel} disabled={busy}>
                        {cancel}
                    </button>
                    {confirm === undefined ? null : link && confirmHref ? (
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
