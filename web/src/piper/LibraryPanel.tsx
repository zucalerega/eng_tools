import { useState } from "react";
import { libraryDrag } from "./Canvas";
import type { Palette } from "./colors";
import { PartIcon, presetPart } from "./icons";
import { CATEGORIES, searchPresets } from "./library/index";
import type { Category } from "./library/kinds";
import { useEditor, type EditorStore } from "./store";

// The library: every part, by category, found by any of its names. Drag one onto the drawing (onto a line, for a valve
// in it), or click it and then click where it goes (Shift-click there to place more).

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
    const [find, setFind] = useState("");
    const [closed, setClosed] = useState<Set<Category>>(storedClosed);
    const found = searchPresets(find);
    const searching = find.trim() !== "";

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
                                            draggable
                                            onDragStart={(event) => {
                                                libraryDrag.preset = preset.id;
                                                event.dataTransfer.setData("application/x-piper-preset", preset.id);
                                                event.dataTransfer.effectAllowed = "copy";
                                            }}
                                            onDragEnd={() => {
                                                libraryDrag.preset = null;
                                            }}
                                            onClick={() =>
                                                store.setTool(
                                                    placing ? { mode: "select" } : { mode: "place", preset: preset.id },
                                                )
                                            }
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
        </aside>
    );
}
