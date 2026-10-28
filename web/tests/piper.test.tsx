import { createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, onTestFinished, test, vi } from "vitest";
import type { Diagram } from "../src/piper/api";
import { LIGHT } from "../src/piper/colors";
import { emptyDrawing, type Drawing } from "../src/piper/drawing";
import { addPart, connect } from "../src/piper/edit";
import { example } from "../src/piper/example";
import { presetOf } from "../src/piper/library/index";
import { drag } from "./drag";
import { renderApp, Team } from "./team";
import { jpegHeader, rgbaPng } from "./pngs";
import { FEED, GLUE, vsdx } from "./visio";

// Piper, through the app: its diagrams, the editor (placing parts, drawing lines, a valve into a line, the inspector),
// saving and its conflicts, history, a test from Yorg on the drawing, deleting, importing Visio, and the PDF export.

// Piper's pages load when one's first opened (src/piper/index.tsx). Loaded here first, the editor's code is compiled
// before the tests, not while the first one to open it waits for it.
beforeAll(async () => {
    await Promise.all([import("../src/piper/Diagrams"), import("../src/piper/Editor"), import("../src/piper/Help")]);
});

const drawingArea = () => screen.getByRole("application", { name: "Drawing" });

/**
 * A point of the drawing, as the pointer's there. The canvas is a pixel wide in jsdom (it lays nothing out), so the
 * view's box is a pixel over its zoom wide: a point is where it is in that box.
 */
function at(x: number, y: number) {
    const [vx, vy, vw] = drawingArea().getAttribute("viewBox")!.split(" ").map(Number) as [number, number, number];
    const zoom = 1 / vw;
    return { clientX: (x - vx) * zoom, clientY: (y - vy) * zoom, pointerId: 1, button: 0 };
}

/** A part placed in a drawing made for a test: its id. */
function place(drawing: { value: Drawing }, preset: string, x: number, y: number): string {
    const added = addPart(drawing.value, presetOf(preset)!, { x, y });
    drawing.value = added.drawing;
    return added.id;
}

/** Edit, on a diagram opened to be looked at: it's yours to change, with the library to place parts from. */
async function startEditing() {
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Done editing" });
}

/** What a test's badge beside a part says. */
const badge = (part: string) => drawingArea().querySelector(`[data-live="${part}"] text`)?.textContent ?? null;

test("Piper is the site's third app: its diagrams, in their folders", async () => {
    const team = await Team.create();
    await team.diagram(team.chief, "Feed system", undefined, "Vespula/Prop");
    await team.diagram(team.chief, "Cold flow stand");
    renderApp(team.chief, "/piper");
    const apps = await screen.findByRole("navigation", { name: "Apps" });
    expect(within(apps).getByRole("link", { name: "Piper" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("heading", { name: "Diagrams" })).toBeTruthy();
    expect(document.title).toBe("Piper");
    // Found by a word of their names (and here, of this test's), in every folder: each says which it's in.
    await userEvent.type(await screen.findByRole("searchbox", { name: "Find diagrams" }), team.folder);
    const table = within(await screen.findByRole("table", { name: "Diagrams" }));
    const feed = (await table.findByRole("link", { name: team.named("Feed system") })).closest("tr")!;
    expect(within(feed).getByText("in Vespula/Prop")).toBeTruthy();
    const loose = table.getByRole("link", { name: team.named("Cold flow stand") }).closest("tr")!;
    expect(within(loose).getByText("in Diagrams")).toBeTruthy(); // the top
});

test("folders: made, moved into by choosing or dragging, opened, renamed, and kept while they hold something", async () => {
    const team = await Team.create();
    const loose = await team.diagram(team.chief, "Cold flow stand");
    const other = await team.diagram(team.chief, "Fill line");
    renderApp(team.chief, "/piper");
    const table = within(await screen.findByRole("table", { name: "Diagrams" }));
    const row = (diagram: Diagram) => table.getByRole("link", { name: diagram.name }).closest("tr")!;
    await table.findByRole("link", { name: loose.name });

    const folder = team.named("Prop");
    await userEvent.click(screen.getByRole("button", { name: "New folder" }));
    const made = within(await screen.findByRole("dialog", { name: "New folder" }));
    await userEvent.type(made.getByLabelText("Name"), folder);
    await userEvent.click(made.getByRole("button", { name: "Make it" }));
    const folderRow = async () => (await table.findByRole("link", { name: folder })).closest("tr")!;
    expect(within(await folderRow()).getByText("0 diagrams")).toBeTruthy();

    // One chosen and moved there; another dragged onto it.
    await userEvent.click(within(row(loose)).getByRole("checkbox", { name: `Choose ${loose.name}` }));
    expect(screen.getByText("1 diagram chosen")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    const move = within(await screen.findByRole("dialog", { name: "Move a diagram" }));
    await userEvent.click(move.getByRole("radio", { name: folder }));
    await userEvent.click(move.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(table.queryByRole("link", { name: loose.name })).toBeNull());
    drag(row(other), () => table.getByRole("link", { name: folder }).closest("tr")!);
    await waitFor(() => expect(table.queryByRole("link", { name: other.name })).toBeNull());
    expect(within(await folderRow()).getByText("2 diagrams")).toBeTruthy();
    expect((await team.piperDiagram(team.chief, other.id)).folder).toBe(folder);

    // A folder with diagrams in it isn't deleted: the server says why.
    await userEvent.click(within(await folderRow()).getByRole("button", { name: `Delete ${folder}` }));
    await userEvent.click(
        within(await screen.findByRole("dialog", { name: `Delete ${folder}?` })).getByRole("button", {
            name: "Delete",
        }),
    );
    expect(await screen.findByText(`${folder} isn't empty: move what's in it out first`)).toBeTruthy();

    // In it: its diagrams, the way back up, and a new diagram made there.
    await userEvent.click(within(await folderRow()).getByRole("link", { name: folder }));
    expect(await screen.findByRole("heading", { name: folder })).toBeTruthy();
    const inside = within(await screen.findByRole("table", { name: "Diagrams" }));
    expect(await inside.findByRole("link", { name: loose.name })).toBeTruthy();
    expect(inside.getByRole("link", { name: other.name })).toBeTruthy();
    const crumbs = within(screen.getByRole("navigation", { name: "Folders" }));
    expect(crumbs.getByRole("link", { name: "Diagrams" }).getAttribute("href")).toBe("/piper");
    await userEvent.click(screen.getByRole("button", { name: "New diagram" }));
    const dialog = within(await screen.findByRole("dialog", { name: `New diagram in ${folder}` }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), team.named("Oxidizer side"));
    await userEvent.click(dialog.getByRole("button", { name: "Make it" }));
    await screen.findByRole("application", { name: "Drawing" });
    const fresh = await team.piperDiagram(team.chief, Number(window.location.pathname.split("/").pop()));
    expect(fresh.folder).toBe(folder);
});

test("a folder renamed keeps its diagrams; an empty one is deleted", async () => {
    const team = await Team.create();
    const kept = await team.piperFolder(team.chief, "Stand");
    const empty = await team.piperFolder(team.chief, "Spare");
    const inside = await team.diagram(team.chief, "Hotfire", undefined, kept.path);
    renderApp(team.chief, "/piper");
    const table = within(await screen.findByRole("table", { name: "Diagrams" }));
    const rowOf = async (name: string) => (await table.findByRole("link", { name })).closest("tr")!;

    await userEvent.click(within(await rowOf(kept.name)).getByRole("button", { name: `Rename ${kept.name}` }));
    const rename = within(await screen.findByRole("dialog", { name: `Rename ${kept.name}` }));
    await userEvent.clear(rename.getByLabelText("Name"));
    await userEvent.type(rename.getByLabelText("Name"), team.named("Hotfire stand"));
    await userEvent.click(rename.getByRole("button", { name: "Rename" }));
    expect(within(await rowOf(team.named("Hotfire stand"))).getByText("1 diagram")).toBeTruthy();
    expect((await team.piperDiagram(team.chief, inside.id)).folder).toBe(team.named("Hotfire stand"));

    await userEvent.click(within(await rowOf(empty.name)).getByRole("button", { name: `Delete ${empty.name}` }));
    await userEvent.click(
        within(await screen.findByRole("dialog", { name: `Delete ${empty.name}?` })).getByRole("button", {
            name: "Delete",
        }),
    );
    await waitFor(() => expect(table.queryByRole("link", { name: empty.name })).toBeNull());
});

test("New diagram opens the editor: a part placed from the library is tagged, renamed, and saved", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/piper");
    await userEvent.click(await screen.findByRole("button", { name: "New diagram" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New diagram" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), team.named("Stand"));
    await userEvent.click(dialog.getByRole("button", { name: "Make it" }));
    const svg = await screen.findByRole("application", { name: "Drawing" });
    expect(await screen.findByRole("button", { name: "Done editing" })).toBeTruthy(); // made just now: to edit
    expect(screen.getByRole("heading", { name: "An empty diagram" })).toBeTruthy(); // what to do first

    await userEvent.click(screen.getByRole("button", { name: "Pressure transducer" }));
    fireEvent.pointerDown(svg, at(103, 48));
    fireEvent.pointerUp(svg, at(103, 48));
    expect(await within(svg).findByRole("button", { name: "PT-1" })).toBeTruthy();
    // It's selected: the inspector says what it is, and its tag's to type.
    expect(screen.getByRole("heading", { name: "Pressure transducer" })).toBeTruthy();
    const tag = screen.getByRole("textbox", { name: "Tag" });
    await userEvent.clear(tag);
    await userEvent.type(tag, "PT-OX-01");
    const id = Number(window.location.pathname.split("/").pop());
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, id)).read;
        expect(saved.parts.map((part) => [part.kind, part.tag, part.x, part.y])).toEqual([
            ["instrument", "PT-OX-01", 100, 50],
        ]);
    });
});

test("a part dragged from the library goes where it's let go, and the drag doesn't start placing", async () => {
    const team = await Team.create();
    const made = await team.diagram(team.chief, "Dragged onto");
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    // jsdom lays nothing out: the drawing's box is given as reaching right and down from where at() measures from, and
    // the library's left of it.
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1e6, 1e6));
    const item = screen.getByRole("button", { name: "Pressure transducer" });
    const pointer = { pointerId: 1, isPrimary: true, button: 0 };
    fireEvent.pointerDown(item, { ...pointer, clientX: -120, clientY: 300 });
    fireEvent.pointerMove(item, { ...pointer, clientX: -60, clientY: 200 }); // over the library still: no part yet
    expect(within(svg).queryByRole("button", { name: "PT-1" })).toBeNull();
    fireEvent.pointerMove(item, { ...pointer, ...at(203, 98) });
    expect(within(svg).getByRole("button", { name: "PT-1" })).toBeTruthy(); // shown where it would go
    fireEvent.pointerUp(item, { ...pointer, ...at(203, 98) });
    fireEvent.click(item); // the click a drag ends with
    expect(item.getAttribute("aria-pressed")).toBe("false");
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read;
        expect(saved.parts.map((part) => [part.tag, part.x, part.y])).toEqual([["PT-1", 200, 100]]);
    });
});

