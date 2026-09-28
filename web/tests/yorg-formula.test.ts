import { describe, expect, test } from "vitest";
import { calculate, channelsOf, FormulaError, parse, type Input } from "../src/yorg/formula";
import { Samples } from "../src/yorg/samples";

// Calculated channels: reading expressions, and working them out over channels that may not share their times.

const channel = (times: number[], values: number[], step = false): Input => ({
    samples: new Samples(new Float64Array(times), new Float64Array(values)),
    step,
});

function run(expression: string, inputs: Record<string, Input>): (number | null)[] {
    const result = calculate(parse(expression), new Map(Object.entries(inputs)));
    return [...result.values].map((value) => (Number.isNaN(value) ? null : Number(value.toFixed(10))));
}

function problem(expression: string): string {
    try {
        parse(expression);
    } catch (error) {
        if (error instanceof FormulaError) {
            return error.message;
        }
        throw error;
    }
    return "no problem";
}

describe("reading expressions", () => {
    test("channels in brackets, or plain names; functions, constants, and time", () => {
        expect(channelsOf(parse("[LC-1] + LC2 * 2 + t * g0 - abs([LC-1])"))).toEqual(["LC-1", "LC2"]);
        expect(channelsOf(parse("[ PT OX 01 ] × 2 ÷ [B] − 1"))).toEqual(["PT OX 01", "B"]); // pasted symbols
    });

    test("saying what's wrong, and where", () => {
        expect(problem("")).toBe("Write an expression, like [LC-1] + [LC-2]");
        expect(problem("[LC-1 + 2")).toBe("A [ without its ]: channel names go in brackets, like [PT-1]");
        expect(problem("abs([A]")).toBe("Expected ) to close abs( at the end");
        expect(problem("foo([A])")).toBe("There's no function called foo");
        expect(problem("log([A])")).toBe("log could mean ln or log10: say which");
        expect(problem("[A] [B]")).toBe("Expected an operator (like + or *) before B");
        expect(problem("where([A] > 1)")).toBe("where(test, value) takes 2 values");
        expect(problem("[A] + * 2")).toBe("Expected a value before *");
        expect(problem("[A] % 2")).toBe("% doesn't mean anything here");
        try {
            parse("[A] + (2");
        } catch (error) {
            expect((error as FormulaError).at).toBe(8);
        }
    });
});

describe("working them out", () => {
    const times = [0, 1, 2, 3, 4];
    const a = channel(times, [1, 2, 3, 4, 5]);

    test("arithmetic, in the usual order", () => {
        expect(run("2 + 3 * [A] ^ 2", { A: a })).toEqual([5, 14, 29, 50, 77]);
        expect(run("-[A]^2", { A: a })).toEqual([-1, -4, -9, -16, -25]);
        expect(run("[A] * 2^-1", { A: a })).toEqual([0.5, 1, 1.5, 2, 2.5]);
        expect(run("([A] + 1) / 2", { A: a })).toEqual([1, 1.5, 2, 2.5, 3]);
        expect(run("[A] > 2", { A: a })).toEqual([0, 0, 1, 1, 1]);
        expect(run("t * 10 + [A]", { A: a })).toEqual([1, 12, 23, 34, 45]);
    });

    test("dividing by zero leaves a gap, not an infinite value", () => {
        expect(run("1 / ([A] - 3)", { A: a })).toEqual([-0.5, -1, null, 1, 0.5]);
    });

    test("where and if: O/F only while fuel flows", () => {
        const ox = channel(times, [0, 2, 3, 3, 0.1]);
        const fuel = channel(times, [0, 1, 1.5, 1.2, 0]);
        expect(run("where([FU] > 0.05, [OX] / [FU])", { OX: ox, FU: fuel })).toEqual([null, 2, 2, 2.5, null]);
        expect(run("if([FU] > 0.05, [OX] / [FU], -1)", { OX: ox, FU: fuel })).toEqual([-1, 2, 2, 2.5, -1]);
    });

    test("channels on other times are read between their samples, or are missing outside them", () => {
        const slow = channel([1, 3], [10, 30]);
        expect(run("[A] + [S]", { A: a, S: slow })).toEqual([null, 12, 23, 34, null]);
        // A state holds its value until the next sample.
        const valve = channel([1, 3], [0, 1], true);
        expect(run("[A] * [V]", { A: a, V: valve })).toEqual([null, 0, 0, 4, null]);
        // The channel with the most samples sets the times.
        expect(
            calculate(
                parse("[S] + [A]"),
                new Map([
                    ["S", slow],
                    ["A", a],
                ]),
            ).times,
        ).toEqual(new Float64Array(times));
    });

    test("min, max, and avg leave out missing values: two sensors, one dropping out", () => {
        const one = channel(times, [1, NaN, 3, 4, 5]);
        const two = channel(times, [3, 4, NaN, 6, 7]);
        expect(run("avg([P1], [P2])", { P1: one, P2: two })).toEqual([2, 4, 3, 5, 6]);
        expect(run("max([P1], [P2])", { P1: one, P2: two })).toEqual([3, 4, 3, 6, 7]);
        expect(run("min([P1], [P2], 2)", { P1: one, P2: two })).toEqual([1, 2, 2, 2, 2]);
    });

    test("rates of change, integrals, and smoothing, in seconds", () => {
        const square = channel(times, [0, 1, 4, 9, 16]);
        expect(run("ddt([Q])", { Q: square })).toEqual([1, 2, 4, 6, 7]);
        expect(run("integral([A] * 0 + 2)", { A: a })).toEqual([0, 2, 4, 6, 8]); // 2 lbf for 4 s: 8 lbf·s
        expect(run("smooth([Q], 2)", { Q: square })).toEqual(
            [0.5, 5 / 3, 14 / 3, 29 / 3, 12.5].map((v) => Number(v.toFixed(10))),
        );
    });

    test("an expression needs a channel, and one this dataset has", () => {
        expect(() => calculate(parse("1 + 2"), new Map())).toThrow("Use at least one channel, like [PT-1]");
        expect(() => calculate(parse("[LC-9] * 2"), new Map([["A", a]]))).toThrow("No channel called LC-9");
        expect(() => run("smooth([A], [A])", { A: a })).toThrow("smooth's window is a number of seconds");
    });
});
