import { lowerBound, Samples } from "./samples";

// Calculated channels: an expression over a dataset's channels, worked out sample by sample.
//
//   [LC-1] + [LC-2]                              channels by name, in brackets (plain names can go without: LC1 + LC2)
//   where([FM-FU] > 0.05, [FM-OX] / [FM-FU])      O/F, only while fuel flows
//   integral([LC-THRUST])                        total impulse
//
// + - * / ^ and ( ), and comparisons (< > <= >= == !=), which give 1 or 0. Functions: abs sqrt exp ln log10 sin cos tan
// round floor ceil; min max avg, of any number of values; if(test, a, b) and where(test, x) (x where test holds, else
// nothing); and(...), or(...), not(test), and between(x, low, high), for tests (masks: a valve open, a redline);
// ddt(x), the rate of change per second; integral(x), from the first sample; smooth(x, seconds), the average over that
// long around each sample. Constants: pi, e, and g0 (9.80665). t is each sample's time, in seconds.
//
// The channels are lined up on the times of the one with the most samples. The others are read between their samples
// (on a straight line; states hold their value), and are missing outside their samples or across a pause in logging.

export class FormulaError extends Error {
    constructor(
        message: string,
        readonly at: number, // where in the expression (from 0), for pointing at it
    ) {
        super(message);
    }
}

type Comparison = "<" | ">" | "<=" | ">=" | "==" | "!=";
type Operator = "+" | "-" | "*" | "/" | "^" | Comparison;

export type Node =
    | { kind: "number"; value: number; at: number }
    | { kind: "channel"; name: string; at: number }
    | { kind: "time"; at: number }
    | { kind: "negate"; arg: Node; at: number }
    | { kind: "operator"; op: Operator; left: Node; right: Node; at: number }
    | { kind: "call"; name: string; args: Node[]; at: number };

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, g0: 9.80665 };

const MATH: Record<string, (x: number) => number> = {
    abs: Math.abs,
    sqrt: Math.sqrt,
    exp: Math.exp,
    ln: Math.log,
    log10: Math.log10,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
};

/** How many arguments each function takes: [at least, at most]. */
const ARGUMENTS: Record<string, [number, number]> = {
    ...Object.fromEntries(Object.keys(MATH).map((name) => [name, [1, 1] as [number, number]])),
    min: [1, 50],
    max: [1, 50],
    avg: [1, 50],
    if: [3, 3],
    where: [2, 2],
    and: [2, 50],
    or: [2, 50],
    not: [1, 1],
    between: [3, 3],
    ddt: [1, 1],
    integral: [1, 1],
    smooth: [2, 2],
};

const USAGE: Record<string, string> = {
    if: "if(test, value, otherwise)",
    where: "where(test, value)",
    smooth: "smooth(value, seconds)",
    not: "not(test)",
    between: "between(value, low, high)",
};

// --- reading an expression ----------------------------------------------------------------------------------------

interface Token {
    kind: "number" | "name" | "channel" | "symbol" | "end";
    text: string;
    at: number;
}

const SYMBOLS = ["<=", ">=", "==", "!=", "<", ">", "+", "-", "*", "/", "^", "(", ")", ","];
// Symbols as people paste them from elsewhere.
const LOOKALIKES: Record<string, string> = { "×": "*", "÷": "/", "−": "-", "·": "*" };

function tokens(text: string): Token[] {
    const found: Token[] = [];
    let i = 0;
    while (i < text.length) {
        const rest = text.slice(i);
        const space = /^\s+/.exec(rest);
        if (space) {
            i += space[0].length;
            continue;
        }
        const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest);
        if (number) {
            found.push({ kind: "number", text: number[0], at: i });
            i += number[0].length;
            continue;
        }
        if (rest[0] === "[") {
            const close = rest.indexOf("]");
            if (close < 0) {
                throw new FormulaError("A [ without its ]: channel names go in brackets, like [PT-1]", i);
            }
            const name = rest.slice(1, close).trim();
            if (!name) {
                throw new FormulaError("Empty brackets: put a channel's name in them, like [PT-1]", i);
            }
            found.push({ kind: "channel", text: name, at: i });
            i += close + 1;
            continue;
        }
        const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
        if (name) {
            found.push({ kind: "name", text: name[0], at: i });
            i += name[0].length;
            continue;
        }
        const symbol = SYMBOLS.find((one) => rest.startsWith(one)) ?? LOOKALIKES[rest[0]!];
        if (symbol) {
            found.push({ kind: "symbol", text: symbol, at: i });
            i += SYMBOLS.includes(symbol) && rest.startsWith(symbol) ? symbol.length : 1;
            continue;
        }
        throw new FormulaError(`${rest[0]} doesn't mean anything here`, i);
    }
    found.push({ kind: "end", text: "", at: text.length });
    return found;
}