test("3/2 and 5/2 solenoid valves, a diffuser, and a manifold come from the library; a manifold's outlets are chosen", async () => {
    const team = await Team.create();
    const made = await team.diagram(team.chief, "Pneumatics panel");
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    for (const [name, x] of [
        ["3/2 solenoid valve", 0],
        ["5/2 solenoid valve", 200],
        ["Diffuser", 400],
        ["Manifold", 600],
    ] as const) {
        await userEvent.click(screen.getByRole("button", { name }));
        fireEvent.pointerDown(svg, at(x, 0));
        fireEvent.pointerUp(svg, at(x, 0));
    }
    // The manifold, placed last, is selected: six outlets for it, on the right, drawn along its top.
    expect(screen.getByRole("heading", { name: "Manifold" })).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Outlets" }), "6");
    const bore = svg.querySelector('[data-kind="manifold"] path[stroke-dasharray]')!.getAttribute("d")!;
    expect(bore.match(/V-8/g)).toHaveLength(6);
    // A 3/2 is normally closed or open, never failing in place: its spring returns it.
    fireEvent.pointerDown(within(svg).getByRole("button", { name: "SV-1" }), at(0, 0));
    fireEvent.pointerUp(svg, at(0, 0));
    const states = within(await screen.findByRole("group", { name: "Normal state" }));
    expect(states.getAllByRole("button").map((button) => button.textContent)).toEqual(["NO", "NC", "—"]);
    expect(states.getByRole("button", { name: "NC" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read;
        expect(
            saved.parts.map((part) => [part.kind, part.tag, part.props.normal ?? "", part.props.outlets ?? ""]),
        ).toEqual([
            ["valve32", "SV-1", "NC", ""], // normally closed, as a pilot valve usually is
            ["valve52", "SV-2", "", ""],
            ["diffuser", "DIFF-1", "", ""],
            ["manifold", "MAN-1", "", "6"],
        ]);
    });
});

test("a line drawn from one part's port to another's is routed, and carries the fluid it's drawn from", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    const bottle = place(drawing, "bottle", 0, 0); // nitrogen; its neck's port up, at (0, -50)
    const valve = place(drawing, "ball-valve", 200, -120); // its first port at (180, -120)
    const made = await team.diagram(team.chief, "Pressurant", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    // The pointer on the bottle shows its ports, to drag a line from.
    fireEvent.pointerMove(within(svg).getByRole("button", { name: "B-1" }), at(0, 0));
    const port = await waitFor(() => {
        const found = svg.querySelector(`[data-hit="port:${bottle}:top"]`);
        expect(found).not.toBeNull();
        return found!;
    });
    fireEvent.pointerDown(port, at(0, -50));
    fireEvent.pointerMove(svg, at(100, -100));
    fireEvent.pointerMove(svg, at(181, -119)); // near the valve's port: the line goes to it
    fireEvent.pointerUp(svg, at(181, -119));
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read;
        expect(saved.lines).toHaveLength(1);
        expect(saved.lines[0]).toMatchObject({
            from: { part: bottle, port: "top" },
            to: { part: valve, port: "a" },
            fluid: "gn2",
            auto: true,
        });
        expect(saved.lines[0]!.points.length).toBeGreaterThan(0); // up out of the bottle, then across
    });
    expect(screen.getByRole("heading", { name: "Pipe" })).toBeTruthy(); // the new line's selected
});

test("a valve dropped on a line goes into it; deleting it joins the line up again", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    const left = place(drawing, "ball-valve", 0, 0);
    const right = place(drawing, "ball-valve", 300, 0);
    drawing.value = connect(drawing.value, { part: left, port: "b" }, { part: right, port: "a" })!.drawing;
    const made = await team.diagram(team.chief, "Into a line", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    await userEvent.click(screen.getByRole("button", { name: "Check valve" }));
    fireEvent.pointerMove(svg, at(150, 3));
    fireEvent.pointerDown(svg, at(150, 3));
    fireEvent.pointerUp(svg, at(150, 3));
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read;
        const check = saved.parts.find((part) => part.kind === "check")!;
        expect([check.x, check.y, check.rotation]).toEqual([150, 0, 0]);
        expect(saved.lines).toHaveLength(2);
    });
    await userEvent.keyboard("{Delete}");
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read;
        expect(saved.parts.map((part) => part.kind)).toEqual(["valve", "valve"]);
        expect(saved.lines).toHaveLength(1);
        expect(saved.lines[0]).toMatchObject({ from: { part: left, port: "b" }, to: { part: right, port: "a" } });
    });
});

