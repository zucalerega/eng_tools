import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { FIND_BOX, type Commands } from "./commands";
import { findInDocument, type Found } from "./find";
import { useEditor, type EditorStore } from "./store";

// Finding a part on the drawing (Ctrl+F): type a tag (PUREG, PT-101) or what it is, and pick it from the list, or press
// Enter for the first: the view goes to it, and it's selected. It looks through all the diagram's pages, and goes to
// the page what's picked is on.

export function FindBox({ store, commands }: { store: EditorStore; commands: Commands }) {
    const document = useEditor(store, (state) => state.document);
    const page = useEditor(store, (state) => state.page);
    const [text, setText] = useState("");
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const list = useId();
    const found = useMemo(() => findInDocument(document, text, page), [document, text, page]);
    const pages = document.pages.length > 1;
    const showing = open && text.trim() !== "";

    function go(entry: Found | undefined) {
        if (entry) {
            commands.goTo(entry.page, [entry.id]);
            setOpen(false);
        }
    }

    function onKey(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : found.length - 1;
            setActive((now) => (found.length ? (now + step) % found.length : 0));
        } else if (event.key === "Enter") {
            event.preventDefault();
            go(found[active]);
        } else if (event.key === "Escape") {
            setText("");
            setOpen(false);
            event.currentTarget.blur();
        }
    }

    return (
        <div className="piper-find">
            <input
                id={FIND_BOX}
                type="search"
                role="combobox"
                aria-label="Find on the drawing"
                aria-expanded={showing}
                aria-controls={list}
                aria-activedescendant={showing && found[active] ? `${list}-${active}` : undefined}
                autoComplete="off"
                placeholder="Find a tag: PT-101"
                title="Find a part or a line on the drawing by its tag, or what it is (Ctrl+F)"
                value={text}
                onChange={(event) => {
                    setText(event.target.value);
                    setActive(0);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={onKey}
            />
            {showing && (
                <div className="piper-find-pop">
                    {found.length === 0 ? (
                        <p className="muted piper-small">
                            Nothing on {pages ? "any of its pages" : "this drawing"} has that.
                        </p>
                    ) : (
                        <ul id={list} role="listbox" aria-label="Found on the drawing">
                            {found.map((entry, index) => (
                                <li
                                    key={entry.id}
                                    id={`${list}-${index}`}
                                    role="option"
                                    aria-selected={index === active}
                                    onMouseDown={(event) => {
                                        event.preventDefault(); // the box keeps its focus as it's picked
                                        go(entry);
                                    }}
                                    onMouseEnter={() => setActive(index)}
                                >
                                    <strong>{entry.tag || "Untagged"}</strong>
                                    <span className="muted">
                                        {entry.what}
                                        {pages && `, on ${document.pages[entry.page]?.name ?? "a page"}`}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
