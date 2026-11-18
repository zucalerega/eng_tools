import { useSyncExternalStore } from "react";
import { api, ApiError, askClaude, type AnswerEvent, type Assistant, type ChatMessage } from "./api";
import type { Screenshot } from "./screenshots";

// Asking Claude, from Help in the top bar: the conversation in this tab, and Claude's answer as it's written. The tab
// keeps the conversation (sessionStorage), so it's still there after a reload or a look at the help page, for whoever
// had it: someone else signing in on the same tab, as on a lab computer, starts with none. The server keeps none of it,
// only what each answer cost (the assistant's budgets, and each person's daily limit).

/** How an answer is going: thinking before it writes, writing, and how it ended. */
export type AnswerState = "thinking" | "writing" | "done" | "cut" | "declined" | "stopped" | "failed";

export interface Exchange {
    question: string;
    page: string; // the page of the web app it was asked from
    screenshots?: Screenshot[]; // added to the question, for Claude to see
    answer: string;
    state: AnswerState;
    problem?: string; // why it failed
}

export interface ChatState {
    exchanges: Exchange[];
    assistant: Assistant | null; // whether Claude's there to ask: null until the server has said
    problem: string | null; // the server couldn't say
}

const KEPT = "yjsp.chat";
// What the server takes in one conversation (assistant.py): older exchanges than fit are left out of what Claude reads.
// It takes 150,000 characters in all, with up to 20,000 in the new question; and the first 300 of a page's address.
const MOST_MESSAGES = 40;
const MOST_CHARACTERS = 120_000;
const MOST_PAGE = 300;
// And up to 3 screenshots in a question, 6 in all: questions before that with more are left out too.
export const MOST_SCREENSHOTS_QUESTION = 3;
const MOST_SCREENSHOTS = 6;

