import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { usePopover } from "./components";
import { tidyFolder } from "./pathTree";

// Picking from folders as the pages of things in folders browse them (Yorg's datasets, Piper's diagrams): a dropdown
// that opens in a folder, lists its folders and what's in it, goes into a folder with a click and back up by the path
// above, and finds anything in any folder by a few words. ItemPicker picks something in a folder (a test to compare
// with); FolderChooser picks a folder (to keep a view in), and can make a new one where it's open. Folders are a tree
// by keys of their own, a tree's ids or paths (pathFolders), so the same dropdown serves both kinds.

/** A folder to browse: in another (parent) or at the top (null). */
export interface BrowseFolder {
    key: string;
    parent: string | null;
    name: string;
}

/** Something in a folder (null: at the top), to pick or to see there. */
export interface BrowseItem {
    key: string;
    name: string;
    folder: string | null;
    note?: string; // said beside its name: when it was added, say
}

interface Tree {
    byKey: ReadonlyMap<string, BrowseFolder>;
    folders: ReadonlyMap<string | null, BrowseFolder[]>; // each folder's folders, by name
    items: ReadonlyMap<string | null, BrowseItem[]>; // each folder's things, in the order they came
    counts: ReadonlyMap<string, number>; // the things in each folder and in its folders
}

const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function add<K, V>(map: Map<K, V[]>, key: K, value: V) {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}

function treeOf(folders: readonly BrowseFolder[], items: readonly BrowseItem[]): Tree {
    const byKey = new Map(folders.map((one) => [one.key, one] as const));
    // A folder or thing in a folder that isn't listed is shown at the top, rather than nowhere.
    const placed = (key: string | null) => (key !== null && byKey.has(key) ? key : null);
    const inFolders = new Map<string | null, BrowseFolder[]>();
    folders.forEach((one) => add(inFolders, placed(one.parent), one));
    inFolders.forEach((list) => list.sort(byName));
    const inItems = new Map<string | null, BrowseItem[]>();
    const counts = new Map<string, number>();
    for (const item of items) {
        add(inItems, placed(item.folder), item);
        for (const one of trail(placed(item.folder), byKey)) {
            counts.set(one.key, (counts.get(one.key) ?? 0) + 1);
        }
    }
    return { byKey, folders: inFolders, items: inItems, counts };
}

/** The folders from the top down to one (none, for the top). */
function trail(key: string | null, byKey: ReadonlyMap<string, BrowseFolder>): BrowseFolder[] {
    const path: BrowseFolder[] = [];
    for (
        let at = key === null ? undefined : byKey.get(key);
        at && path.length < 100; // a folder can't be in itself, but a path never goes on forever
        at = at.parent === null ? undefined : byKey.get(at.parent)
    ) {
        path.unshift(at);
    }
    return path;
}

/** Where a folder is, for a search's results and a chooser's button: "Hotfires / HF-3". */
const pathText = (key: string | null, tree: Tree): string =>
    trail(key, tree.byKey)
        .map((one) => one.name)
        .join(" / ");

/** Folders that are only paths ("Hotfires/HF-3", Yorg's scripts'), as a tree: each folder's key is its path. */
export function pathFolders(paths: readonly string[]): BrowseFolder[] {
    const all = new Map<string, BrowseFolder>();
    for (const path of paths) {
        const parts = tidyFolder(path).split("/").filter(Boolean);
        parts.forEach((name, index) => {
            const key = parts.slice(0, index + 1).join("/");
            if (!all.has(key.toLowerCase())) {
                all.set(key.toLowerCase(), { key, name, parent: index === 0 ? null : parts.slice(0, index).join("/") });
            }
        });
    }
    return [...all.values()];
}

const NOTHING: BrowseItem[] = [];

const wordsOf = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