test("the inspector says what a part is: its normal state, what it shows, and fields of the team's own", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    const valve = place(drawing, "ball-valve", 0, 0);
    const made = await team.diagram(team.chief, "Inspector", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    const part = within(svg).getByRole("button", { name: "BV-1" });
    fireEvent.pointerDown(part, at(0, 0));
    fireEvent.pointerUp(svg, at(0, 0));
    const inspector = within(await screen.findByRole("complementary", { name: "Inspector" }));
    expect(inspector.getByRole("heading", { name: "Ball valve" })).toBeTruthy();
    await userEvent.click(
        within(inspector.getByRole("group", { name: "Normal state" })).getByRole("button", { name: /NC/ }),
    );
    await userEvent.type(inspector.getByRole("textbox", { name: "Size" }), "1/4 in");
    await userEvent.click(inspector.getByRole("button", { name: "Show Size on the drawing" }));
    await userEvent.click(inspector.getByRole("button", { name: "+ Add a field" }));
    await userEvent.type(inspector.getByRole("textbox", { name: "New field's name" }), "Part number");
    await userEvent.click(inspector.getByRole("button", { name: "Add" }));
    await userEvent.type(inspector.getByRole("textbox", { name: "Part number" }), "SS-45S8");
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read.parts.find((entry) => entry.id === valve)!;
        expect(saved.props).toMatchObject({ normal: "NC", size: "1/4 in", "Part number": "SS-45S8" });
        expect(saved.shown).toEqual(["size"]);
    });
    // Under its tag on the drawing: its size. Its state's in its color, not written beside it too, unless it's shown.
    expect(within(svg).getByText("1/4 in")).toBeTruthy();
    expect(within(svg).queryByText("NC")).toBeNull();
});

test("a part links to pages about it: added on the right, opened from it, only http, https, or mailto", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    place(drawing, "pneumatic-valve", 0, 0);
    const made = await team.diagram(team.chief, "Elytra", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    const select = () => {
        fireEvent.pointerDown(within(svg).getByRole("button", { name: "PV-1" }), at(0, 0));
        fireEvent.pointerUp(svg, at(0, 0));
    };
    select();
    const links = within(await screen.findByRole("region", { name: "Links" }));
    await userEvent.click(links.getByRole("button", { name: "+ Add a link" }));
    await userEvent.type(links.getByRole("textbox", { name: "Link's name" }), "Notion");
    // Nothing that would run in the site when it's opened: only http, https, and mailto.
    const address = links.getByRole("textbox", { name: "Link's address" });
    await userEvent.type(address, "javascript:alert(1)");
    expect(links.getByRole("button", { name: "Add link" })).toHaveProperty("disabled", true);
    expect(links.getByText(/A link starts with https:\/\/, http:\/\/, or mailto:/)).toBeTruthy();
    await userEvent.clear(address);
    await userEvent.type(address, "https://www.notion.so/yjsp/FMV-1234");
    await userEvent.click(links.getByRole("button", { name: "Add link" }));
    // It opens in a tab of its own, and the part's marked as having links.
    const link = links.getByRole("link", { name: "Notion" });
    expect(link.getAttribute("href")).toBe("https://www.notion.so/yjsp/FMV-1234");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(svg.querySelector("[data-links]")).not.toBeNull();
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read;
        expect(saved.parts[0]!.links).toEqual([{ label: "Notion", url: "https://www.notion.so/yjsp/FMV-1234" }]);
    });
    // Looked at, not edited: it's still there to open, and nothing changes it.
    await userEvent.click(screen.getByRole("button", { name: "Done editing" }));
    await screen.findByRole("button", { name: "Edit" });
    select();
    const looked = within(await screen.findByRole("region", { name: "Links" }));
    expect(looked.getByRole("link", { name: "Notion" }).getAttribute("href")).toBe(
        "https://www.notion.so/yjsp/FMV-1234",
    );
    expect(looked.queryByRole("button", { name: "+ Add a link" })).toBeNull();
    expect(looked.queryByRole("button", { name: /Remove the link/ })).toBeNull();
});

test("the diagram's labels: their size, and fluids and valve states written everywhere or nowhere at once", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    const left = place(drawing, "solenoid-valve", 0, 0);
    const right = place(drawing, "ball-valve", 200, 0);
    const made = connect(drawing.value, { part: left, port: "b" }, { part: right, port: "a" })!;
    drawing.value = {
        ...made.drawing,
        lines: made.drawing.lines.map((line) => ({ ...line, fluid: "lox", shown: ["fluid"] })),
    };
    const diagram = await team.diagram(team.chief, "Labels", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${diagram.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    const inspector = within(await screen.findByRole("complementary", { name: "Inspector" }));
    expect(inspector.getByText("Fluids written on lines: 1 of 1")).toBeTruthy();
    await userEvent.click(inspector.getByRole("button", { name: "Hide on every line" }));
    await userEvent.click(inspector.getByRole("button", { name: "Show on every valve" }));
    await userEvent.selectOptions(inspector.getByRole("combobox", { name: "Label size" }), "small");
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, diagram.id)).read;
        expect(saved.lines[0]!.shown).toEqual([]);
        expect(saved.parts.map((part) => part.shown.includes("normal"))).toEqual([true, true]);
        expect(saved.style.labels).toBe("small");
    });
    expect(within(svg).getByText("NC")).toBeTruthy(); // the solenoid valve's state, written beside it now
    // A double-acting valve fails in place: FIP, in a color of its own.
    fireEvent.pointerDown(within(svg).getByRole("button", { name: "BV-1" }), at(200, 0));
    fireEvent.pointerUp(svg, at(200, 0));
    await userEvent.click(
        within(await screen.findByRole("group", { name: "Normal state" })).getByRole("button", { name: /FIP/ }),
    );
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, diagram.id)).read;
        expect(saved.parts.find((part) => part.id === right)!.props.normal).toBe("FIP");
    });
    expect(within(svg).getByText("FIP")).toBeTruthy();
});

test("a part's drawn bigger or smaller, its label too, and a text block's set in its font and weight", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    const valve = place(drawing, "ball-valve", 0, 0);
    const note = place(drawing, "text", 0, 200);
    const made = await team.diagram(team.chief, "Sizes", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    fireEvent.pointerDown(within(svg).getByRole("button", { name: "BV-1" }), at(0, 0));
    fireEvent.pointerUp(svg, at(0, 0));
    const inspector = within(await screen.findByRole("complementary", { name: "Inspector" }));
    await userEvent.selectOptions(inspector.getByRole("combobox", { name: "Size" }), "1.5");
    await userEvent.selectOptions(inspector.getByRole("combobox", { name: "Label size" }), "large");
    expect(svg.querySelector("[data-hit='scale:" + valve + "']")).toBeTruthy(); // a handle to drag it to a size

    fireEvent.pointerDown(svg, at(400, 400)); // nothing: then the note
    fireEvent.pointerUp(svg, at(400, 400));
    fireEvent.pointerDown(svg.querySelector(`[data-hit='part:${note}']`)!, at(0, 200));
    fireEvent.pointerUp(svg, at(0, 200));
    const noteInspector = within(await screen.findByRole("complementary", { name: "Inspector" }));
    await userEvent.selectOptions(await noteInspector.findByRole("combobox", { name: "Font" }), "serif");
    await userEvent.selectOptions(noteInspector.getByRole("combobox", { name: "Weight" }), "bold");
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read;
        const [one, two] = [valve, note].map((id) => saved.parts.find((part) => part.id === id)!);
        expect([one!.scale, one!.labelSize]).toEqual([1.5, "large"]);
        expect(two!.props).toMatchObject({ font: "serif", weight: "bold" });
    });
});

