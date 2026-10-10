import { usePopover } from "../../components";
import type { Display, PartKind } from "./api";
import type { Tool } from "./Diagram";

// The P&ID's tools, in one short row: picking parts (Select), adding one (a tank, a junction), connecting two (a line,
// a valve), undoing, and the units the page shows. Adding and connecting are menus, each showing the tool it picked.

/** Units, and pressures above the atmosphere (gauge) or absolute, as one choice. */
const UNITS: { value: string; label: string; units: Display["units"]; gauge: boolean }[] = [
    { value: "us-gauge", label: "psig, °F, in, gal", units: "us", gauge: true },
    { value: "us-absolute", label: "psia, °F, in, gal", units: "us", gauge: false },
    { value: "si-gauge", label: "barg, K, mm, L", units: "si", gauge: true },
    { value: "si-absolute", label: "bar abs, K, mm, L", units: "si", gauge: false },
];

export function Toolbar({
    tool,
    onTool,
    nodes,
    edges,
    canUndo,
    onUndo,
    display,
    onDisplay,
}: {
    tool: Tool;
    onTool: (tool: Tool) => void;
    nodes: PartKind[]; // the parts that are points: tanks, junctions, outlets...
    edges: PartKind[]; // and what connects them: lines, valves...
    canUndo: boolean;
    onUndo: () => void;
    display: Display;
    onDisplay: (display: Display) => void;
}) {
    const units = UNITS.find((one) => one.units === display.units && one.gauge === display.gauge) ?? UNITS[0]!;
    return (
        <div className="dev-toolbar" role="toolbar" aria-label="Tools">
            <button type="button" aria-pressed={tool.mode === "select"} onClick={() => onTool({ mode: "select" })}>
                Select
            </button>
            <ToolMenu
                label="Add part"
                sign="+"
                groups={[{ title: null, kinds: nodes }]}
                picked={tool.mode === "place" ? tool.type : null}
                onPick={(type) => onTool({ mode: "place", type })}
            />
            <ToolMenu
                label="Connect"
                sign="↦"
                groups={[
                    { title: "Liquid", kinds: edges.filter((kind) => kind.phase !== "gas") },
                    { title: "Gas (dashed)", kinds: edges.filter((kind) => kind.phase === "gas") },
                ]}
                picked={tool.mode === "connect" ? tool.type : null}
                onPick={(type) => onTool({ mode: "connect", type, from: null })}
                hint="Click where it starts, then where it ends."
            />
            <button type="button" disabled={!canUndo} onClick={onUndo} title="Ctrl+Z">
                Undo
            </button>
            <select
                className="dev-units"
                aria-label="Units"
                title="The page's units: pressures above the atmosphere (gauge), or absolute"
                value={units.value}
                onChange={(event) => {
                    const picked = UNITS.find((one) => one.value === event.target.value) ?? units;
                    onDisplay({ ...display, units: picked.units, gauge: picked.gauge });
                }}
            >
                {UNITS.map((one) => (
                    <option key={one.value} value={one.value}>
                        {one.label}
                    </option>
                ))}
            </select>
        </div>
    );
}

/** A menu of tools, its button showing the one picked (pressed while it's in use). */
function ToolMenu({
    label,
    sign,
    groups,
    picked,
    onPick,
    hint = "",
}: {
    label: string;
    sign: string;
    groups: { title: string | null; kinds: PartKind[] }[];
    picked: string | null;
    onPick: (type: string) => void;
    hint?: string; // after each part's help, in its tooltip
}) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const current = groups.flatMap((group) => group.kinds).find((kind) => kind.type === picked);
    return (
        <div className="popover" ref={within}>
            <button
                type="button"
                className="menu-button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-pressed={current !== undefined}
                onClick={() => setOpen(!open)}
            >
                {sign} {current?.label ?? label}
            </button>
            {open && (
                <div className="menu menu-left dev-tool-menu" role="menu" aria-label={label}>
                    {groups.map((group) => (
                        <div key={group.title ?? label} role="group" aria-label={group.title ?? undefined}>
                            {group.title && <p className="menu-label">{group.title}</p>}
                            {group.kinds.map((kind) => (
                                <button
                                    key={kind.type}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={kind.type === picked}
                                    className="menu-item"
                                    title={hint ? `${kind.help} ${hint}` : kind.help}
                                    onClick={() => {
                                        setOpen(false);
                                        onPick(kind.type);
                                    }}
                                >
                                    {kind.label}
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
