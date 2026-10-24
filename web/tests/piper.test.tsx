import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, onTestFinished, test, vi } from "vitest";
import { emptyDrawing, type Drawing } from "../src/piper/drawing";
import { addPart, connect } from "../src/piper/edit";
import { example } from "../src/piper/example";
import { presetOf } from "../src/piper/library/index";
import { renderApp, Team } from "./team";
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
    // Found by a word of their names (and here, of this test's): in their folders, each one's folders.
    await userEvent.type(screen.getByRole("searchbox", { name: "Find diagrams" }), team.folder);
    const table = within(await screen.findByRole("table", { name: "Diagrams" }));
    await table.findByRole("link", { name: team.named("Feed system") });
    expect(table.getByRole("link", { name: team.named("Cold flow stand") })).toBeTruthy();
    expect(table.getByRole("button", { name: /Vespula/ }).getAttribute("aria-expanded")).toBe("true");
    expect(table.getByRole("button", { name: /Prop/ })).toBeTruthy();
});

test("New diagram opens the editor: a part placed from the library is tagged, renamed, and saved", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/piper");
    await userEvent.click(await screen.findByRole("button", { name: "New diagram" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New diagram" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), team.named("Stand"));
    await userEvent.click(dialog.getByRole("button", { name: "Make it" }));
    const svg = await screen.findByRole("application", { name: "Drawing" });
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

test("a line drawn from one part's port to another's is routed, and carries the fluid it's drawn from", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    const bottle = place(drawing, "bottle", 0, 0); // nitrogen; its neck's port up, at (0, -50)
    const valve = place(drawing, "ball-valve", 200, -120); // its first port at (180, -120)
    const made = await team.diagram(team.chief, "Pressurant", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
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
        expect(saved.shown).toEqual(["normal", "size"]);
    });
    // Under its tag on the drawing: its state and its size.
    expect(within(svg).getByText("1/4 in")).toBeTruthy();
    expect(within(svg).getByText("NC")).toBeTruthy();
});

test("someone else's save is caught: Keep mine saves over it, and theirs stays in the history", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const drawing = { value: emptyDrawing() };
    place(drawing, "ball-valve", 0, 0);
    const made = await team.diagram(team.chief, "Shared", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
    const theirs = { value: drawing.value };
    place(theirs, "pressure-transducer", 100, 100);
    await team.saveDrawing(bob, made.id, theirs.value, made.version);

    await userEvent.click(screen.getByRole("button", { name: "Pressure gauge" }));
    fireEvent.pointerDown(svg, at(200, 0));
    fireEvent.pointerUp(svg, at(200, 0));
    expect(await screen.findByText(/Bob saved this diagram at/)).toBeTruthy();
    expect(screen.getByText("Someone else saved it")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(async () => {
        const saved = (await team.piperDiagram(team.chief, made.id)).read;
        expect(saved.parts.map((part) => part.kind).sort()).toEqual(["gauge", "valve"]);
    });
    const revisions = await team.revisions(team.chief, made.id);
    expect(revisions.map((revision) => revision.number)).toEqual([3, 2, 1]);
    expect(revisions[1]!.author?.name).toBe("Bob"); // Bob's, kept
});

test("a diagram deleted while it's open says so, and restoring it saves the change it wouldn't take", async () => {
    const team = await Team.create();
    const drawing = { value: emptyDrawing() };
    place(drawing, "ball-valve", 0, 0);
    const made = await team.diagram(team.chief, "Deleted while open", drawing.value);
    renderApp(team.chief, `/piper/diagrams/${made.id}`);
    const svg = await screen.findByRole("application", { name: "Drawing" });
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
    await waitFor(() => expect(panel.getByRole("combobox", { name: "Test" })).toHaveProperty("value", String(data.id)));

    fireEvent.change(panel.getByRole("slider", { name: "Time" }), { target: { value: "0.8" } });
    await waitFor(() => expect(badge(valve)).toBe("OPEN"));
    expect(badge(sensor)).toBe("380.0 psi");
    await userEvent.click(panel.getByRole("button", { name: "Plot in Yorg" }));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(String(open.mock.calls[0]![0])).toMatch(new RegExp(`^/yorg/datasets/${data.id}\\?plots=`));
});

test("whoever made a diagram deletes it to Deleted diagrams, and restores it; no one else can", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    await team.diagram(team.chief, "Old stand");
    const asBob = renderApp(bob, "/piper");
    await userEvent.type(await screen.findByRole("searchbox", { name: "Find diagrams" }), team.folder);
    const row = async () => (await screen.findByRole("link", { name: team.named("Old stand") })).closest("tr")!;
    expect(within(await row()).getByRole("button", { name: "Duplicate" })).toBeTruthy();
    expect(within(await row()).queryByRole("button", { name: "Delete…" })).toBeNull();
    asBob.unmount();

    renderApp(team.chief, "/piper");
    await userEvent.type(await screen.findByRole("searchbox", { name: "Find diagrams" }), team.folder);
    await userEvent.click(within(await row()).getByRole("button", { name: "Delete…" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: team.named("Old stand") })).toBeNull());
    await userEvent.click(screen.getByRole("link", { name: "Deleted diagrams" }));
    expect(await screen.findByRole("heading", { name: "Deleted diagrams" })).toBeTruthy();
    await userEvent.type(screen.getByRole("searchbox", { name: "Find diagrams" }), team.folder);
    await userEvent.click(within(await row()).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: team.named("Old stand") })).toBeNull());
});

test("Import Visio makes a diagram of a drawing's page, and says what became of its shapes", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/piper");
    await userEvent.click(await screen.findByRole("button", { name: "Import Visio…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Import a Visio drawing" }));
    await userEvent.upload(
        dialog.getByLabelText("Visio drawing"),
        new File([vsdx(FEED, GLUE)], `Feed ${team.folder}.vsdx`),
    );
    await userEvent.type(dialog.getByRole("combobox", { name: "Folder" }), "Imported");
    await userEvent.click(dialog.getByRole("button", { name: "Import" }));
    const done = within(await screen.findByRole("dialog", { name: "Imported" }));
    expect(done.getByText(/3 parts, 4 lines, 1 note/)).toBeTruthy();
    expect(done.getByText(/Kept as boxes, since Piper has no part for them: Sheet/)).toBeTruthy();
    await userEvent.click(done.getByRole("link", { name: `Feed ${team.folder}` }));
    const svg = await screen.findByRole("application", { name: "Drawing" });
    expect(within(svg).getByRole("button", { name: "V-1" })).toBeTruthy();
    expect(within(svg).getByRole("button", { name: "PT-101" })).toBeTruthy();
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
        "Importing from Visio",
        "Exports",
        "Keys",
    ]) {
        expect(screen.getByRole("region", { name: topic })).toBeTruthy();
    }
});
