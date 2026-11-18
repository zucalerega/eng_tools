import type { BomLine, BomStatus, Component, ProgramDetail } from "./api";
import { dayNumber, dayString, LONG_LEAD_DAYS, planOf } from "./planning";

// A program's bill of materials, as the BOM page reads it in from the team's own spreadsheet and shows it: which of the
// sheet's columns says what (guessed from its headers, as teams name them), each cell's value read as the server keeps
// it, and the day to order each part by, to have it in hand when its component's build has to start.

export type Field =
    "part_number" | "description" | "component" | "quantity" | "vendor" | "unit_cost" | "lead" | "url" | "status";

export const FIELDS: { field: Field; name: string; hint: string }[] = [
    { field: "part_number", name: "Part number", hint: "PN, Part #, MPN, McMaster #" },
    { field: "description", name: "Description", hint: "what it is" },
    { field: "component", name: "Component", hint: "the component (or assembly) it's for, by name" },
    { field: "quantity", name: "Quantity", hint: "how many: 2, or 1.5 ft" },
    { field: "vendor", name: "Vendor", hint: "who it's bought from" },
    { field: "unit_cost", name: "Cost each", hint: "$41.25" },
    { field: "lead", name: "Lead time", hint: "how long it takes to come: 10 wk, 14 days" },
    { field: "url", name: "Link", hint: "where it's bought" },
    { field: "status", name: "Status", hint: "to order, ordered, received" },
];

