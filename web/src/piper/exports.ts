import { createElement } from "react";
import { LIGHT, withStates } from "./colors";
import { DiagramView } from "./DiagramView";
import { isPortEnd, LINE_KINDS, pageOf, type Document, type Drawing } from "./drawing";
import { drawingBox } from "./edit";
import { fluidOf } from "./fluids";
import { LINE_FIELDS } from "./labels";
import { kindOf, titleOf } from "./library/index";
import type { DiagramMeta, Field } from "./library/kinds";

// A diagram taken out of Piper: drawn as SVG or PNG, printed (or saved as a PDF from the print dialog), and its parts
// list as a CSV. Drawn in the light colors, as on paper, whatever the site's theme.

/** The drawing as an SVG file: everything in it, a margin around it, on white. */
export async function svgOf(
    drawing: Drawing,
    meta: DiagramMeta,
): Promise<{ svg: string; width: number; height: number }> {
    // React's server renderer only loads when something's exported: it's no use otherwise.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const box = drawingBox(drawing) ?? { x0: 0, y0: 0, x1: 400, y1: 300 };
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
        ),
    );
    return { svg: `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`, width, height };
}

/** The drawing as a PNG, at twice its size (sharp on a high-density screen, and printed). */
export async function pngOf(drawing: Drawing, meta: DiagramMeta, scale = 2): Promise<Blob> {
    const { svg, width, height } = await svgOf(drawing, meta);
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

/** The drawing printed: in a frame of its own, fitted to the page, landscape. */
export async function printDrawing(drawing: Drawing, meta: DiagramMeta): Promise<void> {
    const { svg } = await svgOf(drawing, meta);
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

/** A property as the parts list has it: as it was written, but a choice by its name and a fluid by its label. */
function listed(drawing: Drawing, fields: Field[], key: string, value: string): string {
    const field = fields.find((entry) => entry.key === key);
    if (field?.type === "select") {
        return field.options?.find((option) => option.value === value)?.label ?? value;
    }
    return field?.type === "fluid" ? (fluidOf(drawing, value)?.label ?? value) : value;
}

/** A cell of CSV: quoted where it has to be. */
const cell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** A row of the parts list: what it's of (a part's id, or a line's), and its cells, as the head names them. */
export interface PartRow {
    id: string;
    line: boolean;
    page: number; // which of the diagram's pages it's on
    cells: string[];
}

/**
 * The parts list: a row for each part (its tag, what it is, its normal state, what it holds or reads, and every
 * property it has), then each line (its tag, fluid, type, and the tags of what it joins). The table beside the drawing
 * (PartsPanel) shows it, and partsList saves it as a CSV file: a valve list and an instrument list, in a spreadsheet.
 */
export function partTable(drawing: Drawing): { head: string[]; rows: PartRow[] } {
    const parts = drawing.parts.filter(
        (part) => !["junction", "text", "region", "offpage", "legend", "titleblock"].includes(part.kind),
    );
    const skip = new Set(["normal", "fluid", "channel", "notes"]);
    const keys: string[] = [];
    const labels = new Map<string, string>();
    for (const part of parts) {
        for (const field of kindOf(part.kind).fields) {
            labels.set(field.key, field.label);
        }
    }
    for (const field of LINE_FIELDS) {
        labels.set(field.key, field.label);
    }
    for (const item of [...parts, ...drawing.lines]) {
        for (const key of Object.keys(item.props)) {
            if (!skip.has(key) && !keys.includes(key) && item.props[key]) {
                keys.push(key);
            }
        }
    }
    const tagOf = new Map(drawing.parts.map((part) => [part.id, part.tag || titleOf(part)]));
    const head = [
        "Item",
        "Tag",
        "What",
        "Normal state",
        "Fluid",
        "Test channel",
        ...keys.map((key) => labels.get(key) ?? key),
        "Notes",
        "From",
        "To",
    ];
    const rows: PartRow[] = [
        ...parts.map((part) => {
            const kind = kindOf(part.kind);
            const cells = [
                "Part",
                part.tag,
                titleOf(part),
                part.props.normal ?? "",
                fluidOf(drawing, part.props.fluid ?? "")?.label ?? "",
                kind.reads ? part.props.channel || part.tag : "",
                ...keys.map((key) => listed(drawing, kind.fields, key, part.props[key] ?? "")),
                part.props.notes ?? "",
                "",
                "",
            ];
            return { id: part.id, line: false, page: 0, cells };
        }),
        ...drawing.lines.map((line) => ({
            id: line.id,
            line: true,
            page: 0,
            cells: [
                "Line",
                line.tag,
                LINE_KINDS.find((entry) => entry.value === line.kind)?.label ?? line.kind,
                "",
                fluidOf(drawing, line.fluid)?.label ?? "",
                "",
                ...keys.map((key) => line.props[key] ?? ""),
                line.props.notes ?? "",
                isPortEnd(line.from) ? (tagOf.get(line.from.part) ?? "") : "",
                isPortEnd(line.to) ? (tagOf.get(line.to.part) ?? "") : "",
            ],
        })),
    ];
    return { head, rows };
}

/**
 * The parts list of all a diagram's pages: as a page's, of all of them together, and, if there's more than one, with
 * the page each is on, last. (A part's id is unique in the diagram, not only on its page.)
 */
export function documentTable(document: Document): { head: string[]; rows: PartRow[] } {
    const drawings = document.pages.map((_, index) => pageOf(document, index));
    const on = new Map<string, number>();
    drawings.forEach((drawing, index) => {
        for (const item of [...drawing.parts, ...drawing.lines]) {
            on.set(item.id, index);
        }
    });
    const { head, rows } = partTable({
        ...drawings[0]!,
        parts: drawings.flatMap((drawing) => drawing.parts),
        lines: drawings.flatMap((drawing) => drawing.lines),
    });
    const placed = rows.map((row) => ({ ...row, page: on.get(row.id) ?? 0 }));
    if (document.pages.length < 2) {
        return { head, rows: placed };
    }
    return {
        head: [...head, "Page"],
        rows: placed.map((row) => ({ ...row, cells: [...row.cells, document.pages[row.page]?.name ?? ""] })),
    };
}

/** The parts list of a diagram's pages as a CSV file's text. */
export function partsList(document: Document): string {
    const { head, rows } = documentTable(document);
    return [head, ...rows.map((row) => row.cells)].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

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