/** An expression, read into a tree: throws FormulaError, saying where, if it can't be. */
export function parse(text: string): Node {
    const list = tokens(text);
    let position = 0;
    const peek = () => list[position]!;
    const next = () => list[position++]!;
    const isSymbol = (...symbols: string[]) => peek().kind === "symbol" && symbols.includes(peek().text);
    const expect = (symbol: string, what: string) => {
        if (!isSymbol(symbol)) {
            const here = peek();
            throw new FormulaError(
                `Expected ${what}${here.kind === "end" ? " at the end" : ` before ${here.text}`}`,
                here.at,
            );
        }
        next();
    };

    function comparison(): Node {
        const left = sum();
        if (isSymbol("<", ">", "<=", ">=", "==", "!=")) {
            const token = next();
            return { kind: "operator", op: token.text as Comparison, left, right: sum(), at: token.at };
        }
        return left;
    }
    function sum(): Node {
        let left = product();
        while (isSymbol("+", "-")) {
            const token = next();
            left = { kind: "operator", op: token.text as "+" | "-", left, right: product(), at: token.at };
        }
        return left;
    }
    function product(): Node {
        let left = unary();
        while (isSymbol("*", "/")) {
            const token = next();
            left = { kind: "operator", op: token.text as "*" | "/", left, right: unary(), at: token.at };
        }
        return left;
    }
    function unary(): Node {
        if (isSymbol("-")) {
            const token = next();
            return { kind: "negate", arg: unary(), at: token.at };
        }
        if (isSymbol("+")) {
            next();
            return unary();
        }
        return power();
    }
    function power(): Node {
        const base = primary();
        if (isSymbol("^")) {
            const token = next();
            return { kind: "operator", op: "^", left: base, right: unary(), at: token.at };
        }
        return base;
    }
    function primary(): Node {
        const token = next();
        switch (token.kind) {
            case "number":
                return { kind: "number", value: Number(token.text), at: token.at };
            case "channel":
                return { kind: "channel", name: token.text, at: token.at };
            case "name": {
                const lower = token.text.toLowerCase();
                if (isSymbol("(")) {
                    const limits = ARGUMENTS[lower];
                    if (!limits) {
                        throw new FormulaError(
                            lower === "log"
                                ? "log could mean ln or log10: say which"
                                : `There's no function called ${token.text}`,
                            token.at,
                        );
                    }
                    next();
                    const args: Node[] = [];
                    if (!isSymbol(")")) {
                        args.push(comparison());
                        while (isSymbol(",")) {
                            next();
                            args.push(comparison());
                        }
                    }
                    expect(")", `) to close ${token.text}(`);
                    if (args.length < limits[0] || args.length > limits[1]) {
                        const count = limits[0] === limits[1] ? `${limits[0]}` : `${limits[0]} or more`;
                        throw new FormulaError(`${USAGE[lower] ?? `${lower}(…)`} takes ${count} values`, token.at);
                    }
                    return { kind: "call", name: lower, args, at: token.at };
                }
                if (lower === "t") {
                    return { kind: "time", at: token.at };
                }
                if (lower in CONSTANTS) {
                    return { kind: "number", value: CONSTANTS[lower]!, at: token.at };
                }
                return { kind: "channel", name: token.text, at: token.at };
            }
            case "symbol":
                if (token.text === "(") {
                    const inside = comparison();
                    expect(")", "a )");
                    return inside;
                }
                throw new FormulaError(`Expected a value before ${token.text}`, token.at);
            case "end":
                throw new FormulaError(
                    token.at === 0 ? "Write an expression, like [LC-1] + [LC-2]" : "Expected a value at the end",
                    token.at,
                );
        }
    }

    const tree = comparison();
    if (peek().kind !== "end") {
        const extra = peek();
        throw new FormulaError(`Expected an operator (like + or *) before ${extra.text}`, extra.at);
    }
    return tree;
}

/** The channels an expression uses, by name, each once. */
export function channelsOf(node: Node): string[] {
    const found = new Set<string>();
    const walk = (at: Node) => {
        switch (at.kind) {
            case "channel":
                found.add(at.name);
                return;
            case "negate":
                walk(at.arg);
                return;
            case "operator":
                walk(at.left);
                walk(at.right);
                return;
            case "call":
                at.args.forEach(walk);
                return;
        }
    };
    walk(node);
    return [...found];
}

const parsed = new Map<string, Node | FormulaError>();

/** An expression's tree, or why it can't be read: each expression is read once. */
export function readFormula(expression: string): Node | FormulaError {
    let found = parsed.get(expression);
    if (!found) {
        try {
            found = parse(expression);
        } catch (error) {
            found = error instanceof FormulaError ? error : new FormulaError(String(error), 0);
        }
        parsed.set(expression, found);
    }
    return found;
}

