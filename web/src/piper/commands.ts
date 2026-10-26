import { useEffect } from "react";
import type { Point } from "./drawing";
import {
    alignParts,
    clipBox,
    copyItems,
    deleteItems,
    drawingBox,
    flipParts,
    moveItems,
    pasteClip,
    readClip,
    turnParts,
    type Alignment,
    type Clip,
} from "./edit";
import { GRID, type Box } from "./geometry";
import { MAX_ZOOM, MIN_ZOOM, type EditorStore } from "./store";

// What the editor's buttons and keys do to its drawing: each a commit to the store, so it's one step to undo.

export type Commands = ReturnType<typeof commandsOf>;

export function commandsOf(store: EditorStore) {
    const state = () => store.getState();
    const selected = () => new Set(state().selection);
    let pastes = { text: "", count: 0 }; // pasting the same thing again puts it a step further on

    const paste = (clip: Clip, text: string) => {
        pastes = pastes.text === text ? { text, count: pastes.count + 1 } : { text, count: 1 };
        const { drawing } = state();
        const box = clipBox(clip, drawing);
        // Where it came from, a step down and right each time (so it's seen to be new), unless that's out of view.
        const step = 2 * GRID * pastes.count;
        const view = state().view;
        const size = state().size;
        const visible = (point: Point) =>
            point.x >= view.x &&
            point.y >= view.y &&
            point.x <= view.x + size.width / view.zoom &&
            point.y <= view.y + size.height / view.zoom;
        let by = { x: step, y: step };
        if (box && !visible({ x: box.x0 + step, y: box.y0 + step })) {
            by = { x: view.x + 4 * GRID - box.x0, y: view.y + 4 * GRID - box.y0 };
        }
        const pasted = pasteClip(drawing, clip, by);
        store.commit(pasted.drawing, pasted.ids);
    };

    /** A box in the middle of the view, at no more than `most` times its size (and no less than the least zoom). */
    const frame = (box: Box, most: number) => {
        const { size } = state();
        const zoom = Math.min(
            most,
            Math.max(MIN_ZOOM, Math.min(size.width / (box.x1 - box.x0), size.height / (box.y1 - box.y0))),
        );
        store.setView({
            x: (box.x0 + box.x1) / 2 - size.width / zoom / 2,
            y: (box.y0 + box.y1) / 2 - size.height / zoom / 2,
            zoom,
        });
    };

    const zoomTo = (zoom: number, around?: Point) => {
        const { view, size } = state();
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
        // Around a point on the canvas (in pixels): what's under it stays there.
        const at = around ?? { x: size.width / 2, y: size.height / 2 };
        const point = { x: view.x + at.x / view.zoom, y: view.y + at.y / view.zoom };
        store.setView({ x: point.x - at.x / next, y: point.y - at.y / next, zoom: next });
    };

    return {
        remove() {
            if (state().selection.length > 0) {
                store.commit(deleteItems(state().drawing, selected()), []);
            }
        },
        turn(clockwise: boolean) {
            store.commit(turnParts(state().drawing, selected(), clockwise));
        },
        flip() {
            store.commit(flipParts(state().drawing, selected()));
        },
        nudge(by: Point) {
            if (state().selection.length > 0) {
                store.commit(moveItems(state().drawing, selected(), by));
            }
        },
        align(how: Alignment) {
            store.commit(alignParts(state().drawing, selected(), how));
        },
        selectAll() {
            const { drawing } = state();
            store.select([...drawing.parts.map((part) => part.id), ...drawing.lines.map((line) => line.id)]);
        },
        /** What's selected, as the clipboard's text, or null if nothing is. */
        copy(): string | null {
            const clip = copyItems(state().drawing, selected());
            return clip ? JSON.stringify(clip) : null;
        },
        cut(): string | null {
            const text = this.copy();
            if (text) {
                this.remove();
            }
            return text;
        },
        /** The clipboard's text pasted, if it's parts and lines copied from a drawing. */
        paste(text: string): boolean {
            const clip = readClip(text);
            if (clip) {
                paste(clip, text);
            }
            return clip !== null;
        },
        duplicate() {
            const text = this.copy();
            if (text) {
                paste(readClip(text)!, `${text}#${Date.now()}`);
            }
        },
        undo: () => store.undo(),
        redo: () => store.redo(),
        zoomBy(factor: number, around?: Point) {
            zoomTo(state().view.zoom * factor, around);
        },
        zoomTo,
        /** The whole drawing in view, at no more than 1.5 times its size. */
        fit() {
            frame(drawingBox(state().drawing) ?? { x0: -200, y0: -150, x1: 200, y1: 150 }, 1.5);
        },
        /** Parts and lines found (or picked in a list) shown, selected, in the middle of the view, with what's around
         * them: room enough to see where they are. */
        show(ids: string[]) {
            const box = drawingBox(state().drawing, new Set(ids));
            if (box) {
                frame({ x0: box.x0 - 120, y0: box.y0 - 80, x1: box.x1 + 120, y1: box.y1 + 80 }, 2);
                store.select(ids);
            }
        },
    };
}

