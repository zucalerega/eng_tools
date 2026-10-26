import { makeZip, type InZip } from "./zips";

// Visio drawings for the tests: a .vsdx made as Visio makes them, a zip of XML: its pages' shapes (groups with their
// members), the masters they're instances of (whose members an instance's members are), the document's styles and
// colors, and which connector is glued to which shape.

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

/** A geometry row: its type, its cells, and its index (its place in the section, if not where it's listed). */
export type GeometryRow = [type: string, values: Record<string, string | number>, ix?: number];

/** A shape as a test writes it. */
export interface ShapeSpec {
    id: number;
    master?: number;
    masterShape?: number; // a member of an instance: the master's member it is
    type?: "Shape" | "Group";
    name?: string;
    styles?: { line?: number; fill?: number; text?: number };
    cells?: Record<string, string | number>;
    geometry?: { cells?: Record<string, string | number>; rows: GeometryRow[] }[];
    character?: Record<string, string | number>[]; // its character formats, by index
    paragraph?: Record<string, string | number>[];
    connections?: [number, number][];
    text?: string; // its Text element's contents: words, and <cp IX="1"/> where they change format
    members?: ShapeSpec[];
}

/** A rectangle's outline as Visio's basic shapes have it: relative to the shape's width and height. */
export const RECTANGLE: { rows: GeometryRow[] } = {
    rows: [
        ["RelMoveTo", { X: 0, Y: 0 }],
        ["RelLineTo", { X: 1, Y: 0 }],
        ["RelLineTo", { X: 1, Y: 1 }],
        ["RelLineTo", { X: 0, Y: 1 }],
        ["RelLineTo", { X: 0, Y: 0 }],
    ],
};

const rowsOf = (name: string, rows: Record<string, string | number>[] | undefined) =>
    rows
        ? `<Section N="${name}">${rows.map((row, index) => `<Row IX="${index}">${cells(row)}</Row>`).join("")}</Section>`
        : "";

export function shapeXml(spec: ShapeSpec): string {
    const attributes = [
        `ID="${spec.id}"`,
        spec.name ? `NameU="${spec.name}"` : "",
        `Type="${spec.type ?? (spec.members ? "Group" : "Shape")}"`,
        spec.master ? `Master="${spec.master}"` : "",
        spec.masterShape ? `MasterShape="${spec.masterShape}"` : "",
        spec.styles?.line !== undefined ? `LineStyle="${spec.styles.line}"` : "",
        spec.styles?.fill !== undefined ? `FillStyle="${spec.styles.fill}"` : "",
        spec.styles?.text !== undefined ? `TextStyle="${spec.styles.text}"` : "",
    ]
        .filter(Boolean)
        .join(" ");
    const geometry = (spec.geometry ?? [])
        .map(
            (section, index) =>
                `<Section N="Geometry" IX="${index}">${cells(section.cells ?? {})}${section.rows
                    .map(([type, values, ix], row) => `<Row T="${type}" IX="${ix ?? row + 1}">${cells(values)}</Row>`)
                    .join("")}</Section>`,
        )
        .join("");
    const connections = spec.connections
        ? `<Section N="Connection">${spec.connections
              .map(([x, y], index) => `<Row T="Connection" IX="${index}">${cells({ X: x, Y: y })}</Row>`)
              .join("")}</Section>`
        : "";
    const text = spec.text === undefined ? "" : `<Text>${spec.text}</Text>`;
    const members = spec.members ? `<Shapes>${spec.members.map(shapeXml).join("")}</Shapes>` : "";
    return `<Shape ${attributes}>${cells(spec.cells ?? {})}${rowsOf("Character", spec.character)}${rowsOf(
        "Paragraph",
        spec.paragraph,
    )}${geometry}${connections}${text}${members}</Shape>`;
}

/** A shape on a page: its master, its cells, its text, and a rectangle's outline if it draws one. */
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
    return shapeXml({
        id,
        master: options.master,
        name: options.name,
        cells: options.cells,
        geometry: options.outline ? [RECTANGLE] : undefined,
        text: options.text === undefined ? undefined : `<cp IX="0"/>${options.text}`,
    });
}

export interface MasterSpec {
    id: number;
    name: string;
    shape: ShapeSpec; // the master's shape (a group, with its members)
}

export interface PageSpec {
    name: string;
    width?: number;
    height?: number;
    shapes: string; // its shapes' XML
    connects?: string;
    background?: boolean;
}

/**
 * A .vsdx of pages, masters, and the document's styles (StyleSheet elements, by id) and colors (after Visio's own 24),
 * with a background page after them, which isn't a diagram.
 */