/** What a dropdown shows inside: the path above, a box to find things in, and a folder's folders and things. */
function Browser({
    label,
    tree,
    top,
    at,
    onGo,
    picking,
    chosen,
    onItem,
    findLabel,
    empty,
    loading,
    problem,
    footer,
    onClose,
}: {
    label: string;
    tree: Tree;
    top: string;
    at: string | null;
    onGo: (folder: string | null) => void;
    picking: "items" | "folders";
    chosen: string | null;
    onItem: (item: BrowseItem) => void;
    findLabel: string;
    empty: string;
    loading: boolean;
    problem: string | null;
    footer?: ReactNode;
    onClose: () => void;
}) {
    const [find, setFind] = useState("");
    const words = wordsOf(find);
    const searching = words.length > 0;
    const path = trail(at, tree.byKey);

    const folderRow = (one: BrowseFolder, where?: string) => (
        <li key={`folder:${one.key}`}>
            <button
                type="button"
                className="folder-browser-row"
                aria-label={`${where ? `${where} / ` : ""}${one.name}: folder`}
                onClick={() => {
                    setFind("");
                    onGo(one.key);
                }}
            >
                <span className="file-icon file-icon-folder" aria-hidden="true" />
                <span className="folder-browser-name">
                    {one.name}
                    {where && <span className="folder-browser-where">in {where}</span>}
                </span>
                <span className="folder-browser-note">{tree.counts.get(one.key) ?? 0}</span>
            </button>
        </li>
    );
    const itemRow = (item: BrowseItem, where?: string) =>
        picking === "items" ? (
            <li key={`item:${item.key}`}>
                <button
                    type="button"
                    className="folder-browser-row"
                    aria-current={item.key === chosen ? "true" : undefined}
                    onClick={() => onItem(item)}
                >
                    <span className="folder-browser-name">
                        {item.name}
                        {where !== undefined && <span className="folder-browser-where">in {where || top}</span>}
                    </span>
                    {item.note && <span className="folder-browser-note">{item.note}</span>}
                </button>
            </li>
        ) : (
            <li key={`item:${item.key}`} className="folder-browser-item muted">
                <span className="folder-browser-name">{item.name}</span>
            </li>
        );

    let rows: ReactNode[];
    if (searching) {
        const match = (text: string) => words.every((word) => text.toLowerCase().includes(word));
        rows =
            picking === "items"
                ? [...tree.items].flatMap(([folder, list]) => {
                      const where = pathText(folder, tree);
                      return list
                          .filter((item) => match(`${item.name} ${item.note ?? ""} ${where}`))
                          .map((item) => itemRow(item, where));
                  })
                : [...tree.byKey.values()]
                      .filter((one) => match(one.name))
                      .sort(byName)
                      .map((one) => folderRow(one, pathText(one.parent, tree) || top));
    } else {
        rows = [
            ...(tree.folders.get(at) ?? []).map((one) => folderRow(one)),
            ...(tree.items.get(at) ?? []).map((item) => itemRow(item)),
        ];
    }

    // The arrows go between the box and the rows; Enter in the box takes the first row; Escape closes this, not a
    // dialog it's in.
    function onKey(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
            return;
        }
        const stops = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(".folder-browser-find, .folder-browser-row"),
        ];
        const now = stops.indexOf(document.activeElement as HTMLElement);
        const next = Math.max(0, Math.min(stops.length - 1, now + (event.key === "ArrowDown" ? 1 : -1)));
        event.preventDefault();
        stops[next]?.focus();
    }

    return (
        <div className="menu menu-left folder-browser-pop" role="dialog" aria-label={label} onKeyDown={onKey}>
            {/* Once the folders are in: before, the way to the start folder isn't known. */}
            <nav className="folder-browser-path" aria-label={`${label}: where`} hidden={loading}>
                {path.length === 0 ? (
                    <strong>{top}</strong>
                ) : (
                    <button type="button" className="folder-browser-up" onClick={() => onGo(null)}>
                        {top}
                    </button>
                )}
                {path.map((one, index) => (
                    <span key={one.key}>
                        <span className="separator" aria-hidden="true">
                            /
                        </span>
                        {index === path.length - 1 ? (
                            <strong>{one.name}</strong>
                        ) : (
                            <button type="button" className="folder-browser-up" onClick={() => onGo(one.key)}>
                                {one.name}
                            </button>
                        )}
                    </span>
                ))}
            </nav>
            <input
                className="folder-browser-find"
                type="search"
                autoFocus
                aria-label={findLabel}
                placeholder={`${findLabel}, in every folder`}
                value={find}
                onChange={(event) => setFind(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault(); // not the dialog's button
                        event.currentTarget.parentElement?.querySelector<HTMLElement>(".folder-browser-row")?.click();
                    }
                }}
            />
            {problem ? (
                <p className="field-problem folder-browser-empty">{problem}</p>
            ) : loading ? (
                <p className="muted folder-browser-empty">Loading…</p>
            ) : rows.length === 0 ? (
                <p className="muted folder-browser-empty">{searching ? "Nothing has that." : empty}</p>
            ) : (
                <ul className="folder-browser-list">{rows}</ul>
            )}
            {footer}
        </div>
    );
}

/**
 * A button that opens a dropdown of things in folders to pick one from: opened in the start folder (the folder of what
 * it's picked to go with), with the chosen one marked.
 */
