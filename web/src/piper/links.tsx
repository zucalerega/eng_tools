import { useState } from "react";
import type { Palette } from "./colors";
import {
    linkName,
    linkUrl,
    MAX_LINK_LABEL,
    MAX_LINK_URL,
    MAX_LINKS,
    readLinks,
    type Drawing,
    type Part,
    type PartLink,
} from "./drawing";
import { boxOf } from "./library/index";

// Links on parts, to pages about them (a valve's Notion page, its spec sheet): listed in the inspector, to open and,
// while the diagram's yours to edit, to add and remove; and marked on the canvas. Only http, https, and mailto links
// (drawing.ts linkUrl), as the server keeps only those.

/**
 * A part's links, to pages about it (its Notion page, its spec sheet, someone to email): each opens in a tab of its
 * own, for anyone looking at the diagram. While it's yours to edit, links are added and removed; only http, https, and
 * mailto ones are taken (linkUrl), as only those are the server's to keep.
 */
export function PartLinks({
    part,
    editing,
    onChange,
}: {
    part: Part;
    editing: boolean;
    onChange: (links: PartLink[]) => void;
}) {
    const links = readLinks(part.links); // only those that are links: never one that would run in the site
    const [adding, setAdding] = useState(false);
    const [label, setLabel] = useState("");
    const [address, setAddress] = useState("");
    if (links.length === 0 && !editing) {
        return null;
    }
    const url = linkUrl(address);
    return (
        <section className="piper-links" aria-label="Links">
            <h3>Links</h3>
            {links.length > 0 && (
                <ul>
                    {links.map((link, index) => {
                        const name = link.label || linkName(link.url);
                        return (
                            <li key={index}>
                                <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
                                    {name}
                                </a>
                                {editing && (
                                    <button
                                        type="button"
                                        className="piper-remove"
                                        aria-label={`Remove the link ${name}`}
                                        title="Remove this link"
                                        onClick={() => onChange(links.filter((_, at) => at !== index))}
                                    >
                                        ×
                                    </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            {editing &&
                links.length < MAX_LINKS &&
                (adding ? (
                    <form
                        className="piper-link-form"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (url) {
                                onChange([...links, { label: label.trim(), url }]);
                                setLabel("");
                                setAddress("");
                                setAdding(false);
                            }
                        }}
                    >
                        <input
                            autoFocus
                            aria-label="Link's name"
                            placeholder="Notion page, spec sheet…"
                            value={label}
                            maxLength={MAX_LINK_LABEL}
                            onChange={(event) => setLabel(event.target.value)}
                        />
                        <input
                            aria-label="Link's address"
                            placeholder="https://…"
                            value={address}
                            maxLength={MAX_LINK_URL}
                            onChange={(event) => setAddress(event.target.value)}
                        />
                        {address.trim() && !url && (
                            <p className="piper-warning">
                                A link starts with https://, http://, or mailto:, and has no spaces in it.
                            </p>
                        )}
                        <div className="piper-link-buttons">
                            <button type="submit" className="button-small" disabled={!url}>
                                Add link
                            </button>
                            <button type="button" className="button-small" onClick={() => setAdding(false)}>
                                Cancel
                            </button>
                        </div>
                    </form>
                ) : (
                    <button type="button" className="button-small piper-add-field" onClick={() => setAdding(true)}>
                        + Add a link
                    </button>
                ))}
        </section>
    );
}

/** A link's mark: two links of a chain. */
const CHAIN =
    "M-0.6 1.6 L-2 3 A1.7 1.7 0 0 1 -4.4 0.6 L-3 -0.8 M0.6 -1.6 L2 -3 A1.7 1.7 0 0 1 4.4 -0.6 L3 0.8 M-1.3 1.3 L1.3 -1.3";

/**
 * A mark at the top right of each part with links (pages about it), its tooltip their names: a click there selects the
 * part, whose links the inspector opens. Only on the canvas: not in an export, where it would open nothing.
 */
export function LinkMarks({ drawing, palette }: { drawing: Drawing; palette: Palette }) {
    return (
        <>
            {drawing.parts
                .map((part) => ({ part, links: readLinks(part.links) }))
                .filter(({ links }) => links.length > 0)
                .map(({ part, links }) => {
                    const box = boxOf(part, drawing);
                    return (
                        <g
                            key={part.id}
                            className="piper-link-mark"
                            data-hit={`part:${part.id}`}
                            data-links={part.id}
                            transform={`translate(${box.x1 + 3} ${box.y0 - 3})`}
                        >
                            <title>{links.map((link) => link.label || linkName(link.url)).join("\n")}</title>
                            <circle r={6.5} fill={palette.paper} stroke={palette.select} strokeWidth={1.2} />
                            <path
                                d={CHAIN}
                                fill="none"
                                stroke={palette.select}
                                strokeWidth={1.3}
                                strokeLinecap="round"
                            />
                        </g>
                    );
                })}
        </>
    );
}