/** The id of the toolbar's find box, which Ctrl+F (⌘F) goes to. */
export const FIND_BOX = "piper-find";

/** Whether a key or clipboard event is for a field being typed in, not the drawing. */
function typing(target: EventTarget | null): boolean {
    const element = target instanceof Element ? target : null;
    return !!element?.closest("input, textarea, select, [contenteditable='true'], .dialog-backdrop");
}

/**
 * The editor's keys, while its page is open and nothing's being typed: Delete, undo and redo, select all, duplicate,
 * find (Ctrl+F), turn (R), flip (F), nudge (arrows, Shift for five steps), zoom (+, -, 0 to fit), and copy, cut, and
 * paste.
 */
export function useEditorKeys(store: EditorStore, commands: Commands, enabled: boolean): void {
    useEffect(() => {
        if (!enabled) {
            return;
        }
        const keydown = (event: KeyboardEvent) => {
            if (typing(event.target) || event.defaultPrevented) {
                return;
            }
            const mod = event.ctrlKey || event.metaKey;
            const key = event.key.toLowerCase();
            const step = (event.shiftKey ? 5 : 1) * GRID;
            const handled = (() => {
                if (mod && key === "z") {
                    if (event.shiftKey) {
                        commands.redo();
                    } else {
                        commands.undo();
                    }
                } else if (mod && key === "y") {
                    commands.redo();
                } else if (mod && key === "a") {
                    commands.selectAll();
                } else if (mod && key === "d") {
                    commands.duplicate();
                } else if (mod && key === "f") {
                    // Find on the drawing, not the page: the browser's find can't move the drawing to what it finds.
                    document.getElementById(FIND_BOX)?.focus();
                } else if (mod) {
                    return false; // the browser's own (copy and paste come as their own events)
                } else if (key === "delete" || key === "backspace") {
                    commands.remove();
                } else if (key === "r") {
                    commands.turn(!event.shiftKey);
                } else if (key === "f") {
                    commands.flip();
                } else if (key === "arrowleft") {
                    commands.nudge({ x: -step, y: 0 });
                } else if (key === "arrowright") {
                    commands.nudge({ x: step, y: 0 });
                } else if (key === "arrowup") {
                    commands.nudge({ x: 0, y: -step });
                } else if (key === "arrowdown") {
                    commands.nudge({ x: 0, y: step });
                } else if (key === "+" || key === "=") {
                    commands.zoomBy(1.25);
                } else if (key === "-" || key === "_") {
                    commands.zoomBy(0.8);
                } else if (key === "0") {
                    commands.fit();
                } else if (key === "escape") {
                    if (store.getState().tool.mode !== "select") {
                        store.setTool({ mode: "select" });
                    } else {
                        store.select([]);
                    }
                } else if (key === "v") {
                    store.setTool({ mode: "select" });
                } else if (key === "l") {
                    store.setTool({ mode: "line" });
                } else {
                    return false;
                }
                return true;
            })();
            if (handled) {
                event.preventDefault();
            }
        };
        const copy = (event: ClipboardEvent) => {
            if (typing(event.target)) {
                return;
            }
            const text = event.type === "cut" ? commands.cut() : commands.copy();
            if (text) {
                event.clipboardData?.setData("text/plain", text);
                event.preventDefault();
            }
        };
        const paste = (event: ClipboardEvent) => {
            if (!typing(event.target) && commands.paste(event.clipboardData?.getData("text/plain") ?? "")) {
                event.preventDefault();
            }
        };
        document.addEventListener("keydown", keydown);
        document.addEventListener("copy", copy);
        document.addEventListener("cut", copy);
        document.addEventListener("paste", paste);
        return () => {
            document.removeEventListener("keydown", keydown);
            document.removeEventListener("copy", copy);
            document.removeEventListener("cut", copy);
            document.removeEventListener("paste", paste);
        };
    }, [store, commands, enabled]);
}
