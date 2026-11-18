import { readZip, ZipError, type ZipEntry } from "../zip";

// Spreadsheets, read in the browser, for a BOM to be read in from (Bom.tsx): a CSV file, or an Excel workbook (.xlsx),
// each sheet as rows of cells' text. An .xlsx is a zip of XML (as Piper's Visio drawings are), read with the site's
// own zip reader (zip.ts); nothing more is needed to read it.

export interface Sheet {
    name: string;
    rows: string[][]; // as the sheet has them: row 1 first, empty rows kept, so row numbers are the sheet's own
}

export class SheetError extends Error {}

/** The sheets in a spreadsheet file: a CSV file's one, or an Excel workbook's, in its order. */
export async function readSheets(file: Blob, name: string): Promise<Sheet[]> {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
        throw new SheetError(
            `${name} is an Excel workbook from before 2007 (.xls). Open it in Excel, save it as an Excel Workbook (.xlsx) or a CSV file, and read that in.`,
        );
    }
    if (head[0] === 0x50 && head[1] === 0x4b) {
        return readWorkbook(file, name);
    }
    return [{ name: name.replace(/\.[^.]*$/, ""), rows: parseCsv(await file.text()) }];
}

/**
 * A CSV file's rows (RFC 4180): its cells split by commas (or semicolons or tabs, whichever its first line has most
 * of, outside quotes), a quoted cell kept whole, its doubled quotes one, and line breaks in it kept.
 */
export function parseCsv(text: string): string[][] {
    const body = text.replace(/^﻿/, "");
    const delimiter = delimiterOf(body);
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    for (let at = 0; at < body.length; at++) {
        const char = body[at]!;
        if (quoted) {
            if (char === '"' && body[at + 1] === '"') {
                cell += '"';
                at++;
            } else if (char === '"') {
                quoted = false;
            } else {
                cell += char;
            }
        } else if (char === '"' && cell === "") {
            quoted = true;
        } else if (char === delimiter) {
            row.push(cell);
            cell = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && body[at + 1] === "\n") {
                at++;
            }
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
        } else {
            cell += char;
        }
    }
    if (cell !== "" || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

function delimiterOf(text: string): string {
    const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
    let quoted = false;
    for (const char of text) {
        if (char === '"') {
            quoted = !quoted;
        } else if (!quoted && (char === "\n" || char === "\r")) {
            break;
        } else if (!quoted && char in counts) {
            counts[char]! += 1;
        }
    }
    const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
    return count > 0 ? best : ",";
}

type Files = Map<string, ZipEntry>;

async function xmlOf(files: Files, path: string): Promise<Document | null> {
    const entry = files.get(path.toLowerCase());
    if (!entry) {
        return null;
    }
    const document = new DOMParser().parseFromString(new TextDecoder().decode(await entry.read()), "application/xml");
    return document.getElementsByTagName("parsererror").length > 0 ? null : document;
}

/** The elements under one with a name, whatever their namespace's prefix. */
const named = (node: Document | Element, name: string) => [...node.getElementsByTagNameNS("*", name)];

/** An Excel workbook's sheets (its worksheets: not its charts), in its order. */
async function readWorkbook(file: Blob, name: string): Promise<Sheet[]> {
    let files: Files;
    try {
        const zip = await readZip(file, name);
        files = new Map(zip.entries.map((entry) => [entry.path.toLowerCase(), entry]));
    } catch (error) {
        if (error instanceof ZipError) {
            throw new SheetError(`${name} isn't an Excel workbook (.xlsx) or a CSV file, or it's damaged.`);
        }
        throw error;
    }
    const workbook = await xmlOf(files, "xl/workbook.xml");
    if (!workbook) {
        throw new SheetError(
            `${name} isn't an Excel workbook: it has no sheets. Save it as .xlsx or CSV, and read that in.`,
        );
    }
    const targets = new Map<string, string>();
    for (const rel of named((await xmlOf(files, "xl/_rels/workbook.xml.rels")) ?? workbook, "Relationship")) {
        const target = rel.getAttribute("Target") ?? "";
        targets.set(rel.getAttribute("Id") ?? "", target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
    const strings = named((await xmlOf(files, "xl/sharedStrings.xml")) ?? workbook, "si").map((si) => textOf(si));
    const sheets: Sheet[] = [];
    for (const sheet of named(workbook, "sheet")) {
        const id = [...sheet.attributes].find((a) => a.localName === "id")?.value ?? "";
        const path = targets.get(id);
        const document = path ? await xmlOf(files, path) : null;
        if (document) {
            sheets.push({
                name: sheet.getAttribute("name") ?? `Sheet ${sheets.length + 1}`,
                rows: rowsOf(document, strings),
            });
        }
    }
    if (sheets.length === 0) {
        throw new SheetError(`${name} has no sheets with cells in them to read.`);
    }
    return sheets;
}

/** A shared string's text: its runs together, without their phonetic guides. */
function textOf(si: Element): string {
    return named(si, "t")
        .filter((t) => t.parentElement?.localName !== "rPh")
        .map((t) => t.textContent ?? "")
        .join("");
}

/** A worksheet's cells' text, by row and column (A1 is rows[0][0]). */
function rowsOf(document: Document, strings: string[]): string[][] {
    const rows: string[][] = [];
    for (const row of named(document, "row")) {
        const number = Number(row.getAttribute("r")) || rows.length + 1;
        const cells: string[] = [];
        for (const cell of named(row, "c")) {
            const column = columnOf(cell.getAttribute("r")) ?? cells.length;
            while (cells.length < column) {
                cells.push("");
            }
            cells[column] = valueOf(cell, strings);
        }
        while (rows.length < number - 1) {
            rows.push([]);
        }
        rows[number - 1] = cells;
    }
    return rows;
}

/** A cell's column from its reference ("C7": 2), or null without one. */
function columnOf(reference: string | null): number | null {
    const letters = /^([A-Z]+)\d+$/i.exec(reference ?? "")?.[1];
    if (!letters) {
        return null;
    }
    return [...letters.toUpperCase()].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

/** A cell's text: a shared string, an inline one, a formula's text, TRUE or FALSE, or a number as it's stored. */
function valueOf(cell: Element, strings: string[]): string {
    const type = cell.getAttribute("t");
    const value = named(cell, "v")[0]?.textContent ?? "";
    if (type === "s") {
        return strings[Number(value)] ?? "";
    }
    if (type === "inlineStr") {
        const inline = named(cell, "is")[0];
        return inline ? textOf(inline) : "";
    }
    if (type === "b") {
        return value === "1" ? "TRUE" : "FALSE";
    }
    if (type === "n" || type === null) {
        // Stored to 17 digits (0.1 as 0.10000000000000001): shown as its shortest, as Excel shows it.
        return value === "" ? "" : String(Number(Number(value).toPrecision(15)));
    }
    return value;
}
