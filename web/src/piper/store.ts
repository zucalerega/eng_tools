import { useSyncExternalStore } from "react";
import { emptyDocument, pageOf, withPage, type Document, type Drawing, type Point } from "./drawing";
import type { Box } from "./geometry";
import type { Guide } from "./snap";

// The editor's state: the diagram's drawing (its document, all its pages), the page being worked on (as a drawing),
// what's selected, the view, and, while something's dragged, what the page would be if it were dropped now (shown),
// with the guides it snapped to and where a line would go. A change is committed once (a drag, when it's dropped),
// which is what undo goes back through (pages added, renamed, or deleted too) and what's saved.

export type Tool = { mode: "select" } | { mode: "place"; preset: string } | { mode: "line" };

/** What the canvas shows: the drawing's point at its top left, and how many pixels a unit is. */
export interface View {
    x: number;
    y: number;
    zoom: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;
const HISTORY = 200;

/** Where a line being drawn would end, highlighted: a port, a point on a line, or a point of its own. */
export type Aim =
    | { kind: "port"; part: string; port: string; at: Point }
    | { kind: "line"; line: string; at: Point }
    | { kind: "point"; at: Point };

export interface EditorState {
    document: Document; // the drawing as it's saved: all its pages
    page: number; // which of them is being worked on
    drawing: Drawing; // that page, as it is
    shown: Drawing; // what's drawn: the drawing, or what a drag would make of it
    selection: string[]; // parts' and lines' ids
    view: View;
    size: { width: number; height: number }; // the canvas's, in pixels
    tool: Tool;
    guides: Guide[]; // what a drag snapped to
    aim: Aim | null; // where a line being drawn would end
    sketch: Point[] | null; // the line being drawn, end to end
    into: string | null; // the line a part being dragged would go into
    marquee: Box | null; // the box being dragged out to select what's in it
    canUndo: boolean;
    canRedo: boolean;
    changes: number; // counts committed changes: what saving watches
}

export class EditorStore {
    private state: EditorState;
    private readonly listeners = new Set<() => void>();
    private readonly undos: Step[] = [];
    private readonly redos: Step[] = [];
    private merging: { key: string; at: number } | null = null;