const say = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A conversation as the tab keeps it: whose it is (their account's id), and its exchanges. */
interface Kept {
    owner: number;
    exchanges: Exchange[];
}

/**
 * The conversation the tab kept for this person, if it did: none if it's someone else's. An answer that was coming
 * when the page went is stopped.
 */
function restore(owner: number): Exchange[] {
    try {
        const kept = JSON.parse(sessionStorage.getItem(KEPT) ?? "null") as Kept | null;
        if (kept?.owner !== owner || !Array.isArray(kept.exchanges)) {
            forgetChat(); // someone else's: gone from the tab, not only from view
            return [];
        }
        return kept.exchanges.map((exchange) =>
            exchange.state === "thinking" || exchange.state === "writing"
                ? { ...exchange, state: "stopped" }
                : exchange,
        );
    } catch {
        return []; // nothing kept, or storage the browser won't let the page use
    }
}

function keep(kept: Kept): void {
    try {
        sessionStorage.setItem(KEPT, JSON.stringify(kept));
    } catch {
        // Storage full, as screenshots can fill it: the words are kept, and the screenshots last as long as the page.
        try {
            const words = kept.exchanges.map(({ screenshots: _, ...exchange }) => exchange);
            sessionStorage.setItem(KEPT, JSON.stringify({ ...kept, exchanges: words }));
        } catch {
            // blocked: the conversation lasts as long as the page, then
        }
    }
}

/** The tab forgets its conversation: on signing out, so the next person on a shared computer can't find it. */
export function forgetChat(): void {
    try {
        sessionStorage.removeItem(KEPT);
    } catch {
        // storage the browser won't let the page use: nothing was kept
    }
}

/**
 * What Claude reads before a question with `screenshots` of its own: the exchanges it answered, as questions and
 * answers. Answers that failed, were stopped, or were declined are left out, and so are the oldest when there are more
 * than a conversation holds.
 */
function conversation(exchanges: Exchange[], screenshots: number): ChatMessage[] {
    const answered = exchanges.filter((e) => (e.state === "done" || e.state === "cut") && e.answer.trim());
    const kept: ChatMessage[] = [];
    let characters = 0;
    for (const exchange of answered.reverse()) {
        characters += exchange.question.length + exchange.answer.length;
        screenshots += exchange.screenshots?.length ?? 0;
        if (kept.length + 3 > MOST_MESSAGES || characters > MOST_CHARACTERS || screenshots > MOST_SCREENSHOTS) {
            break;
        }
        kept.unshift(
            { role: "user", text: exchange.question, page: exchange.page, ...pictures(exchange.screenshots) },
            { role: "assistant", text: exchange.answer },
        );
    }
    return kept;
}

/** A question's screenshots, as it's sent: none, if it has none, so it reads as it did before there were any. */
const pictures = (screenshots: Screenshot[] | undefined) =>
    screenshots?.length ? { screenshots: screenshots.map((shot) => shot.data) } : {};

export class ChatStore {
    private state: ChatState = { exchanges: [], assistant: null, problem: null };
    private readonly listeners = new Set<() => void>();
    private controller: AbortController | null = null;
    private owner: number | null = null;
    // Which conversation this is: a new one (cleared, or someone else's) gets a new number, so that an answer still
    // coming to the last one never lands in it.
    private current = 0;

    /** Whose conversation it is: the one signed in. Someone else's goes, and theirs comes back if the tab kept it. */
    belongsTo(owner: number): void {
        if (owner !== this.owner) {
            this.stop();
            this.current += 1;
            this.owner = owner;
            this.set({ exchanges: restore(owner), assistant: null, problem: null });
        }
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getState = (): ChatState => this.state;

    /** Whether an answer is coming now. */
    get answering(): boolean {
        const last = this.state.exchanges.at(-1);
        return last?.state === "thinking" || last?.state === "writing";
    }

    /** Whether Claude's there to ask, and how much of your daily limit you've used: asked when Help opens. */
    async refresh(): Promise<void> {
        try {
            this.set({ assistant: await api.assistant(), problem: null });
        } catch (error) {
            this.set({ problem: say(error) });
        }
    }

    /** Ask Claude, with the conversation so far: its answer fills in as it's written. */
    async ask(question: string, page: string, screenshots: Screenshot[] = []): Promise<void> {
        const text = question.trim();
        if (!text || this.answering) {
            return;
        }
        // Kept as it's sent, as it goes back with each question after.
        const where = page.slice(0, MOST_PAGE);
        const shots = screenshots.length ? { screenshots } : {};
        const messages: ChatMessage[] = [
            ...conversation(this.state.exchanges, screenshots.length),
            { role: "user", text, page: where, ...pictures(screenshots) },
        ];
        const at = this.state.exchanges.length;
        this.exchanges([
            ...this.state.exchanges,
            { question: text, page: where, ...shots, answer: "", state: "thinking" },
        ]);
        const controller = new AbortController();
        this.controller = controller;
        const asked = this.current;
        const mine = () => asked === this.current; // still the conversation it was asked in
        try {
            const received = (event: AnswerEvent) => {
                if (mine()) {
                    this.received(at, event);
                }
            };
            await askClaude(messages, received, controller.signal);
            const now = this.state.exchanges[at]?.state;
            if (mine() && (now === "thinking" || now === "writing")) {
                this.change(at, { state: "failed", problem: "Claude's answer broke off: try again" });
            }
        } catch (error) {
            if (!mine()) {
                // started over meanwhile: nothing of this answer stays
            } else if (controller.signal.aborted) {
                this.change(at, { state: "stopped" });
            } else {
                this.change(at, { state: "failed", problem: say(error) });
                if (error instanceof ApiError && error.code.startsWith("assistant_")) {
                    void this.refresh(); // its budget, or your limit: Help says so from now on
                }
            }
        } finally {
            if (this.controller === controller) {
                this.controller = null;
            }
        }
    }

    /** Stop the answer that's coming: what it has written so far stays. */
    stop(): void {
        this.controller?.abort();
    }

    /** Ask a question again whose answer failed or was stopped: in its place, at the end of the conversation. */
    async again(at: number): Promise<void> {
        const exchange = this.state.exchanges[at];
        if (!exchange || this.answering) {
            return;
        }
        this.exchanges(this.state.exchanges.filter((_, index) => index !== at));
        await this.ask(exchange.question, exchange.page, exchange.screenshots);
    }

    /** Start over: the conversation so far goes. */
    clear(): void {
        this.stop();
        this.current += 1;
        this.exchanges([]);
    }

    private received(at: number, event: AnswerEvent): void {
        const exchange = this.state.exchanges[at];
        if (!exchange) {
            return;
        }
        if (event.type === "text") {
            this.change(at, { answer: exchange.answer + event.text, state: "writing" });
        } else if (event.type === "done") {
            // Declined: whatever it wrote before it stopped isn't an answer.
            const state =
                event.stop_reason === "refusal" ? "declined" : event.stop_reason === "max_tokens" ? "cut" : "done";
            this.change(at, { state, answer: state === "declined" ? "" : exchange.answer });
            if (this.state.assistant) {
                this.set({ assistant: { ...this.state.assistant, day_used: event.day_used } });
            }
        } else if (event.type === "error") {
            this.change(at, { state: "failed", problem: event.message });
        }
        // "thinking": it still is, as the answer already says
    }

    private change(at: number, change: Partial<Exchange>): void {
        this.exchanges(
            this.state.exchanges.map((exchange, index) => (index === at ? { ...exchange, ...change } : exchange)),
        );
    }

    private exchanges(exchanges: Exchange[]): void {
        this.set({ exchanges });
        if (this.owner !== null) {
            keep({ owner: this.owner, exchanges });
        }
    }

    private set(change: Partial<ChatState>): void {
        this.state = { ...this.state, ...change };
        this.listeners.forEach((listener) => listener());
    }
}

/** The conversation with Claude, as it is now. */
export function useChat(chat: ChatStore): ChatState {
    return useSyncExternalStore(chat.subscribe, chat.getState);
}