/** The channel a name in an expression means: the one of that name, or one differing only in case. */
export function findChannel<T extends { name: string }>(channels: readonly T[], name: string): T | undefined {
    return (
        channels.find((one) => one.name === name) ??
        channels.find((one) => one.name.toLowerCase() === name.toLowerCase())
    );
}

// --- working it out -----------------------------------------------------------------------------------------------

export interface Input {
    samples: Samples;
    step: boolean; // a state: hold each value until the next, rather than draw a line between them
}

type Value = number | Float64Array;

function same(a: Float64Array, b: Float64Array): boolean {
    if (a === b) {
        return true;
    }
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

/** An input's values at the given times: its own where it has one, else read between its samples. */
function onto(input: Input, times: Float64Array): Float64Array {
    const { times: own, values, gap } = input.samples;
    if (same(own, times)) {
        return values;
    }
    const out = new Float64Array(times.length);
    let j = 0;
    for (let i = 0; i < times.length; i++) {
        const t = times[i]!;
        j = lowerBound(own, t, j);
        if (j < own.length && own[j] === t) {
            out[i] = values[j]!;
        } else if (j === 0 || j === own.length || own[j]! - own[j - 1]! > gap) {
            out[i] = NaN; // before, after, or in a pause
        } else if (input.step) {
            out[i] = values[j - 1]!;
        } else {
            const [t0, t1] = [own[j - 1]!, own[j]!];
            out[i] = values[j - 1]! + ((values[j]! - values[j - 1]!) * (t - t0)) / (t1 - t0);
        }
    }
    return out;
}

function map1(a: Value, f: (x: number) => number): Value {
    if (typeof a === "number") {
        return f(a);
    }
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) {
        out[i] = f(a[i]!);
    }
    return out;
}

function map2(a: Value, b: Value, f: (x: number, y: number) => number): Value {
    if (typeof a === "number" && typeof b === "number") {
        return f(a, b);
    }
    const length = typeof a === "number" ? (b as Float64Array).length : a.length;
    const out = new Float64Array(length);
    for (let i = 0; i < length; i++) {
        out[i] = f(typeof a === "number" ? a : a[i]!, typeof b === "number" ? b : b[i]!);
    }
    return out;
}

const at = (value: Value, i: number): number => (typeof value === "number" ? value : value[i]!);

const truth = (x: number, y: number, holds: boolean) => (Number.isNaN(x) || Number.isNaN(y) ? NaN : holds ? 1 : 0);

const OPERATORS: Record<Operator, (x: number, y: number) => number> = {
    "+": (x, y) => x + y,
    "-": (x, y) => x - y,
    "*": (x, y) => x * y,
    "/": (x, y) => x / y,
    "^": (x, y) => x ** y,
    "<": (x, y) => truth(x, y, x < y),
    ">": (x, y) => truth(x, y, x > y),
    "<=": (x, y) => truth(x, y, x <= y),
    ">=": (x, y) => truth(x, y, x >= y),
    "==": (x, y) => truth(x, y, x === y),
    "!=": (x, y) => truth(x, y, x !== y),
};

function derivative(values: Value, times: Float64Array): Value {
    if (typeof values === "number") {
        return 0;
    }
    const count = values.length;
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        const a = Math.max(0, i - 1);
        const b = Math.min(count - 1, i + 1);
        const span = times[b]! - times[a]!;
        out[i] = span > 0 ? (values[b]! - values[a]!) / span : NaN;
    }
    return out;
}

function integral(values: Value, times: Float64Array): Float64Array {
    const out = new Float64Array(times.length);
    let total = 0;
    for (let i = 1; i < times.length; i++) {
        const [a, b] = [at(values, i - 1), at(values, i)];
        if (Number.isFinite(a) && Number.isFinite(b)) {
            total += ((a + b) / 2) * (times[i]! - times[i - 1]!);
        }
        out[i] = total;
    }
    return out;
}

/** The average of the values within seconds / 2 either side of each sample (missing ones left out). */
function smooth(values: Value, seconds: number, times: Float64Array): Value {
    if (typeof values === "number") {
        return values;
    }
    const half = seconds / 2;
    const out = new Float64Array(values.length);
    let [start, end, total, count] = [0, 0, 0, 0];
    for (let i = 0; i < values.length; i++) {
        while (end < values.length && times[end]! <= times[i]! + half) {
            if (Number.isFinite(values[end]!)) {
                total += values[end]!;
                count += 1;
            }
            end += 1;
        }
        while (times[start]! < times[i]! - half) {
            if (Number.isFinite(values[start]!)) {
                total -= values[start]!;
                count -= 1;
            }
            start += 1;
        }
        out[i] = count > 0 ? total / count : NaN;
    }
    return out;
}