test("a save from another window is caught: Keep mine saves over it, and the other stays in the history", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const drawing = { value: emptyDrawing() };
    place(drawing, "ball-valve", 0, 0);
    const made = await team.diagram(bob, "Shared", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    const theirs = { value: drawing.value };
    place(theirs, "pressure-transducer", 100, 100);
    await team.saveDrawing(team.chief, made.id, theirs.value, made.version); // in another window

    await userEvent.click(screen.getByRole("button", { name: "Pressure gauge" }));
    fireEvent.pointerDown(svg, at(200, 0));
    fireEvent.pointerUp(svg, at(200, 0));
    expect(await screen.findByText(/You saved this diagram in another window at/)).toBeTruthy();
    expect(screen.getByText("Someone else saved it")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read;
        expect(saved.parts.map((part) => part.kind).sort()).toEqual(["gauge", "valve"]);
    });
    const revisions = await team.revisions(team.chief, made.id);
    expect(revisions.map((revision) => [revision.number, revision.author?.name])).toEqual([
        [3, team.chief.user.name],
        [2, team.chief.user.name], // the other window's, kept
        [1, "Bob"],
    ]);
});

test("one person edits a diagram at a time: the others look, see what's saved, and edit once they're done", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const drawing = { value: emptyDrawing() };
    place(drawing, "ball-valve", 0, 0);
    const made = await team.diagram(team.chief, "Taking turns", drawing.value);
    await team.editDiagram(bob, made.id);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });

    // Opened to look at: no library, nothing to undo, and the inspector only says what's there.
    expect(await screen.findByText("Bob is editing")).toBeTruthy();
    const editButton = screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement;
    expect(editButton.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Pressure gauge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    fireEvent.pointerDown(within(svg).getByRole("button", { name: "BV-1" }), at(0, 0));
    fireEvent.pointerMove(svg, at(100, 0)); // a drag moves the view, not the valve
    fireEvent.pointerUp(svg, at(100, 0));
    fireEvent.pointerDown(within(svg).getByRole("button", { name: "BV-1" }), at(0, 0));
    fireEvent.pointerUp(svg, at(0, 0)); // a click selects it
    const inspector = within(await screen.findByRole("complementary", { name: "Inspector" }));
    expect(inspector.getByRole("textbox", { name: "Tag" }).matches(":disabled")).toBe(true);
    fireEvent.keyDown(document, { key: "Delete" });
    expect(within(svg).getByRole("button", { name: "BV-1" })).toBeTruthy();

    // What Bob saves shows as soon as the tab's come back to.
    const his = { value: drawing.value };
    place(his, "pressure-transducer", 100, 100);
    await team.saveDrawing(bob, made.id, his.value, made.version);
    fireEvent.focus(window);
    expect(await within(svg).findByRole("button", { name: "PT-1" })).toBeTruthy();

    // Once he's done, it's anyone's to edit: Edit makes it yours, and the list says so.
    await team.doneEditing(bob, made.id);
    fireEvent.focus(window);
    await waitFor(() => expect(editButton.disabled).toBe(false));
    await startEditing();
    expect(screen.getByRole("button", { name: "Pressure gauge" })).toBeTruthy();
    expect((await team.piperDiagram(bob, made.id)).editing?.by.name).toBe(team.chief.user.name);
    const refused = team.saveDrawing(bob, made.id, drawing.value, 2);
    await expect(refused).rejects.toThrow(`${team.chief.user.name} is editing`);

    // Done editing lets it go.
    await userEvent.click(screen.getByRole("button", { name: "Done editing" }));
    await screen.findByRole("button", { name: "Edit" });
    expect((await team.piperDiagram(bob, made.id)).editing).toBeNull();
});

test("an admin takes over editing from someone, once they've said they mean to", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const made = await team.diagram(bob, "Taken over");
    await team.editDiagram(bob, made.id);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Take over editing" }));
    expect(dialog.getByText(/Bob is editing this diagram/)).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Take over" }));
    await screen.findByRole("button", { name: "Done editing" });
    expect((await team.piperDiagram(bob, made.id)).editing?.by.name).toBe(team.chief.user.name);
});

test("a change made after someone took over editing isn't saved over theirs: it's kept as a diagram of its own", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const drawing = { value: emptyDrawing() };
    place(drawing, "ball-valve", 0, 0);
    const made = await team.diagram(bob, "Taken from", drawing.value);
    renderApp(bob, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull(); // nobody's editing it
    await startEditing();
    await team.editDiagram(team.chief, made.id, true); // an admin takes it over

    await userEvent.click(screen.getByRole("button", { name: "Pressure gauge" }));
    fireEvent.pointerDown(svg, at(200, 0));
    fireEvent.pointerUp(svg, at(200, 0));
    expect(await screen.findByText(new RegExp(`${team.chief.user.name} is editing this diagram now`))).toBeTruthy();
    expect(screen.getByText("Someone else is editing it")).toBeTruthy();
    expect(screen.getByText(`${team.chief.user.name} is editing`)).toBeTruthy(); // who, at the top too
    expect((await team.piperDiagram(bob, made.id)).read.parts.map((part) => part.kind)).toEqual(["valve"]);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeTruthy(); // only looked at here now

    await userEvent.click(screen.getByRole("button", { name: "Save mine as a new diagram" }));
    await screen.findByRole("button", { name: "Done editing" }); // the copy's his, to go on editing
    const copy = Number(window.location.pathname.split("/").pop());
    expect(copy).not.toBe(made.id);
    const kept = await team.piperDiagram(bob, copy);
    expect([kept.name, kept.read.parts.map((part) => part.kind).sort()]).toEqual([
        `${made.name} (my changes)`,
        ["gauge", "valve"],
    ]);
});

test("a diagram deleted while it's open says so, and restoring it saves the change it wouldn't take", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    place(drawing, "ball-valve", 0, 0);
    const made = await team.diagram(team.chief, "Deleted while open", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    await team.deleteDiagram(team.chief, made.id); // in another window

    await userEvent.click(screen.getByRole("button", { name: "Pressure gauge" }));
    fireEvent.pointerDown(svg, at(200, 0));
    fireEvent.pointerUp(svg, at(200, 0));
    expect(await screen.findByText("This diagram is deleted: it can be looked at, but not changed.")).toBeTruthy();
    expect(screen.getByText("Deleted: not saved")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Restore it" }));
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read;
        expect(saved.parts.map((part) => part.kind).sort()).toEqual(["gauge", "valve"]);
    });
    expect(await screen.findByText("Saved")).toBeTruthy();
});

test("a drawing the server won't take says why, and the change that fixes it is saved", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    const valve = place(drawing, "ball-valve", 0, 0);
    const made = await team.diagram(team.chief, "Too big", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    fireEvent.pointerDown(within(svg).getByRole("button", { name: "BV-1" }), at(0, 0));
    fireEvent.pointerUp(svg, at(0, 0));
    const inspector = within(await screen.findByRole("complementary", { name: "Inspector" }));
    const size = inspector.getByRole("textbox", { name: "Size" });
    fireEvent.change(size, { target: { value: "x".repeat(3 << 20) } }); // over the 2 MB a drawing can be
    expect(await screen.findByText("Not saved: A drawing can be up to 2 MB")).toBeTruthy();

    fireEvent.change(size, { target: { value: "1/4 in" } });
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read.parts.find((part) => part.id === valve)!;
        expect(saved.props).toMatchObject({ size: "1/4 in" });
    });
    expect(await screen.findByText("Saved")).toBeTruthy();
});

