import { useState } from "react";
import { Link } from "../../router";
import { caliperUrl } from "../paths";
import { useVault } from "../store";
import type { Node } from "./model";

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
                {node.file && (
                    <span className="muted caliper-version">
                        v{node.file.version}
                        {latest && latest.version !== node.file.version && ` (now v${latest.version})`}
                    </span>
                )}
                {node.problem && (
                    <span className="tag tag-warning" title={node.problem}>
                        No 3D model
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
