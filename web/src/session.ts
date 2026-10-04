import { createContext, useContext, useSyncExternalStore } from "react";
import { api, ApiError, signIn, type Account } from "./api";

// Who's signed in, for both apps: loaded when the page opens, then asked again every minute while it's visible. That
// also tells the server you're on (Admin > People), which notes a session's use at most once a minute.

export interface SessionState {
    me: Account | null;
}

export class SessionStore {
    private state: SessionState = { me: null };
    private readonly listeners = new Set<() => void>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private running = false;
    private pending: Promise<void> | null = null;

    constructor(private readonly pollMs = 60_000) {}

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getState = (): SessionState => this.state;

    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        document.addEventListener("visibilitychange", this.catchUp);
        void this.load();
    }

    stop(): void {
        this.running = false;
        clearTimeout(this.timer);
        document.removeEventListener("visibilitychange", this.catchUp);
    }

    /** You, as the server has you now: after you changed your name, say. */
    updateMe(me: Account): void {
        this.set({ me });
    }

    /** Ask the server who you are, now (once, however many ask at the same time). */
    refresh(): Promise<void> {
        this.pending ??= this.fetch().finally(() => (this.pending = null));
        return this.pending;
    }

    private catchUp = () => {
        if (!document.hidden) {
            void this.refresh();
        }
    };

    private async load() {
        await this.refresh();
        this.poll();
    }

    private poll() {
        clearTimeout(this.timer);
        if (!this.running) {
            return;
        }
        this.timer = setTimeout(async () => {
            if (!document.hidden) {
                await this.refresh();
            }
            this.poll();
        }, this.pollMs);
    }

    private async fetch() {
        try {
            const me = await api.me();
            if (JSON.stringify(me) !== JSON.stringify(this.state.me)) {
                this.set({ me });
            }
        } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
                signIn(); // signed out in another tab, or the session expired
            }
            // Otherwise the server's out of reach for now: keep who you were, and try again at the next poll.
        }
    }

    private set(change: Partial<SessionState>) {
        this.state = { ...this.state, ...change };
        this.listeners.forEach((listener) => listener());
    }
}

export const SessionContext = createContext<SessionStore | null>(null);

export function useSessionStore(): SessionStore {
    const store = useContext(SessionContext);
    if (!store) {
        throw new Error("useSessionStore needs a SessionContext");
    }
    return store;
}

/** Who you are, for both apps: null until the server has said. */
export function useSession(): SessionState {
    const store = useSessionStore();
    return useSyncExternalStore(store.subscribe, store.getState);
}
