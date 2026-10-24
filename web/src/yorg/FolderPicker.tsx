import { useId, useRef, useState, type KeyboardEvent } from "react";
import { tidyFolder } from "../pathTree";

// The folder of a saved view or a script: one there is, picked from the list (which opens as you click or type, and
// keeps to what's typed), or a path typed for a new one ("Hotfires/HF-4"). "" is no folder: at the top.

interface Props {
    value: string;
    onChange: (folder: string) => void;
    folders: string[]; // the folders there are (pathTree.foldersOf)
    label?: string; // its name, for screen readers
    placeholder?: string;
    className?: string;
}

export function FolderPicker({
    value,
    onChange,
    folders,
    label = "Folder",
    placeholder = "No folder",
    className = "",
}: Props) {
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState<number | null>(null); // the option the arrows (or the mouse) are on
    const list = useId();
    const input = useRef<HTMLInputElement>(null);
    const typed = tidyFolder(value);
    const known = folders.some((folder) => folder.toLowerCase() === typed.toLowerCase());
    // Every folder while what's typed is one there is (or nothing is), else those with what's typed in them.
    const shown = [
        "",
        ...(typed && !known ? folders.filter((folder) => folder.toLowerCase().includes(typed.toLowerCase())) : folders),
    ];

    function pick(folder: string) {
        onChange(folder);
        setOpen(false);
    }

    function onKey(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : shown.length - 1;
            setActive(
                active === null ? (event.key === "ArrowDown" ? 0 : shown.length - 1) : (active + step) % shown.length,
            );
        } else if (event.key === "Enter" && open) {
            // The option the arrows are on; with none, what's typed stays (a new folder, maybe).
            event.preventDefault(); // this, not the dialog's button
            if (active !== null && active < shown.length) {
                pick(shown[active]!);
            } else {
                setOpen(false);
            }
        } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation(); // close the list, not the dialog
            setOpen(false);
        }
    }

    return (
        <div className={`folder-picker ${className}`}>
            <input
                ref={input}
                role="combobox"
                aria-label={label}
                aria-expanded={open}
                aria-controls={list}
                aria-autocomplete="list"
                aria-activedescendant={open && active !== null ? `${list}-${active}` : undefined}
                autoComplete="off"
                value={value}
                maxLength={300}
                placeholder={placeholder}
                onChange={(event) => {
                    onChange(event.target.value);
                    setOpen(true);
                    setActive(null);
                }}
                onClick={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={onKey}
            />
            <button
                type="button"
                className="folder-picker-toggle"
                tabIndex={-1}
                aria-label={`${label}: the folders there are`}
                onMouseDown={(event) => {
                    event.preventDefault(); // keep the box's focus
                    setOpen(!open);
                    input.current?.focus();
                }}
            >
                ▾
            </button>
            {open && (
                <div className="folder-picker-pop">
                    <ul id={list} role="listbox" aria-label={`${label}s`}>
                        {shown.map((folder, index) => (
                            <li
                                key={folder || "(the top)"}
                                id={`${list}-${index}`}
                                role="option"
                                aria-selected={index === active}
                                className={index === active ? "folder-picker-active" : undefined}
                                onMouseDown={(event) => {
                                    event.preventDefault(); // the box keeps its focus as it's picked
                                    pick(folder);
                                }}
                                onMouseEnter={() => setActive(index)}
                            >
                                {folder ? (
                                    <>
                                        <span className="file-icon file-icon-folder" aria-hidden="true" />
                                        {folder.split("/").join(" / ")}
                                    </>
                                ) : (
                                    <span className="muted">No folder</span>
                                )}
                            </li>
                        ))}
                    </ul>
                    {typed && !known && <p className="folder-picker-new muted">A new folder: {typed}</p>}
                </div>
            )}
        </div>
    );
}
