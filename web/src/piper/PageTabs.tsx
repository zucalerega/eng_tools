import { useState } from "react";
import { Dialog, MenuButton } from "../components";
import type { Commands } from "./commands";
import { newId, type Document, type Page } from "./drawing";
import { useEditor, type EditorStore } from "./store";

// The diagram's pages, as tabs under the drawing, as a P&ID's sheets are: the vehicle on one, the ground systems on
// another. A tab goes to its page; the page's menu renames, moves, or deletes it, and + adds one. Each is a change to
// the drawing, undone as any is. While a revision's looked at, the tabs only go between its pages.

export function PageTabs({
    store,
    commands,
    looking,
    editing,
}: {
    store: EditorStore;
    commands: Commands;
    looking: { pages: Page[]; at: number; onGo: (index: number) => void } | null; // a revision's pages, looked at
    editing: boolean;
}) {
    const own = useEditor(store, (state) => state.document.pages);
    const page = useEditor(store, (state) => state.page);
    const pages = looking?.pages ?? own;
    const [renaming, setRenaming] = useState<number | null>(null);
    const [deleting, setDeleting] = useState<number | null>(null);
    const at = looking?.at ?? page;
    const now = () => store.getState().document;

    function add() {
        const document = now();
        const blank: Page = { id: newId("g"), name: nextName(document), parts: [], lines: [], sheet: null };
        store.commitDocument({ ...document, pages: [...document.pages, blank] }, document.pages.length);
        commands.fit();
    }

    function move(index: number, by: -1 | 1) {
        const document = now();
        const pages = [...document.pages];
        const [moved] = pages.splice(index, 1);
        pages.splice(index + by, 0, moved!);
        store.commitDocument({ ...document, pages }, index + by);
    }

    function remove(index: number) {
        const document = now();
        const gone = document.pages[index]!.id;
        // Off-page connectors to it go nowhere now: they keep their words.
        const pages = document.pages
            .filter((_, at) => at !== index)
            .map((page) => ({
                ...page,
                parts: page.parts.map((part) =>
                    part.kind === "offpage" && part.props.page === gone
                        ? { ...part, props: { ...part.props, page: "", part: "" } }
                        : part,
                ),
            }));
        store.commitDocument({ ...document, pages }, Math.min(index, pages.length - 1));
        commands.fit();
    }

    return (
        <div className="piper-pages" role="tablist" aria-label="Pages">
            {pages.map((entry, index) => (
                <div key={entry.id} className={`piper-page-tab ${index === at ? "piper-page-tab-on" : ""}`}>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={index === at}
                        title={editing && index === at ? "Double-click to rename it" : undefined}
                        onClick={() => (looking ? looking.onGo(index) : commands.goTo(index))}
                        onDoubleClick={() => editing && setRenaming(index)}
                    >
                        {entry.name}
                    </button>
                    {editing && index === at && (
                        <MenuButton
                            label="⋯"
                            name={`${entry.name}'s menu`}
                            align="left"
                            items={[
                                { label: "Rename…", onSelect: () => setRenaming(index) },
                                ...(index > 0 ? [{ label: "Move left", onSelect: () => move(index, -1) }] : []),
                                ...(index < pages.length - 1
                                    ? [{ label: "Move right", onSelect: () => move(index, 1) }]
                                    : []),
                                ...(pages.length > 1
                                    ? [
                                          {
                                              label: "Delete…",
                                              onSelect: () =>
                                                  entry.parts.length + entry.lines.length > 0
                                                      ? setDeleting(index)
                                                      : remove(index),
                                          },
                                      ]
                                    : []),
                            ]}
                        />
                    )}
                </div>
            ))}
            {editing && (
                <button
                    type="button"
                    className="piper-page-add"
                    title="Add a page"
                    aria-label="Add a page"
                    onClick={add}
                >
                    +
                </button>
            )}
            {renaming !== null && pages[renaming] && (
                <RenamePage
                    name={pages[renaming].name}
                    onCancel={() => setRenaming(null)}
                    onRename={(name) => {
                        const document = now();
                        store.commitDocument({
                            ...document,
                            pages: document.pages.map((page, at) => (at === renaming ? { ...page, name } : page)),
                        });
                        setRenaming(null);
                    }}
                />
            )}
            {deleting !== null && pages[deleting] && (
                <Dialog
                    title={`Delete ${pages[deleting].name}?`}
                    confirm="Delete"
                    danger
                    onCancel={() => setDeleting(null)}
                    onConfirm={() => {
                        remove(deleting);
                        setDeleting(null);
                    }}
                >
                    <p>
                        Its {count(pages[deleting].parts.length, "part")} and{" "}
                        {count(pages[deleting].lines.length, "line")} go with it. Undo (Ctrl+Z) brings it back, and its
                        revisions keep it.
                    </p>
                </Dialog>
            )}
        </div>
    );
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** A new page's name: the next "Page n" that isn't taken. */
function nextName(document: Document): string {
    const taken = new Set(document.pages.map((page) => page.name.toLowerCase()));
    let number = document.pages.length + 1;
    while (taken.has(`page ${number}`)) {
        number++;
    }
    return `Page ${number}`;
}

function RenamePage({
    name,
    onRename,
    onCancel,
}: {
    name: string;
    onRename: (name: string) => void;
    onCancel: () => void;
}) {
    const [text, setText] = useState(name);
    const trimmed = text.trim();
    return (
        <Dialog
            title="Rename the page"
            confirm="Rename"
            disabled={!trimmed}
            onConfirm={() => onRename(trimmed)}
            onCancel={onCancel}
        >
            <label className="field">
                Name
                <input
                    value={text}
                    maxLength={60}
                    autoFocus
                    onChange={(event) => setText(event.target.value)}
                    placeholder="P&ID, GSE, Sheet 2"
                />
            </label>
        </Dialog>
    );
}
