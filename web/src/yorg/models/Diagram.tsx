import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Catalog, Edge, Part, SystemModel } from "./api";
import { kindOf, shownLinks } from "./model";

// The model as a P&ID on an SVG canvas: tanks, gas supplies, junctions, and outlets where they're put, and the lines,
// valves, orifices, venturis, and regulators between them (gas ones dashed), each with a bubble for every channel it's
// linked to (PT, TC, FM, CMD).
//
//   select: click a part to pick it, drag a node to move it, Delete to remove what's picked
//   place: click where the new node goes
//   connect: click the node it flows from, then the one it flows to (and on: each click continues the run)

export const WIDTH = 1000;
export const HEIGHT = 560;
const GRID = 10;

export type Tool =
    { mode: "select" } | { mode: "place"; type: string } | { mode: "connect"; type: string; from: string | null };

interface Props {
    model: SystemModel;
    catalog: Catalog;
    selected: string | null;
    tool: Tool;
    onSelect: (id: string | null) => void;
    onMove: (id: string, x: number, y: number, done: boolean) => void; // done: the drag ended (to keep for undo)
    onPlace: (type: string, x: number, y: number) => void;
    onConnect: (from: string, to: string) => void;
    onTool: (tool: Tool) => void;
    onDelete: (id: string) => void;
}

/** Half a node's width and height, for where lines meet it. */
function extent(type: string): [number, number] {
    switch (type) {
        case "tank":
            return [30, 48];
        case "source":
            return [24, 24];
        case "outlet":
            return [18, 16];
        case "gas_junction":
            return [8, 8];
        default:
            return [6, 6];
    }
}

/** Where a line from a node's center toward (tx, ty) leaves the node. */
function edgePoint(node: Part, tx: number, ty: number): [number, number] {
    const [hw, hh] = extent(node.type);
    const dx = tx - node.x;
    const dy = ty - node.y;
    if (dx === 0 && dy === 0) {
        return [node.x, node.y];
    }
    const t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
    return [node.x + dx * Math.min(t, 1), node.y + dy * Math.min(t, 1)];
}

const TAGS: Record<string, string> = { pressure: "PT", temperature: "TC", mass_flow: "FM", command: "CMD" };

function Bubbles({ part, catalog, at }: { part: Part; catalog: Catalog; at: [number, number] }) {
    const links = shownLinks(kindOf(catalog, part.type), part.settings).filter((link) => part.links[link.key]);
    return (
        <>
            {links.map((link, index) => {
                const x = at[0] + 26;
                const y = at[1] - 30 - index * 28;
                return (
                    <g key={link.key} className="dev-bubble">
                        <title>{`${link.label}: ${part.links[link.key]}`}</title>
                        <line x1={at[0]} y1={at[1]} x2={x} y2={y} />
                        <circle cx={x} cy={y} r={12} />
                        <text x={x} y={y + 3.5} textAnchor="middle">
                            {TAGS[link.quantity] ?? "?"}
                        </text>
                    </g>
                );
            })}
        </>
    );
}

function NodeShape({ node }: { node: Part }) {
    const settings = node.settings;
    switch (node.type) {
        case "tank": {
            const full =
                settings.mode === "ullage" && Number(settings.volume) > 0
                    ? Math.min(1, Number(settings.liquid_volume) / Number(settings.volume))
                    : 0.7;
            return (
                <>
                    <rect x={-28} y={-46} width={56} height={92} rx={20} className="dev-shape" />
                    <clipPath id={`clip-${node.id}`}>
                        <rect x={-28} y={-46} width={56} height={92} rx={20} />
                    </clipPath>
                    <rect
                        x={-28}
                        y={46 - 92 * full}
                        width={56}
                        height={92 * full}
                        className="dev-liquid"
                        clipPath={`url(#clip-${node.id})`}
                    />
                    <rect x={-28} y={-46} width={56} height={92} rx={20} className="dev-outline" />
                </>
            );
        }
        case "source":
            return (
                <>
                    <circle r={24} className="dev-shape dev-gas" />
                    <text y={4} textAnchor="middle" className="dev-inner">
                        {String(settings.gas ?? "").slice(0, 3)}
                    </text>
                </>
            );
        case "outlet":
            return <path d="M -18 -16 L 18 0 L -18 16 Z" className="dev-shape" />;
        case "gas_junction":
            return <circle r={7} className="dev-shape dev-gas" />;
        default:
            return <circle r={6} className="dev-junction" />;
    }
}

