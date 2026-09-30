import { act } from "@testing-library/react";
import { vi } from "vitest";
import { python } from "../src/yorg/scripts/python";
import type { FromPython, PythonTransport, ToPython } from "../src/yorg/scripts/sandbox";

// Python for the tests. jsdom can't run Pyodide, so the page's Python is a stand-in that says only what a test tells
// it to, and keeps what the page tells it: the page's side (the session, the page, the channels it hands over from the
// real server) is what's tested. worker.js and yorg.py run in the browser (see docs/design.md, Scripts).

export class FakePython implements PythonTransport {
    readonly received: ToPython[] = [];
    stopped = false;
    /** How it answers the editor's questions (suggestions, what a name is, syntax): with nothing, unless told. */
    services: (question: Extract<ToPython, { type: "service" }>) => unknown = () => null;
    private receiver: ((message: FromPython) => void) | null = null;

    start(receive: (message: FromPython) => void): void {
        this.receiver = receive;
    }

    post(message: ToPython): void {
        this.received.push(message);
        if (message.type === "service") {
            const value = this.services(message);
            queueMicrotask(() => this.receiver?.({ type: "answer", id: message.id, value }));
        } else if (message.type === "tools") {
            queueMicrotask(() => this.receiver?.({ type: "prepared" })); // the editor's suggestions: ready at once
        }
    }

    stop(): void {
        this.stopped = true;
        this.receiver = null;
    }

    /** Python says something to the page. */
    say(message: FromPython): void {
        act(() => this.receiver?.(message));
    }

    /** The last message of a kind the page sent, once it has (a warm-up waits for typing to pause). */
    async next<K extends ToPython["type"]>(type: K): Promise<Extract<ToPython, { type: K }>> {
        return vi.waitFor(
            () => {
                const found = this.received.filter((one) => one.type === type);
                if (!found.length) {
                    throw new Error(`The page hasn't sent Python a ${type} yet`);
                }
                return found[found.length - 1] as Extract<ToPython, { type: K }>;
            },
            { timeout: 10_000, interval: 25 },
        );
    }

    /** How many of a kind the page has sent. */
    count(type: ToPython["type"]): number {
        return this.received.filter((one) => one.type === type).length;
    }
}

/** The page's Python from now on: a new stand-in each time it starts. */
export function fakePython(): { all: FakePython[]; latest: () => FakePython } {
    const all: FakePython[] = [];
    python.reset(() => {
        const made = new FakePython();
        all.push(made);
        return made;
    });
    return { all, latest: () => all[all.length - 1]! };
}