test("Find goes to a part by its tag and selects it; a search on the diagrams' list opens at what it found", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    const regulator = place(drawing, "regulator", 0, 0);
    drawing.value = {
        ...drawing.value,
        parts: drawing.value.parts.map((part) =>
            part.id === regulator ? { ...part, tag: `PUREG${team.folder}` } : part,
        ),
    };
    place(drawing, "pressure-transducer", 400, 0);
    const made = await team.diagram(team.chief, "Found", drawing.value);
    const listed = renderApp(team.chief, "/piper");
    await userEvent.type(await screen.findByRole("searchbox", { name: "Find diagrams" }), `pureg${team.folder}`);
    const link = await screen.findByRole("link", { name: made.name });
    expect(link.getAttribute("href")).toBe(
        `/piper/diagrams/${made.id}?find=${encodeURIComponent(`pureg${team.folder}`)}`,
    );
    await userEvent.click(link);
    // Opened at it, selected: the inspector says what it is.
    expect(await screen.findByRole("heading", { name: "Pressure regulator" })).toBeTruthy();
    listed.unmount();

    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    await screen.findByRole("application", { name: "Drawing" });
    const box = screen.getByRole("combobox", { name: "Find on the drawing" });
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(box);
    await userEvent.type(box, "pt");
    expect(within(screen.getByRole("listbox", { name: "Found on the drawing" })).getByText("PT-1")).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Pressure transducer" })).toBeTruthy();
});

