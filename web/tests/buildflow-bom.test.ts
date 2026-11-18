import { expect, test } from "vitest";
import {
    centsOf,
    componentNamed,
    guessColumns,
    guessHeader,
    guessLeadUnit,
    leadDaysOf,
    quantityOf,
    readLines,
    statusOf,
} from "../src/buildflow/billOfMaterials";
import { parseCsv, readSheets, SheetError } from "../src/buildflow/sheets";
import type { ProgramDetail } from "../src/buildflow/api";
import { makeZip } from "./zips";

// Reading a BOM in, without the server: a CSV file's rows and an Excel workbook's sheets, which column says what by its
// header, and each cell's value as the server keeps it.

test("a CSV file's rows: quoted cells whole, doubled quotes one, and line breaks in a cell kept", () => {
    const text = '﻿Part #,Description,Qty\r\nSS-63TS8,"1/2"" ball valve, 316",1\r\n91251A463,"Screw\nlong",12\n';
    expect(parseCsv(text)).toEqual([
        ["Part #", "Description", "Qty"],
        ["SS-63TS8", '1/2" ball valve, 316', "1"],
        ["91251A463", "Screw\nlong", "12"],
    ]);
    // Semicolons, or tabs, when that's what the first line has most of.
    expect(parseCsv("Part;Qty\nA-1;2,5")).toEqual([
        ["Part", "Qty"],
        ["A-1", "2,5"],
    ]);
    expect(parseCsv("Part\tQty\nA-1\t2")).toEqual([
        ["Part", "Qty"],
        ["A-1", "2"],
    ]);
});

const workbook = (sheets: { name: string; xml: string }[], strings: string[]) =>
    new Blob([
        makeZip([
            {
                name: "xl/workbook.xml",
                contents: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
                    .map(
                        (sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
                    )
                    .join("")}</sheets></workbook>`,
            },
            {
                name: "xl/_rels/workbook.xml.rels",
                contents: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
                    .map(
                        (_, index) =>
                            `<Relationship Id="rId${index + 1}" Type="worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
                    )
                    .join("")}</Relationships>`,
            },
            {
                name: "xl/sharedStrings.xml",
                contents: `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings
                    .map((text) => `<si><t>${text}</t></si>`)
                    .join("")}</sst>`,
                deflate: true,
            },
            ...sheets.map((sheet, index) => ({
                name: `xl/worksheets/sheet${index + 1}.xml`,
                contents: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.xml}</sheetData></worksheet>`,
                deflate: true,
            })),
        ]),
    ]);

test("an Excel workbook's sheets: shared and inline strings, numbers as Excel shows them, and gaps kept", async () => {
    const file = workbook(
        [
            { name: "Notes", xml: `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` },
            {
                name: "BOM",
                xml:
                    `<row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c></row>` +
                    `<row r="3"><c r="A3" t="inlineStr"><is><t>SS-63TS8</t></is></c><c r="C3"><v>412.50000000000006</v></c></row>`,
            },
        ],
        ["Read me", "Part number", "Cost"],
    );
    const sheets = await readSheets(file, "Elytra BOM.xlsx");
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Notes", "BOM"]);
    expect(sheets[1]!.rows).toEqual([[], ["Part number", "", "Cost"], ["SS-63TS8", "", "412.5"]]);
});

test("an old Excel file, or a damaged one, says what to do", async () => {
    const old = new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]);
    await expect(readSheets(old, "BOM.xls")).rejects.toThrow(/before 2007 \(\.xls\)\. Open it in Excel, save it/);
    const notOne = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])]);
    await expect(readSheets(notOne, "BOM.xlsx")).rejects.toBeInstanceOf(SheetError);
});

test("which column says what, by its header, as teams write them", () => {
    const headers = [
        "Item #",
        "Part No.",
        "Description",
        "Assembly",
        "Qty",
        "Supplier",
        "Unit Price",
        "Total",
        "Lead Time (days)",
        "Link",
        "Ordered?",
    ];
    expect(guessColumns(headers)).toEqual({
        part_number: 1,
        description: 2,
        component: 3,
        quantity: 4,
        vendor: 5,
        unit_cost: 6,
        lead: 8,
        url: 9,
        status: 10,
    });
    expect([guessLeadUnit("Lead Time (days)"), guessLeadUnit("Lead (wks)"), guessLeadUnit("Lead")]).toEqual([
        "days",
        "weeks",
        "weeks",
    ]);
    expect(guessHeader([["Elytra BOM"], [], ["PN", "Qty"], ["A-1", "2"]])).toBe(2);
});

test("each cell's value, as the server keeps it", () => {
    expect([quantityOf("12"), quantityOf("1.5 ft"), quantityOf("1,000"), quantityOf("TBD")]).toEqual([
        { quantity: 12, unit: "" },
        { quantity: 1.5, unit: "ft" },
        { quantity: 1000, unit: "" },
        { quantity: null, unit: "" },
    ]);
    expect([centsOf("$41.25"), centsOf("1,234.5 USD"), centsOf("TBD"), centsOf("")]).toEqual([
        4125,
        123450,
        null,
        null,
    ]);
    expect([
        leadDaysOf("10", "weeks"),
        leadDaysOf("14", "days"),
        leadDaysOf("2-3 weeks", "days"),
        leadDaysOf("3 mo", "weeks"),
        leadDaysOf("In stock", "weeks"),
        leadDaysOf("", "weeks"),
    ]).toEqual([70, 14, 21, 90, 0, null]);
    expect([
        statusOf("Received"),
        statusOf("PO placed"),
        statusOf("not ordered"),
        statusOf("yes", "Ordered?"),
        statusOf("x", "In hand"),
        statusOf("no", "Ordered?"),
        statusOf(""),
        statusOf("maybe"),
    ]).toEqual(["received", "ordered", "to_order", "ordered", "received", "to_order", null, null]);
});

test("a sheet's lines: each row with a part, not a section's title, its values read, its link only if it's one", () => {
    const rows = [
        ["Elytra BOM"],
        ["PN", "Description", "Component", "Qty", "Vendor", "Cost", "Lead (wks)", "Link", "Status"],
        ["", "PROPULSION"],
        [
            "SS-63TS8",
            "1/2 in ball valve",
            "Main oxidizer valve",
            "1",
            "Swagelok",
            "$412.50",
            "10",
            "https://www.swagelok.com",
            "Ordered",
        ],
        ["", "C101 copper plate", "Injector", "1.5 ft", "", "", "3", "javascript:alert(1)", ""],
        [],
    ];
    const lines = readLines(rows, { header: 1, columns: guessColumns(rows[1]!), leadUnit: "weeks" });
    expect(lines).toEqual([
        {
            row: 4,
            part_number: "SS-63TS8",
            description: "1/2 in ball valve",
            component: "Main oxidizer valve",
            quantity: 1,
            unit: "",
            vendor: "Swagelok",
            unit_cost: 41250,
            lead_days: 70,
            url: "https://www.swagelok.com",
            status: "ordered",
        },
        {
            row: 5,
            part_number: "",
            description: "C101 copper plate",
            component: "Injector",
            quantity: 1.5,
            unit: "ft",
            vendor: "",
            unit_cost: null,
            lead_days: 21,
            url: "",
            status: null,
        },
    ]);
    const program = { components: [{ id: 7, name: "Main  Oxidizer Valve" }] } as unknown as ProgramDetail;
    expect(componentNamed(program, "main oxidizer valve")?.id).toBe(7);
    expect(componentNamed(program, "Injector")).toBeNull();
});
