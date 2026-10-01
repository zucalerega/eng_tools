import { pythonLanguage } from "@codemirror/lang-python";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { useMemo, useState, type ReactNode } from "react";
import { REFERENCE, type Entry } from "./docs";

// The yorg module's reference (docs.ts), beside a notebook: each of its names, what it does, found by a word,
// and opened for more and an example to put in the code (onInsert: after the line the cursor's on, in the cell last
// written in).

interface Props {
    onInsert: (code: string) => void;
}

/** Code, coloured as the editor colours it (scripts.css has the .tok-* colours). */
function Highlighted({ code }: { code: string }) {
    const parts = useMemo(() => {
        const found: ReactNode[] = [];
        highlightCode(
            code,
            pythonLanguage.parser.parse(code),
            classHighlighter,
            (text, classes) =>
                found.push(
                    classes ? (
                        <span key={found.length} className={classes}>
                            {text}
                        </span>
                    ) : (
                        text
                    ),
                ),
            () => found.push("\n"),
        );
        return found;
    }, [code]);
    return (
        <pre className="reference-code">
            <code>{parts}</code>
        </pre>
    );
}

/** How code says it, its name standing out: yorg.channel(name, dataset=None), await yorg.load(...). */
function Usage({ entry }: { entry: Entry }) {
    if (entry.of === null) {
        return <span className="reference-title">{entry.name}</span>;
    }
    return (
        <code className="reference-usage">
            {entry.kind === "async" && <span className="reference-quiet">await </span>}
            <span className="reference-quiet">{entry.of}.</span>
            <span className="reference-name">{entry.name}</span>
            {entry.signature && <span className="reference-quiet">{entry.signature}</span>}
        </code>
    );
}

const has = (texts: (string | null | undefined)[], words: string[]) => {
    const text = texts.join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
};

/** What a search finds: the names it's in, if it's in any (plot: yorg.plot, not all that mention plots), else the words. */
function found(words: string[]): (entry: Entry) => boolean {
    const named = (entry: Entry) => has([entry.of, entry.name], words);
    if (words.length === 0) {
        return () => true;
    }
    return REFERENCE.some((section) => section.entries.some(named))
        ? named
        : (entry) => has([entry.of, entry.name, entry.signature, entry.summary, entry.details], words);
}

export function Reference({ onInsert }: Props) {
    const [find, setFind] = useState("");
    const [opened, setOpened] = useState<Set<string>>(() => new Set());
    const wanted = found(find.trim().toLowerCase().split(/\s+/).filter(Boolean));
    const sections = REFERENCE.map((section) => ({ ...section, entries: section.entries.filter(wanted) })).filter(
        (section) => section.entries.length > 0,
    );

    function toggle(key: string) {
        setOpened((now) => {
            const next = new Set(now);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }

    return (
        <aside className="reference" aria-label="Reference">
            <p className="reference-intro muted">
                The <code>yorg</code> module: your code&apos;s way to Yorg&apos;s tests. Hover a name in the code for
                its help there too.
            </p>
            <input
                className="reference-find"
                type="search"
                placeholder="Find in yorg"
                aria-label="Find in the reference"
                value={find}
                onChange={(event) => setFind(event.target.value)}
            />
            {sections.length === 0 && <p className="muted">Nothing in yorg has that.</p>}
            {sections.map((section) => (
                <section key={section.title} className="reference-section" aria-label={section.title}>
                    <h3>{section.title}</h3>
                    <ul>
                        {section.entries.map((entry) => {
                            const key = `${entry.of ?? ""}.${entry.name}`;
                            const more = Boolean(entry.details || entry.example);
                            const open = more && opened.has(key);
                            const head = (
                                <>
                                    <Usage entry={entry} />
                                    <span className="reference-summary">{entry.summary}</span>
                                </>
                            );
                            return (
                                <li key={key} className={open ? "reference-open" : undefined}>
                                    {more ? (
                                        <button
                                            type="button"
                                            className="reference-entry"
                                            aria-expanded={open}
                                            onClick={() => toggle(key)}
                                        >
                                            {head}
                                        </button>
                                    ) : (
                                        <div className="reference-entry">{head}</div>
                                    )}
                                    {open && (
                                        <div className="reference-more">
                                            {entry.details && <p>{entry.details}</p>}
                                            {entry.example && (
                                                <div className="reference-example">
                                                    <div className="reference-example-head">
                                                        <span>Example</span>
                                                        <button
                                                            type="button"
                                                            className="button-small"
                                                            aria-label={`Insert the example of ${entry.of ? `${entry.of}.` : ""}${entry.name}`}
                                                            title="Put it in the code: after the line the cursor's on"
                                                            onClick={() => onInsert(entry.example!)}
                                                        >
                                                            Insert
                                                        </button>
                                                    </div>
                                                    <Highlighted code={entry.example} />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ))}
        </aside>
    );
}
