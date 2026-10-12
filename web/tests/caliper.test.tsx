import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { Mesh } from "../src/vault/caliper/format";
import { wasmFrom } from "../src/vault/caliper/step";
import { caliperUrl, fileUrl, folderUrl } from "../src/vault/paths";
import { renderApp, table, Team } from "./team";

// Caliper, the 3D viewer: where it's offered, what it shows of a part's or an assembly's model, and of a STEP file.
// jsdom draws no 3D (no WebGL), so these see the page around the view: its tree and what it says. What the view
// measures is in caliper-geometry.test.ts and caliper-step.test.ts.

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** A mesh of one or more bodies, each a tetrahedron of four faces. */
function tetrahedra(...names: string[]): Mesh {
    const positions: number[] = [];
    const indices: number[] = [];
    const bodies = names.map((name, b) => {
        const faces = [
            [0, 2, 1],
            [0, 1, 3],
            [0, 3, 2],
            [1, 2, 3],
        ].map((triangle, f) => {
            const base = positions.length / 3;
            const corners = [
                [10 * b, 0, 0],
                [10 * b + 10, 0, 0],
                [10 * b, 10, 0],
                [10 * b, 0, 10],
            ];
            triangle.forEach((i) => positions.push(...corners[i]!));
            indices.push(base, base + 1, base + 2);
            return { first: 4 * b + f, count: 1 };
        });
        return { name, solid: true, color: [0.79, 0.82, 0.93] as [number, number, number], opacity: 1, faces };
    });
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices), bodies };
}

const component = (name: string, file: { id: number; version: number } | null, more: object = {}) => ({
    name,
    ...(file ? { file_id: file.id, version: file.version } : {}),
    configuration: "Default",
    transform: IDENTITY,
    ...more,
});

const tree = () => within(screen.getByRole("tree", { name: "Components" }));

test("parts, assemblies, and STEP files open in Caliper, beside Open in SolidWorks", async () => {
    const team = await Team.create();
    const [fin] = await team.checkin(team.chief, {
        "Fin.SLDPRT": "fin",
        "Can.SLDASM": "can",
        "Tab.STEP": "step",
        "Notes.pdf": "notes",
    });
    await team.checkin(team.chief, { "Fin.SLDDRW": "drawing" }, { refs: { "Fin.SLDDRW": ["Fin.SLDPRT"] } });

    renderApp(team.chief, folderUrl(team.folder));
    const files = await table();
    const row = (name: string) => within(files.getByRole("link", { name }).closest("tr")!);
    for (const name of ["Fin.SLDPRT", "Can.SLDASM"]) {
        expect(row(name).getByRole("link", { name: "Open in SolidWorks" })).toBeTruthy();
        expect(row(name).getByRole("link", { name: "Open in Caliper" })).toBeTruthy();
    }
    expect(row("Tab.STEP").getByRole("link", { name: "Open in Caliper" })).toBeTruthy();
    expect(row("Fin.SLDDRW").queryByRole("link", { name: "Open in Caliper" })).toBeNull();
    expect(row("Notes.pdf").queryByRole("link", { name: "Open in Caliper" })).toBeNull();
    expect(row("Fin.SLDPRT").getByRole("link", { name: "Open in Caliper" }).getAttribute("href")).toBe(
        caliperUrl(fin!.id),
    );

    await userEvent.click(row("Fin.SLDPRT").getByRole("link", { name: "Fin.SLDPRT" }));
    const head = (await screen.findByRole("heading", { name: "Fin.SLDPRT" })).closest("header")!;
    const solidworks = within(head).getByRole("link", { name: "Open in SolidWorks" });
    expect(solidworks.nextElementSibling?.textContent).toBe("Open in Caliper"); // right beside it
});