export function ItemPicker({
    label,
    button,
    buttonClass = "",
    folders,
    items,
    start = null,
    chosen = null,
    top,
    findLabel = "Find",
    empty = "Nothing here",
    problem = null,
    disabled = false,
    onOpen,
    onPick,
}: {
    label: string; // the dropdown's name: "Compare with"
    button: ReactNode; // what its button says: "Compare with another dataset", or what's chosen
    buttonClass?: string;
    folders: readonly BrowseFolder[] | null; // null: still loading
    items: readonly BrowseItem[] | null;
    start?: string | null;
    chosen?: string | null;
    top: string; // the top, by its page's name: "Datasets"
    findLabel?: string; // "Find a dataset"
    empty?: string; // what an empty folder says
    problem?: string | null; // why the folders or things couldn't be listed
    disabled?: boolean;
    onOpen?: () => void; // the first time it opens, say: to list what's in it
    onPick: (key: string) => void;
}) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const [at, setAt] = useState<string | null>(start);
    const tree = useMemo(() => treeOf(folders ?? [], items ?? []), [folders, items]);
    const show = (now: boolean) => {
        if (now) {
            setAt(start);
            onOpen?.();
        }
        setOpen(now);
    };
    const close = () => {
        setOpen(false);
        within.current?.querySelector<HTMLElement>(".folder-browser-button")?.focus();
    };
    return (
        <div className="popover folder-browser" ref={within}>
            <button
                type="button"
                className={`folder-browser-button ${buttonClass}`}
                aria-haspopup="dialog"
                aria-expanded={open}
                disabled={disabled}
                onClick={() => show(!open)}
            >
                <span className="folder-browser-chosen">{button}</span>
                <span className="folder-browser-caret" aria-hidden="true">
                    ▾
                </span>
            </button>
            {open && (
                <Browser
                    label={label}
                    tree={tree}
                    top={top}
                    at={at !== null && tree.byKey.has(at) ? at : null}
                    onGo={setAt}
                    picking="items"
                    chosen={chosen}
                    onItem={(item) => {
                        close();
                        onPick(item.key);
                    }}
                    findLabel={findLabel}
                    empty={empty}
                    loading={folders === null || items === null}
                    problem={problem}
                    onClose={close}
                />
            )}
        </div>
    );
}

/**
 * A folder, chosen from a dropdown of the folders there are, opened where it is: going into a folder and Choose
 * picks it. A new one can be made in the folder it's open in (when onNewFolder is given), which is then chosen.
 */
export function FolderChooser({
    label,
    folders,
    value,
    onChange,
    top,
    items = NOTHING,
    onNewFolder,
    disabled = false,
}: {
    label: string; // the field's name: "Folder"
    folders: readonly BrowseFolder[];
    value: string | null; // the chosen folder's key; null: the top
    onChange: (folder: string | null) => void;
    top: string; // the top, by its page's name: "Views"
    items?: readonly BrowseItem[]; // what's in the folders already, to see where things are
    onNewFolder?: (parent: string | null, name: string) => Promise<string>; // makes it, and says its key
    disabled?: boolean;
}) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const [at, setAt] = useState<string | null>(value);
    const [naming, setNaming] = useState<string | null>(null); // a new folder's name, while it's typed
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const tree = useMemo(() => treeOf(folders, items), [folders, items]);
    const here = at !== null && tree.byKey.has(at) ? at : null;
    const close = () => {
        setOpen(false);
        within.current?.querySelector<HTMLElement>(".folder-browser-button")?.focus();
    };
    const choose = (folder: string | null) => {
        onChange(folder);
        close();
    };
    async function make() {
        const name = (naming ?? "").trim();
        if (!name || !onNewFolder) {
            return;
        }
        setBusy(true);
        setProblem(null);
        try {
            const made = await onNewFolder(here, name);
            setNaming(null);
            choose(made);
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }
    const shown = value !== null && tree.byKey.has(value) ? value : null;
    const footer = (
        <div className="folder-browser-foot">
            {naming === null ? (
                <>
                    {onNewFolder && (
                        <button type="button" className="button-small" onClick={() => setNaming("")}>
                            New folder
                        </button>
                    )}
                    <button type="button" className="button-small button-primary" onClick={() => choose(here)}>
                        Choose {here === null ? top : tree.byKey.get(here)!.name}
                    </button>
                </>
            ) : (
                <>
                    <input
                        autoFocus
                        aria-label="The new folder's name"
                        placeholder={`A new folder in ${here === null ? top : tree.byKey.get(here)!.name}`}
                        maxLength={200}
                        value={naming}
                        disabled={busy}
                        onChange={(event) => setNaming(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault(); // not the dialog's button
                                void make();
                            }
                        }}
                    />
                    <button
                        type="button"
                        className="button-small button-primary"
                        disabled={busy || !naming.trim()}
                        onClick={() => void make()}
                    >
                        Make it
                    </button>
                    <button type="button" className="button-small" onClick={() => setNaming(null)}>
                        Cancel
                    </button>
                </>
            )}
            {problem && <p className="field-problem">{problem}</p>}
        </div>
    );
    return (
        <div className="popover folder-browser" ref={within}>
            <button
                type="button"
                className="folder-browser-button"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={`${label}: ${shown === null ? top : pathText(shown, tree)}`}
                disabled={disabled}
                onClick={() => {
                    if (!open) {
                        setAt(value);
                        setNaming(null);
                        setProblem(null);
                    }
                    setOpen(!open);
                }}
            >
                <span className="file-icon file-icon-folder" aria-hidden="true" />
                <span className="folder-browser-chosen">
                    {shown === null ? <span className="muted">{top} (the top)</span> : pathText(shown, tree)}
                </span>
                <span className="folder-browser-caret" aria-hidden="true">
                    ▾
                </span>
            </button>
            {open && (
                <Browser
                    label={label}
                    tree={tree}
                    top={top}
                    at={here}
                    onGo={setAt}
                    picking="folders"
                    chosen={null}
                    onItem={() => {}}
                    findLabel="Find a folder"
                    empty="No folders in it"
                    loading={false}
                    problem={null}
                    footer={footer}
                    onClose={close}
                />
            )}
        </div>
    );
}
