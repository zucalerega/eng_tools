import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

const KEYWORDS = new Set(
    "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
        " ",
    ),
);
const CONSTANTS = new Set(["True", "False", "None"]);
const BUILTINS = new Set([
    "print",
    "range",
    "len",
    "int",
    "float",
    "str",
    "bool",
    "enumerate",
    "zip",
    "sum",
    "min",
    "max",
    "abs",
    "wait_for",
    "wait_until",
]);
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

interface Token {
    text: string;
    kind: string;
}

function tokenizePython(code: string): Token[] {
    const tokens: Token[] = [];
    const stack: string[] = [];
    let plain = "";
    let i = 0;

    const flush = () => {
        if (plain) {
            tokens.push({ text: plain, kind: "" });
            plain = "";
        }
    };

    const push = (text: string, kind: string) => {
        flush();
        tokens.push({ text, kind });
    };

    const readQuoted = (start: number, quoteAt: number) => {
        const quote = code.charAt(quoteAt);
        const triple = code.slice(quoteAt, quoteAt + 3) === quote.repeat(3);
        const width = triple ? 3 : 1;
        let end = quoteAt + width;
        while (end < code.length) {
            if (code[end] === "\\") {
                end += 2;
                continue;
            }
            if (code.slice(end, end + width) === quote.repeat(width)) {
                end += width;
                break;
            }
            if (!triple && code[end] === "\n") {
                break;
            }
            end += 1;
        }
        push(code.slice(start, end), "string");
        i = end;
    };

    while (i < code.length) {
        const ch = code.charAt(i);
        if (ch === "#") {
            const end = code.indexOf("\n", i);
            const next = end < 0 ? code.length : end;
            push(code.slice(i, next), "comment");
            i = next;
        } else if (ch === "'" || ch === '"') {
            readQuoted(i, i);
        } else if (/[A-Za-z_]/.test(ch)) {
            const start = i;
            i += 1;
            while (i < code.length && /\w/.test(code.charAt(i))) {
                i += 1;
            }
            const word = code.slice(start, i);
            const nextChar = code.charAt(i);
            if (/^[rfbu]{1,3}$/i.test(word) && (nextChar === "'" || nextChar === '"')) {
                readQuoted(start, i);
            } else {
                const kind = KEYWORDS.has(word)
                    ? "keyword"
                    : CONSTANTS.has(word)
                      ? "constant"
                      : BUILTINS.has(word) || (nextChar === "(" && code.charAt(start - 1) === ".")
                        ? "function"
                        : "";
                if (kind) {
                    push(word, kind);
                } else {
                    plain += word;
                }
            }
        } else if (/\d/.test(ch)) {
            const match = code.slice(i).match(/^(?:0[xX][\da-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/);
            if (match) {
                push(match[0], "number");
                i += match[0].length;
            } else {
                plain += ch;
                i += 1;
            }
        } else if (ch === "(" || ch === "[" || ch === "{") {
            push(ch, `bracket-${stack.length % 3}`);
            stack.push(ch);
            i += 1;
        } else if (ch === ")" || ch === "]" || ch === "}") {
            const matching = stack[stack.length - 1] === PAIRS[ch];
            push(ch, matching ? `bracket-${(stack.length - 1) % 3}` : "bracket-error");
            if (matching) {
                stack.pop();
            }
            i += 1;
        } else if (/[+\-*/%=<>!&|^~:]/.test(ch)) {
            const start = i;
            i += 1;
            while (i < code.length && /[+\-*/%=<>!&|^~:]/.test(code.charAt(i))) {
                i += 1;
            }
            push(code.slice(start, i), "operator");
        } else {
            plain += ch;
            i += 1;
        }
    }
    if (code.endsWith("\n")) {
        plain += " ";
    }
    flush();
    return tokens;
}

export interface CodeEditorProps {
    value: string;
    onChange: (next: string) => void;
    activeLine: number;
    onClearActiveLine?: () => void;
    onRunShortcut?: () => void;
    jumpToken?: number;
}

export function CodeEditor({
    value,
    onChange,
    activeLine,
    onClearActiveLine,
    onRunShortcut,
    jumpToken,
}: CodeEditorProps) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const gutterRef = useRef<HTMLPreElement | null>(null);
    const highlightRef = useRef<HTMLPreElement | null>(null);
    const [scrollTop, setScrollTop] = useState(0);

    const tokens = useMemo(() => tokenizePython(value), [value]);
    const lineCount = useMemo(() => Math.max(1, value.split("\n").length), [value]);
    const gutterText = useMemo(
        () => Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n"),
        [lineCount],
    );

    useEffect(() => {
        if (!activeLine || !textareaRef.current) {
            return;
        }
        const textarea = textareaRef.current;
        const lines = value.split("\n");
        const targetIndex = Math.max(0, Math.min(lines.length - 1, activeLine - 1));
        let offset = 0;
        for (let i = 0; i < targetIndex; i += 1) {
            offset += (lines[i]?.length ?? 0) + 1;
        }
        const lineHeight = 21;
        textarea.focus();
        textarea.setSelectionRange(offset, offset + (lines[targetIndex]?.length ?? 0));
        const top = Math.max(0, targetIndex * lineHeight - textarea.clientHeight / 3);
        textarea.scrollTop = top;
        setScrollTop(top);
        if (gutterRef.current) {
            gutterRef.current.scrollTop = top;
        }
        if (highlightRef.current) {
            highlightRef.current.scrollTop = top;
        }
    }, [activeLine, jumpToken]); // eslint-disable-line react-hooks/exhaustive-deps

    function syncScroll() {
        const textarea = textareaRef.current;
        if (!textarea) {
            return;
        }
        setScrollTop(textarea.scrollTop);
        if (gutterRef.current) {
            gutterRef.current.scrollTop = textarea.scrollTop;
        }
        if (highlightRef.current) {
            highlightRef.current.scrollTop = textarea.scrollTop;
            highlightRef.current.scrollLeft = textarea.scrollLeft;
        }
    }

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            onRunShortcut?.();
            return;
        }
        if (event.key === "Tab") {
            event.preventDefault();
            const textarea = event.currentTarget;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const next = `${value.slice(0, start)}    ${value.slice(end)}`;
            onChange(next);
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = start + 4;
                    textareaRef.current.selectionEnd = start + 4;
                }
            });
        }
    }

    return (
        <div className="tempo-code-wrap">
            <pre ref={gutterRef} className="tempo-gutter" aria-hidden="true">
                {gutterText}
            </pre>
            <div className="tempo-code-input">
                {activeLine > 0 && (
                    <div
                        className="tempo-line-focus"
                        aria-hidden="true"
                        style={{ top: `${12 + (activeLine - 1) * 21 - scrollTop}px` }}
                    />
                )}
                <pre ref={highlightRef} className="tempo-highlight" aria-hidden="true">
                    {tokens.map((tok, idx) =>
                        tok.kind ? (
                            <span key={idx} className={`tok-${tok.kind}`}>
                                {tok.text}
                            </span>
                        ) : (
                            tok.text
                        ),
                    )}
                </pre>
                <textarea
                    ref={textareaRef}
                    className="tempo-textarea"
                    aria-label="Python sequence source"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    wrap="off"
                    value={value}
                    onScroll={syncScroll}
                    onKeyDown={handleKeyDown}
                    onChange={(event) => {
                        onClearActiveLine?.();
                        onChange(event.target.value);
                    }}
                />
            </div>
        </div>
    );
}
