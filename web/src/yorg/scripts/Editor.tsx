import { useRef, type KeyboardEvent } from "react";

// A script's code: a text box with line numbers, and the keys Python wants. Tab and Shift+Tab indent and outdent
// (the lines picked, or at the cursor), Enter keeps the line's indent (one more after a colon), Ctrl+Enter runs, and
// Ctrl+S saves. Edits go through the browser's own typing, so Ctrl+Z undoes them.

const INDENT = "    ";

interface Props {
    code: string;
    onChange: (code: string) => void;
    onRun: () => void;
    onSave: () => void;
    label: string;
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

export function Editor({ code, onChange, onRun, onSave, label }: Props) {
    const area = useRef<HTMLTextAreaElement>(null);
    const gutter = useRef<HTMLDivElement>(null);
    const lines = code.split("\n").length;

    function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
        const box = event.currentTarget;
        const { selectionStart: from, selectionEnd: to, value } = box;
        const modifier = event.ctrlKey || event.metaKey;
        if (modifier && event.key === "Enter") {
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
                    <div key={index}>{index + 1}</div>
                ))}
            </div>
            <textarea
                ref={area}
                aria-label={label}
                value={code}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                wrap="off"
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={onKey}
                onScroll={(event) => {
                    if (gutter.current) {
                        gutter.current.scrollTop = event.currentTarget.scrollTop;
                    }
                }}
            />
        </div>
    );
}
