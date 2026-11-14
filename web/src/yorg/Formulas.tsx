import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Dialog, Notice } from "../components";
import { yorg, type DatasetDetail, type Formula } from "./api";
import { formulas, plan, reloadFormulas, workedOut, type Place } from "./data";
import { ExpressionBox } from "./ExpressionBox";
import { channelsOf, FormulaError, readFormula } from "./formula";
import { formatValue } from "../scale";

// Making and changing a calculated channel: a name, a unit, and an expression over channels, checked as it's typed
// against the dataset it's being made from.

const NONE: Formula[] = [];

const EXAMPLES = [
    ["[LC-1] + [LC-2]", "two load cells: total thrust"],
    ["where([FM-FU] > 0.05, [FM-OX] / [FM-FU])", "O/F, only while fuel flows"],
    ["[PT-OX-INJ] - [PT-CHAMBER]", "pressure drop across the injector"],
    ["integral([LC-THRUST])", "total impulse, from the first sample"],
    ["smooth([PT-CHAMBER], 0.05)", "the average over 50 ms around each sample"],
    ["[mdot] / sqrt(2 * 997 * ([PT-1] - [PT-2]) * 6894.76)", "CdA, from the calculated channel mdot"],
] as const;

/** What a try-out of the expression found in the dataset: its range, or why it didn't work. */
type Trial =
    | { state: "idle" }
    | { state: "trying" }
    | { state: "done"; low: number; high: number; count: number }
    | { state: "failed"; error: string };

/** Whether two names are one: names are unique whatever their case. */
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Names said in a sentence: "CdA", "CdA and Isp", "CdA, Isp, and c*". */
const listed = (names: string[]) =>
    names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

