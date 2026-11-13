import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { expect, test } from "vitest";
import { vaultApi } from "../src/vault/api";
import { caliperUrl, folderUrl } from "../src/vault/paths";
import { renderApp, table, Team } from "./team";

// Drawings and DXF files in Caliper: where they're offered, a DXF file's layers, and a SolidWorks drawing's sheets: the
// PDF Vault for SolidWorks made of it, or else the pictures of them SolidWorks saved in it. jsdom draws nothing on a
// canvas and shows no PDFs, so these see the page around them; what's drawn and measured is in dxf.test.ts.

/** A PNG: what SolidWorks keeps its pictures of sheets as (the server only checks that's what it is). */
function png(shade: number): Buffer {
    const chunk = (kind: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind), data])));
        return Buffer.concat([length, Buffer.from(kind), data, sum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(4, 0);
    header.writeUInt32BE(3, 4);
    header[8] = 8; // 8 bits of gray
    const rows = Buffer.concat(Array.from({ length: 3 }, () => Buffer.from([0, shade, shade, shade, shade])));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

/** A drawing as SolidWorks 2015 and later save them, of the streams Caliper reads (as server/tests/test_drawings.py's). */
function drawing(...sheets: string[]): Uint8Array {
    const name = (text: string) =>
        Buffer.concat([Buffer.from([0xff, 0xfe, 0xff, text.length]), Buffer.from(text, "utf16le"), Buffer.alloc(4)]);
    const count = Buffer.alloc(2);
    count.writeUInt16LE(sheets.length);
    const streams: [string, Buffer][] = [
        ["SheetPreviews/SheetNames", Buffer.concat([count, ...sheets.map(name)])],
        ...sheets.map((_, i): [string, Buffer] => [`Images/Sheet_${i}`, png(50 * (i + 1))]),
    ];
    const marker = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
    const parts = [Buffer.alloc(16)];
    streams.forEach(([stream, contents], tag) => {
        const swapped = Buffer.from([...Buffer.from(stream)].map((b) => ((b << 4) | (b >> 4)) & 0xff));
        const body = deflateRawSync(contents);
        const header = Buffer.alloc(20);
        [tag, crc32(contents), body.length, contents.length, swapped.length].forEach((v, i) =>
            header.writeUInt32LE(v, 4 * i),
        );
        parts.push(marker, header, swapped, body);
    });
    return new Uint8Array(Buffer.concat(parts));
}

/** A DXF file in inches, of a part to cut: its outline on Cut, red; a hole on Etch; and a picture, which isn't shown. */
const PLATE = [
    [0, "SECTION", 2, "HEADER", 9, "$INSUNITS", 70, 1, 0, "ENDSEC"],
    [0, "SECTION", 2, "TABLES", 0, "TABLE", 2, "LAYER"],
    [0, "LAYER", 2, "Cut", 70, 0, 62, 1, 6, "CONTINUOUS"],
    [0, "LAYER", 2, "Etch", 70, 0, 62, 5, 6, "CONTINUOUS"],
    [0, "LAYER", 2, "Unused", 70, 0, 62, 3, 6, "CONTINUOUS"],
    [0, "ENDTAB", 0, "ENDSEC"],
    [0, "SECTION", 2, "ENTITIES"],
    [0, "LWPOLYLINE", 8, "Cut", 90, 4, 70, 1, 10, 0, 20, 0, 10, 4, 20, 0, 10, 4, 20, 2, 10, 0, 20, 2],
    [0, "CIRCLE", 8, "Etch", 10, 1, 20, 1, 40, 0.125],
    [0, "IMAGE", 8, "Etch"],
    [0, "ENDSEC", 0, "EOF"],
]
    .flat()
    .join("\n");

test("drawings and DXF files open in Caliper; DXF files have no Open in SolidWorks", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, { "Fin.SLDPRT": "fin", "Plate.DXF": PLATE });
    const [fin] = await team.checkin(
        team.chief,
        { "Fin.SLDDRW": drawing("Sheet1") },
        { refs: { "Fin.SLDDRW": ["Fin.SLDPRT"] } },
    );

    renderApp(team.chief, folderUrl(team.folder));
    const files = await table();
    const row = (name: string) => within(files.getByRole("link", { name }).closest("tr")!);
    expect(row("Fin.SLDDRW").getByRole("link", { name: "Open in SolidWorks" })).toBeTruthy();
    expect(row("Fin.SLDDRW").getByRole("link", { name: "Open in Caliper" }).getAttribute("href")).toBe(
        caliperUrl(fin!.id),
    );
    expect(row("Plate.DXF").getByRole("link", { name: "Open in Caliper" }).getAttribute("title")).toBe(
        "See it in the browser: zoom in, and measure it",
    );
    expect(row("Plate.DXF").queryByRole("link", { name: "Open in SolidWorks" })).toBeNull();

    await userEvent.click(row("Fin.SLDDRW").getByRole("link", { name: "Fin.SLDDRW" }));
    const head = (await screen.findByRole("heading", { name: "Fin.SLDDRW" })).closest("header")!;
    expect(within(head).getByRole("link", { name: "Open in Caliper" })).toBeTruthy();
});

