import { useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { channelCode, completionAt, inString, type Attached, type Completion } from "./complete";

// A script's code: a text box with line numbers, and the keys Python wants. Tab and Shift+Tab indent and outdent
// (the lines picked, or at the cursor), Enter keeps the line's indent (one more after a colon), Ctrl+Enter runs, and
// Ctrl+S saves. Edits go through the browser's own typing, so Ctrl+Z undoes them. As you type, it offers channels' and
// tests' names in quotes and the yorg module's names after "yorg." (complete.ts); Ctrl+Space asks for them anywhere.

const INDENT = "    ";

/** What the page can do to the editor: put a channel in at the cursor, from the Data panel (test: as testRef has it). */
export interface EditorHandle {
    insertChannel: (channel: string, test: string | number | null) => void;
}

interface Props {
    code: string;
    onChange: (code: string) => void;
    onRun: () => void;
    onSave: () => void;
    label: string;
    attached: Attached[]; // the tests attached to the script, the first first, for completing their names
    errorLine?: number | null; // the line the last run failed on, marked in the gutter
    ref?: Ref<EditorHandle>;
}

/** Replace the box's selection with text, as typing would (so undo has it), then select from start to end. */
function type(area: HTMLTextAreaElement, text: string, start?: number, end?: number) {
    area.focus();
    // execCommand is the only way that keeps the browser's undo; where it's missing (tests), set the text directly.
    const typed = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
    if (!typed) {
        area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
        area.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (start !== undefined) {
        area.setSelectionRange(start, end ?? start);
    }
}

interface Open {
    completion: Completion;
    index: number; // the item picked
    x: number; // under the caret, in the editor's box
    y: number;
}

export function Editor({ code, onChange, onRun, onSave, label, attached, errorLine = null, ref }: Props) {
    const area = useRef<HTMLTextAreaElement>(null);
    const gutter = useRef<HTMLDivElement>(null);
    const measure = useRef<HTMLSpanElement>(null);
    const list = useRef<HTMLUListElement>(null);
    const [open, setOpen] = useState<Open | null>(null);
    const lines = code.split("\n").length;

    useImperativeHandle(ref, () => ({
        insertChannel(channel, test) {
            const box = area.current;
            if (!box) {
                return;
            }
            box.focus();
            // In an open string, its name; anywhere else, the code that takes it.
            type(box, inString(box.value, box.selectionStart) ? channel : channelCode(channel, test));
            setOpen(null);
        },
    }));

    // The picked item stays in view as the arrows move it.
    useLayoutEffect(() => {
        list.current?.children[open?.index ?? 0]?.scrollIntoView?.({ block: "nearest" });
    }, [open?.index]);

    /** Where the caret is, in the editor's box (the font is monospaced, and lines don't wrap). */
    function caretPoint(box: HTMLTextAreaElement, caret: number): { x: number; y: number } {
        const style = window.getComputedStyle(box);
        const lineHeight = parseFloat(style.lineHeight) || 19.5;
        const charWidth = measure.current ? measure.current.getBoundingClientRect().width / 10 : 7.8;
        const before = box.value.slice(0, caret);
        const row = before.split("\n").length - 1;
        const column = caret - (before.lastIndexOf("\n") + 1);
        const gutterWidth = gutter.current?.getBoundingClientRect().width ?? 0;
        return {
            x: gutterWidth + (parseFloat(style.paddingLeft) || 0) + column * charWidth - box.scrollLeft,
            y: (parseFloat(style.paddingTop) || 0) + (row + 1) * lineHeight - box.scrollTop,
        };
    }

    /** Offer what fits at the caret (or close the list if nothing does). */
    function suggest(box: HTMLTextAreaElement, asked: boolean) {
        const completion = completionAt(box.value, box.selectionStart, attached, asked);
        if (!completion || box.selectionStart !== box.selectionEnd) {
            setOpen(null);
            return;
        }
        setOpen({ completion, index: 0, ...caretPoint(box, completion.from) });
    }

    function accept(index: number) {
        const box = area.current;
        const item = open?.completion.items[index];
        if (!box || !open || !item) {
            return;
        }
        box.setSelectionRange(open.completion.from, open.completion.to);
        type(box, item.insert);
        setOpen(null);
    }

    function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
        const box = event.currentTarget;
        const { selectionStart: from, selectionEnd: to, value } = box;
        const modifier = event.ctrlKey || event.metaKey;
        if (open) {
            const count = open.completion.items.length;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setOpen({ ...open, index: (open.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count });
                return;
            }
            if ((event.key === "Enter" || event.key === "Tab") && !modifier) {
                event.preventDefault();
                accept(open.index);
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                setOpen(null);
                return;
            }
        }
        if (modifier && event.key === " ") {
            event.preventDefault();
            suggest(box, true);
        } else if (modifier && event.key === "Enter") {
            event.preventDefault();
            onRun();
        } else if (modifier && event.key.toLowerCase() === "s") {
            event.preventDefault();
            onSave();
        } else if (event.key === "Tab") {
            event.preventDefault();
            const lineStart = value.lastIndexOf("\n", from - 1) + 1;
            if (from === to && !event.shiftKey) {
                type(box, INDENT);
                return;
            }
            // Indent or outdent every line the selection touches.
            const lineEnd = to > from && value[to - 1] === "\n" ? to - 1 : to;
            const block = value.slice(lineStart, lineEnd);
            const changed = block
                .split("\n")
                .map((line) =>
                    event.shiftKey ? line.replace(new RegExp(`^ {1,${INDENT.length}}`), "") : INDENT + line,
                )
                .join("\n");
            box.setSelectionRange(lineStart, lineEnd);
            type(box, changed, lineStart, lineStart + changed.length);
        } else if (event.key === "Enter" && !modifier && !event.shiftKey) {
            const lineStart = value.lastIndexOf("\n", from - 1) + 1;
            const line = value.slice(lineStart, from);
            const indent = /^\s*/.exec(line)?.[0] ?? "";
            const extra = /:\s*(#.*)?$/.test(line) ? INDENT : "";
            if (indent || extra) {
                event.preventDefault();
                type(box, `\n${indent}${extra}`);
            }
        }
    }

    return (
        <div className="scripts-editor">
            <div className="scripts-gutter" ref={gutter} aria-hidden="true">
                {Array.from({ length: lines }, (_, index) => (
                    <div key={index} className={index + 1 === errorLine ? "scripts-gutter-error" : undefined}>
                        {index + 1}
                    </div>
                ))}
            </div>
            <textarea
                ref={area}
                aria-label={label}
                aria-autocomplete="list"
                aria-expanded={open !== null}
                aria-controls={open ? "scripts-suggestions" : undefined}
                value={code}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                wrap="off"
                onChange={(event) => {
                    onChange(event.target.value);
                    suggest(event.target, false);
                }}
                onKeyDown={onKey}
                onClick={() => setOpen(null)}
                onBlur={() => window.setTimeout(() => setOpen(null), 150)} // after a click on the list
                onScroll={(event) => {
                    if (gutter.current) {
                        gutter.current.scrollTop = event.currentTarget.scrollTop;
                    }
                    setOpen(null);
                }}
            />
            <span ref={measure} className="scripts-measure" aria-hidden="true">
                MMMMMMMMMM
            </span>
            {open && (
                <ul
                    ref={list}
                    id="scripts-suggestions"
                    className="scripts-suggestions"
                    role="listbox"
                    aria-label="Suggestions"
                    style={{ left: open.x, top: open.y }}
                >
                    {open.completion.items.map((item, index) => (
                        <li
                            key={`${item.label}\u0000${item.detail}`}
                            role="option"
                            aria-selected={index === open.index}
                            onMouseDown={(event) => {
                                event.preventDefault(); // keep the editor's focus and caret
                                accept(index);
                            }}
                        >
                            <span>{item.label}</span>
                            <span className="muted">{item.detail}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
