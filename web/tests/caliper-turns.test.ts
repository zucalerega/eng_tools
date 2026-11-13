import { expect, test } from "vitest";
import { ApiError } from "../src/api";
import { inTurns, unlessBusy } from "../src/vault/caliper/turns";

// Taking turns with the server, which reads two SolidWorks files at a time: no more at once than it reads, and again
// after a wait while it's busy with others'. The waits are handed in, so nothing here waits on a clock.

/** Work that finishes when it's told to, and says when it started. */
function held(started: string[], name: string) {
    let finish!: () => void;
    const done = new Promise<string>((resolve) => (finish = () => resolve(name)));
    return {
        work: () => {
            started.push(name);
            return done;
        },
        finish: () => finish(),
    };
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("work runs no more than so many at a time, in the order it was asked for", async () => {
    const turn = inTurns(2);
    const started: string[] = [];
    const works = ["a", "b", "c", "d"].map((name) => held(started, name));
    const results = works.map((w) => turn(w.work));
    await settled();
    expect(started).toEqual(["a", "b"]);
    works[1]!.finish();
    await settled();
    expect(started).toEqual(["a", "b", "c"]);
    works[0]!.finish();
    works[2]!.finish();
    await settled();
    expect(started).toEqual(["a", "b", "c", "d"]);
    works[3]!.finish();
    expect(await Promise.all(results)).toEqual(["a", "b", "c", "d"]);

    // A refusal takes its turn too, and gives it up.
    const failing = turn(() => Promise.reject(new Error("no")));
    await expect(failing).rejects.toThrow("no");
    expect(await turn(() => Promise.resolve("after"))).toBe("after");
});

test("work the server is too busy for is tried again, waiting longer each time, and then refused", async () => {
    const busy = () => new ApiError(409, "busy", "The server is reading other SolidWorks files: try again in a minute");
    const waited: number[] = [];
    const wait = async (ms: number) => {
        waited.push(ms);
    };

    let tries = 0;
    const read = await unlessBusy(
        async () => {
            if (++tries < 3) {
                throw busy();
            }
            return "read";
        },
        [10, 20, 40],
        wait,
    );
    expect([read, tries, waited]).toEqual(["read", 3, [10, 20]]);

    // Past the last wait, its refusal stands; anything else stands at once.
    waited.length = 0;
    await expect(unlessBusy(() => Promise.reject(busy()), [10, 20], wait)).rejects.toThrow("try again in a minute");
    expect(waited).toEqual([10, 20]);
    waited.length = 0;
    const unreadable = new ApiError(422, "unreadable_file", "It isn't a SolidWorks part that Caliper can read");
    await expect(unlessBusy(() => Promise.reject(unreadable), [10, 20], wait)).rejects.toBe(unreadable);
    expect(waited).toEqual([]);
});
