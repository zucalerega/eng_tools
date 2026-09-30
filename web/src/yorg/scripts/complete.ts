// What the Python window's editor offers as you type: a channel's name in quotes, a test's name, what the yorg module
// has after "yorg.", and (asked for with Ctrl+Space) a whole yorg.channel("...") for a word.

/** A test attached to the script, and its channels, for completing their names. */
export interface Attached {
    id: number;
    name: string;
    channels: { name: string; unit: string }[];
}

/** Whether another attached test has this one's name (tests in two folders can): then only its id says which. */
function sharesName(attached: Attached[], index: number): boolean {
    const name = attached[index]?.name.toLowerCase();
    return attached.some((other, at) => at !== index && other.name.toLowerCase() === name);
}

/**
 * How code names an attached test: null for the first (yorg.channel() takes from it unless told another), else its
 * name, or its id when another attached test has that name too.
 */
export function testRef(attached: Attached[], index: number): string | number | null {
    const test = attached[index];
    if (index === 0 || !test) {
        return null;
    }
    return sharesName(attached, index) ? test.id : test.name;
}

export interface Suggestion {
    label: string; // what the list shows
    detail: string; // beside it, muted
    insert: string; // what replaces from..to
}

export interface Completion {
    from: number; // the code replaced, from and to (the caret)
    to: number;
    items: Suggestion[];
}

const MEMBERS: [string, string][] = [
    ["channel", "(name, dataset=None): a channel named in quotes, of an attached test"],
    ["load", "(name, dataset=None): any channel, with await"],
    ["channels", "(dataset=None): an attached test's channels"],
    ["datasets", "(): every test, with await"],
    ["attached", ": the tests attached to the script"],
    ["dataset", ": the first test attached"],
    ["t0", ": its T0"],
    ["window", ": a page's time in view, (start, end)"],
    ["shifts", ": a page's tests' shifts, by id"],
    ["plot", "(x, y=None, name=None, unit='', title=None)"],
    ["download", "(filename, content): a file to save"],
    ["si", "(values, unit): in SI units"],
    ["resample", "(*channels, dt=None): on one clock"],
    ["cda", "(mass_flow, pressure_drop, density)"],
    ["Channel", ": t, values, unit, between(), at(), si()"],
    ["PSI", " = 6894.757 Pa"],
    ["ATMOSPHERE", " = 101325 Pa"],
];

const MAX = 50;

/** Items first that start with what's typed, then those that have it anywhere; none that don't. */
function matching(items: Suggestion[], typed: string): Suggestion[] {
    const wanted = typed.toLowerCase();
    const starts = items.filter((item) => item.label.toLowerCase().startsWith(wanted));
    const has = items.filter(
        (item) => !item.label.toLowerCase().startsWith(wanted) && item.label.toLowerCase().includes(wanted),
    );
    return [...starts, ...has].slice(0, MAX);
}

/** Where a string that's still open at the caret starts (just after its quote), and its quote; null if none is. */
function openString(line: string): { start: number; quote: string } | null {
    let open: { start: number; quote: string } | null = null;
    for (let at = 0; at < line.length; at += 1) {
        const char = line[at]!;
        if (open) {
            if (char === "\\") {
                at += 1;
            } else if (char === open.quote) {
                open = null;
            }
        } else if (char === "#") {
            return null; // a comment: nothing to complete
        } else if (char === '"' || char === "'") {
            open = { start: at + 1, quote: char };
        }
    }
    return open;
}

/**
 * What to offer at the caret (null: nothing). Unasked (as you type), only where it's clearly wanted: a string after
 * yorg.channel( or load( or dataset=, or with two letters typed; and after "yorg.". Asked (Ctrl+Space), anywhere.
 */
export function completionAt(code: string, caret: number, attached: Attached[], asked: boolean): Completion | null {
    const lineStart = code.lastIndexOf("\n", caret - 1) + 1;
    const line = code.slice(lineStart, caret);
    const string = openString(line);
    if (string) {
        const typed = line.slice(string.start);
        const before = line.slice(0, string.start - 1);
        const wanted = /(?:channel|load|channels)\(\s*$|dataset\s*=\s*$/.test(before) || typed.length >= 2;
        if (!asked && !wanted) {
            return null;
        }
        const closes = code[caret] === string.quote ? "" : string.quote;
        // A channel's name where a channel goes, a test's after dataset=, and either in any other string.
        const datasetArgument = /dataset\s*=\s*$/.test(before);
        const channelArgument = /(?:channel|load)\(\s*$/.test(before);
        // A test by its name, or by its id where two attached have that name (an id in quotes works too).
        const tests: Suggestion[] = attached.map((test, index) => {
            const shared = sharesName(attached, index);
            return {
                label: shared ? `${test.name} (${test.id})` : test.name,
                detail: index === 0 ? "test (the first)" : "test",
                insert: (shared ? String(test.id) : test.name) + closes,
            };
        });
        const channels: Suggestion[] = attached.flatMap((test) =>
            test.channels.map((channel) => ({
                label: channel.name,
                detail: [channel.unit, test.name].filter(Boolean).join(" · "),
                insert: channel.name + closes,
            })),
        );
        // A channel's name once (the first test's), unless another test has it with another unit.
        const seen = new Set<string>();
        const unique = channels.filter((item) => {
            const key = `${item.label}\u0000${item.detail.split(" · ")[0]}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
        const items = matching(datasetArgument ? tests : channelArgument ? unique : [...unique, ...tests], typed);
        return items.length ? { from: lineStart + string.start, to: caret, items } : null;
    }
    const member = /\byorg\.([A-Za-z_]*)$/.exec(line);
    if (member) {
        const typed = member[1]!;
        const items = matching(
            MEMBERS.map(([name, detail]) => ({ label: name, detail: detail.trim(), insert: name })),
            typed,
        );
        return items.length ? { from: caret - typed.length, to: caret, items } : null;
    }
    if (!asked) {
        return null;
    }
    // Asked, on a word: a channel, as a whole yorg.channel("...") of its test.
    const word = /[A-Za-z0-9_-]*$/.exec(line)?.[0] ?? "";
    const expressions: Suggestion[] = attached.flatMap((test, index) =>
        test.channels.map((channel) => ({
            label: channel.name,
            detail: [channel.unit, test.name].filter(Boolean).join(" · "),
            insert: channelCode(channel.name, testRef(attached, index)),
        })),
    );
    const items = matching(expressions, word);
    return items.length ? { from: caret - word.length, to: caret, items } : null;
}

/**
 * The code for a channel of a test (named as testRef has it): yorg.channel("PT-TANK"), with dataset="Hotfire 4" (or
 * dataset=12) when it isn't the first test.
 */
export function channelCode(channel: string, test: string | number | null): string {
    const dataset = test === null ? "" : `, dataset=${typeof test === "number" ? test : JSON.stringify(test)}`;
    return `yorg.channel(${JSON.stringify(channel)}${dataset})`;
}

/** Whether the caret is in a string that's still open (so a channel clicked goes in as just its name). */
export function inString(code: string, caret: number): boolean {
    const lineStart = code.lastIndexOf("\n", caret - 1) + 1;
    return openString(code.slice(lineStart, caret)) !== null;
}
