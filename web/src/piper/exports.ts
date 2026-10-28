import { createElement } from "react";
import { imageHref, piper } from "./api";
import { LIGHT, withStates } from "./colors";
import { DiagramView } from "./DiagramView";
import type { Drawing, Point } from "./drawing";
import { drawingBox } from "./edit";
import { grow, union, type Box } from "./geometry";
import { layoutLegend, legendBox, LegendBlock, legendOf } from "./legend";
import type { DiagramMeta } from "./library/kinds";
import { dataUri, type PictureSource } from "./pictures";

// A diagram taken out of Piper: drawn as SVG or PNG, or printed (or saved as a PDF from the print dialog), in the light
// colors, as on paper, whatever the site's theme. Each picture of a page can have its legend beside it (legend.tsx).
// Its parts list's CSV is parts.ts's.

/** A legend on an export: of a page, beside what's drawn (to its right, from its top), or at a point of its own. */
export interface ExportLegend {
    of: Drawing; // the page whose parts, lines, and fluids it lists
    fluids: boolean; // whether it lists the fluids: not in black and white, where every line's in ink
    at?: Point; // its top left, if not beside the drawing
    maxHeight?: number; // how tall its columns may be, if not as tall as the drawing
}

/** The drawing as an SVG file: everything in it, a margin around it, on white; and its legend, if it's given one. */
export async function svgOf(
    drawing: Drawing,
    meta: DiagramMeta,
    pictures: PictureSource = piper.imageBytes,
    legend: ExportLegend | null = null,
): Promise<{ svg: string; width: number; height: number }> {
    // React's server renderer only loads when something's exported: it's no use otherwise.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const drawn = drawingBox(drawing);
    const placed = legend ? placeLegend(legend, drawn) : null;
    const box = union(
        [drawn, placed ? grow(legendBox(placed.layout, placed.at), 40) : null].filter((one) => !!one),
    ) ?? {
        x0: 0,
        y0: 0,
        x1: 400,
        y1: 300,
    };
    const width = Math.ceil(box.x1 - box.x0);
    const height = Math.ceil(box.y1 - box.y0);
    const palette = withStates(LIGHT, drawing);
    const markup = renderToStaticMarkup(
        createElement(
            "svg",
            {
                xmlns: "http://www.w3.org/2000/svg",
                width,
                height,
                viewBox: `${box.x0} ${box.y0} ${width} ${height}`,
            },
            createElement("rect", { x: box.x0, y: box.y0, width, height, fill: palette.paper }),
            createElement(DiagramView, { drawing, palette, meta }),
            legend &&
                placed &&
                createElement(LegendBlock, {
                    layout: placed.layout,
                    at: placed.at,
                    drawing: legend.of,
                    palette: withStates(LIGHT, legend.of),
                    meta,
                }),
        ),
    );
    // Its pictures in it, so it shows them wherever it's opened, and drawn as an image (which fetches nothing).
    let svg = markup;
    const shown = drawing.parts.filter((part) => part.kind === "picture" && part.props.image);
    for (const sha of new Set(shown.map((part) => part.props.image!))) {
        try {
            svg = svg.split(imageHref(sha)).join(dataUri(new Uint8Array(await pictures(sha))));
        } catch {
            // out of reach: it stays a link, which a PNG or a PDF of the drawing leaves out
        }
    }
    return { svg: `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`, width, height };
}

/**
 * Where a legend goes, laid out: where it's said to, or beside the drawing, to its right, level with its top, its
 * columns no taller than the drawing (it's then as tall as the drawing, and as wide as it takes).
 */
function placeLegend(legend: ExportLegend, drawn: Box | null) {
    const entries = legendOf(legend.of, legend.fluids);
    if (legend.at || !drawn) {
        return { layout: layoutLegend(entries, legend.of, legend.maxHeight ?? 600), at: legend.at ?? { x: 0, y: 0 } };
    }
    const layout = layoutLegend(entries, legend.of, legend.maxHeight ?? Math.max(240, drawn.y1 - drawn.y0 - 80));
    return { layout, at: { x: drawn.x1, y: drawn.y0 + 40 } };
}

/** A page's legend, beside it, on an export of it: the parts, lines, and fluids on it. */
export const legendBeside = (drawing: Drawing): ExportLegend => ({ of: drawing, fluids: true });

/** The drawing as a PNG, at twice its size (sharp on a high-density screen, and printed); with its legend, if asked. */
export async function pngOf(drawing: Drawing, meta: DiagramMeta, legend = false, scale = 2): Promise<Blob> {
    const { svg, width, height } = await svgOf(drawing, meta, piper.imageBytes, legend ? legendBeside(drawing) : null);
    const image = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("The drawing couldn't be drawn as an image"));
            image.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = width * scale;
        canvas.height = height * scale;
        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("This browser can't make images");
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
                (blob) => (blob ? resolve(blob) : reject(new Error("The image couldn't be made"))),
                "image/png",
            ),
        );
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** The drawing printed: in a frame of its own, fitted to the page, landscape; with its legend, if asked. */
export async function printDrawing(drawing: Drawing, meta: DiagramMeta, legend = false): Promise<void> {
    const { svg } = await svgOf(drawing, meta, piper.imageBytes, legend ? legendBeside(drawing) : null);
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
    document.body.appendChild(frame);
    const page = frame.contentDocument;
    if (!page || !frame.contentWindow) {
        frame.remove();
        throw new Error("This browser can't print from here");
    }
    page.open();
    page.write(
        `<!doctype html><title>${escapeHtml(meta.name)}</title><style>@page{size:landscape;margin:12mm}` +
            "html,body{margin:0;height:100%}svg{width:100%;height:100%}</style>" +
            svg
                .replace(/^<\?xml[^>]*>\s*/, "")
                .replace(/ width="\d+" height="\d+"/, ' preserveAspectRatio="xMidYMid meet"'),
    );
    page.close();
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60_000); // after the print dialog's had what it needs
}

const escapeHtml = (text: string) =>
    text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);

/** A file saved from the browser. */
export function download(name: string, contents: Blob): void {
    const url = URL.createObjectURL(contents);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A diagram's name as a file's: what a file system won't take, left out. */
export const fileName = (name: string, extension: string) =>
    `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "diagram"}.${extension}`;