export function FormulaDialog({
    formula,
    own,
    page,
    onClose,
    onSaved,
}: {
    formula: Formula | null; // null: a new one
    own: DatasetDetail; // it's tried on this one (the first on the page, for one across them)
    page: Place[] | null; // the datasets on the page, lined up as they are there (placesOf), for one across them
    onClose: () => void;
    onSaved: (saved: Formula, created: boolean) => void;
}) {
    const [name, setName] = useState(formula?.name ?? "");
    const [unit, setUnit] = useState(formula?.unit ?? "");
    const [expression, setExpression] = useState(formula?.expression ?? "");
    const [description, setDescription] = useState(formula?.description ?? "");
    const [find, setFind] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [trial, setTrial] = useState<Trial>({ state: "idle" });
    const box = useRef<HTMLTextAreaElement>(null);
    const loaded = formulas();
    const list = loaded.status === "ready" ? loaded.value : NONE;
    const several = page !== null && page.length > 1;

    // The team's others, and this one as it's written (so a loop back to it is found, through others too).
    const others = useMemo(() => list.filter((one) => one.id !== formula?.id), [list, formula?.id]);
    const self = name.trim() || formula?.name || "this";
    const known = [...others, { id: formula?.id ?? null, name: self, expression }];
    const tree = expression.trim() ? readFormula(expression) : null;
    const error = tree instanceof FormulaError ? tree : null;
    // In this dataset alone if it has what it uses, else across the page's datasets, as they're lined up there.
    const alone = tree && !error ? plan(expression, [{ detail: own, shift: 0 }], known, [self]) : null;
    const across = alone instanceof FormulaError && several ? plan(expression, page, known, [self]) : null;
    const result = alone instanceof FormulaError ? (across ?? alone) : alone;
    const unusable = result instanceof FormulaError ? result : null;
    const ready = result && !(result instanceof FormulaError) ? result : null;
    const spread = ready !== null && across === ready;

    // Others that use this one by its name: renaming or deleting it leaves them without it.
    const usedBy = useMemo(() => {
        if (!formula) {
            return [];
        }
        return others
            .filter((one) => {
                const read = readFormula(one.expression);
                return !(read instanceof FormulaError) && channelsOf(read).some((used) => sameName(used, formula.name));
            })
            .map((one) => one.name);
    }, [others, formula]);

    // Try it once typing stops: its range tells whether it's what was meant.
    const trying = ready?.key ?? null;
    useEffect(() => {
        if (!ready) {
            setTrial({ state: "idle" });
            return;
        }
        let current = true;
        setTrial({ state: "trying" });
        const timer = setTimeout(() => {
            workedOut(ready).then(
                (samples) => {
                    let [low, high, count] = [Infinity, -Infinity, 0];
                    for (const value of samples.values) {
                        if (!Number.isNaN(value)) {
                            low = Math.min(low, value);
                            high = Math.max(high, value);
                            count += 1;
                        }
                    }
                    if (current) {
                        setTrial({ state: "done", low, high, count });
                    }
                },
                (failure: unknown) =>
                    current &&
                    setTrial({ state: "failed", error: String(failure instanceof Error ? failure.message : failure) }),
            );
        }, 350);
        return () => {
            current = false;
            clearTimeout(timer);
        };
        // What it works out is the plan, which its key names.
    }, [trying]);

    /** Put a channel (or a calculated channel) into the expression where the cursor is. */
    function insert(channel: string) {
        const field = box.current;
        const text = `[${channel}]`;
        const [start, end] = field
            ? [field.selectionStart, field.selectionEnd]
            : [expression.length, expression.length];
        // The new text in the field now, and the cursor after it: waiting a frame to move the cursor let keys
        // typed meanwhile land where it was.
        flushSync(() => setExpression(expression.slice(0, start) + text + expression.slice(end)));
        field?.focus();
        field?.setSelectionRange(start + text.length, start + text.length);
    }

    async function save() {
        setBusy(true);
        setProblem(null);
        const body = { name: name.trim(), expression: expression.trim(), unit: unit.trim(), description };
        try {
            const saved = formula ? await yorg.updateFormula(formula.id, body) : await yorg.addFormula(body);
            await reloadFormulas();
            onSaved(saved, formula === null);
        } catch (failure) {
            setProblem(failure instanceof Error ? failure.message : String(failure));
            setBusy(false);
        }
    }

    async function remove() {
        if (!formula) {
            return;
        }
        setBusy(true);
        try {
            await yorg.removeFormula(formula.id);
            await reloadFormulas();
            onClose();
        } catch (failure) {
            setProblem(failure instanceof Error ? failure.message : String(failure));
            setBusy(false);
        }
    }

    const places = several ? page : [{ detail: own, shift: 0 }];
    const where = spread
        ? `Across ${listed(ready.datasets.map((one) => one.name))}, as they're lined up here`
        : `In ${own.name}`;
    // The calculated channels it can use here: those that work out in this dataset, or across the page's.
    const usable = useMemo(
        () =>
            others.filter(
                (one) =>
                    !(plan(one.expression, [{ detail: own, shift: 0 }], others, [one.name]) instanceof FormulaError) ||
                    (several && !(plan(one.expression, page, others, [one.name]) instanceof FormulaError)),
            ),
        [others, own, page, several],
    );
    const calculatedNames = useMemo(() => {
        const channels = new Set(places.flatMap((place) => place.detail.channels.map((one) => one.name.toLowerCase())));
        return new Set(others.map((one) => one.name.toLowerCase()).filter((one) => !channels.has(one)));
    }, [others, places]);
    const words = find.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = (text: string) => words.every((word) => text.toLowerCase().includes(word));
    const readOnly = formula !== null && !formula.can_change;
    const renaming = formula !== null && name.trim() !== "" && !sameName(name.trim(), formula.name);
    const check = error
        ? `${error.message} (at character ${error.at + 1})`
        : unusable
          ? `${unusable.message}: it won't show ${several ? "on this page" : `in ${own.name}`}.`
          : trial.state === "trying"
            ? "Working it out…"
            : trial.state === "done"
              ? trial.count === 0
                  ? `${where}, it has no values.`
                  : `${where}: ${formatValue(trial.low)} to ${formatValue(trial.high)} ${unit}`.trim()
              : trial.state === "failed"
                ? trial.error
                : "Click channels below to put them in.";
    return (
        <Dialog
            title={formula ? (readOnly ? formula.name : `Change ${formula.name}`) : "New calculated channel"}
            confirm={formula ? "Save" : "Save and plot"}
            busy={busy}
            disabled={readOnly || !name.trim() || !tree || error !== null}
            onConfirm={() => void save()}
            onCancel={onClose}
        >
            <div className="yorg-formula">
                <p className="muted">
                    Calculated channels are for the whole team: this one shows in every dataset that has the channels it
                    uses{several ? ", or across the datasets compared, when it uses channels of more than one" : ""}.
                </p>
                <div className="yorg-row">
                    <label className="field">
                        Name
                        <input
                            autoFocus={!formula}
                            value={name}
                            disabled={readOnly}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Thrust"
                        />
                    </label>
                    <label className="field yorg-formula-unit">
                        Unit
                        <input
                            value={unit}
                            disabled={readOnly}
                            onChange={(event) => setUnit(event.target.value)}
                            placeholder="lbf"
                        />
                    </label>
                </div>
                {renaming && usedBy.length > 0 && (
                    <Notice>
                        {listed(usedBy)} {usedBy.length === 1 ? "uses" : "use"} it as {formula.name}: renamed, change{" "}
                        {usedBy.length === 1 ? "it" : "them"} to its new name too.
                    </Notice>
                )}
                <ExpressionBox
                    label="Expression"
                    box={box}
                    value={expression}
                    onChange={setExpression}
                    calculated={calculatedNames}
                    wrong={error?.at ?? null}
                    invalid={error !== null || unusable !== null}
                    disabled={readOnly}
                    placeholder="[LC-1] + [LC-2]"
                />
                <p
                    className={`yorg-formula-check${error || unusable || trial.state === "failed" ? " field-problem" : " muted"}`}
                    role="status"
                >
                    {check}
                </p>
                {!readOnly && (
                    <div className="yorg-formula-channels">
                        <input
                            type="search"
                            placeholder={several ? "Find a channel of these datasets" : `Find a channel of ${own.name}`}
                            aria-label="Find a channel to put in"
                            value={find}
                            onChange={(event) => setFind(event.target.value)}
                        />
                        {places.map((place) => {
                            const choices = place.detail.channels.filter((channel) => matching(channel.name));
                            return (
                                <div key={place.detail.id} className="yorg-formula-group">
                                    {several && <p className="yorg-formula-group-name">{place.detail.name}</p>}
                                    <div
                                        className="yorg-formula-choices"
                                        role="group"
                                        aria-label={`Channels of ${place.detail.name}`}
                                    >
                                        {choices.slice(0, 60).map((channel) => (
                                            <button
                                                key={channel.name}
                                                type="button"
                                                className="button-small"
                                                onClick={() => insert(channel.name)}
                                            >
                                                {channel.name}
                                            </button>
                                        ))}
                                        {choices.length === 0 && <span className="muted">None match.</span>}
                                    </div>
                                </div>
                            );
                        })}
                        {usable.some((one) => matching(one.name)) && (
                            <div className="yorg-formula-group">
                                <p className="yorg-formula-group-name">Calculated</p>
                                <div className="yorg-formula-choices" role="group" aria-label="Calculated channels">
                                    {usable
                                        .filter((one) => matching(one.name))
                                        .slice(0, 60)
                                        .map((one) => (
                                            <button
                                                key={one.id}
                                                type="button"
                                                className="button-small yorg-formula-calculated"
                                                title={`${one.name} = ${one.expression}`}
                                                onClick={() => insert(one.name)}
                                            >
                                                {one.name}
                                            </button>
                                        ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
                <details className="yorg-formula-help">
                    <summary>What you can write</summary>
                    <p>
                        Channels in brackets, like <code>[PT-OX-01]</code> (plain names like <code>LC1</code> can go
                        without). Numbers, <code>+ - * / ^</code>, and parentheses: the pair at the cursor is boxed, and
                        each depth has its color. Comparisons (<code>&lt; &gt; &lt;= &gt;= == !=</code>) give 1 or 0.
                    </p>
                    <p>
                        Other calculated channels by name, like <code>[mdot]</code>: one worked out once can be used in
                        others (never in itself). With datasets compared, a channel of another of them works too:
                        it&apos;s worked out across them, on the first one&apos;s times, as they&apos;re lined up.
                    </p>
                    <p>
                        Functions: <code>abs sqrt exp ln log10 sin cos tan round floor ceil</code>;{" "}
                        <code>min max avg</code> of any number of values; <code>if(test, value, otherwise)</code>;{" "}
                        <code>where(test, value)</code> (nothing where the test fails); <code>and(a, b, …)</code>,{" "}
                        <code>or(a, b, …)</code>, <code>not(test)</code>, and <code>between(x, low, high)</code> for
                        tests; <code>ddt(x)</code>, the rate of change per second; <code>integral(x)</code>;{" "}
                        <code>smooth(x, seconds)</code>. <code>t</code> is the time, and <code>pi</code>, <code>e</code>
                        , and <code>g0</code> (9.80665) are there too.
                    </p>
                    <ul className="plain">
                        {EXAMPLES.map(([example, meaning]) => (
                            <li key={example}>
                                <code>{example}</code> <span className="muted">{meaning}</span>
                            </li>
                        ))}
                    </ul>
                </details>
                <label className="field">
                    Notes
                    <textarea
                        value={description}
                        disabled={readOnly}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </label>
                {readOnly && (
                    <Notice>
                        Only whoever made it ({formula.created_by?.name ?? "someone"}), or an admin, can change it.
                    </Notice>
                )}
                {problem && <Notice tone="error">{problem}</Notice>}
                {formula?.can_change && (
                    <div className="yorg-formula-delete">
                        {deleting ? (
                            <>
                                <span>
                                    Delete {formula.name} for everyone? Plots that use it lose it.
                                    {usedBy.length > 0 &&
                                        ` ${listed(usedBy)} ${usedBy.length === 1 ? "uses" : "use"} it, and won't work without it.`}
                                </span>
                                <button
                                    type="button"
                                    className="button-danger"
                                    disabled={busy}
                                    onClick={() => void remove()}
                                >
                                    Delete it
                                </button>
                                <button type="button" onClick={() => setDeleting(false)}>
                                    Keep it
                                </button>
                            </>
                        ) : (
                            <button type="button" className="button-small" onClick={() => setDeleting(true)}>
                                Delete this calculated channel
                            </button>
                        )}
                    </div>
                )}
            </div>
        </Dialog>
    );
}
