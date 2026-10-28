import { normalFill, normalState, type Palette } from "./colors";
import { emptyDrawing, newPart, type Part } from "./drawing";
import { fluidOf, isGas } from "./fluids";
import { kindOf } from "./library/index";
import type { DiagramMeta, Preset } from "./library/kinds";

// Parts drawn small, as the library shows them and the inspector heads what it's showing.

const META: DiagramMeta = { name: "Diagram", revision: "1", savedAt: null, by: "" };

/** A part as an icon: its kind drawn to fit the box it's in. */
export function PartIcon({ part, palette, size = 40 }: { part: Part; palette: Palette; size?: number }) {
    const kind = kindOf(part.kind);
    const drawing = emptyDrawing();
    const [x0, y0, x1, y1] = kind.box(part, drawing);
    const pad = 4;
    const holds = fluidOf(drawing, part.props.fluid ?? "");
    const fill = kind.state ? normalFill(palette, part.props.normal) : null;
    return (
        <svg
            className="piper-icon"
            width={size}
            height={size}
            viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`}
            aria-hidden="true"
        >
            {kind.draw(part, {
                ink: palette.ink,
                paper: palette.paper,
                muted: palette.muted,
                fill,
                state: kind.state ? normalState(part.props.normal) : null,
                fluid: holds?.color ?? null,
                fluidLabel: holds?.label ?? "",
                gas: holds ? isGas(drawing, holds.id) : false,
                pipe: null,
                lines: 0,
                states: { no: palette.no, nc: palette.nc, fip: palette.fip },
                drawing,
                meta: META,
            })}
        </svg>
    );
}

/** A library entry's part, as it would be placed: for its icon. */
export const presetPart = (preset: Preset): Part =>
    newPart(
        preset.kind,
        { x: 0, y: 0 },
        {
            id: `icon-${preset.id}`,
            tag: preset.prefix ? `${preset.prefix}-1` : "",
            props: { ...preset.props },
            text: preset.text ?? "",
            w: Math.min(preset.w ?? 0, 120),
            h: Math.min(preset.h ?? 0, 80),
        },
    );
