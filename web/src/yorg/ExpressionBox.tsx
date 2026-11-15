import { useId, useMemo, useState, type ReactNode, type RefObject } from "react";
import { parenAt, parentheses, type Paren } from "./formula";

// An expression's box (a calculated channel's, a mask's), shown as an editor shows code: channels in their color,
// calculated channels in another, functions and numbers in theirs, and parentheses colored by how deep they are, with
// the pair at the caret marked (as VS Code marks them) and one without a partner marked as wrong. It's a textarea over
// a copy of its text with the colors, which it lets show through (its own text is clear): typing, selecting, and
// pasting are the textarea's own. The two are laid over each other in one grid cell, so the box grows with the text,
// and neither scrolls.

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;
const NAME = /^[A-Za-z_][A-Za-z0-9_.]*/;
const DEPTHS = 3; // colors that parentheses go round, by depth

interface Part {
    text: string;
    kind: string | null; // its class's last word: channel, calculated, function, number, paren...
}

/** An expression's text in parts to color: the same text, all of it, in order. */
export function partsOf(
    text: string,
    calculated: ReadonlySet<string>, // calculated channels' names, lowercased
    pair: Paren | null, // the parenthesis at the caret
    wrong: number | null, // where a problem is (FormulaError.at)
): Part[] {
    const parens = new Map(parentheses(text).map((one) => [one.at, one] as const));
    const parts: Part[] = [];
    let at = 0;
    const take = (end: number, kind: string | null) => {
        const marked = wrong !== null && wrong >= at && wrong < end;
        parts.push({ text: text.slice(at, end), kind: marked ? `${kind ?? "plain"} yorg-x-wrong` : kind });
        at = end;
    };
    while (at < text.length) {
        const rest = text.slice(at);
        if (rest[0] === "[") {
            const close = text.indexOf("]", at + 1);
            const name = text.slice(at + 1, close < 0 ? text.length : close).trim();
            take(close < 0 ? text.length : close + 1, calculated.has(name.toLowerCase()) ? "calculated" : "channel");
            continue;
        }
        const paren = parens.get(at);
        if (paren) {
            const matched =
                pair !== null && (paren.at === pair.at || (pair.partner !== null && paren.at === pair.partner));
            take(
                at + 1,
                paren.partner === null
                    ? "paren yorg-x-unmatched"
                    : `paren yorg-x-depth-${paren.depth % DEPTHS}${matched ? " yorg-x-match" : ""}`,
            );
            continue;
        }
        const number = NUMBER.exec(rest);
        if (number) {
            take(at + number[0].length, "number");
            continue;
        }
        const name = NAME.exec(rest);
        if (name) {
            const call = /^\s*\(/.test(text.slice(at + name[0].length));
            take(at + name[0].length, call ? "function" : calculated.has(name[0].toLowerCase()) ? "calculated" : null);
            continue;
        }
        // Operators and spaces, up to the next thing to color (or the problem's place, marked by itself).
        let end = at + 1;
        while (end < text.length && at !== wrong && end !== wrong && !/[[()A-Za-z0-9_.]/.test(text[end]!)) {
            end += 1;
        }
        take(end, null);
    }
    return parts;
}

export function ExpressionBox({
    label,
    value,
    onChange,
    box,
    calculated,
    wrong = null,
    invalid = false,
    disabled = false,
    placeholder,
}: {
    label: string; // the field's name: "Expression"
    value: string;
    onChange: (value: string) => void;
    box: RefObject<HTMLTextAreaElement | null>;
    calculated: ReadonlySet<string>; // calculated channels' names, lowercased
    wrong?: number | null; // where its problem is, to underline
    invalid?: boolean;
    disabled?: boolean;
    placeholder?: string;
}) {
    const id = useId();
    const [caret, setCaret] = useState<number | null>(null); // null: the box isn't focused
    const parens = useMemo(() => parentheses(value), [value]);
    const pair = caret === null ? null : parenAt(parens, caret);
    const parts = partsOf(value, calculated, pair, wrong);
    // Where the caret is, as it moves: by keys, the mouse, or typing (a collapsed selection only, as an IDE does).
    const follow = (field: HTMLTextAreaElement) =>
        setCaret(field.selectionStart === field.selectionEnd ? field.selectionEnd : null);
    let shown: ReactNode[] = parts.map((part, index) =>
        part.kind ? (
            <span key={index} className={`yorg-x-${part.kind}`}>
                {part.text}
            </span>
        ) : (
            part.text
        ),
    );
    // A last line that's empty still takes its height, as it does in the box.
    shown = [...shown, "​"];
    // Its label beside the box, not around it: a label's name would take in the copy's text.
    return (
        <div className="field">
            <label htmlFor={id}>{label}</label>
            <div className="yorg-expression-box">
                <div className="yorg-expression yorg-expression-shown" aria-hidden="true">
                    {shown}
                </div>
                <textarea
                    id={id}
                    ref={box}
                    className="yorg-expression yorg-expression-input"
                    value={value}
                    disabled={disabled}
                    spellCheck={false}
                    placeholder={placeholder}
                    aria-invalid={invalid}
                    onChange={(event) => {
                        onChange(event.target.value);
                        follow(event.target);
                    }}
                    onSelect={(event) => follow(event.currentTarget)}
                    onKeyUp={(event) => follow(event.currentTarget)}
                    onMouseUp={(event) => follow(event.currentTarget)}
                    onFocus={(event) => follow(event.currentTarget)}
                    onBlur={() => setCaret(null)}
                />
            </div>
        </div>
    );
}