/** Each sample's least, greatest, or average of the values, leaving out missing ones. */
function combine(values: Value[], length: number, how: "min" | "max" | "avg"): Value {
    const out = new Float64Array(length);
    for (let i = 0; i < length; i++) {
        let [total, count, low, high] = [0, 0, Infinity, -Infinity];
        for (const value of values) {
            const x = at(value, i);
            if (!Number.isNaN(x)) {
                total += x;
                count += 1;
                low = Math.min(low, x);
                high = Math.max(high, x);
            }
        }
        out[i] = count === 0 ? NaN : how === "min" ? low : how === "max" ? high : total / count;
    }
    return out;
}

/**
 * Whether every test holds (and) or any does (or), sample by sample: 1 or 0, or missing where that turns on a missing
 * one (one that doesn't hold decides an and, whatever the others are; one that does, an or).
 */
function logic(tests: Value[], length: number, how: "and" | "or"): Float64Array {
    const decides = how === "and" ? 0 : 1;
    const out = new Float64Array(length);
    for (let i = 0; i < length; i++) {
        let result = 1 - decides;
        for (const test of tests) {
            const x = at(test, i);
            if (Number.isNaN(x)) {
                result = NaN;
            } else if ((x ? 1 : 0) === decides) {
                result = decides;
                break;
            }
        }
        out[i] = result;
    }
    return out;
}

function run(node: Node, times: Float64Array, inputs: ReadonlyMap<string, Float64Array>): Value {
    switch (node.kind) {
        case "number":
            return node.value;
        case "time":
            return times;
        case "channel":
            return inputs.get(node.name)!;
        case "negate":
            return map1(run(node.arg, times, inputs), (x) => -x);
        case "operator":
            return map2(run(node.left, times, inputs), run(node.right, times, inputs), OPERATORS[node.op]);
        case "call": {
            const args = node.args.map((arg) => run(arg, times, inputs));
            const [first, second, third] = [args[0]!, args[1]!, args[2]!];
            switch (node.name) {
                case "min":
                case "max":
                case "avg":
                    return combine(args, times.length, node.name);
                case "if":
                case "where": {
                    // Where the test holds (isn't 0), the value; where it doesn't, the other (or nothing); unknown: nothing.
                    const out = new Float64Array(times.length);
                    for (let i = 0; i < out.length; i++) {
                        const test = at(first, i);
                        out[i] = Number.isNaN(test)
                            ? NaN
                            : test
                              ? at(second, i)
                              : node.name === "if"
                                ? at(third, i)
                                : NaN;
                    }
                    return out;
                }
                case "and":
                case "or":
                    return logic(args, times.length, node.name);
                case "not":
                    return map1(first, (x) => (Number.isNaN(x) ? NaN : x ? 0 : 1));
                case "between": {
                    const out = new Float64Array(times.length);
                    for (let i = 0; i < out.length; i++) {
                        const [x, low, high] = [at(first, i), at(second, i), at(third, i)];
                        const unknown = Number.isNaN(x) || Number.isNaN(low) || Number.isNaN(high);
                        out[i] = unknown ? NaN : x >= low && x <= high ? 1 : 0;
                    }
                    return out;
                }
                case "ddt":
                    return derivative(first, times);
                case "integral":
                    return integral(first, times);
                case "smooth":
                    if (typeof second !== "number" || !(second > 0)) {
                        throw new FormulaError(
                            "smooth's window is a number of seconds, like smooth([PT-1], 0.05)",
                            node.at,
                        );
                    }
                    return smooth(first, second, times);
                default:
                    return map1(first, MATH[node.name]!);
            }
        }
    }
}

/** An expression worked out for a dataset's channels (inputs, by the names the expression uses). */
export function calculate(node: Node, inputs: ReadonlyMap<string, Input>): Samples {
    const names = channelsOf(node);
    if (names.length === 0) {
        throw new FormulaError("Use at least one channel, like [PT-1]", 0);
    }
    let base: Input | null = null;
    for (const name of names) {
        const input = inputs.get(name);
        if (!input) {
            throw new FormulaError(`No channel called ${name}`, 0);
        }
        if (!base || input.samples.length > base.samples.length) {
            base = input;
        }
    }
    const times = base!.samples.times;
    const lined = new Map(names.map((name) => [name, onto(inputs.get(name)!, times)] as const));
    const result = run(node, times, lined);
    const values = new Float64Array(times.length);
    for (let i = 0; i < times.length; i++) {
        const value = at(result, i);
        values[i] = Number.isFinite(value) ? value : NaN; // a division by zero is a gap, not an infinite axis
    }
    return new Samples(times, values);
}
