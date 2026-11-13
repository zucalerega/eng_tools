import { ApiError } from "../../api";

// Taking turns with the server, which reads two SolidWorks files at a time (vault.py, _READING): a page asks it to
// read only as many at once, and asks again, after a wait, when it's busy with others'.

/** Run work no more than `at` at a time, in the order it's asked for. */
export function inTurns(at: number): <T>(work: () => Promise<T>) => Promise<T> {
    let running = 0;
    const waiting: (() => void)[] = [];
    return async <T>(work: () => Promise<T>): Promise<T> => {
        if (running >= at) {
            await new Promise<void>((go) => waiting.push(go));
        } else {
            running++;
        }
        try {
            return await work();
        } finally {
            const next = waiting.shift();
            if (next) {
                next(); // its turn: the count stays as it is
            } else {
                running--;
            }
        }
    };
}

// How long to wait before each try again while the server is busy: about three minutes in all.
export const BUSY_WAITS = [2, 4, 8, 15, 30, 30, 30, 30, 30].map((seconds) => seconds * 1000);

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Work, tried again while the server says it's busy (409 busy: reading other SolidWorks files), waiting longer each
 * time; past the last wait, its refusal stands. Anything else it says stands at once.
 */
export async function unlessBusy<T>(
    work: () => Promise<T>,
    waits: readonly number[] = BUSY_WAITS,
    wait: (ms: number) => Promise<void> = pause,
): Promise<T> {
    for (let tried = 0; ; tried++) {
        try {
            return await work();
        } catch (error) {
            if (!(error instanceof ApiError && error.code === "busy") || tried >= waits.length) {
                throw error;
            }
            await wait(waits[tried]!);
        }
    }
}
