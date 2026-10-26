import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { piper, type ChangedDetails, type Diagram, type DiagramDetail, type Editing, type LockedDetails } from "./api";
import { readDocument } from "./drawing";
import type { EditorStore } from "./store";

// Saving as you go: a second after the last change, the drawing goes to the server with the version it was changed
// from. If someone saved the diagram since, the server says who, and saving stops until you choose: keep yours (saved
// over theirs, which stays in the history), save yours as a new diagram, or load theirs. If someone else is editing it
// now (an admin took it over, or it was let go while you were away and someone took it), the server says who, and
// saving stops: save yours as a new diagram, or load theirs.

export type SaveStatus = "saved" | "saving" | "unsaved" | "offline" | "changed" | "locked" | "deleted";

const SOON_MS = 1000;
const RETRY_MS = 5000;
// What the server says when it's the drawing it won't take (too big, or not a drawing): not worth sending again as is.
const REFUSED = new Set([400, 413, 422]);

export interface Saving {
    status: SaveStatus;
    changed: ChangedDetails | null; // who saved it after it was opened here
    locked: Editing | null; // who's editing it instead, when that's why it isn't saved
    problem: string | null;
    /** Whatever isn't saved yet, saved now: whether everything is, after. */
    saveNow: () => Promise<boolean>;
    keepMine: () => Promise<void>;
    loadTheirs: () => Promise<void>;
    /** After the server changed the drawing itself (a revision restored): this is its version now. */
    adopt: (detail: DiagramDetail) => void;
    /** After the diagram was restored: what wasn't saved while it was deleted is saved now. */
    resume: () => void;
}

export function useSaving(store: EditorStore, diagram: Diagram | null, onSaved: (diagram: Diagram) => void): Saving {
    const [status, setStatus] = useState<SaveStatus>("saved");
    const [changed, setChanged] = useState<ChangedDetails | null>(null);
    const [locked, setLocked] = useState<Editing | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const version = useRef(0);
    const saved = useRef(0); // the store's changes count when it was last saved
    const busy = useRef(false);
    const flight = useRef<Promise<void>>(Promise.resolve()); // the save under way, done when it is
    const halted = useRef(false); // stopped until a choice is made
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const id = diagram?.id ?? null;
    const saved_ = useRef(onSaved);
    saved_.current = onSaved;

    // A diagram opened: its version is where saves start from, and nothing in it is unsaved.
    useEffect(() => {
        if (diagram) {
            version.current = diagram.version;
            saved.current = store.getState().changes;
            halted.current = false;
            setStatus("saved");
            setChanged(null);
            setLocked(null);
        }
        // Only when another diagram's opened: a save gives the same one a new version, which save() keeps.
    }, [id]);

    const save = useCallback(
        async (fresh = false): Promise<boolean> => {
            clearTimeout(timer.current);
            if (id === null || busy.current || halted.current) {
                return id !== null && !halted.current && store.getState().changes === saved.current;
            }
            const { document, changes } = store.getState();
            if (changes === saved.current && !fresh) {
                setStatus("saved");
                return true;
            }
            busy.current = true;
            let landed = () => {};
            flight.current = new Promise((resolve) => (landed = resolve));
            setStatus("saving");
            try {
                const result = await piper.save(id, document, version.current, fresh);
                version.current = result.version;
                saved.current = changes;
                setProblem(null);
                saved_.current(result);
                if (store.getState().changes !== changes) {
                    setStatus("unsaved");
                    timer.current = setTimeout(() => void save(), SOON_MS / 2);
                    return false;
                }
                setStatus("saved");
                return true;
            } catch (error) {
                if (error instanceof ApiError && error.code === "changed") {
                    halted.current = true;
                    setChanged(error.details as unknown as ChangedDetails);
                    setStatus("changed");
                } else if (error instanceof ApiError && error.code === "locked") {
                    halted.current = true;
                    setLocked((error.details as unknown as LockedDetails).editing);
                    setStatus("locked");
                } else if (error instanceof ApiError && error.code === "deleted") {
                    // Deleted since it was opened: the page shows it as it is now, deleted, to restore if you can.
                    halted.current = true;
                    setStatus("deleted");
                    piper.diagram(id).then(saved_.current, () => {});
                } else if (error instanceof ApiError && REFUSED.has(error.status)) {
                    // The server won't take the drawing as it is (too big, say): sending it again won't change that,
                    // but the next change might, so that's saved as any change is.
                    setProblem(error.message);
                    setStatus("offline");
                } else {
                    // Out of reach, or signed out (signed in again in another tab, it's saved): tried again soon.
                    setProblem(error instanceof ApiError ? error.message : null);
                    setStatus("offline");
                    timer.current = setTimeout(() => void save(), RETRY_MS);
                }
                return false;
            } finally {
                busy.current = false;
                landed();
            }
        },
        [id, store],
    );

    // Each change: saved a second after the last.
    useEffect(
        () =>
            store.subscribe(() => {
                if (halted.current || store.getState().changes === saved.current) {
                    return;
                }
                setStatus((now) => (now === "saving" ? now : "unsaved"));
                clearTimeout(timer.current);
                timer.current = setTimeout(() => void save(), SOON_MS);
            }),
        [store, save],
    );

    // Leaving with changes not yet saved: the browser asks first. Leaving the page within the app saves them.
    useEffect(() => {
        const leaving = (event: BeforeUnloadEvent) => {
            if (store.getState().changes !== saved.current) {
                event.preventDefault();
            }
        };
        window.addEventListener("beforeunload", leaving);
        return () => {
            window.removeEventListener("beforeunload", leaving);
            clearTimeout(timer.current);
            if (!halted.current && store.getState().changes !== saved.current) {
                void save();
            }
        };
    }, [store, save]);

    return {
        status,
        changed,
        locked,
        problem,
        saveNow: async () => {
            await flight.current; // after the save under way, if one is
            return save();
        },
        keepMine: async () => {
            if (!changed) {
                return;
            }
            version.current = changed.version;
            halted.current = false;
            setChanged(null);
            await save(true); // a revision of its own, so theirs stays in the history whoever saved it
        },
        loadTheirs: async () => {
            if (id === null) {
                return;
            }
            const latest = await piper.diagram(id);
            store.load(readDocument(latest.drawing));
            version.current = latest.version;
            saved.current = store.getState().changes;
            halted.current = false;
            setChanged(null);
            setLocked(null);
            setStatus("saved");
            saved_.current(latest);
        },
        adopt: (detail: DiagramDetail) => {
            clearTimeout(timer.current);
            store.load(readDocument(detail.drawing));
            version.current = detail.version;
            saved.current = store.getState().changes;
            halted.current = false;
            setChanged(null);
            setLocked(null);
            setStatus("saved");
            saved_.current(detail);
        },
        resume: () => {
            if (status === "deleted") {
                halted.current = false;
                void save();
            }
        },
    };
}
