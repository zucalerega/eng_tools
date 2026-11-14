import { useState } from "react";
import { Link } from "../../router";
import { caliperUrl, titleBeside } from "../paths";
import { useVault } from "../store";
import type { Node, Source, Why } from "./model";

// What a component that draws nothing says beside its name (its full reason is the tag's title).
const TAGS: Record<Why, string> = {
    absent: "Not in the vault",
    elsewhere: "No components",
    configuration: "No 3D view",
    unreadable: "No 3D view",
    inside: "No shape inside",
    failed: "Didn't load",
};

// Where a part's shape is from, beside its version, in a word; and in full, for its title.
const FROM: Record<Source, [string, string]> = {
    solidworks: ["SW", "From SolidWorks: Vault for SolidWorks made this view there, so it's what SolidWorks showed"],
    view: ["file", "Read from its file: the 3D view SolidWorks saved in it"],
    file: ["file", "Read from its file"],
    cad: ["file", "Its STEP or IGES file, read as it is"],
    solid: [
        "rebuilt",
        "Rebuilt from the solid in its file, which has no saved 3D view of this configuration: its shape and sizes " +
            "are the part's, but colors and cosmetic threads may differ. Checking it in from SolidWorks gives its " +
            "exact view",
    ],
};

/** What a component shows in place of what the assembly has, in a few words and in full; none where it shows that. */
function standIn(node: Node): [string, string] | null {
    if (node.instead && node.file) {
        const { version, configuration, why } = node.instead;
        const older = version !== node.file.version;
        const said = why ? ` ${why}` : "";
        return older
            ? [
                  `Shows v${version}`,
                  `This is v${version}, the version the assembly was checked in with: v${node.file.version} has no ` +
                      `3D view Caliper can show${configuration ? ` in ${node.file.configuration || configuration}` : ""}.${said}`,
              ]
            : [
                  `Shows ${configuration}`,
                  `This is its ${configuration} configuration: its file has no 3D view of ` +
                      `${node.file.configuration}, the one the assembly uses.${said}`,
              ];
    }
    if (node.layout !== undefined && node.file) {
        return [
            `v${node.layout}'s layout`,
            `These are the components it had at v${node.layout}, when the assembly was checked in: v${node.file.version}, ` +
                "its latest, has no 3D view in this configuration yet",
        ];
    }
    return null;
}

// The model's tree, beside the view: an assembly's components (a part's bodies), each with a box to show or hide it,
// and ways to isolate it (show only it) or open it on its own. Clicking one selects it in the view.

export interface TreeProps {
    nodes: Node[];
    hidden: ReadonlySet<string>;
    isolated: ReadonlySet<string> | null;
    selected: string | null;
    open: ReadonlySet<string>;
    toggleOpen(id: string): void;
    toggleHidden(id: string): void;
    isolate(id: string): void;
    select(id: string | null): void;
    zoomTo(id: string): void;
    /** Open a node on its own: an assembly's component in its own Caliper page, or a STEP file's product here. */
    openHere?: (id: string) => void;
}

export function ComponentTree(props: TreeProps) {
    return (
        <ul className="caliper-tree" role="tree" aria-label="Components">
            {props.nodes.map((node) => (
                <Row key={node.id} node={node} depth={0} {...props} />
            ))}
        </ul>
    );
}

function Row({ node, depth, ...props }: TreeProps & { node: Node; depth: number }) {
    const vault = useVault();
    const [hover, setHover] = useState(false);
    const open = props.open.has(node.id);
    const shown = !props.hidden.has(node.id);
    const latest = node.file ? vault.files.get(node.file.id) : undefined;
    const file = latest?.name;
    const titled = latest ? titleBeside(latest) : null; // what its file is called, where the name doesn't say
    const other = standIn(node);
    const from = node.shape && node.source ? FROM[node.source] : null;
    const since = node.pinned !== undefined ? `; the assembly was checked in with v${node.pinned}` : "";
    return (
        <li
            role="treeitem"
            aria-expanded={node.children.length > 0 ? open : undefined}
            aria-selected={props.selected === node.id}
        >
            <div
                className={`caliper-row${props.selected === node.id ? " caliper-row-selected" : ""}`}
                style={{ paddingLeft: `${0.35 + depth * 1.05}rem` }}
                onMouseEnter={() => setHover(true)}
                onMouseLeave={() => setHover(false)}
            >
                {node.children.length > 0 ? (
                    <button
                        type="button"
                        className="disclosure"
                        aria-expanded={open}
                        aria-label={`${open ? "Hide" : "Show"} what's in ${node.name}`}
                        onClick={() => props.toggleOpen(node.id)}
                    />
                ) : (
                    <span className="disclosure-space" />
                )}
                <input
                    type="checkbox"
                    className="caliper-eye"
                    checked={shown}
                    aria-label={`Show ${node.name}`}
                    onChange={() => props.toggleHidden(node.id)}
                />
                <button
                    type="button"
                    className={`caliper-name${shown ? "" : " caliper-name-hidden"}`}
                    title={file && file !== node.name ? `${node.name}: ${latest?.path}` : (latest?.path ?? node.name)}
                    onClick={() => props.select(props.selected === node.id ? null : node.id)}
                    onDoubleClick={() => props.zoomTo(node.id)}
                >
                    <span className={`caliper-kind caliper-kind-${node.kind}`} aria-hidden="true" />
                    {node.name}
                </button>
                {titled && <span className="file-title caliper-title">{titled}</span>}
                {(node.file || from) && (
                    <span
                        className="muted caliper-version"
                        title={[node.file && `v${node.file.version}${since}`, from?.[1]].filter(Boolean).join(". ")}
                    >
                        {node.file && `v${node.file.version}`}
                        {node.file && latest && latest.version !== node.file.version && ` (now v${latest.version})`}
                        {node.file && from && " · "}
                        {from && <span className={`caliper-from caliper-from-${node.source}`}>{from[0]}</span>}
                    </span>
                )}
                {node.problem && (
                    <span className="tag tag-warning" title={node.problem}>
                        {TAGS[node.why ?? "unreadable"]}
                    </span>
                )}
                {other && (
                    <span className="tag tag-warning caliper-stand-in" title={other[1]}>
                        {other[0]}
                    </span>
                )}
                {node.deleted && (
                    <span className="tag" title="Its file is in the trash">
                        In the trash
                    </span>
                )}
                <span
                    className={`caliper-row-actions${hover || props.selected === node.id ? " caliper-row-actions-on" : ""}`}
                >
                    <button
                        type="button"
                        className="button-small"
                        aria-label={`Isolate ${node.name}`}
                        title="Show only this"
                        onClick={() => props.isolate(node.id)}
                    >
                        Isolate
                    </button>
                    {node.file ? (
                        <Link
                            className="button button-small"
                            to={caliperUrl(node.file.id, node.file.version, node.file.configuration)}
                            aria-label={`Open ${node.name} in Caliper`}
                            title={`Open ${file ?? node.name} v${node.file.version} on its own`}
                        >
                            Open
                        </Link>
                    ) : (
                        props.openHere &&
                        node.children.length > 0 && (
                            <button
                                type="button"
                                className="button-small"
                                aria-label={`Open ${node.name}`}
                                title="Show only this, zoomed to it"
                                onClick={() => props.openHere?.(node.id)}
                            >
                                Open
                            </button>
                        )
                    )}
                </span>
            </div>
            {open && node.children.length > 0 && (
                <ul role="group">
                    {node.children.map((child) => (
                        <Row key={child.id} {...props} node={child} depth={depth + 1} />
                    ))}
                </ul>
            )}
        </li>
    );
}