    constructor(document: Document = emptyDocument()) {
        const drawing = pageOf(document, 0);
        this.state = {
            document,
            page: 0,
            drawing,
            shown: drawing,
            selection: [],
            view: { x: -100, y: -100, zoom: 1 },
            size: { width: 800, height: 600 },
            tool: { mode: "select" },
            guides: [],
            aim: null,
            sketch: null,
            into: null,
            marquee: null,
            canUndo: false,
            canRedo: false,
            changes: 0,
        };
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getState = (): EditorState => this.state;

    /** A drawing to start from, with nothing to undo: the diagram as it was opened, or another loaded in its place,
     * at the page it was at (or its last, if it has fewer now). */
    load(document: Document): void {
        this.undos.length = 0;
        this.redos.length = 0;
        const page = Math.min(this.state.page, document.pages.length - 1);
        const drawing = pageOf(document, page);
        const ids = new Set([...drawing.parts.map((part) => part.id), ...drawing.lines.map((line) => line.id)]);
        this.set({
            document,
            page,
            drawing,
            shown: drawing,
            selection: this.state.selection.filter((id) => ids.has(id)),
            canUndo: false,
            canRedo: false,
            ...CLEAR,
        });
    }

    /** Another page to work on: nothing selected on it yet. */
    setPage(page: number): void {
        const index = Math.min(Math.max(0, page), this.state.document.pages.length - 1);
        if (index === this.state.page) {
            return;
        }
        const drawing = pageOf(this.state.document, index);
        this.set({ page: index, drawing, shown: drawing, selection: [], ...CLEAR });
    }

    /** A change to the pages themselves (added, renamed, moved, deleted), undone as any change is: at `page` after. */
    commitDocument(document: Document, page = this.state.page): void {
        this.remember();
        const index = Math.min(Math.max(0, page), document.pages.length - 1);
        const drawing = pageOf(document, index);
        this.set({
            document,
            page: index,
            drawing,
            shown: drawing,
            selection: index === this.state.page ? this.state.selection : [],
            canUndo: true,
            canRedo: false,
            changes: this.state.changes + 1,
            ...CLEAR,
        });
    }

    private remember() {
        this.merging = null;
        this.undos.push({ document: this.state.document, page: this.state.page });
        if (this.undos.length > HISTORY) {
            this.undos.shift();
        }
        this.redos.length = 0;
    }

    /**
     * A change made: what undo goes back to, and what's saved. selection: what to select after it. merge: changes with
     * the same key (typing in one field), each within a couple of seconds of the last, undo as one.
     */
    commit(drawing: Drawing, selection?: string[], merge?: string): void {
        if (drawing === this.state.drawing) {
            this.set({ shown: drawing, ...CLEAR, ...(selection ? { selection } : {}) });
            return;
        }
        const now = Date.now();
        const merging = merge !== undefined && this.merging?.key === merge && now - this.merging.at < 2000;
        this.merging = merge === undefined ? null : { key: merge, at: now };
        if (!merging) {
            this.undos.push({ document: this.state.document, page: this.state.page });
            if (this.undos.length > HISTORY) {
                this.undos.shift();
            }
        }
        this.redos.length = 0;
        this.set({
            document: withPage(this.state.document, this.state.page, drawing),
            drawing,
            shown: drawing,
            selection: selection ?? this.state.selection,
            canUndo: this.undos.length > 0,
            canRedo: false,
            changes: this.state.changes + 1,
            ...CLEAR,
        });
    }

    /** What a drag would make of the drawing, shown until it's dropped (commit) or let go of (cancel). */
    preview(shown: Drawing, extras: Partial<Pick<EditorState, "guides" | "aim" | "sketch" | "into" | "marquee">> = {}) {
        this.set({ shown, ...CLEAR, ...extras });
    }

    /** A drag let go of: the drawing as it was. */
    cancel(): void {
        this.set({ shown: this.state.drawing, ...CLEAR });
    }

    undo(): void {
        this.merging = null;
        const before = this.undos.pop();
        if (!before) {
            return;
        }
        this.redos.push({ document: this.state.document, page: this.state.page });
        this.travel(before);
    }

    redo(): void {
        const after = this.redos.pop();
        if (!after) {
            return;
        }
        this.undos.push({ document: this.state.document, page: this.state.page });
        this.travel(after);
    }

    private travel({ document, page }: Step) {
        const drawing = pageOf(document, page);
        const ids = new Set([...drawing.parts.map((part) => part.id), ...drawing.lines.map((line) => line.id)]);
        this.set({
            document,
            page,
            drawing,
            shown: drawing,
            selection: this.state.selection.filter((id) => ids.has(id)),
            canUndo: this.undos.length > 0,
            canRedo: this.redos.length > 0,
            changes: this.state.changes + 1,
            ...CLEAR,
        });
    }

    select(selection: string[]): void {
        if (
            selection.length !== this.state.selection.length ||
            selection.some((id, i) => id !== this.state.selection[i])
        ) {
            this.set({ selection });
        }
    }

    setView(view: View): void {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom));
        this.set({ view: { ...view, zoom } });
    }

    setSize(size: { width: number; height: number }): void {
        if (size.width !== this.state.size.width || size.height !== this.state.size.height) {
            this.set({ size });
        }
    }

    setTool(tool: Tool): void {
        this.set({ tool, ...CLEAR, shown: this.state.drawing });
    }

    private set(change: Partial<EditorState>) {
        this.state = { ...this.state, ...change };
        this.listeners.forEach((listener) => listener());
    }
}

const CLEAR = { guides: [], aim: null, sketch: null, into: null, marquee: null } satisfies Partial<EditorState>;

/** What undo goes back to: the document as it was, and the page it was at. */
interface Step {
    document: Document;
    page: number;
}

export function useEditor<T>(store: EditorStore, pick: (state: EditorState) => T): T {
    return useSyncExternalStore(store.subscribe, () => pick(store.getState()));
}
