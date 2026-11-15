import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../components";
import type { DatasetDetail, Formula } from "./api";
import { formulas, plan, workedOut } from "./data";
import { ExpressionBox } from "./ExpressionBox";
import { findChannel, FormulaError, readFormula } from "./formula";
import { newId, type Mask } from "./layout";
import { measure, runsOf } from "./masks";
import { formatDuration, formatValue } from "../scale";

// Making and changing a mask: where a test on channels holds (a valve open, a pressure over its redline), written like
// a calculated channel, or put together from a channel, a comparison, and a value.

const NONE: Formula[] = [];

export const MASK_COLORS = ["#2ca25f", "#d64541", "#2f7ed8", "#e0a500", "#8e5bd6", "#16a5a5"];

const COMPARISONS = [
    [">", "is above"],
    ["<", "is below"],
    [">=", "is at least"],
    ["<=", "is at most"],
    ["==", "is"],
    ["!=", "isn't"],
] as const;

const EXAMPLES = [
    ["[MOV-OX] == 1", "the valve's open (a state's values count from 0, in its list's order)"],
    ["[PT-CHAMBER] > 450", "over a redline"],
    ["and([MOV-OX] == 1, [MOV-FU] == 1)", "both valves open"],
    ["between([PT-OX-TANK], 300, 350)", "within a band"],
] as const;

/** What the mask does in the dataset it's tried on: how often and how long it holds, or why it can't be worked out. */
type Trial =
    | { state: "idle" }
    | { state: "trying" }
    | { state: "done"; count: number; total: number }
    | { state: "failed"; error: string };

export function MaskDialog({
    mask,
    detail,
    count,
    onSave,
    onRemove,
    onClose,
}: {
    mask: Mask | null; // null: a new one
    detail: DatasetDetail; // it's tried on this one
    count: number; // masks there are already (for a new one's color)
    onSave: (mask: Mask) => void;
    onRemove: () => void;
    onClose: () => void;
}) {
    const [name, setName] = useState(mask?.name ?? "");
    const [expression, setExpression] = useState(mask?.expression ?? "");
    const [color, setColor] = useState(mask?.color ?? MASK_COLORS[count % MASK_COLORS.length]!);
    const [shade, setShade] = useState(mask?.shade ?? true);
    const [hide, setHide] = useState(mask?.hide ?? false);
    const [trial, setTrial] = useState<Trial>({ state: "idle" });
    const box = useRef<HTMLTextAreaElement>(null);

    const loaded = formulas();
    const list = loaded.status === "ready" ? loaded.value : NONE;
    const tree = expression.trim() ? readFormula(expression) : null;
    const error = tree instanceof FormulaError ? tree : null;
    // Its channels, or calculated channels, in this dataset.
    const planned = tree && !error ? plan(expression, [{ detail, shift: 0 }], list) : null;
    const unusable = planned instanceof FormulaError ? planned : null;
    const ready = planned && !(planned instanceof FormulaError) && planned.sources.size > 0 ? planned : null;
    const calculatedNames = useMemo(() => {
        const channels = new Set(detail.channels.map((one) => one.name.toLowerCase()));
        return new Set(list.map((one) => one.name.toLowerCase()).filter((one) => !channels.has(one)));
    }, [list, detail]);

    // Try it on the dataset once typing stops: how often it holds says whether it's what was meant.
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
                (samples) => current && setTrial({ state: "done", ...measure(runsOf(samples)) }),
                (failure: unknown) =>
                    current &&
                    setTrial({ state: "failed", error: failure instanceof Error ? failure.message : String(failure) }),
            );
        }, 300);
        return () => {
            current = false;
            clearTimeout(timer);
        };
        // What it works out is the plan, which its key names.
    }, [trying]);

    const length = detail.t_min !== null && detail.t_max !== null ? detail.t_max - detail.t_min : null;
    const check = error
        ? `${error.message} (at character ${error.at + 1})`
        : unusable
          ? `${unusable.message}.`
          : trial.state === "trying"
            ? "Working it out…"
            : trial.state === "failed"
              ? trial.error
              : trial.state === "done"
                ? trial.count === 0
                    ? `In ${detail.name}, it never holds.`
                    : `In ${detail.name}, it holds ${trial.count === 1 ? "once" : `${trial.count} times`}: ` +
                      `${formatDuration(trial.total)} in all${length ? ` of ${formatDuration(length)}` : ""}.`
                : "Put a test together above, or write one.";
    const failing = error !== null || unusable !== null || trial.state === "failed";

    return (
        <Dialog
            title={mask ? `Change ${mask.name}` : "New mask"}
            confirm={mask ? "Save" : "Add the mask"}
            disabled={!name.trim() || !tree || error !== null}
            onConfirm={() =>
                onSave({
                    id: mask?.id ?? newId(),
                    name: name.trim(),
                    expression: expression.trim(),
                    color,
                    shade,
                    hide,
                })
            }
            onCancel={onClose}
        >
            <div className="yorg-formula yorg-mask-dialog">
                <p className="muted">
                    A mask is where a test on channels holds: a valve open, a pressure over its redline. It can shade
                    the plots there, hide data everywhere else, and split a file into its tests.
                </p>
                <label className="field">
                    Name
                    <input
                        autoFocus={!mask}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Main valve open"
                    />
                </label>
                <TestBuilder
                    detail={detail}
                    onAdd={(test, label, join) => {
                        const tree = expression.trim() ? readFormula(expression) : null;
                        const text = expression.trim();
                        // Another test joins the others: in the same and(...) or or(...), if that's what's there.
                        const next = !text
                            ? test
                            : tree && !(tree instanceof FormulaError) && tree.kind === "call" && tree.name === join
                              ? `${text.slice(0, -1)}, ${test})`
                              : `${join}(${text}, ${test})`;
                        setExpression(next);
                        if (!name.trim()) {
                            setName(label);
                        }
                        requestAnimationFrame(() => box.current?.focus());
                    }}
                    joining={expression.trim() !== ""}
                />
                <ExpressionBox
                    label="Test"
                    box={box}
                    value={expression}
                    onChange={setExpression}
                    calculated={calculatedNames}
                    wrong={error?.at ?? null}
                    invalid={failing}
                    placeholder="[MOV-OX] == 1"
                />
                <p className={`yorg-formula-check${failing ? " field-problem" : " muted"}`} role="status">
                    {check}
                </p>
                <details className="yorg-formula-help">
                    <summary>What you can write</summary>
                    <p>
                        What a calculated channel can: channels (and calculated channels) in brackets, numbers,
                        arithmetic, and comparisons (<code>&lt; &gt; &lt;= &gt;= == !=</code>). It holds where it isn't
                        0, and not where a channel it uses has no sample. Tests go together with{" "}
                        <code>and(a, b, …)</code> and <code>or(a, b, …)</code>; <code>not(test)</code> turns one around,
                        and <code>between(x, low, high)</code> is a band.
                    </p>
                    <ul className="plain">
                        {EXAMPLES.map(([example, meaning]) => (
                            <li key={example}>
                                <code>{example}</code> <span className="muted">{meaning}</span>
                            </li>
                        ))}
                    </ul>
                </details>
                <fieldset className="yorg-mask-color">
                    <legend>Color</legend>
                    {MASK_COLORS.map((one) => (
                        <label key={one} className="yorg-swatch-choice" title={one}>
                            <input
                                type="radio"
                                name="mask-color"
                                checked={color === one}
                                onChange={() => setColor(one)}
                                aria-label={`Color ${one}`}
                            />
                            <span className="yorg-swatch" style={{ background: one }} aria-hidden="true" />
                        </label>
                    ))}
                </fieldset>
                <label className="check">
                    <input type="checkbox" checked={shade} onChange={(event) => setShade(event.target.checked)} />
                    Shade the plots where it holds
                </label>
                <label className="check">
                    <input type="checkbox" checked={hide} onChange={(event) => setHide(event.target.checked)} />
                    Hide data where it doesn't hold
                </label>
                {mask && (
                    <div className="yorg-formula-delete">
                        <button type="button" className="button-small" onClick={onRemove}>
                            Remove this mask
                        </button>
                    </div>
                )}
            </div>
        </Dialog>
    );
}

