import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { piper, type Diagram, type Editing, type LockedDetails } from "./api";
import type { Saving } from "./saving";

// One person edits a diagram at a time. It opens to be looked at; Edit makes it yours to change (the server holds it
// for you, and refuses anyone else's save), and Done editing lets it go. While it's yours, the editor tells the server
// you're still at it every minute, unless nothing's been done in it for a quarter of an hour: the server lets go of a
// diagram it hasn't heard about in ten minutes, so a tab left open, a laptop shut, or a browser that crashed doesn't
// keep it from everyone. Back at it, you go on editing if no one else has started. While it's only looked at, what's
// saved shows every 20 seconds or so, and as soon as you come back to the tab.

const STILL_HERE_MS = 60_000;
const AWAY_MS = 15 * 60_000;
const LOOK_MS = 20_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface EditLock {
    mine: boolean; // it's being edited here
    busy: boolean; // starting or finishing
    taken: Editing | null; // who's editing it instead, when that's why it stopped being yours
    problem: string | null; // why Edit or Done editing didn't work
    /** Edit: yours to change, if no one else is editing it (force: an admin taking it over). */
    start: (force?: boolean) => Promise<void>;
    /** Done editing: what isn't saved is saved, then it's let go. */
    stop: () => Promise<void>;
    /** Someone else is editing it now (saving was refused): it's only looked at here. told: they're named in a banner
     * of their own (else whatever refused it says so). */
    lose: (to: Editing | null, told?: boolean) => void;
    dismiss: () => void;
}

export function useEditLock(diagram: Diagram | null, saving: Saving, onDiagram: (diagram: Diagram) => void): EditLock {
    const [mine, setMine] = useState(false);
    const [busy, setBusy] = useState(false);
    const [taken, setTaken] = useState<Editing | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const id = diagram?.id ?? null;
    // What the timers and listeners read: the latest, whenever they run.
    const latest = useRef({ diagram, saving, onDiagram, mine });
    latest.current = { diagram, saving, onDiagram, mine };
    const active = useRef(Date.now()); // when something was last done here
    const said = useRef(0); // when the server was last told you're still at it

    /** The diagram as it is now, from the server: its drawing too, if it's been saved since it was loaded here. */
    async function catchUp(found: Diagram) {
        const now = latest.current;
        if (!now.diagram || found.version === now.diagram.version) {
            now.onDiagram(found);
        } else if (now.saving.status === "saved") {
            now.saving.adopt(await piper.diagram(found.id));
        } else {
            noteEditing(found); // changes here aren't saved: they stay until it's chosen what becomes of them
        }
    }

    /** Only who's editing it, from what the server said: saves here keep the rest of it current. */
    function noteEditing(found: Diagram) {
        const now = latest.current.diagram;
        if (now) {
            latest.current.onDiagram({ ...now, editing: found.editing ?? null });
        }
    }

    function lose(to: Editing | null, told = true) {
        setMine(false);
        setTaken(told ? to : null);
        const now = latest.current.diagram;
        if (now && to) {
            noteEditing({ ...now, editing: to });
        }
    }

    async function start(force = false) {
        if (id === null) {
            return;
        }
        setBusy(true);
        setProblem(null);
        try {
            const got = await piper.edit(id, force);
            said.current = active.current = Date.now();
            await catchUp(got);
            setTaken(null);
            setMine(true);
        } catch (error) {
            if (error instanceof ApiError && error.code === "locked" && latest.current.diagram) {
                noteEditing({
                    ...latest.current.diagram,
                    editing: (error.details as unknown as LockedDetails).editing,
                });
            }
            setProblem(message(error));
        } finally {
            setBusy(false);
        }
    }

    async function stop() {
        if (id === null) {
            return;
        }
        setBusy(true);
        setProblem(null);
        try {
            if (!(await latest.current.saving.saveNow())) {
                setProblem("Your last change isn't saved yet: it's still yours to edit until it is.");
                return;
            }
            setMine(false);
            noteEditing(await piper.doneEditing(id));
        } catch (error) {
            setProblem(message(error));
        } finally {
            setBusy(false);
        }
    }

    // Another diagram opened: it's looked at, to begin with.
    useEffect(() => {
        setMine(false);
        setTaken(null);
        setProblem(null);
    }, [id]);

    // While it's yours: telling the server you're still at it, every minute you're about, and as soon as you're back.
    useEffect(() => {
        if (id === null || !mine) {
            return;
        }
        let renewing = false;
        const renew = async () => {
            if (renewing) {
                return;
            }
            renewing = true;
            try {
                noteEditing(await piper.edit(id));
                said.current = Date.now();
            } catch (error) {
                if (error instanceof ApiError && error.code === "locked") {
                    lose((error.details as unknown as LockedDetails).editing);
                } else if (error instanceof ApiError && error.code === "deleted") {
                    setMine(false);
                    piper.diagram(id).then(latest.current.onDiagram, () => {});
                }
                // Out of reach: said again next time.
            } finally {
                renewing = false;
            }
        };
        const busyHere = () => {
            active.current = Date.now();
            if (active.current - said.current >= STILL_HERE_MS) {
                void renew(); // back after a while: still yours, if no one else has started
            }
        };
        const timer = setInterval(() => {
            if (Date.now() - active.current < AWAY_MS) {
                void renew();
            }
        }, STILL_HERE_MS);
        // The page closed (or put away by the browser to come back to): let go now, not ten minutes from now.
        const leaving = () => piper.doneEditingAsLeaving(id);
        const back = (event: PageTransitionEvent) => {
            if (event.persisted) {
                void renew();
            }
        };
        const events = ["pointerdown", "keydown", "wheel"] as const;
        events.forEach((name) => window.addEventListener(name, busyHere, { capture: true, passive: true }));
        window.addEventListener("pagehide", leaving);
        window.addEventListener("pageshow", back);
        return () => {
            clearInterval(timer);
            events.forEach((name) => window.removeEventListener(name, busyHere, { capture: true }));
            window.removeEventListener("pagehide", leaving);
            window.removeEventListener("pageshow", back);
        };
    }, [id, mine]);

    // Left for another page of the app while editing it: let go.
    useEffect(() => {
        if (id === null) {
            return;
        }
        return () => {
            if (latest.current.mine) {
                piper.doneEditingAsLeaving(id);
            }
        };
    }, [id]);

    // While it's only looked at: who's editing it, and what they've saved, now and then and on coming back to it.
    const deleted = diagram?.deleted_at != null;
    useEffect(() => {
        if (id === null || mine || deleted) {
            return;
        }
        const look = () => {
            if (document.visibilityState === "visible") {
                piper.editing(id).then(catchUp, () => {}); // out of reach: looked again soon
            }
        };
        const timer = setInterval(look, LOOK_MS);
        document.addEventListener("visibilitychange", look);
        window.addEventListener("focus", look);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", look);
            window.removeEventListener("focus", look);
        };
    }, [id, mine, deleted]);

    return { mine, busy, taken, problem, start, stop, lose, dismiss: () => setTaken(null) };
}
