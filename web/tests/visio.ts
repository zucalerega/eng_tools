import { makeZip, type InZip } from "./zips";

// Visio drawings for the tests: a .vsdx made as Visio makes them, a zip of XML (its pages, the masters their shapes are
// instances of, and which connector is glued to which shape).

const VISIO = 'xmlns="http://schemas.microsoft.com/office/visio/2012/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

const rels = (targets: Record<string, string>) =>
    `<?xml version="1.0" encoding="utf-8"?><Relationships ${RELS}>${Object.entries(targets)
        .map(
            ([id, target]) =>
                `<Relationship Id="${id}" Type="http://schemas.microsoft.com/visio/2010/relationships/x" Target="${target}"/>`,
        )
        .join("")}</Relationships>`;

const cells = (values: Record<string, string | number>) =>
    Object.entries(values)
        .map(([name, value]) => `<Cell N="${name}" V="${value}"/>`)
        .join("");

/** A shape on a page: its master, its cells, its text, and an outline if it draws one. */
export function shape(
    id: number,
    options: {
        master?: number;
        cells: Record<string, string | number>;
        text?: string;
        outline?: boolean;
        name?: string;
    },
): string {
    const master = options.master ? ` Master="${options.master}"` : "";
    const name = options.name ? ` NameU="${options.name}"` : "";
    const outline = options.outline
        ? '<Section N="Geometry" IX="0"><Row T="MoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row><Row T="LineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0"/></Row></Section>'
        : "";
    const text = options.text === undefined ? "" : `<Text><cp IX="0"/>${options.text}</Text>`;
    return `<Shape ID="${id}"${name} Type="Shape"${master}>${cells(options.cells)}${outline}${text}</Shape>`;
}

/** A master: its name, and its first shape's cells (a connector's have BeginX). */
const master = (id: number, name: string, values: Record<string, string | number>) => ({
    entry: `<Master ID="${id}" NameU="${name}" Name="${name}"><Rel r:id="rId${id}"/></Master>`,
    file: {
        name: `visio/masters/master${id}.xml`,
        contents: `<?xml version="1.0"?><MasterContents ${VISIO}><Shapes>${shape(1, { cells: values, outline: true })}</Shapes></MasterContents>`,
        deflate: true,
    },
});

/** A .vsdx with one page of these shapes and glue (and a background page, which isn't a diagram). */
export function vsdx(pageShapes: string, connects: string): Uint8Array<ArrayBuffer> {
    const masters = [
        master(2, "Vessel", { Width: 1, Height: 1.5 }),
        master(3, "Gate valve", { Width: 0.4, Height: 0.2 }),
        master(4, "Indicator", { Width: 0.3, Height: 0.3 }),
        master(5, "Dynamic connector", { BeginX: 0, BeginY: 0, EndX: 1, EndY: 0 }),
        master(6, "Pneumatic signal", { BeginX: 0, BeginY: 0, EndX: 1, EndY: 0, LinePattern: 2 }),
    ];
    const files: InZip[] = [
        { name: "[Content_Types].xml", contents: '<?xml version="1.0"?><Types/>' },
        {
            name: "visio/pages/pages.xml",
            contents: `<?xml version="1.0" encoding="utf-8"?><Pages ${VISIO} ${R}><Page ID="0" NameU="Page-1" Name="Feed"><PageSheet>${cells({ PageWidth: 11, PageHeight: 8.5 })}</PageSheet><Rel r:id="rId1"/></Page><Page ID="4" NameU="Background-1" Background="1"><PageSheet/><Rel r:id="rId2"/></Page></Pages>`,
            deflate: true,
        },
        { name: "visio/pages/_rels/pages.xml.rels", contents: rels({ rId1: "page1.xml", rId2: "page2.xml" }) },
        {
            name: "visio/pages/page1.xml",
            contents: `<?xml version="1.0" encoding="utf-8"?><PageContents ${VISIO}><Shapes>${pageShapes}</Shapes><Connects>${connects}</Connects></PageContents>`,
            deflate: true,
        },
        {
            name: "visio/pages/page2.xml",
            contents: `<?xml version="1.0"?><PageContents ${VISIO}><Shapes/></PageContents>`,
        },
        {
            name: "visio/masters/masters.xml",
            contents: `<?xml version="1.0" encoding="utf-8"?><Masters ${VISIO} ${R}>${masters.map((entry) => entry.entry).join("")}</Masters>`,
        },
        {
            name: "visio/masters/_rels/masters.xml.rels",
            contents: rels(
                Object.fromEntries(masters.map((_, index) => [`rId${index + 2}`, `master${index + 2}.xml`])),
            ),
        },
        ...masters.map((entry) => entry.file),
    ];
    return makeZip(files);
}

/**
 * A feed system's page: a vessel of LOX, a gate valve turned a quarter (V-1), a pressure transducer (PT over 101), a
 * text box, a box Piper has no part for (DAQ), and connectors: tank to valve (colored blue), tank to PT (saying GN2), a
 * pneumatic signal from the PT to nowhere, and a red line from the box.
 */
export const FEED = [
    shape(1, { master: 2, cells: { PinX: 2, PinY: 5, Width: 1, Height: 1.5 }, text: "LOX" }),
    shape(2, { master: 3, cells: { PinX: 2, PinY: 3, Width: 0.4, Height: 0.2, Angle: Math.PI / 2 }, text: "V-1" }),
    shape(3, { master: 4, cells: { PinX: 4, PinY: 5, Width: 0.3, Height: 0.3 }, text: "PT\n101" }),
    shape(4, { cells: { PinX: 6, PinY: 6, Width: 1, Height: 0.3 }, text: "LOX feed" }),
    shape(5, { name: "Sheet.5", cells: { PinX: 8, PinY: 5, Width: 1, Height: 0.6 }, text: "DAQ", outline: true }),
    shape(6, { master: 5, cells: { BeginX: 2, BeginY: 4.25, EndX: 2, EndY: 3.2, LineColor: "#0070c0" } }),
    shape(7, { master: 5, cells: { BeginX: 2.5, BeginY: 5, EndX: 3.75, EndY: 5 }, text: "GN2" }),
    shape(8, { master: 6, cells: { BeginX: 4, BeginY: 4.8, EndX: 4, EndY: 4 } }),
    shape(9, { master: 5, cells: { BeginX: 7.5, BeginY: 5, EndX: 7, EndY: 5, LineColor: "#ff0000" } }),
].join("");

export const GLUE = [
    '<Connect FromSheet="6" FromCell="BeginX" ToSheet="1" ToCell="PinX"/>',
    '<Connect FromSheet="6" FromCell="EndX" ToSheet="2" ToCell="Connections.X1"/>',
    '<Connect FromSheet="7" FromCell="BeginX" ToSheet="1"/>',
    '<Connect FromSheet="7" FromCell="EndX" ToSheet="3"/>',
    '<Connect FromSheet="8" FromCell="BeginX" ToSheet="3"/>',
    '<Connect FromSheet="9" FromCell="BeginX" ToSheet="5"/>',
].join("");