test("a diagram's pages: added and renamed from their tabs, saved, and an off-page connector goes to another", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    place(drawing, "offpage", 0, 0);
    const made = await team.diagram(team.chief, "Pages", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    const tabs = screen.getByRole("tablist", { name: "Pages" });
    expect(within(tabs).getByRole("tab", { name: "Page 1", selected: true })).toBeTruthy();

    // A page added is the one worked on; a valve placed on it is on it alone.
    await userEvent.click(within(tabs).getByRole("button", { name: "Add a page" }));
    expect(within(tabs).getByRole("tab", { name: "Page 2", selected: true })).toBeTruthy();
    expect(within(svg).queryByRole("button", { name: "Off-page connector" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Ball valve" }));
    fireEvent.pointerDown(svg, at(300, 0));
    fireEvent.pointerUp(svg, at(300, 0));
    expect(await within(svg).findByRole("button", { name: "BV-1" })).toBeTruthy();
    await userEvent.click(within(tabs).getByRole("button", { name: "Page 2's menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const rename = within(await screen.findByRole("dialog", { name: "Rename the page" }));
    await userEvent.clear(rename.getByRole("textbox", { name: "Name" }));
    await userEvent.type(rename.getByRole("textbox", { name: "Name" }), "Ground");
    await userEvent.click(rename.getByRole("button", { name: "Rename" }));
    expect(within(tabs).getByRole("tab", { name: "Ground", selected: true })).toBeTruthy();
    await waitFor(async () => {
        const saved = await team.piperDiagram(team.chief, made.id);
        expect(saved.document.pages.map((page) => [page.name, page.parts.map((part) => part.tag)])).toEqual([
            ["Page 1", [""]],
            ["Ground", ["BV-1"]],
        ]);
        expect(saved.pages).toBe(2);
    });

    // The connector on the first page goes to the valve on the other: its words say where, and Go goes there.
    await userEvent.click(within(tabs).getByRole("tab", { name: "Page 1" }));
    fireEvent.pointerDown(within(svg).getByRole("button", { name: "Off-page connector" }), at(0, 0));
    fireEvent.pointerUp(svg, at(0, 0));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "To page" }), "Ground");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Goes to" }).value).toBe("TO GROUND");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "At" }), "BV-1");
    await userEvent.click(screen.getByRole("button", { name: "Go to Ground" }));
    expect(within(tabs).getByRole("tab", { name: "Ground", selected: true })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ball valve" })).toBeTruthy(); // it's selected
    // What it arrives at says where it comes from, to go back.
    await userEvent.click(screen.getByRole("button", { name: "TO GROUND, on Page 1" }));
    expect(within(tabs).getByRole("tab", { name: "Page 1", selected: true })).toBeTruthy();

    // Find looks through every page, and goes to the one what it found is on.
    await userEvent.click(within(tabs).getByRole("tab", { name: "Page 1" }));
    await userEvent.type(screen.getByRole("combobox", { name: "Find on the drawing" }), "bv-1");
    const found = within(screen.getByRole("listbox", { name: "Found on the drawing" }));
    expect(found.getByText(/on Ground/)).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    expect(within(tabs).getByRole("tab", { name: "Ground", selected: true })).toBeTruthy();

    // A page deleted takes what's on it; undo brings it back, and its connector's link.
    await userEvent.click(within(tabs).getByRole("button", { name: "Ground's menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    await userEvent.click(
        within(await screen.findByRole("dialog", { name: "Delete Ground?" })).getByRole("button", { name: "Delete" }),
    );
    expect(within(tabs).queryByRole("tab", { name: "Ground" })).toBeNull();
    await waitFor(async () => {
        const saved = await team.piperDiagram(team.chief, made.id);
        expect([saved.pages, saved.document.pages[0]!.parts[0]!.props.page]).toEqual([1, ""]);
    });
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(within(tabs).getByRole("tab", { name: "Ground", selected: true })).toBeTruthy();
    await waitFor(async () => {
        const { document: saved } = await team.piperDiagram(team.chief, made.id);
        expect(saved.pages[0]!.parts[0]!.props).toMatchObject({
            page: saved.pages[1]!.id,
            part: saved.pages[1]!.parts[0]!.id,
        });
    });
});

test("a picture dropped on the drawing is added there, in its shape; the inspector replaces it", async () => {
    const team = await Team.create();
    const made = await team.diagram(team.chief, "Pictures");
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    svg.getBoundingClientRect = () => new DOMRect(0, 0, 1, 1); // the drawing's a pixel wide in jsdom, as at() says

    // A file that isn't a picture says so, and isn't put on the drawing.
    // jsdom's drop is a plain event: where it's let go is put on it, as a browser's drag event has it.
    const drop = (file: File) => {
        const event = createEvent.drop(svg, { dataTransfer: { types: ["Files"], files: [file], dropEffect: "copy" } });
        const { clientX, clientY } = at(100, 50);
        Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: clientY } });
        fireEvent(svg, event);
    };
    drop(new File(["just words"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByText(/notes\.txt isn't on the drawing: That isn't a PNG or a JPEG picture/)).toBeTruthy();

    const png = await rgbaPng([
        [
            [255, 0, 0, 255],
            [0, 0, 255, 128],
        ],
    ]);
    drop(new File([png], "injector.png", { type: "image/png" }));
    expect(await within(svg).findByRole("button", { name: "Picture" })).toBeTruthy();
    expect(await screen.findByText("2 × 1 pixels")).toBeTruthy(); // selected: the inspector says what it shows
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", png)), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
    await waitFor(async () => {
        const part = (await team.piperDiagram(team.chief, made.id)).read.parts[0]!;
        expect([part.kind, part.props.image, part.w, part.h, part.x, part.y]).toEqual([
            "picture",
            sha,
            40,
            20,
            100,
            50,
        ]);
    });

    // Replaced, it keeps its width and takes the new one's shape.
    await userEvent.upload(
        screen.getByLabelText("Picture to show"),
        new File([jpegHeader(400, 400)], "tca.jpg", { type: "image/jpeg" }),
    );
    expect(await screen.findByText("400 × 400 pixels")).toBeTruthy();
    await waitFor(async () => {
        const part = (await team.piperDiagram(team.chief, made.id)).read.parts[0]!;
        expect([part.w, part.h, part.props.imageWidth]).toEqual([40, 40, "400"]);
    });
});

test("Parts lists every part by what it is, with its specs, and a tag goes to its part", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    const first = place(drawing, "ball-valve", 0, 0);
    place(drawing, "ball-valve", 200, 0);
    place(drawing, "tank", 0, 200);
    drawing.value = {
        ...drawing.value,
        parts: drawing.value.parts.map((part) =>
            part.id === first ? { ...part, props: { ...part.props, mawp: "3000 psi" } } : part,
        ),
    };
    const made = await team.diagram(team.chief, "Listed", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    await screen.findByRole("application", { name: "Drawing" });
    await userEvent.click(screen.getByRole("button", { name: "Parts" }));
    const panel = within(await screen.findByRole("region", { name: "Parts" }));
    expect(panel.getByText("3 parts, 0 lines")).toBeTruthy();
    const valves = within(panel.getByRole("table", { name: "Ball valve" }));
    expect(valves.getAllByRole("row")).toHaveLength(3); // its head, and the two
    expect(valves.getByRole("columnheader", { name: "MAWP" })).toBeTruthy(); // what any of them has
    expect(valves.getByText("3000 psi")).toBeTruthy();
    expect(panel.getByRole("table", { name: "Tank" })).toBeTruthy();
    await userEvent.click(valves.getByRole("button", { name: "BV-1" }));
    expect(await screen.findByRole("heading", { name: "Ball valve" })).toBeTruthy();
    expect(valves.getByRole("button", { name: "BV-1" }).closest("tr")!.getAttribute("aria-selected")).toBe("true");
});

test("a diagram takes a scheme's colors, and says when the scheme has changed since", async () => {
    const team = await Team.create();
    const blue = { id: "lox", name: "Liquid oxygen", label: "LOX", color: "#0000ff", gas: false };
    const scheme = await team.scheme(team.chief, "Stand", [blue]);
    const drawing = { value: emptyDrawing() };
    const valve = place(drawing, "ball-valve", 0, 0);
    const made = connect(drawing.value, { part: valve, port: "b" }, { x: 200, y: 0 })!;
    drawing.value = { ...made.drawing, lines: made.drawing.lines.map((line) => ({ ...line, fluid: "lox" })) };
    const diagram = await team.diagram(team.chief, "Schemed", drawing.value);
    const first = renderApp(team.chief, `/piper/diagrams/${diagram.id}`);
    await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Colors from" }), String(scheme.id));
    const saved = async () => (await team.piperDiagram(team.chief, diagram.id)).read;
    await waitFor(async () => {
        const read = await saved();
        expect(read.style.scheme).toBe(String(scheme.id));
        expect(read.fluids.find((fluid) => fluid.id === "lox")?.color).toBe("#0000ff");
    });
    first.unmount();

    // The scheme changes: the diagram says so, and takes the new colors when asked.
    await team.changeScheme(team.chief, scheme.id, { fluids: [{ ...blue, color: "#00aaff" }] });
    renderApp(team.chief, `/piper/diagrams/${diagram.id}`);
    await startEditing();
    await userEvent.click(await screen.findByRole("button", { name: "Take its colors again" }));
    await waitFor(async () =>
        expect((await saved()).fluids.find((fluid) => fluid.id === "lox")?.color).toBe("#00aaff"),
    );
});

test("Schemes lists the team's color schemes; one's changed there, its fluids and states together", async () => {
    const team = await Team.create();
    const scheme = await team.scheme(team.chief, "Cold flow", [
        { id: "water", name: "Water", label: "H2O", color: "#22a6d6", gas: false },
    ]);
    renderApp(team.chief, "/piper/schemes");
    expect(await screen.findByRole("heading", { name: "Color schemes" })).toBeTruthy();
    const card = within(await screen.findByRole("article", { name: scheme.name }));
    await userEvent.click(card.getByRole("button", { name: "Edit" }));
    const form = within(await screen.findByRole("form", { name: `Editing ${scheme.name}` }));
    await userEvent.clear(form.getByRole("textbox", { name: "Water's label" }));
    await userEvent.type(form.getByRole("textbox", { name: "Water's label" }), "WATER");
    await userEvent.click(form.getByRole("checkbox", { name: "Gas" }));
    await userEvent.click(form.getByRole("button", { name: "+ Add a fluid" }));
    await userEvent.click(form.getByRole("button", { name: "Save" }));
    await waitFor(async () => {
        const found = (await team.changeScheme(team.chief, scheme.id, {})).fluids;
        expect(found.map((fluid) => [fluid.label, fluid.gas])).toEqual([
            ["WATER", true],
            ["NEW", false],
        ]);
    });
});

test("on Schemes, only whoever made a scheme, or an admin, can change or delete it", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const water = [{ id: "water", name: "Water", label: "H2O", color: "#22a6d6", gas: false }];
    const chiefs = await team.scheme(team.chief, "The chief's", water);
    const his = await team.scheme(bob, "Bob's", water);
    renderApp(bob, "/piper/schemes");
    const mine = within(await screen.findByRole("article", { name: his.name }));
    expect(mine.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(mine.getByRole("button", { name: "Delete…" })).toBeTruthy();
    const theirs = within(await screen.findByRole("article", { name: chiefs.name }));
    expect(theirs.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(theirs.queryByRole("button", { name: "Delete…" })).toBeNull();
});

test("History lists the revisions; looking at one shows it, and restoring it makes it the drawing again", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const drawing = { value: emptyDrawing() };
    place(drawing, "tank", 0, 0);
    const made = await team.diagram(team.chief, "Tanks", drawing.value);
    const later = { value: drawing.value };
    place(later, "tank", 200, 0);
    await team.saveDrawing(bob, made.id, later.value, made.version);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    await screen.findByRole("application", { name: "Drawing" });
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    const history = within(await screen.findByRole("complementary", { name: "History" }));
    const first = (await history.findByText("Revision 1")).closest("li")!;
    expect(history.getByText("Revision 2").closest("li")!.textContent).toContain("Latest");
    await userEvent.click(within(first).getByRole("button", { name: "Look" }));
    const still = await screen.findByRole("img", { name: "Drawing" }); // a revision's only looked at
    expect(within(still).queryAllByRole("button", { hidden: true })).toHaveLength(0);
    expect(screen.getByText(/^Revision 1, by/)).toBeTruthy();
    await userEvent.click(within(first).getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("Revision 1 is the drawing again, as revision 3.")).toBeTruthy();
    const saved = await team.piperDiagram(team.chief, made.id);
    expect(saved.read.parts).toHaveLength(1);
    expect((await team.revisions(team.chief, made.id))[0]).toMatchObject({ number: 3, restored_from: 1 });
});

test("a revision's released once its approvers approve it: Rev A, kept as it is", async () => {
    const team = await Team.create();
    const approver = await team.member(`Approver${team.folder.slice(5)}`);
    const made = await team.diagram(team.chief, "Released");
    const asChief = renderApp(team.chief, `/piper/diagrams/${made.id}`);
    await screen.findByRole("application", { name: "Drawing" });
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    const history = within(await screen.findByRole("complementary", { name: "History" }));
    await userEvent.click(await history.findByRole("button", { name: "Release…" }));
    const form = within(history.getByRole("form", { name: "Release revision 1" }));
    await userEvent.type(form.getByRole("textbox", { name: "What it's for" }), "For HF-3");
    expect((form.getByRole("button", { name: "Ask for approval" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(await form.findByRole("checkbox", { name: approver.user.name }));
    await userEvent.click(form.getByRole("button", { name: "Ask for approval" }));
    const waiting = within(await history.findByRole("region", { name: "Release waiting for approval" }));
    expect(waiting.getByText("For HF-3")).toBeTruthy();
    expect(waiting.getByRole("button", { name: "Withdraw" })).toBeTruthy();
    expect(waiting.queryByRole("button", { name: "Approve" })).toBeNull(); // not the chief's to approve
    expect(history.queryByRole("button", { name: "Release…" })).toBeNull(); // one waits at a time
    expect(history.getByText("Waiting for approval")).toBeTruthy();
    asChief.unmount();

    renderApp(approver, `/piper/diagrams/${made.id}`);
    await screen.findByRole("application", { name: "Drawing" });
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    const theirs = within(await screen.findByRole("complementary", { name: "History" }));
    await userEvent.click(await theirs.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Rev A, released")).toBeTruthy(); // beside the diagram's name
    const past = within(await theirs.findByRole("region", { name: "Releases" }));
    expect(past.getByText(new RegExp(`revision 1, approved by ${approver.user.name}`))).toBeTruthy();
    expect(theirs.queryByRole("button", { name: "Name" })).toBeNull(); // released: kept as it is, its name too
    expect((await team.revisions(team.chief, made.id))[0]).toMatchObject({ number: 1, released: "A" });
});

test("a test from Yorg on the drawing: each instrument's value and each valve's state at the time on its timeline", async () => {
    const team = await Team.create();
    const csv = [
        "Time (s),PT-1 (psi),SV-1",
        ...Array.from({ length: 11 }, (_, i) =>
            [i / 10, (300 + i * 10).toFixed(1), i < 5 ? "CLOSED" : "OPEN"].join(","),
        ),
    ].join("\n");
    const data = await team.data(team.chief, "Cold flow", csv);
    const drawing = { value: emptyDrawing() };
    const sensor = place(drawing, "pressure-transducer", 0, 0);
    const valve = place(drawing, "solenoid-valve", 100, 0);
    place(drawing, "pressure-transducer", 0, 100); // PT-2: the test has no channel for it
    const made = await team.diagram(team.chief, "Cold flow", drawing.value);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    onTestFinished(() => open.mockRestore());
    renderApp(team.chief, `/piper/diagrams/${made.id}?test=${data.id}&t=0.3`);
    const panel = within(await screen.findByRole("region", { name: "Test data" }));
    await waitFor(() => expect(badge(sensor)).toBe("330.0 psi"));
    expect(badge(valve)).toBe("CLOSED");
    expect(panel.getByText(/has no channel for PT-2/)).toBeTruthy();
    // Each on a leader to its part, in its color: a valve's, its state's.
    const leader = (part: string) => drawingArea().querySelector(`[data-leader="${part}"]`);
    expect([leader(sensor), leader(valve)].every(Boolean)).toBe(true);
    expect(leader(valve)!.getAttribute("stroke")).toBe(LIGHT.nc);
    await waitFor(() => expect(panel.getByRole("combobox", { name: "Test" })).toHaveProperty("value", String(data.id)));

    fireEvent.change(panel.getByRole("slider", { name: "Time" }), { target: { value: "0.8" } });
    await waitFor(() => expect(badge(valve)).toBe("OPEN"));
    expect(badge(sensor)).toBe("380.0 psi");
    await userEvent.click(panel.getByRole("button", { name: "Plot in Yorg" }));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(String(open.mock.calls[0]![0])).toMatch(new RegExp(`^/yorg/datasets/${data.id}\\?plots=`));
});

test("a diagram opens again to the test it was read against, at its time, until Test data is closed", async () => {
    const team = await Team.create();
    const csv = [
        "Time (s),PT-1 (psi)",
        ...Array.from({ length: 11 }, (_, i) => [i / 10, (300 + i * 10).toFixed(1)].join(",")),
    ].join("\n");
    const data = await team.data(team.chief, "Kept between openings", csv);
    const drawing = { value: emptyDrawing() };
    const sensor = place(drawing, "pressure-transducer", 0, 0);
    const made = await team.diagram(team.chief, "Kept between openings", drawing.value);
    const first = renderApp(team.chief, `/piper/diagrams/${made.id}?test=${data.id}&t=0.3`);
    await waitFor(() => expect(badge(sensor)).toBe("330.0 psi"));
    first.unmount();

    // Opened again with nothing in its address, as from the diagrams' list: the same test, at the same time.
    const again = renderApp(team.chief, `/piper/diagrams/${made.id}`);
    await waitFor(() => expect(badge(sensor)).toBe("330.0 psi"));
    expect(new URLSearchParams(window.location.search).get("test")).toBe(String(data.id));

    // Closing Test data unlinks it: the next time, it opens without a test.
    await userEvent.click(await screen.findByRole("button", { name: "Close test data" }));
    again.unmount();
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    await screen.findByRole("application", { name: "Drawing" });
    expect(screen.queryByRole("region", { name: "Test data" })).toBeNull();
    expect(new URLSearchParams(window.location.search).has("test")).toBe(false);
});

test("a part's test channel is picked from the test's channels, in a list that narrows to what's typed", async () => {
    const team = await Team.create();
    const csv = ["Time (s),PT-1 (psi),PT-OX-INJ (psi),TC-1 (K)", "0,300,250,80", "0.1,310,260,81"].join("\n");
    const data = await team.data(team.chief, "Channels to pick", csv);
    const drawing = { value: emptyDrawing() };
    place(drawing, "pressure-transducer", 0, 0);
    const made = await team.diagram(team.chief, "Channels to pick", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}?test=${data.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    await startEditing();
    fireEvent.pointerDown(within(svg).getByRole("button", { name: "PT-1" }), at(0, 0));
    fireEvent.pointerUp(svg, at(0, 0));
    const inspector = within(await screen.findByRole("complementary", { name: "Inspector" }));
    const box = await inspector.findByRole("combobox", { name: "Test channel" }); // a list once the test's here
    const names = () =>
        within(screen.getByRole("listbox", { name: "The test's channels" }))
            .getAllByRole("option")
            .map((option) => option.firstChild?.textContent);

    await userEvent.click(box);
    expect(names()).toEqual(["PT-1", "PT-OX-INJ", "TC-1"]); // all of them, each with its unit beside it
    await userEvent.type(box, "ox");
    expect(names()).toEqual(["PT-OX-INJ"]);
    await userEvent.click(screen.getByRole("option", { name: /PT-OX-INJ/ }));
    expect(box).toHaveProperty("value", "PT-OX-INJ");
    expect(screen.queryByRole("listbox")).toBeNull();

    // Or with the keyboard: the first that matches, with Enter.
    await userEvent.clear(box);
    await userEvent.type(box, "tc{Enter}");
    expect(box).toHaveProperty("value", "TC-1");
    await waitFor(async () =>
        expect((await team.piperDiagram(team.chief, made.id)).read.parts[0]?.props.channel).toBe("TC-1"),
    );
});

test("a duplicated transducer shows both its channels' values", async () => {
    const team = await Team.create();
    const csv = ["Time (s),PT-7A (psi),PT-7B (psi)", "0,100.0,101.5", "1,200.0,201.5"].join("\n");
    const data = await team.data(team.chief, "Redundant", csv);
    const drawing = { value: emptyDrawing() };
    const sensor = place(drawing, "pressure-transducer-2", 0, 0);
    drawing.value = {
        ...drawing.value,
        parts: drawing.value.parts.map((part) => (part.id === sensor ? { ...part, tag: "PT-7" } : part)),
    };
    const made = await team.diagram(team.chief, "Redundant", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}?test=${data.id}&t=0.5`);
    await waitFor(() => expect(badge(sensor)).toBe("100.0 psi / 101.5 psi"));
});

test("chosen diagrams are deleted together by whoever made them, and restored together", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const first = await team.diagram(team.chief, "Old stand");
    const second = await team.diagram(team.chief, "Old panel");
    const asBob = renderApp(bob, "/piper");
    await userEvent.type(await screen.findByRole("searchbox", { name: "Find diagrams" }), team.folder);
    let table = within(await screen.findByRole("table", { name: "Diagrams" }));
    await table.findByRole("link", { name: first.name });
    // Bob can choose them, to move, but not delete them: they're the chief's.
    await userEvent.click(table.getByRole("checkbox", { name: "Choose every diagram here" }));
    expect(screen.getByText("2 diagrams chosen")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Delete…" }).disabled).toBe(true);
    asBob.unmount();

    renderApp(team.chief, "/piper");
    await userEvent.type(await screen.findByRole("searchbox", { name: "Find diagrams" }), team.folder);
    table = within(await screen.findByRole("table", { name: "Diagrams" }));
    await table.findByRole("link", { name: first.name });
    await userEvent.click(table.getByRole("checkbox", { name: "Choose every diagram here" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete 2 diagrams?" }));
    const listed = within(dialog.getByRole("list", { name: "Diagrams to delete" }));
    expect(listed.getAllByRole("listitem").map((item) => item.textContent)).toEqual(
        expect.arrayContaining([first.name, second.name]),
    );
    await userEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: first.name })).toBeNull());
    expect(screen.queryByText(/diagrams? chosen/)).toBeNull();

    await userEvent.click(screen.getByRole("link", { name: "Deleted diagrams" }));
    expect(await screen.findByRole("heading", { name: "Deleted diagrams" })).toBeTruthy();
    const deleted = within(await screen.findByRole("table", { name: "Deleted diagrams" }));
    await userEvent.click(within((await deleted.findByText(first.name)).closest("tr")!).getByRole("checkbox"));
    await userEvent.click(within(deleted.getByText(second.name).closest("tr")!).getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.queryByText(first.name)).toBeNull());
    expect(screen.queryByText(second.name)).toBeNull();
    expect((await team.piperDiagram(team.chief, first.id)).deleted_at).toBeNull();
});

test("Import Visio makes a diagram of a drawing, in the folder it's imported in, and says what became of its shapes", async () => {
    const team = await Team.create();
    const place = await team.piperFolder(team.chief, "Imported");
    renderApp(team.chief, `/piper/folders/${place.id}`);
    // Import Visio… asks for the file first, as Yorg's Upload data does; the dialog shows it, to change.
    const picker = await screen.findByLabelText<HTMLInputElement>("Visio drawing to import");
    const click = vi.spyOn(picker, "click");
    await userEvent.click(screen.getByRole("button", { name: "Import Visio…" }));
    expect(click).toHaveBeenCalled();
    await userEvent.upload(picker, new File(["not this one"], "Other.vsdx"));
    const dialog = within(await screen.findByRole("dialog", { name: "Import a Visio drawing" }));
    expect(dialog.getByText("Other.vsdx")).toBeTruthy();
    await userEvent.upload(
        dialog.getByLabelText("Another Visio drawing"),
        new File([vsdx(FEED, GLUE)], `Feed ${team.folder}.vsdx`),
    );
    expect(dialog.getByText(`Feed ${team.folder}.vsdx`)).toBeTruthy();
    expect(dialog.queryByText("Other.vsdx")).toBeNull();
    expect(dialog.getByText(new RegExp(`It becomes a diagram in ${place.name}`))).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Import" }));
    const done = within(await screen.findByRole("dialog", { name: "Imported" }));
    expect(done.getByText(/3 parts, 4 lines, 1 note, 1 shape drawn as in Visio/)).toBeTruthy();
    await userEvent.click(done.getByRole("link", { name: `Feed ${team.folder}` }));
    const svg = await screen.findByRole("application", { name: "Drawing" });
    expect(within(svg).getByRole("button", { name: "V-1" })).toBeTruthy();
    expect(within(svg).getByRole("button", { name: "PT-101" })).toBeTruthy();
    const imported = await team.piperDiagram(team.chief, Number(window.location.pathname.split("/").pop()));
    expect(imported.folder_id).toBe(place.id);
});

test("Export, PDF: the drawing on a drawing sheet, as a PDF file", async () => {
    const team = await Team.create();
    const made = await team.diagram(team.chief, "Sheet", example(), "Vespula");
    const saved: Blob[] = [];
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => (saved.push(blob), "blob:piper");
    URL.revokeObjectURL = () => {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    onTestFinished(() => {
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
        click.mockRestore();
    });
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    await screen.findByRole("application", { name: "Drawing" });
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "PDF…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Save as PDF" }));
    await userEvent.selectOptions(dialog.getByRole("combobox", { name: "Paper" }), "letter");
    expect(dialog.getByRole("checkbox", { name: /On a drawing sheet/ })).toHaveProperty("checked", true);
    await userEvent.click(dialog.getByRole("button", { name: "Save PDF" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const text = Array.from(new Uint8Array(await saved[0]!.arrayBuffer()), (byte) => String.fromCharCode(byte)).join(
        "",
    );
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 792 612]"); // letter, landscape
    expect(click).toHaveBeenCalled();
});

test("Export, an image or a print: with a legend beside the drawing if it's asked for, and asked again next time", async () => {
    const team = await Team.create();
    const made = await team.diagram(team.chief, "Legend", example());
    const saved: Blob[] = [];
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => (saved.push(blob), "blob:piper");
    URL.revokeObjectURL = () => {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    onTestFinished(() => {
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
        click.mockRestore();
    });
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    await screen.findByRole("application", { name: "Drawing" });
    const svgWith = async (legend: boolean) => {
        await userEvent.click(screen.getByRole("button", { name: "Export" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "SVG image…" }));
        const dialog = within(await screen.findByRole("dialog", { name: "Save as SVG" }));
        const check = dialog.getByRole("checkbox", { name: /With a legend/ });
        expect(check).toHaveProperty("checked", !legend); // as it was last time: none, the first
        await userEvent.click(check);
        await userEvent.click(dialog.getByRole("button", { name: "Save SVG" }));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save as SVG" })).toBeNull());
        return saved[saved.length - 1]!.text();
    };
    // (The example has a legend part of its own, of its fluids and states: the export's is the one beside it.)
    const withLegend = await svgWith(true);
    expect(withLegend).toContain('class="piper-legend"');
    expect(withLegend).toContain('data-legend="Pressure transducer"');
    expect(withLegend).toContain('data-legend="Normally closed"');
    expect(await svgWith(false)).not.toContain('class="piper-legend"');
    // The PDF's dialog asks too, as the last export was.
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "PDF…" }));
    const pdf = within(await screen.findByRole("dialog", { name: "Save as PDF" }));
    expect(pdf.getByRole("checkbox", { name: /With a legend/ })).toHaveProperty("checked", false);
});

test("Help says what Piper does, and how", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/piper/help");
    expect(await screen.findByRole("heading", { name: "Help" })).toBeTruthy();
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    expect(nav.getByRole("link", { name: "Help" }).getAttribute("aria-current")).toBe("page");
    for (const topic of [
        "Parts",
        "Lines",
        "Snapping",
        "Into a line",
        "Fluids and states",
        "Test data from Yorg",
        "Pages and sheets",
        "Importing from Visio",
        "Exports",
        "Keys",
    ]) {
        expect(screen.getByRole("region", { name: topic })).toBeTruthy();
    }
});
