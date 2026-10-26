import { useRef, useState, type PointerEvent } from "react";
import { libraryDrop } from "./Canvas";
import type { Palette } from "./colors";
import { PartIcon, presetPart } from "./icons";
import { CATEGORIES, presetOf, searchPresets } from "./library/index";
import type { Category } from "./library/kinds";
import { useEditor, type EditorStore } from "./store";

// The library: every part, by category, found by any of its names. Drag one onto the drawing (onto a line, for a valve
// in it), or click it and then click where it goes (Shift-click there to place more). The drag is the pointer's own,
// not the browser's drag-and-drop, which some browsers (Firefox) won't start from a button.

/** How far the pointer goes, in pixels, before a press is a drag rather than a click. */
const DRAG_START = 4;

const CLOSED = "piper.library.closed"; // the categories shut in this browser

function storedClosed(): Set<Category> {
    try {
        return new Set(JSON.parse(window.localStorage.getItem(CLOSED) ?? "[]") as Category[]);
    } catch {
        return new Set();
    }
}

export function LibraryPanel({
    store,
    palette,
    onPlace,
}: {
    store: EditorStore;
    palette: Palette;
    onPlace: (preset: string) => void;
}) {
    const tool = useEditor(store, (state) => state.tool);
    // The entry pressed, and whether the pointer's gone far enough with it to be dragging it.
    const press = useRef<{ preset: string; pointer: number; x: number; y: number; dragging: boolean } | null>(null);
    const dragged = useRef(false); // a drag just ended: the click that ends it isn't a click
    // The part following the pointer, until it's over the drawing, which shows it where it would go.
    const [ghost, setGhost] = useState<{ preset: string; x: number; y: number } | null>(null);
    const [find, setFind] = useState("");
    const [closed, setClosed] = useState<Set<Category>>(storedClosed);
    const found = searchPresets(find);
    const searching = find.trim() !== "";

    function onPointerDown(event: PointerEvent<HTMLButtonElement>, preset: string) {
        // The main button, and the first finger of a touch (a second one isn't another drag).
        if (event.button === 0 && event.isPrimary !== false) {
            dragged.current = false; // a browser that sent no click after the last drag: this press is a new one
            press.current = { preset, pointer: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
            // Followed wherever it goes from here, a quick flick onto the drawing too; a click is still a click.
            event.currentTarget.setPointerCapture?.(event.pointerId);
        }
    }

    function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const now = press.current;
        if (!now || now.pointer !== event.pointerId) {
            return;
        }
        if (!now.dragging) {
            if (Math.hypot(event.clientX - now.x, event.clientY - now.y) < DRAG_START) {
                return;
            }
            now.dragging = true;
        }
        const client = { x: event.clientX, y: event.clientY };
        const over = libraryDrop.target?.over(now.preset, client, event.altKey) ?? false;
        setGhost(over ? null : { preset: now.preset, ...client });
    }

    function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
        const now = press.current;
        press.current = null;
        if (now?.dragging && now.pointer === event.pointerId) {
            dragged.current = true;
            setGhost(null);
            libraryDrop.target?.drop(now.preset, { x: event.clientX, y: event.clientY }, event.altKey);
        }
    }

    function onPointerCancel() {
        if (press.current?.dragging) {
            libraryDrop.target?.leave();
        }
        press.current = null;
        setGhost(null);
    }

    function toggle(category: Category) {
        const next = new Set(closed);
        if (next.has(category)) {
            next.delete(category);
        } else {
            next.add(category);
        }
        setClosed(next);
        try {
            window.localStorage.setItem(CLOSED, JSON.stringify([...next]));
        } catch {
            // storage blocked: shut for this visit
        }
    }

    return (
        <aside className="piper-library" aria-label="Library">
            <input
                type="search"
                className="piper-library-search"
                placeholder="Find a part: valve, PT, COPV…"
                aria-label="Find a part"
                value={find}
                onChange={(event) => setFind(event.target.value)}
            />
            {found.length === 0 && <p className="muted piper-library-none">No part goes by that name.</p>}
            {CATEGORIES.map((category) => {
                const presets = found.filter((preset) => preset.category === category.id);
                if (presets.length === 0) {
                    return null;
                }
                const open = searching || !closed.has(category.id);
                return (
                    <section key={category.id} className="piper-library-section">
                        <button
                            type="button"
                            className="piper-library-head"
                            aria-expanded={open}
                            onClick={() => toggle(category.id)}
                            disabled={searching}
                        >
                            {category.name}
                        </button>
                        {open && (
                            <div className="piper-library-grid">
                                {presets.map((preset) => {
                                    const placing = tool.mode === "place" && tool.preset === preset.id;
                                    return (
                                        <button
                                            key={preset.id}
                                            type="button"
                                            className="piper-library-item"
                                            aria-pressed={placing}
                                            title={`${preset.name}: drag it onto the drawing, or click it, then where it goes`}
                                            onPointerDown={(event) => onPointerDown(event, preset.id)}
                                            onPointerMove={onPointerMove}
                                            onPointerUp={onPointerUp}
                                            onPointerCancel={onPointerCancel}
                                            onClick={() => {
                                                if (dragged.current) {
                                                    dragged.current = false;
                                                    return;
                                                }
                                                store.setTool(
                                                    placing ? { mode: "select" } : { mode: "place", preset: preset.id },
                                                );
                                            }}
                                            onDoubleClick={() => onPlace(preset.id)}
                                        >
                                            <PartIcon part={presetPart(preset)} palette={palette} size={34} />
                                            <span>{preset.name}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                );
            })}
            {ghost && <Ghost preset={ghost.preset} x={ghost.x} y={ghost.y} palette={palette} />}
        </aside>
    );
}

/** A part being dragged from the library, following the pointer while it isn't over the drawing. */
function Ghost({ preset, x, y, palette }: { preset: string; x: number; y: number; palette: Palette }) {
    const found = presetOf(preset);
    if (!found) {
        return null;
    }
    return (
        <div className="piper-library-ghost" style={{ left: x, top: y }} aria-hidden="true">
            <PartIcon part={presetPart(found)} palette={palette} size={34} />
        </div>
    );
}