/** A test from a channel, a comparison, and a value (a state's, by its name): "PT-CHAMBER is above 450". */
function TestBuilder({
    detail,
    onAdd,
    joining,
}: {
    detail: DatasetDetail;
    onAdd: (test: string, label: string, join: "and" | "or") => void;
    joining: boolean; // there's a test already: this one goes with it
}) {
    const [channelName, setChannelName] = useState(detail.channels[0]?.name ?? "");
    const [comparison, setComparison] = useState<string>(">");
    const [value, setValue] = useState("");
    const [join, setJoin] = useState<"and" | "or">("and");
    const channel = findChannel(detail.channels, channelName) ?? null;
    const labels = channel?.kind === "state" ? channel.labels : null;
    const comparisons = labels ? COMPARISONS.filter(([op]) => op === "==" || op === "!=") : COMPARISONS;
    const op = comparisons.some(([one]) => one === comparison) ? comparison : comparisons[0]![0];
    // A state's value is its name's place in its list; a number, as typed.
    const number = labels ? Number(value || 0) : value.trim() === "" ? NaN : Number(value);
    const ready = channel !== null && Number.isFinite(number);
    const add = () => {
        if (!channel || !ready) {
            return;
        }
        const wording = COMPARISONS.find(([one]) => one === op)![1];
        const shown = labels ? (labels[number] ?? String(number)) : formatValue(number);
        onAdd(`[${channel.name}] ${op} ${number}`, `${channel.name} ${wording} ${shown}`, join);
    };
    return (
        <fieldset className="yorg-test-builder">
            <legend>{joining ? "Add a test" : "Put a test together"}</legend>
            {joining && (
                <select
                    aria-label="How it goes with the test there"
                    value={join}
                    onChange={(event) => setJoin(event.target.value as "and" | "or")}
                >
                    <option value="and">and</option>
                    <option value="or">or</option>
                </select>
            )}
            <select
                aria-label="Channel"
                value={channelName}
                onChange={(event) => {
                    setChannelName(event.target.value);
                    setValue(""); // a number for one channel is no name for a state
                }}
            >
                {detail.channels.map((one) => (
                    <option key={one.name} value={one.name}>
                        {one.name}
                    </option>
                ))}
            </select>
            <select aria-label="Comparison" value={op} onChange={(event) => setComparison(event.target.value)}>
                {comparisons.map(([one, wording]) => (
                    <option key={one} value={one}>
                        {wording}
                    </option>
                ))}
            </select>
            {labels ? (
                <select aria-label="Value" value={value || "0"} onChange={(event) => setValue(event.target.value)}>
                    {labels.map((label, index) => (
                        <option key={label} value={String(index)}>
                            {label}
                        </option>
                    ))}
                </select>
            ) : (
                <input
                    aria-label="Value"
                    inputMode="decimal"
                    placeholder={channel?.unit ? `in ${channel.unit}` : "value"}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            add();
                        }
                    }}
                />
            )}
            <button type="button" className="button-small" disabled={!ready} onClick={add}>
                Add
            </button>
        </fieldset>
    );
}
