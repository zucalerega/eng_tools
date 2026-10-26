import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Dialog, Notice } from "../components";
import { yorg, type DatasetDetail, type Formula } from "./api";
import { calculateFor, reloadFormulas } from "./data";
import { channelsOf, findChannel, FormulaError, readFormula } from "./formula";
import { formatValue } from "../scale";

// Making and changing a calculated channel: a name, a unit, and an expression over channels, checked as it's typed
// against the dataset it's being made from.

const EXAMPLES = [
    ["[LC-1] + [LC-2]", "two load cells: total thrust"],
    ["where([FM-FU] > 0.05, [FM-OX] / [FM-FU])", "O/F, only while fuel flows"],
    ["[PT-OX-INJ] - [PT-CHAMBER]", "pressure drop across the injector"],
    ["integral([LC-THRUST])", "total impulse, from the first sample"],
    ["smooth([PT-CHAMBER], 0.05)", "the average over 50 ms around each sample"],
] as const;

/** What a try-out of the expression found in the dataset: its range, or why it didn't work. */
type Trial =
    | { state: "idle" }
    | { state: "trying" }
    | { state: "done"; low: number; high: number; count: number }
    | { state: "failed"; error: string };

export function FormulaDialog({
    formula,
    detail,
    onClose,
    onSaved,
}: {
    formula: Formula | null; // null: a new one
    detail: DatasetDetail;
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

    const tree = expression.trim() ? readFormula(expression) : null;
    const error = tree instanceof FormulaError ? tree : null;
    const used = tree && !(tree instanceof FormulaError) ? channelsOf(tree) : [];
    const missing = used.filter((channel) => !findChannel(detail.channels, channel));

    // Try it on this dataset once typing stops: its range tells whether it's what was meant.
    useEffect(() => {
        if (!tree || error || used.length === 0 || missing.length > 0) {
            setTrial({ state: "idle" });
            return;
        }
        let current = true;
        setTrial({ state: "trying" });
        const timer = setTimeout(() => {
            calculateFor(detail, expression).then(
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
        // Everything it uses comes from the expression and the dataset.
    }, [expression, detail]);

    /** Put a channel into the expression where the cursor is. */
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

    const words = find.toLowerCase().split(/\s+/).filter(Boolean);
    const choices = detail.channels.filter((channel) =>
        words.every((word) => channel.name.toLowerCase().includes(word)),
    );
    const readOnly = formula !== null && !formula.can_change;
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
                    uses.
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
                <label className="field">
                    Expression
                    <textarea
                        ref={box}
                        className="yorg-expression"
                        value={expression}
                        disabled={readOnly}
                        spellCheck={false}
                        placeholder="[LC-1] + [LC-2]"
                        aria-invalid={error !== null || missing.length > 0}
                        onChange={(event) => setExpression(event.target.value)}
                    />
                </label>
                <p
                    className={`yorg-formula-check${error || missing.length || trial.state === "failed" ? " field-problem" : " muted"}`}
                    role="status"
                >
                    {error
                        ? `${error.message} (at character ${error.at + 1})`
                        : missing.length > 0
                          ? `${detail.name} has no channel called ${missing.join(" or ")}: it won't show there.`
                          : trial.state === "trying"
                            ? "Working it out…"
                            : trial.state === "done"
                              ? trial.count === 0
                                  ? `In ${detail.name}, it has no values.`
                                  : `In ${detail.name}: ${formatValue(trial.low)} to ${formatValue(trial.high)} ${unit}`.trim()
                              : trial.state === "failed"
                                ? trial.error
                                : "Click channels below to put them in."}
                </p>
                {!readOnly && (
                    <div className="yorg-formula-channels">
                        <input
                            type="search"
                            placeholder={`Find a channel of ${detail.name}`}
                            aria-label="Find a channel to put in"
                            value={find}
                            onChange={(event) => setFind(event.target.value)}
                        />
                        <div className="yorg-formula-choices">
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
                        </div>
                    </div>
                )}
                <details className="yorg-formula-help">
                    <summary>What you can write</summary>
                    <p>
                        Channels in brackets, like <code>[PT-OX-01]</code> (plain names like <code>LC1</code> can go
                        without). Numbers, <code>+ - * / ^</code>, and parentheses. Comparisons (
                        <code>&lt; &gt; &lt;= &gt;= == !=</code>) give 1 or 0.
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
                                <span>Delete {formula.name} for everyone? Plots that use it lose it.</span>
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