test("a DXF file shows its layers, to show and hide, and says what it leaves out", async () => {
    const team = await Team.create();
    const [plate] = await team.checkin(team.chief, { "Plate.DXF": PLATE });

    renderApp(team.chief, caliperUrl(plate!.id));
    expect(await screen.findByRole("heading", { name: "Plate.DXF" })).toBeTruthy();
    const layers = within(await screen.findByRole("list", { name: "Layers of the drawing" }));
    const cut = (await layers.findByRole("checkbox", { name: "Show Cut" })) as HTMLInputElement;
    expect(cut.checked).toBe(true);
    expect(layers.getByRole("checkbox", { name: "Show Etch" })).toBeTruthy();
    expect(layers.queryByRole("checkbox", { name: "Show Unused" })).toBeNull(); // nothing's on it
    expect(screen.getByText("Not shown: 1 IMAGE.")).toBeTruthy();
    // jsdom has no canvas, which the page says, keeping the layers.
    expect(screen.getByText(/isn't drawing here/)).toBeTruthy();

    await userEvent.click(cut);
    expect(cut.checked).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(cut.checked).toBe(true);
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
        vaultApi.downloadUrl(plate!.id, 1),
    );
});

test("a file that isn't DXF says why", async () => {
    const team = await Team.create();
    const [notes] = await team.checkin(team.chief, { "Notes.dxf": "a note, not a drawing\n" });

    renderApp(team.chief, caliperUrl(notes!.id));
    expect(await screen.findByText(/It isn't a DXF file/)).toBeTruthy();
});

test("a drawing shows the pictures of its sheets until Vault for SolidWorks makes its PDF", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, { "Fin.SLDPRT": "fin" });
    const [fin] = await team.checkin(
        team.chief,
        { "Fin.SLDDRW": drawing("Sheet1", "Detail") },
        { refs: { "Fin.SLDDRW": ["Fin.SLDPRT"] } },
    );

    const pictures = renderApp(team.chief, caliperUrl(fin!.id));
    expect(await screen.findByText(/These are the pictures of its sheets SolidWorks saved in v1/)).toBeTruthy();
    expect(screen.getByText(/click Make PDF on the Vault tab/)).toBeTruthy();
    const sheets = within(screen.getByRole("tablist", { name: "Sheets" }));
    expect(sheets.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Sheet1", "Detail"]);
    const first = screen.getByRole("img", { name: "Sheet1 of Fin.SLDDRW v1, as SolidWorks pictured it" });
    expect(first.getAttribute("src")).toBe(vaultApi.sheetPictureUrl(fin!.id, 1, 1));
    await userEvent.click(sheets.getByRole("tab", { name: "Detail" }));
    const second = screen.getByRole("img", { name: "Detail of Fin.SLDDRW v1, as SolidWorks pictured it" });
    expect(second.getAttribute("src")).toBe(vaultApi.sheetPictureUrl(fin!.id, 1, 2));
    expect(screen.queryByRole("link", { name: "Open PDF" })).toBeNull();
    // It says where the sheets came from, and what that means.
    await userEvent.click(screen.getByRole("button", { name: "Where it came from: Pictures saved in the file" }));
    expect(screen.getByText(/too small to read\. Make PDF, in SolidWorks/)).toBeTruthy();

    // Vault for SolidWorks saves its PDF, which Caliper then shows, in the browser's own viewer.
    await team.drawingPdf(team.chief, fin!, "%PDF-1.7\n%%EOF\n");
    pictures.unmount();
    renderApp(team.chief, caliperUrl(fin!.id, 1));
    const frame = await screen.findByTitle("Fin.SLDDRW v1");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(vaultApi.drawingPdfUrl(fin!.id, 1));
    expect((await screen.findByRole("link", { name: "Open PDF" })).getAttribute("href")).toBe(
        vaultApi.drawingPdfUrl(fin!.id, 1),
    );
    await userEvent.click(screen.getByRole("button", { name: "Where it came from: Made in SolidWorks" }));
    expect(screen.getByText(/^Made by chief, /)).toBeTruthy();
});

test("a drawing whose model changed since it was checked in says its sheets may show older shapes", async () => {
    const team = await Team.create();
    const [part] = await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin" });
    const [fin] = await team.checkin(
        team.chief,
        { "Fins/Fin.SLDDRW": drawing("Sheet1") },
        { refs: { "Fins/Fin.SLDDRW": ["Fins/Fin.SLDPRT"] } },
    );
    await team.drawingPdf(team.chief, fin!, "%PDF-1.7\n%%EOF\n");
    const unchanged = renderApp(team.chief, caliperUrl(fin!.id));
    expect(await screen.findByTitle("Fin.SLDDRW v1")).toBeTruthy();
    expect(screen.queryByText(/changed since this drawing was checked in/)).toBeNull();
    unchanged.unmount();

    await team.checkout(team.chief, "Fins/Fin.SLDPRT", "CHIEF-PC");
    await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin v2" }, { host: "CHIEF-PC" });
    const latest = renderApp(team.chief, caliperUrl(fin!.id));
    expect(await screen.findByText("Its model has changed since this drawing was checked in.")).toBeTruthy();
    expect(screen.getByText(/check it in again to bring them up to date/)).toBeTruthy();
    expect(screen.getByRole("link", { name: team.path("Fins/Fin.SLDPRT") }).getAttribute("href")).toBe(
        caliperUrl(part!.id),
    );
    expect(screen.getByText(/v1 here, now v2/)).toBeTruthy();
    expect(
        [...(screen.getByRole("combobox", { name: "Version" }) as HTMLSelectElement).options].map((o) => o.textContent),
    ).toEqual(["v1 (latest)"]);
    latest.unmount();
});

test("a drawing Caliper can't read says why, and how to show it", async () => {
    const team = await Team.create();
    await team.checkin(team.chief, { "Fin.SLDPRT": "fin" });
    const [fin] = await team.checkin(
        team.chief,
        { "Fin.SLDDRW": "not a drawing" },
        { refs: { "Fin.SLDDRW": ["Fin.SLDPRT"] } },
    );

    renderApp(team.chief, caliperUrl(fin!.id));
    expect(
        await screen.findByText("v1 of Fin.SLDDRW has no PDF, nor pictures of its sheets that Caliper can show."),
    ).toBeTruthy();
    expect(
        screen.getByText(/It isn't a SolidWorks drawing with pictures of its sheets that Caliper can read/),
    ).toBeTruthy();
    expect(screen.getByText(/click Make PDF on the Vault tab/)).toBeTruthy();
});