export function vsdxOf(options: { pages: PageSpec[]; masters?: MasterSpec[]; styles?: string; colors?: string[] }) {
    const pages = [...options.pages, { name: "Background-1", shapes: "", background: true }];
    const masters = options.masters ?? [];
    const document = `<?xml version="1.0" encoding="utf-8"?><VisioDocument ${VISIO}><Colors>${(options.colors ?? [])
        .map((rgb, index) => `<ColorEntry IX="${24 + index}" RGB="${rgb}"/>`)
        .join("")}</Colors><StyleSheets>${options.styles ?? ""}</StyleSheets></VisioDocument>`;
    const files: InZip[] = [
        { name: "[Content_Types].xml", contents: '<?xml version="1.0"?><Types/>' },
        {
            name: "_rels/.rels",
            contents: `<?xml version="1.0"?><Relationships ${RELS}><Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/></Relationships>`,
        },
        { name: "visio/document.xml", contents: document, deflate: true },
        {
            name: "visio/_rels/document.xml.rels",
            contents: `<?xml version="1.0"?><Relationships ${RELS}><Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/masters" Target="masters/masters.xml"/><Relationship Id="rId2" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/></Relationships>`,
        },
        {
            name: "visio/pages/pages.xml",
            contents: `<?xml version="1.0" encoding="utf-8"?><Pages ${VISIO} ${R}>${pages
                .map(
                    (page, index) =>
                        `<Page ID="${index}" NameU="Page-${index + 1}" Name="${page.name}"${
                            page.background ? ' Background="1"' : ""
                        }><PageSheet>${cells({
                            PageWidth: page.width ?? 11,
                            PageHeight: page.height ?? 8.5,
                        })}</PageSheet><Rel r:id="rId${index + 1}"/></Page>`,
                )
                .join("")}</Pages>`,
            deflate: true,
        },
        {
            name: "visio/pages/_rels/pages.xml.rels",
            contents: rels(Object.fromEntries(pages.map((_, index) => [`rId${index + 1}`, `page${index + 1}.xml`]))),
        },
        ...pages.map((page, index) => ({
            name: `visio/pages/page${index + 1}.xml`,
            contents: `<?xml version="1.0" encoding="utf-8"?><PageContents ${VISIO}><Shapes>${page.shapes}</Shapes><Connects>${"connects" in page ? (page.connects ?? "") : ""}</Connects></PageContents>`,
            deflate: true,
        })),
        {
            name: "visio/masters/masters.xml",
            contents: `<?xml version="1.0" encoding="utf-8"?><Masters ${VISIO} ${R}>${masters
                .map(
                    (master) =>
                        `<Master ID="${master.id}" NameU="${master.name}" Name="${master.name}"><Rel r:id="rId${master.id}"/></Master>`,
                )
                .join("")}</Masters>`,
        },
        {
            name: "visio/masters/_rels/masters.xml.rels",
            contents: rels(Object.fromEntries(masters.map((master) => [`rId${master.id}`, `master${master.id}.xml`]))),
        },
        ...masters.map((master) => ({
            name: `visio/masters/master${master.id}.xml`,
            contents: `<?xml version="1.0"?><MasterContents ${VISIO}><Shapes>${shapeXml(master.shape)}</Shapes></MasterContents>`,
            deflate: true,
        })),
    ];
    return makeZip(files);
}

/** A connector glued to a shape at one of its ends. */
export const glued = (connector: number, end: "Begin" | "End", to: number, cell = "PinX") =>
    `<Connect FromSheet="${connector}" FromCell="${end}X" ToSheet="${to}" ToCell="${cell}"/>`;

/** The masters a feed system's drawn with: Visio's P&ID stencils' vessel, valve, and indicator, and its connectors. */
export const FEED_MASTERS: MasterSpec[] = [
    { id: 2, name: "Vessel", shape: { id: 1, cells: { Width: 1, Height: 1.5 }, geometry: [RECTANGLE] } },
    { id: 3, name: "Gate valve", shape: { id: 1, cells: { Width: 0.4, Height: 0.2 }, geometry: [RECTANGLE] } },
    { id: 4, name: "Indicator", shape: { id: 1, cells: { Width: 0.3, Height: 0.3 }, geometry: [RECTANGLE] } },
    {
        id: 5,
        name: "Dynamic connector",
        shape: {
            id: 1,
            cells: { BeginX: 0, BeginY: 0, EndX: 1, EndY: 0, Width: 1, Height: 0 },
            geometry: [
                {
                    cells: { NoFill: 1 },
                    rows: [
                        ["MoveTo", { X: 0, Y: 0 }],
                        ["LineTo", { X: 1, Y: 0 }],
                    ],
                },
            ],
        },
    },
    {
        id: 6,
        name: "Pneumatic signal",
        shape: {
            id: 1,
            cells: { BeginX: 0, BeginY: 0, EndX: 1, EndY: 0, Width: 1, Height: 0, LinePattern: 2 },
            geometry: [
                {
                    cells: { NoFill: 1 },
                    rows: [
                        ["MoveTo", { X: 0, Y: 0 }],
                        ["LineTo", { X: 1, Y: 0 }],
                    ],
                },
            ],
        },
    },
];

/** A .vsdx with one page of these shapes and glue, drawn with the feed system's masters. */
export function vsdx(pageShapes: string, connects: string): Uint8Array<ArrayBuffer> {
    return vsdxOf({ pages: [{ name: "Feed", shapes: pageShapes, connects }], masters: FEED_MASTERS });
}

/** A connector from one point to another, as its route runs (its geometry, in its own frame, from its begin). */
export function connector(
    id: number,
    from: [number, number],
    to: [number, number],
    options: {
        master?: number;
        route?: [number, number][];
        cells?: Record<string, string | number>;
        text?: string;
    } = {},
): ShapeSpec {
    const points = [from, ...(options.route ?? []), to];
    return {
        id,
        master: options.master ?? 5,
        cells: {
            BeginX: from[0],
            BeginY: from[1],
            EndX: to[0],
            EndY: to[1],
            // A 1-D shape's frame starts at its begin: its pin there, unturned, so its route is from it.
            PinX: from[0],
            PinY: from[1],
            Width: Math.hypot(to[0] - from[0], to[1] - from[1]),
            Height: 0,
            LocPinX: 0,
            LocPinY: 0,
            ...options.cells,
        },
        geometry: [
            {
                cells: { NoFill: 1 },
                rows: points.map(([x, y], index) => [
                    index === 0 ? "MoveTo" : "LineTo",
                    { X: x - from[0], Y: y - from[1] },
                ]),
            },
        ],
        text: options.text === undefined ? undefined : `<cp IX="0"/>${options.text}`,
    };
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
