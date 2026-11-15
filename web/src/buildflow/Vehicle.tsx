import { useMemo, useRef, useState, type PointerEvent } from "react";
import type { Component, Milestone, Profile } from "./api";
import { drawVehicle, phaseState, STATE_NAMES, toDrawing } from "./vehicle";

// The vehicle, drawn in white on the stage's black, and its components on it as dots in the colors of where each is in
// the phase shown. A dot is a button: it picks its component. On the layout page, admins drag the dots to move them,
// and place one that isn't on the drawing yet by clicking where it goes.

interface Props {
    profile: Profile;
    components: Component[];
    milestones: Milestone[]; // the phase's: where each component is in it colors its dot
    selected: number | null;
    onSelect: (component: Component) => void;
    label: string; // what it's a drawing of, for screen readers: "Elytra"
    arranging?: boolean; // dots drag (admins, on the layout page)
    onMove?: (component: Component, x: number, y: number) => void;
    placing?: Component | null; // a click on the drawing puts it there
    onPlace?: (x: number, y: number) => void;
    sections?: boolean; // the sections' names, under them (the layout page)
}

export function Vehicle({
    profile,
    components,
    milestones,
    selected,
    onSelect,
    label,
    arranging = false,
    onMove,
    placing = null,
    onPlace,
    sections = false,
}: Props) {
    const svg = useRef<SVGSVGElement>(null);
    const [dragging, setDragging] = useState<{ id: number; x: number; y: number } | null>(null);
    const drawn = useMemo(() => drawVehicle(profile, components), [profile, components]);
    const { box } = drawn;
    // Sizes on screen, whatever the vehicle's: a share of the drawing's width (or of a tall one's height).
    const scale = Math.max(box.width, box.height * 3.5);
    const dot = scale * 0.0048;
    const text = scale * 0.0125;
    const placed = components.filter((c) => c.x !== null && c.y !== null);
    const where = (c: Component) => (dragging?.id === c.id ? dragging : { x: c.x!, y: c.y! });

    function grab(event: PointerEvent<SVGGElement>, component: Component) {
        if (!arranging || !onMove) {
            return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging({ id: component.id, x: component.x!, y: component.y! });
    }

    function drag(event: PointerEvent<SVGSVGElement>) {
        if (dragging && svg.current) {
            const point = toDrawing(svg.current, event.clientX, event.clientY);
            if (point) {
                setDragging({ id: dragging.id, ...point });
            }
        }
    }

    function drop() {
        if (!dragging) {
            return;
        }
        const component = components.find((c) => c.id === dragging.id);
        if (component && (component.x !== dragging.x || component.y !== dragging.y)) {
            onMove?.(component, dragging.x, dragging.y);
        }
        setDragging(null);
    }

    const chosen = placed.find((c) => c.id === selected);
    return (
        <svg
            ref={svg}
            className={`bf-vehicle ${placing ? "bf-vehicle-placing" : ""}`}
            viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="group"
            aria-label={`${label}'s vehicle`}
            onPointerMove={drag}
            onPointerUp={drop}
            onClick={(event) => {
                if (placing && onPlace && svg.current && event.target === event.currentTarget) {
                    const point = toDrawing(svg.current, event.clientX, event.clientY);
                    if (point) {
                        onPlace(point.x, point.y);
                    }
                }
            }}
        >
            <path className="bf-detail" d={drawn.detail} />
            <path className="bf-outline" d={drawn.outline} />
            {sections &&
                drawn.spans.map(({ x0, x1, section }, index) => (
                    <text
                        key={index}
                        className="bf-section-name"
                        x={(x0 + x1) / 2}
                        y={box.y + box.height - text * 0.4}
                        fontSize={text * 0.8}
                        textAnchor="middle"
                    >
                        {section.label}
                    </text>
                ))}
            {placed.map((component) => {
                const state = phaseState(component, milestones);
                const at = where(component);
                return (
                    <g
                        key={component.id}
                        className={`bf-dot bf-dot-${state} ${component.id === selected ? "bf-dot-selected" : ""}`}
                        transform={`translate(${at.x} ${-at.y})`}
                        role="button"
                        tabIndex={0}
                        aria-label={`${component.name}: ${STATE_NAMES[state]}`}
                        aria-pressed={component.id === selected}
                        onPointerDown={(event) => grab(event, component)}
                        onClick={(event) => {
                            event.stopPropagation();
                            onSelect(component);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                onSelect(component);
                            }
                        }}
                    >
                        <title>{`${component.name}: ${STATE_NAMES[state]}`}</title>
                        <circle className="bf-dot-hit" r={dot * 2.4} />
                        {component.id === selected && <circle className="bf-dot-ring" r={dot * 2} />}
                        <circle className="bf-dot-mark" r={state === "skipped" ? dot * 0.8 : dot} />
                    </g>
                );
            })}
            {chosen && (
                <text
                    className="bf-dot-name"
                    x={where(chosen).x}
                    y={-where(chosen).y - dot * 3}
                    fontSize={text}
                    textAnchor="middle"
                >
                    {chosen.name}
                </text>
            )}
        </svg>
    );
}