test("a part's model shows its bodies, to show and hide", async () => {
    const team = await Team.create();
    const [fin] = await team.checkin(team.chief, { "Fin.SLDPRT": "fin" });
    await team.model(team.chief, fin!, { mesh: tetrahedra("Fin", "Doubler"), units: "in" });

    renderApp(team.chief, caliperUrl(fin!.id));
    expect(await screen.findByRole("heading", { name: "Fin.SLDPRT" })).toBeTruthy();
    const doubler = await screen.findByRole("checkbox", { name: "Show Doubler" });
    expect(tree().getByRole("checkbox", { name: "Show Fin" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Bodies" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Version" }) as HTMLSelectElement).value).toBe("1");
    expect(screen.getByText("Default")).toBeTruthy(); // its configuration
    // jsdom has no 3D, which the page says, keeping the list.
    expect(screen.getByText(/isn't drawing 3D/)).toBeTruthy();

    await userEvent.click(doubler);
    expect((doubler as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect((doubler as HTMLInputElement).checked).toBe(true);
});

/** An assembly of a part in one folder and a sub-assembly (with a part of its own) in another, and its model. */
async function rocket(team: Team) {
    const [fin, grain] = await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin", "Motor/Grain.SLDPRT": "grain" });
    const [motor] = await team.checkin(
        team.chief,
        { "Motor/Motor.SLDASM": "motor" },
        { refs: { "Motor/Motor.SLDASM": ["Motor/Grain.SLDPRT"] } },
    );
    const [assembly] = await team.checkin(
        team.chief,
        { "Rocket/Rocket.SLDASM": "rocket" },
        { refs: { "Rocket/Rocket.SLDASM": ["Fins/Fin.SLDPRT", "Motor/Motor.SLDASM"] } },
    );
    await team.model(team.chief, fin!, { mesh: tetrahedra("Fin") });
    await team.model(team.chief, assembly!, {
        components: [
            component("Fin-1", fin!),
            component("Fin-2", fin!, { hidden: true }),
            component("Motor-1", motor!, { children: [component("Grain-1", grain!)] }),
        ],
    });
    return { fin: fin!, rocket: assembly! };
}

test("an assembly's components: hidden as SolidWorks had them, isolated, and opened on their own", async () => {
    const team = await Team.create();
    const { fin, rocket: assembly } = await rocket(team);
    await team.checkout(team.chief, "Fins/Fin.SLDPRT", "CHIEF-PC");
    await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin v2" }, { host: "CHIEF-PC" });

    renderApp(team.chief, caliperUrl(assembly.id));
    const finOne = await screen.findByRole("checkbox", { name: "Show Fin-1" });
    expect((finOne as HTMLInputElement).checked).toBe(true);
    expect((tree().getByRole("checkbox", { name: "Show Fin-2" }) as HTMLInputElement).checked).toBe(false);
    await waitFor(() => expect(within(finOne.closest("li")!).getByText("v1 (now v2)")).toBeTruthy());
    // Grain's file isn't a real SolidWorks part, so it has no 3D view to read.
    expect(screen.getByText("1 component isn't shown:")).toBeTruthy();
    expect(screen.getByText("1 part's file has no 3D view Caliper can read.")).toBeTruthy();
    await userEvent.click(tree().getByRole("button", { name: "Show what's in Motor-1" }));
    const grainRow = tree().getByRole("checkbox", { name: "Show Grain-1" }).closest("li")!;
    expect(within(grainRow).getByText("No 3D model")).toBeTruthy();

    await userEvent.click(tree().getByRole("button", { name: "Isolate Fin-1" }));
    expect(screen.getByText(/Showing only Fin-1/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show the rest" }));
    expect(screen.queryByText(/Showing only/)).toBeNull();
    expect(tree().getByRole("link", { name: "Open Fin-1 in Caliper" }).getAttribute("href")).toBe(
        caliperUrl(fin.id, 1, "Default"),
    );
    await userEvent.click(tree().getByRole("link", { name: "Open Motor-1 in Caliper" }));
    expect(await screen.findByRole("heading", { name: "Motor.SLDASM" })).toBeTruthy();
    // Its model would be read from the file, which isn't a real SolidWorks assembly.
    expect(await screen.findByText("v1 of Motor.SLDASM has no 3D model.")).toBeTruthy();
    expect(screen.getByText(/v1: It isn't a SolidWorks assembly that Caliper can read/)).toBeTruthy();
});

test("what an assembly doesn't show is summed up by why, with what to do about it", async () => {
    const team = await Team.create();
    const servo = (name: string) =>
        readFile(resolve(import.meta.dirname, "../../server/tests/fixtures/solidworks", name));
    // A part with a model; SparkFun's spline, whose file has a 3D view of its Default configuration only; and a
    // sub-assembly none of whose parts were found.
    const [fin, spline, tail] = await team.checkin(team.chief, {
        "Fins/Fin.SLDPRT": "fin",
        "Servo/Embout.SLDPRT": await servo("Embout.SLDPRT"),
        "Tail/Tail.SLDASM": "tail",
    });
    const [assembly] = await team.checkin(
        team.chief,
        { "Rocket/Rocket.SLDASM": "rocket" },
        { refs: { "Rocket/Rocket.SLDASM": ["Fins/Fin.SLDPRT", "Servo/Embout.SLDPRT", "Tail/Tail.SLDASM"] } },
    );
    await team.model(team.chief, fin!, { mesh: tetrahedra("Fin") });
    await team.model(team.chief, assembly!, {
        components: [
            component("Fin-1", fin!),
            component("Embout-1", spline!, { configuration: "Long" }),
            component("Tail-1", tail!),
        ],
    });

    renderApp(team.chief, caliperUrl(assembly!.id));
    expect(await screen.findByText("2 components aren't shown:")).toBeTruthy();
    expect(screen.getByText("1 part is in a configuration its file has no 3D view of.")).toBeTruthy();
    expect(screen.getByText("1 sub-assembly has none of its parts in the vault.")).toBeTruthy();
    expect(screen.getByText(/click Make 3D view on the Vault tab to make those parts' models/)).toBeTruthy();
    expect(screen.getByText("Parts that aren't in the vault show once someone checks them in.")).toBeTruthy();
    const row = (name: string) =>
        tree()
            .getByRole("checkbox", { name: `Show ${name}` })
            .closest("li")!;
    expect(within(row("Embout-1")).getByText("Other configuration").getAttribute("title")).toBe(
        "v1 has a 3D view of its Default configuration, not Long",
    );
    expect(within(row("Tail-1")).getByText("Parts not in the vault")).toBeTruthy();
    expect(within(row("Fin-1")).queryByText(/No 3D model|Other configuration/)).toBeNull();
});

test("components in folders you can't see are left out, with what's in them", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const { rocket: assembly } = await rocket(team);
    // Bob sees the rocket's folder and the fins', but not the motor's.
    await team.grant(team.folder, null, null);
    await team.grant(team.path("Rocket"), bob.user.id, "viewer");
    await team.grant(team.path("Fins"), bob.user.id, "viewer");

    renderApp(bob, caliperUrl(assembly.id));
    expect(await screen.findByText(/1 component is in folders you can't see/)).toBeTruthy();
    expect(tree().getByRole("checkbox", { name: "Show Fin-1" })).toBeTruthy();
    expect(tree().queryByRole("checkbox", { name: "Show Motor-1" })).toBeNull();
});

test("a version with no model says why; with none asked for, the newest that has one shows", async () => {
    const team = await Team.create();
    const [fin] = await team.checkin(team.chief, { "Fin.SLDPRT": "fin v1" });
    await team.model(team.chief, fin!, { mesh: tetrahedra("Fin") });
    await team.checkout(team.chief, "Fin.SLDPRT", "CHIEF-PC");
    await team.checkin(team.chief, { "Fin.SLDPRT": "fin v2" }, { host: "CHIEF-PC", comment: "from the web" });

    // v2's model would be read from the file, which isn't a real SolidWorks part.
    const finPage = renderApp(team.chief, caliperUrl(fin!.id));
    expect(await screen.findByText("v2, the latest version, has no 3D model, so this is v1.")).toBeTruthy();
    expect(screen.getByText(/v2: It isn't a SolidWorks part that Caliper can read/)).toBeTruthy();
    expect(await screen.findByRole("checkbox", { name: "Show Fin" })).toBeTruthy();
    const version = screen.getByRole("combobox", { name: "Version" }) as HTMLSelectElement;
    expect([...version.options].map((option) => option.textContent)).toEqual(["v2 (no 3D model)", "v1"]);

    await userEvent.selectOptions(version, "2");
    expect(await screen.findByText("v2 of Fin.SLDPRT has no 3D model.")).toBeTruthy();
    expect(screen.getByText(/Vault for SolidWorks makes models too/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "v1" }).getAttribute("href")).toBe(caliperUrl(fin!.id, 1));

    finPage.unmount(); // or it follows the next page too, and shows it twice

    // Drawings and other files aren't Caliper's.
    const [drawing] = await team.checkin(
        team.chief,
        { "Fin.SLDDRW": "drawing" },
        { refs: { "Fin.SLDDRW": ["Fin.SLDPRT"] } },
    );
    renderApp(team.chief, caliperUrl(drawing!.id));
    expect(await screen.findByText(/Caliper shows SolidWorks parts and assemblies/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Fin.SLDDRW" }).getAttribute("href")).toBe(fileUrl(drawing!.id));
});

test("a SolidWorks file without a model shows the 3D view SolidWorks saved in it", async () => {
    // SparkFun's servo (server/tests/fixtures/solidworks/README.md): a part of two bodies, and its assembly.
    const servo = (name: string) =>
        readFile(resolve(import.meta.dirname, "../../server/tests/fixtures/solidworks", name));
    const team = await Team.create();
    const [assembly, spline] = await team.checkin(
        team.chief,
        {
            "Servo/9347.SLDASM": await servo("9347.SLDASM"),
            "Servo/Embout.SLDPRT": await servo("Embout.SLDPRT"),
            "Servo/Servomoteur.SLDPRT": await servo("Servomoteur.SLDPRT"),
        },
        { refs: { "Servo/9347.SLDASM": ["Servo/Embout.SLDPRT", "Servo/Servomoteur.SLDPRT"] } },
    );

    const part = renderApp(team.chief, caliperUrl(spline!.id));
    expect(await screen.findByText(/Reading the 3D view SolidWorks saved in v1 of Embout.SLDPRT/)).toBeTruthy();
    expect(await screen.findByRole("checkbox", { name: "Show Fillet3" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Show Boss-Extrude2" })).toBeTruthy();
    part.unmount();

    renderApp(team.chief, caliperUrl(assembly!.id));
    expect(await screen.findByRole("checkbox", { name: "Show Servomoteur-1" })).toBeTruthy();
    expect(tree().getByRole("link", { name: "Open Embout-1 in Caliper" }).getAttribute("href")).toBe(
        caliperUrl(spline!.id, 1, "Default"),
    );
    expect(screen.queryByText(/no 3D model/)).toBeNull();
});

test("an assembly's parts without models of their own have them made from their files", async () => {
    // SparkFun's servo again, its assembly without a 3D view of its own (its display list renamed: SolidWorks stores a
    // stream's name with each byte's halves swapped), checked in as the web app does, with no references. Its parts are
    // found by the paths SolidWorks saved for them, ...\Servomoteur SM-S4303R\, and each is read from its own file.
    const servo = (name: string) =>
        readFile(resolve(import.meta.dirname, "../../server/tests/fixtures/solidworks", name));
    const swapped = (name: string) => Buffer.from([...Buffer.from(name)].map((b) => ((b << 4) | (b >> 4)) & 0xff));
    const viewless = (data: Buffer) => {
        const [from, to] = [swapped("Contents/DisplayLists"), swapped("Contents/DisplayListz")];
        const out = Buffer.from(data);
        for (let at = out.indexOf(from); at >= 0; at = out.indexOf(from, at + 1)) {
            to.copy(out, at);
        }
        return out;
    };
    const team = await Team.create();
    const [assembly, spline, caseFile] = await team.checkin(team.chief, {
        "Servo/9347.SLDASM": viewless(await servo("9347.SLDASM")),
        "Servomoteur SM-S4303R/Embout.SLDPRT": await servo("Embout.SLDPRT"),
        "Servomoteur SM-S4303R/Servomoteur.SLDPRT": await servo("Servomoteur.SLDPRT"),
    });

    renderApp(team.chief, caliperUrl(assembly!.id));
    // The tree comes once every part's shape has, so nothing says it's missing.
    expect(await screen.findByRole("checkbox", { name: "Show Servomoteur-1" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Show Embout-1" })).toBeTruthy();
    expect(screen.queryByText(/no 3D model|didn't load/)).toBeNull();
    expect(tree().getByRole("link", { name: "Open Embout-1 in Caliper" }).getAttribute("href")).toBe(
        caliperUrl(spline!.id, 1, "Default"),
    );
    // The parts' models were made on the way, as opening each on its own would.
    for (const part of [spline!, caseFile!]) {
        expect((await team.caliperModels(part.id)).map((model) => model.configuration)).toEqual(["Default"]);
    }
});

test("a STEP file is read as it is, its products the tree", async () => {
    const team = await Team.create();
    const step = await readFile(resolve(import.meta.dirname, "fixtures/tab.step"), "utf8");
    const [tab] = await team.checkin(team.chief, { "Tab.STEP": step });
    // The browser fetches OpenCascade's WebAssembly from the app; here it's read from where npm put it.
    const wasm = resolve(import.meta.dirname, "../node_modules/occt-import-js/dist/occt-import-js.wasm");
    wasmFrom(async () => (await readFile(wasm)).buffer as ArrayBuffer);

    renderApp(team.chief, caliperUrl(tab!.id));
    expect(await screen.findByRole("heading", { name: "Tab.STEP" })).toBeTruthy();
    expect(await screen.findByRole("checkbox", { name: "Show Tab" }, { timeout: 20_000 })).toBeTruthy();
    expect(screen.queryByText(/no 3D model/)).toBeNull();
});