const BOWTIE = "M -12 -9 L 12 9 L 12 -9 L -12 9 Z";

function EdgeSymbol({ edge }: { edge: Edge }) {
    switch (edge.type) {
        case "valve":
        case "gas_valve":
            return <path d={BOWTIE} className="dev-shape" />;
        case "orifice":
        case "gas_orifice":
            return <path d="M 0 -12 L 0 -3 M 0 3 L 0 12" className="dev-plate" />;
        case "venturi":
            // Its walls, narrowing to the throat and opening out again.
            return (
                <path
                    d="M -17 -10 L -4 -3.5 L 4 -3.5 L 17 -10 M -17 10 L -4 3.5 L 4 3.5 L 17 10"
                    className="dev-plate"
                />
            );
        case "regulator":
            // A valve with a spring-loaded dome on its stem.
            return (
                <>
                    <path d={BOWTIE} className="dev-shape" />
                    <path d="M 0 0 L 0 -13" className="dev-plate dev-stem" />
                    <path d="M -9 -13 A 9 7 0 0 1 9 -13 Z" className="dev-shape" />
                </>
            );
        default:
            return null;
    }
}

export function Diagram(props: Props) {
    const { model, catalog, selected, tool } = props;
    const svg = useRef<SVGSVGElement | null>(null);
    const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
    const byId = new Map(model.nodes.map((node) => [node.id, node]));

    function point(event: PointerEvent): [number, number] {
        const element = svg.current;
        const matrix = element && typeof element.getScreenCTM === "function" ? element.getScreenCTM() : null;
        if (!matrix) {
            return [event.clientX, event.clientY];
        }
        const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        return [at.x, at.y];
    }

    const snap = (value: number, low: number, high: number) =>
        Math.min(high, Math.max(low, Math.round(value / GRID) * GRID));

    function onBackground(event: PointerEvent<SVGSVGElement>) {
        if (event.target !== event.currentTarget && !(event.target as Element).classList.contains("dev-grid")) {
            return;
        }
        if (tool.mode === "place") {
            const [x, y] = point(event);
            props.onPlace(tool.type, snap(x, 40, WIDTH - 40), snap(y, 60, HEIGHT - 60));
        } else if (tool.mode === "connect") {
            props.onTool({ ...tool, from: null });
        } else {
            props.onSelect(null);
        }
    }

    function onNodeDown(event: PointerEvent<SVGGElement>, node: Part) {
        event.stopPropagation();
        if (tool.mode === "connect") {
            if (tool.from === null || tool.from === node.id) {
                props.onTool({ ...tool, from: node.id });
            } else {
                props.onConnect(tool.from, node.id);
            }
            return;
        }
        props.onSelect(node.id);
        const [x, y] = point(event);
        setDrag({ id: node.id, dx: node.x - x, dy: node.y - y, moved: false });
        event.currentTarget.setPointerCapture?.(event.pointerId);
    }

    function onNodeMove(event: PointerEvent<SVGGElement>) {
        if (!drag) {
            return;
        }
        const [x, y] = point(event);
        setDrag({ ...drag, moved: true });
        props.onMove(drag.id, snap(x + drag.dx, 40, WIDTH - 40), snap(y + drag.dy, 60, HEIGHT - 60), false);
    }

    function onNodeUp(event: PointerEvent<SVGGElement>) {
        if (drag?.moved) {
            const [x, y] = point(event);
            props.onMove(drag.id, snap(x + drag.dx, 40, WIDTH - 40), snap(y + drag.dy, 60, HEIGHT - 60), true);
        }
        setDrag(null);
    }

    function onKey(event: KeyboardEvent<SVGSVGElement>) {
        if ((event.key === "Delete" || event.key === "Backspace") && selected) {
            event.preventDefault();
            props.onDelete(selected);
        } else if (event.key === "Escape") {
            props.onTool({ mode: "select" });
        }
    }

    return (
        <svg
            ref={svg}
            className={`dev-diagram dev-${tool.mode}`}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="application"
            aria-label="P&ID"
            tabIndex={0}
            onPointerDown={onBackground}
            onKeyDown={onKey}
        >
            <defs>
                <pattern id="dev-dots" width={20} height={20} patternUnits="userSpaceOnUse">
                    <circle cx={1} cy={1} r={1} className="dev-dot" />
                </pattern>
                <marker
                    id="dev-arrow"
                    viewBox="0 0 10 10"
                    refX={5}
                    refY={5}
                    markerWidth={7}
                    markerHeight={7}
                    orient="auto"
                >
                    <path d="M 0 0 L 10 5 L 0 10 Z" className="dev-arrowhead" />
                </marker>
            </defs>
            <rect className="dev-grid" width={WIDTH} height={HEIGHT} fill="url(#dev-dots)" />
            {model.edges.map((edge) => {
                const from = byId.get(edge.source);
                const to = byId.get(edge.target);
                if (!from || !to) {
                    return null;
                }
                const [x1, y1] = edgePoint(from, to.x, to.y);
                const [x2, y2] = edgePoint(to, from.x, from.y);
                const mx = (x1 + x2) / 2;
                const my = (y1 + y2) / 2;
                const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
                const gas = kindOf(catalog, edge.type).phase === "gas";
                const flip = Math.abs(angle) > 90;
                return (
                    <g
                        key={edge.id}
                        className={`dev-edge ${selected === edge.id ? "dev-selected" : ""} ${gas ? "dev-gas-edge" : ""}`}
                        role="button"
                        aria-label={edge.name}
                        onPointerDown={(event) => {
                            event.stopPropagation();
                            if (tool.mode === "select") {
                                props.onSelect(edge.id);
                            }
                        }}
                    >
                        <line x1={x1} y1={y1} x2={x2} y2={y2} className="dev-hit" />
                        <line x1={x1} y1={y1} x2={x2} y2={y2} className="dev-pipe" />
                        {/* Which way it flows: an arrow three quarters along, clear of the valve or orifice. */}
                        <line
                            x1={x1 + (x2 - x1) * 0.72}
                            y1={y1 + (y2 - y1) * 0.72}
                            x2={x1 + (x2 - x1) * 0.76}
                            y2={y1 + (y2 - y1) * 0.76}
                            className="dev-pipe"
                            markerEnd="url(#dev-arrow)"
                        />
                        <g transform={`translate(${mx} ${my}) rotate(${angle})`}>
                            <EdgeSymbol edge={edge} />
                            {/* Its name under the line, clear of its channels' bubbles above; turned the right way up
                                when the line runs leftward (turned twice, it's still under the line). */}
                            <text
                                y={28}
                                textAnchor="middle"
                                transform={flip ? "rotate(180)" : undefined}
                                className="dev-label"
                            >
                                {edge.name}
                            </text>
                        </g>
                        <Bubbles part={edge} catalog={catalog} at={[mx, my]} />
                    </g>
                );
            })}
            {model.nodes.map((node) => {
                const connecting = tool.mode === "connect" && tool.from === node.id;
                const [, hh] = extent(node.type);
                return (
                    <g key={node.id}>
                        <g
                            className={`dev-node dev-${node.type} ${selected === node.id ? "dev-selected" : ""} ${connecting ? "dev-from" : ""}`}
                            transform={`translate(${node.x} ${node.y})`}
                            role="button"
                            aria-label={node.name}
                            onPointerDown={(event) => onNodeDown(event, node)}
                            onPointerMove={onNodeMove}
                            onPointerUp={onNodeUp}
                        >
                            <NodeShape node={node} />
                            <text y={hh + 16} textAnchor="middle" className="dev-label">
                                {node.name}
                            </text>
                        </g>
                        <Bubbles part={node} catalog={catalog} at={[node.x, node.y]} />
                    </g>
                );
            })}
        </svg>
    );
}