// Headers as teams write them, for each field: the first column that fits each, in the order the fields are guessed.
// An "Item #" is the line's number in the sheet, not a part number.
const GUESSES: [Field, RegExp][] = [
    [
        "part_number",
        /^(part\s*(no\.?|num(ber)?|#)|p\s*\/?\s*n\b|mpn|mfr\.?\s*(part|p\/?n)|vendor\s*(part|p\/?n)|mcmaster|sku)/i,
    ],
    ["component", /^(component|assembly|sub-?assembly|system|sub-?system|parent|for\b|part\s+of|used\s+(in|on))/i],
    ["description", /^(desc|description|item(?!\s*(#|no\b|no\.|num))|part(\s*name)?$|name|title|what)/i],
    ["quantity", /^(qty|quantity|count|amount|number\s+(needed|of)|#\s*(needed|req))/i],
    ["vendor", /^(vendor|supplier|source|manufacturer|mfr|store|bought\s+from|from$)/i],
    ["unit_cost", /^(unit\s*(cost|price)|cost(\s*each|\s*\/\s*unit)?$|price(\s*each)?$|each$|\$\s*each|unit\s*\$)/i],
    ["lead", /^(lead|lt\b|l\/t|delivery|ship(ping)?\s*time|weeks?\s*to)/i],
    ["url", /^(link|url|website|web\s*page|purchase\s*link|where)/i],
    ["status", /^(status|state|ordered|received|purchased|bought$|in\s*hand|arrived)/i],
];

/** Which of a sheet's columns is which field, by its header: those it can tell. */
export function guessColumns(headers: string[]): Partial<Record<Field, number>> {
    const found: Partial<Record<Field, number>> = {};
    const taken = new Set<number>();
    for (const [field, pattern] of GUESSES) {
        const column = headers.findIndex((header, index) => !taken.has(index) && pattern.test(header.trim()));
        if (column >= 0) {
            found[field] = column;
            taken.add(column);
        }
    }
    return found;
}

export type LeadUnit = "weeks" | "days";

/** The unit a lead time column's bare numbers are in, by its header: days if it says so, else weeks. */
export const guessLeadUnit = (header: string): LeadUnit => (/\b(days?|d)\b|\(d\)/i.test(header) ? "days" : "weeks");

/** The sheet's header row: the first with two cells or more in it. */
export function guessHeader(rows: string[][]): number {
    const found = rows.findIndex((row) => row.filter((cell) => cell.trim() !== "").length >= 2);
    return found < 0 ? 0 : found;
}

/** A quantity and its unit: "12" is 12; "1.5 ft" is 1.5 ft; "1,000" is 1000; nothing, or no number, none. */
export function quantityOf(text: string): { quantity: number | null; unit: string } {
    const found = /^\s*([0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+)\s*(?:x\b)?\s*(.*)$/i.exec(text);
    if (!found) {
        return { quantity: null, unit: "" };
    }
    const quantity = Number(found[1]!.replaceAll(",", ""));
    return Number.isFinite(quantity) ? { quantity, unit: found[2]!.trim().slice(0, 20) } : { quantity: null, unit: "" };
}

/** A cost each, in cents: "$41.25", "41.25", "1,234.50 USD". Nothing, or no number (TBD), none. */
export function centsOf(text: string): number | null {
    const found = /([0-9][0-9,]*(?:\.[0-9]*)?|\.[0-9]+)/.exec(text);
    if (!found) {
        return null;
    }
    const dollars = Number(found[1]!.replaceAll(",", ""));
    return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
}

/**
 * A lead time, in days: a number in the column's unit ("10"), or one that says its own ("10 wk", "14 days", "3 mo");
 * a range ("2-3 weeks") is its longest; "in stock" is none to wait. Nothing, or nothing to read, none.
 */
export function leadDaysOf(text: string, unit: LeadUnit): number | null {
    const tidy = text.trim().toLowerCase();
    if (tidy === "") {
        return null;
    }
    if (/in\s*stock|on\s*hand|stock$/.test(tidy)) {
        return 0;
    }
    const numbers = [...tidy.matchAll(/[0-9]+(?:\.[0-9]+)?/g)].map((found) => Number(found[0]));
    if (numbers.length === 0) {
        return null;
    }
    const most = Math.max(...numbers);
    const per = /mo(nth)?s?\b/.test(tidy)
        ? 30
        : /w(ee)?ks?\b|\bw\b/.test(tidy)
          ? 7
          : /d(ays?)?\b/.test(tidy)
            ? 1
            : unit === "weeks"
              ? 7
              : 1;
    return Math.min(3650, Math.round(most * per));
}

/** Where a part is, from its status cell (and its column's header, for a yes or no under "Ordered?"): none said if
 * it's empty, or doesn't say. */
export function statusOf(text: string, header = ""): BomStatus | null {
    const tidy = text.trim().toLowerCase();
    if (tidy === "") {
        return null;
    }
    if (/^(y|yes|x|true|✓|✔|done)$/.test(tidy)) {
        return /receiv|arriv|in\s*hand|have/i.test(header)
            ? "received"
            : /order|purchas|bought/i.test(header)
              ? "ordered"
              : null;
    }
    if (/^(n|no|false)$/.test(tidy)) {
        return "to_order";
    }
    if (/receiv|arriv|in\s*hand|deliver|^have|complete|^in$/.test(tidy)) {
        return "received";
    }
    if (/not\s*(yet\s*)?order|to\s*order|need|pending|tbd|not\s*purchas/.test(tidy)) {
        return "to_order";
    }
    if (/order|purchas|bought|ship|transit|placed|po\b/.test(tidy)) {
        return "ordered";
    }
    return null;
}

export interface Reading {
    header: number; // the header row's index in the sheet
    columns: Partial<Record<Field, number>>;
    leadUnit: LeadUnit;
}

/** A line as it's read from a sheet's row, before it's matched to a component. */
export interface ReadLine {
    row: number; // the sheet's own row number
    part_number: string;
    description: string;
    component: string; // what its Component column says, if it has one
    quantity: number | null;
    unit: string;
    vendor: string;
    unit_cost: number | null;
    lead_days: number | null;
    url: string;
    status: BomStatus | null;
}

/** A sheet's lines, read as the reading says: each row under the header with a part number or a description. A row
 * with nothing but a description (a section's title, "PROPULSION") isn't a part. */
export function readLines(rows: string[][], reading: Reading): ReadLine[] {
    const headers = rows[reading.header] ?? [];
    const cell = (row: string[], field: Field) => {
        const column = reading.columns[field];
        return column === undefined ? "" : (row[column] ?? "").trim();
    };
    const lines: ReadLine[] = [];
    rows.forEach((row, index) => {
        if (index <= reading.header) {
            return;
        }
        const partNumber = cell(row, "part_number").slice(0, 100);
        const description = cell(row, "description").slice(0, 500);
        const { quantity, unit } = quantityOf(cell(row, "quantity"));
        const vendor = cell(row, "vendor").slice(0, 200);
        const cost = centsOf(cell(row, "unit_cost"));
        const lead = leadDaysOf(cell(row, "lead"), reading.leadUnit);
        if (!partNumber && (!description || (quantity === null && !vendor && cost === null && lead === null))) {
            return;
        }
        const url = cell(row, "url");
        const status = reading.columns.status;
        lines.push({
            row: index + 1,
            part_number: partNumber,
            description,
            component: cell(row, "component"),
            quantity,
            unit,
            vendor,
            unit_cost: cost,
            lead_days: lead,
            url: /^https?:\/\/\S+$/i.test(url) ? url.slice(0, 2000) : "",
            status: statusOf(cell(row, "status"), status === undefined ? "" : (headers[status] ?? "")),
        });
    });
    return lines;
}

/** The component a line's Component cell names: one of the program's, by its name, whatever its case and spacing. */
export function componentNamed(program: ProgramDetail, name: string): Component | null {
    const key = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
    return name.trim() === "" ? null : (program.components.find((c) => key(c.name) === key(name)) ?? null);
}

export interface PartPlan {
    line: BomLine;
    component: Component | null;
    needBy: string | null; // when it has to be in hand: when its component's build has to start, or its ready-by day
    orderBy: string | null; // that, less its lead time
    late: boolean; // still to order, and its day to order it by has passed
    long: boolean; // a long lead (six weeks or more), and not received yet
}

/** Each line's day to order it by: in hand by the day its component's build has to start (its start-by day on the
 * build plan; its ready-by day, if it has no lead time of its own), less the part's lead time. */
export function partsPlan(lines: BomLine[], program: ProgramDetail, now: string): PartPlan[] {
    const plans = new Map(planOf(program, now).map((p) => [p.component.id, p]));
    const today = dayNumber(now);
    return lines.map((line) => {
        const plan = line.component_id === null ? undefined : plans.get(line.component_id);
        const needBy = plan ? (plan.startBy ?? plan.needBy) : null;
        const orderBy =
            needBy !== null && line.lead_days !== null ? dayString(dayNumber(needBy) - line.lead_days) : null;
        return {
            line,
            component: plan?.component ?? null,
            needBy,
            orderBy,
            late: line.status === "to_order" && orderBy !== null && dayNumber(orderBy) < today,
            long: line.status !== "received" && line.lead_days !== null && line.lead_days >= LONG_LEAD_DAYS,
        };
    });
}

/** Dollars, from cents: $1,234.50. */
export const dollars = (cents: number) =>
    (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
