import type { ReactNode } from "react";
import type { Part } from "../drawing";
import { upright } from "../geometry";
import type { DrawContext } from "./kinds";

// What every kind draws with: the same stroke, and letters that read upright however the part's turned.

export const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** A symbol's outline: ink, at the symbol's weight. */
export const ink = (context: DrawContext, width = 1.6) => ({
    stroke: context.ink,
    strokeWidth: width,
    strokeLinejoin: "round" as const,
    strokeLinecap: "round" as const,
});

/**
 * What reads a flipped part's words forwards again, mirroring them back about the upright line through x in its frame:
 * a flip moves them, and its turn turns them, but a flip never mirrors them. Nothing, unflipped.
 */
export const unflipped = (part: Pick<Part, "flip">, x = 0): string | undefined =>
    part.flip ? `translate(${2 * x} 0) scale(-1 1)` : undefined;

/** Words in a part's frame at (x, y), centered there, reading upright. */
export function Letters({
    part,
    x,
    y,
    size,
    fill,
    bold = false,
    children,
}: {
    part: Pick<Part, "rotation" | "flip">;
    x: number;
    y: number;
    size: number;
    fill: string;
    bold?: boolean;
    children: ReactNode;
}) {
    return (
        <text
            x={x}
            y={y}
            transform={upright(part, x, y)}
            fontSize={size}
            fontFamily={FONT}
            fontWeight={bold ? 700 : 500}
            textAnchor="middle"
            dominantBaseline="central"
            fill={fill}
            stroke="none"
        >
            {children}
        </text>
    );
}
