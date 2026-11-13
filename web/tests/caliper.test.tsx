import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFile } from "node:fs/promises";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
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

// SparkFun's servo (server/tests/fixtures/solidworks/README.md), and ways to change its files as SolidWorks might have
// saved them. SolidWorks stores a stream's name with each byte's halves swapped, and each stream with its CRC.
const servo = (name: string) => readFile(resolve(import.meta.dirname, "../../server/tests/fixtures/solidworks", name));
const swapped = (name: string) => Buffer.from([...Buffer.from(name)].map((b) => ((b << 4) | (b >> 4)) & 0xff));

/** The file with no display list: its streams of that name, renamed. */
function viewless(data: Buffer): Buffer {
    const [from, to] = [swapped("Contents/DisplayLists"), swapped("Contents/DisplayListz")];
    const out = Buffer.from(data);
    for (let at = out.indexOf(from); at >= 0; at = out.indexOf(from, at + 1)) {
        to.copy(out, at);
    }
    return out;
}

/** The file with one stream changed, packed again with its CRC (as server/tests/test_caliper_files.py's repacked). */
function repacked(data: Buffer, name: string, change: (old: Buffer) => Buffer): Buffer {
    const marker = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
    for (let at = data.indexOf(marker); at >= 0; at = data.indexOf(marker, at + 1)) {
        const head = at + marker.length;
        const [tag, crc, packed, size, length] = [0, 4, 8, 12, 16].map((offset) => data.readUInt32LE(head + offset));
        const start = head + 20 + length!;
        if (!swapped(name).equals(data.subarray(head + 20, start))) {
            continue;
        }
        let old: Buffer;
        try {
            old = inflateRawSync(data.subarray(start, start + packed!));
        } catch {
            continue; // the blocks at a file's start that look like streams but don't unpack
        }
        if (old.length !== size || crc32(old) !== crc) {
            continue;
        }
        const fresh = change(old);
        const body = deflateRawSync(fresh);
        const header = Buffer.alloc(20);
        [tag!, crc32(fresh), body.length, fresh.length, length!].forEach((value, i) =>
            header.writeUInt32LE(value, 4 * i),
        );
        return Buffer.concat([
            data.subarray(0, at),
            marker,
            header,
            data.subarray(head + 20, start),
            body,
            data.subarray(start + packed!),
        ]);
    }
    throw new Error(`The file has no stream ${name}`);
}

const MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]); // what each of a file's streams starts with

/** A stream of the file, unpacked: the copy whose CRC checks. */
function streamOf(data: Buffer, name: string): Buffer {
    for (let at = data.indexOf(MARKER); at >= 0; at = data.indexOf(MARKER, at + 1)) {
        const head = at + MARKER.length;
        const [crc, packed, size, length] = [4, 8, 12, 16].map((offset) => data.readUInt32LE(head + offset));
        const start = head + 20 + length!;
        if (!swapped(name).equals(data.subarray(head + 20, start))) {
            continue;
        }
        try {
            const found = inflateRawSync(data.subarray(start, start + packed!));
            if (found.length === size && crc32(found) === crc) {
                return found;
            }
        } catch {
            // the blocks at a file's start that look like streams but don't unpack
        }
    }
    throw new Error(`The file has no stream ${name}`);
}

/** The file with one more stream, at its end. */
function keeping(data: Buffer, name: string, contents: Buffer): Buffer {
    const body = deflateRawSync(contents);
    const header = Buffer.alloc(20);
    [0, crc32(contents), body.length, contents.length, name.length].forEach((value, i) =>
        header.writeUInt32LE(value, 4 * i),
    );
    return Buffer.concat([data, MARKER, header, swapped(name), body]);
}

/**
 * The servo's case as a part of three configurations, as server/tests/test_caliper_files.py's case_in_configurations
 * has it: Default, the one SolidWorks saved it in, with its 3D view; Spline, up to date then, so SolidWorks kept its
 * solid (the spline's, here); and Old, which needed a rebuild, so it kept nothing of it.
 */
async function caseInConfigurations(): Promise<Buffer> {
    const spline = await servo("Embout.SLDPRT");
    const more = ["Spline", "Old"]
        .map(
            (name, i) =>
                `<swConfiguration id="${7 + i}" swName="${name}" swID="${1 + i}" swMostRecentConfiguration="NO" ` +
                `swConfigurationNeedsUpdate="${name === "Old" ? "YES" : "NO"}" swModelRef="2"/>`,
        )
        .join("");
    const listed = repacked(await servo("Servomoteur.SLDPRT"), "swXmlContents/Features", (xml) =>
        Buffer.from(
            xml.toString("latin1").replace("</swConfigurationList>", `${more}</swConfigurationList>`),
            "latin1",
        ),
    );
    const solid = keeping(listed, "Contents/Config-1-Partition", streamOf(spline, "Contents/Config-0-Partition"));
    return keeping(solid, "Contents/Config-1", streamOf(spline, "Contents/Config-0"));
}

test("parts, assemblies, and STEP and STL files open in Caliper, beside Open in SolidWorks", async () => {
    const team = await Team.create();
    const [fin] = await team.checkin(team.chief, {
        "Fin.SLDPRT": "fin",
        "Can.SLDASM": "can",
        "Tab.STEP": "step",
        "Bracket.STL": "solid bracket\nendsolid bracket\n",
        "Notes.pdf": "notes",
    });

    renderApp(team.chief, folderUrl(team.folder));
    const files = await table();
    const row = (name: string) => within(files.getByRole("link", { name }).closest("tr")!);
    for (const name of ["Fin.SLDPRT", "Can.SLDASM"]) {
        expect(row(name).getByRole("link", { name: "Open in SolidWorks" })).toBeTruthy();
        expect(row(name).getByRole("link", { name: "Open in Caliper" })).toBeTruthy();
    }
    expect(row("Tab.STEP").getByRole("link", { name: "Open in Caliper" })).toBeTruthy();
    expect(row("Bracket.STL").getByRole("link", { name: "Open in Caliper" })).toBeTruthy();
    expect(row("Bracket.STL").queryByRole("link", { name: "Open in SolidWorks" })).toBeNull();
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
    // Where it came from: Vault for SolidWorks made it, and who did.
    await userEvent.click(screen.getByRole("button", { name: "Where it came from: Made in SolidWorks" }));
    const about = screen.getByRole("dialog", { name: "Where it came from" });
    expect(within(about).getByText(/What SolidWorks drew/)).toBeTruthy();
    expect(within(about).getByText(/^Made by chief, /)).toBeTruthy();
    await userEvent.keyboard("{Escape}");

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
    // Fin's v2 isn't a real SolidWorks part, so it has no 3D model: the fin shows v1, as the rocket was checked in,
    // and says why.
    await waitFor(() => expect(within(finOne.closest("li")!).getByText("v1 (now v2)")).toBeTruthy());
    expect(within(finOne.closest("li")!).getByText("Not the latest").getAttribute("title")).toMatch(
        /^v2, its latest, has no 3D model: .*It isn't a SolidWorks part that Caliper can read/,
    );
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
    // Its model, in the configuration the rocket uses, would be read from the file, which isn't a real SolidWorks
    // assembly.
    expect(await screen.findByText("The Default configuration of v1 of Motor.SLDASM has no 3D model.")).toBeTruthy();
    expect(screen.getByText(/v1: It isn't a SolidWorks assembly that Caliper can read/)).toBeTruthy();
});

test("what an assembly doesn't show is summed up by why, with what to do about it", async () => {
    const team = await Team.create();
    // A part with a model; SparkFun's spline, in a configuration its file hasn't (it has Default only); and a
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
        `${team.path("Servo/Embout.SLDPRT")} v1: It has no configuration named Long`,
    );
    expect(within(row("Tail-1")).getByText("Parts not in the vault")).toBeTruthy();
    expect(within(row("Fin-1")).queryByText(/No 3D model|Other configuration/)).toBeNull();
    expect(within(row("Fin-1")).getByRole("img", { name: "Made in SolidWorks" })).toBeTruthy();
    expect(screen.getByText("1 made in SolidWorks")).toBeTruthy();
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

test("an assembly's parts show at their latest versions, or as it was checked in", async () => {
    const team = await Team.create();
    const { fin, rocket: assembly } = await rocket(team);
    await team.checkout(team.chief, "Fins/Fin.SLDPRT", "CHIEF-PC");
    const [fin2] = await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin v2" }, { host: "CHIEF-PC" });
    await team.model(team.chief, fin2!, { mesh: tetrahedra("Fin", "Tab") });

    // As SolidWorks shows it once it has the latest files: the fin's v2, where the rocket put its v1.
    const page = renderApp(team.chief, caliperUrl(assembly.id));
    const finRow = async () => (await screen.findByRole("checkbox", { name: "Show Fin-1" })).closest("li")!;
    expect(within(await finRow()).getByText("v2")).toBeTruthy();
    expect(
        within(await finRow())
            .getByText("Changed since")
            .getAttribute("title"),
    ).toBe("The assembly was checked in with v1. This is v2, the latest, where the assembly put v1.");
    const choice = screen.getByRole("combobox", { name: "Parts" }) as HTMLSelectElement;
    expect(choice.value).toBe("latest");
    expect(screen.getByText(/2 parts and sub-assemblies changed since v1 of the assembly was checked in/)).toBeTruthy();
    expect(tree().getByRole("link", { name: "Open Fin-1 in Caliper" }).getAttribute("href")).toBe(
        caliperUrl(fin.id, 2, "Default"),
    );

    // As it was checked in: the fin's v1, which says there's a newer one.
    await userEvent.selectOptions(choice, "checked_in");
    await waitFor(() => expect(within(screen.getAllByRole("treeitem")[0]!).getByText("v1 (now v2)")).toBeTruthy());
    expect(screen.queryByText("Changed since")).toBeNull();
    expect(screen.getByText(/2 parts and sub-assemblies have a newer version than v1 of the assembly/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show the latest" }));
    expect(within(await finRow()).getByText("v2")).toBeTruthy();
    page.unmount();

    // An older version of the assembly, asked for, shows as it was checked in.
    await team.checkout(team.chief, "Rocket/Rocket.SLDASM", "CHIEF-PC");
    await team.checkin(team.chief, { "Rocket/Rocket.SLDASM": "rocket v2" }, { host: "CHIEF-PC" });
    renderApp(team.chief, caliperUrl(assembly.id, 1));
    expect(within(await finRow()).getByText("v1 (now v2)")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Parts" }) as HTMLSelectElement).value).toBe("checked_in");
});

test("a sub-assembly checked in since shows its newer parts, its model made from its file", async () => {
    // A rocket whose servo bay was checked in again since, as SparkFun's servo (server/tests/fixtures/solidworks): its
    // v2 has no model yet, so the server reads it from the file, and the rocket shows its parts.
    const team = await Team.create();
    const [spline, , bay] = await team.checkin(team.chief, {
        "Servo/Embout.SLDPRT": await servo("Embout.SLDPRT"),
        "Servo/Servomoteur.SLDPRT": await servo("Servomoteur.SLDPRT"),
        "Servo/9347.SLDASM": "an empty bay",
    });
    const [assembly] = await team.checkin(
        team.chief,
        { "Rocket/Rocket.SLDASM": "rocket" },
        { refs: { "Rocket/Rocket.SLDASM": ["Servo/9347.SLDASM"] } },
    );
    await team.model(team.chief, assembly!, {
        components: [component("Bay-1", bay!, { children: [component("Embout-1", spline!)] })],
    });
    await team.checkout(team.chief, "Servo/9347.SLDASM", "CHIEF-PC");
    await team.checkin(
        team.chief,
        { "Servo/9347.SLDASM": await servo("9347.SLDASM") },
        { host: "CHIEF-PC", refs: { "Servo/9347.SLDASM": ["Servo/Embout.SLDPRT", "Servo/Servomoteur.SLDPRT"] } },
    );

    renderApp(team.chief, caliperUrl(assembly!.id));
    // The bay is all there is, so it's open.
    expect(await screen.findByRole("checkbox", { name: "Show Servomoteur-1" })).toBeTruthy();
    const bayRow = tree().getByRole("checkbox", { name: "Show Bay-1" }).parentElement!;
    expect(within(bayRow).getByText("v2")).toBeTruthy();
    expect(within(bayRow).getByText("Changed since")).toBeTruthy();
    expect((await team.caliperModels(bay!.id)).map((model) => model.version)).toEqual([2]);
});

test("a version with no model says why; with none asked for, the newest that has one shows", async () => {
    const team = await Team.create();
    const [fin] = await team.checkin(team.chief, { "Fin.SLDPRT": "fin v1" });
    await team.model(team.chief, fin!, { mesh: tetrahedra("Fin") });
    await team.checkout(team.chief, "Fin.SLDPRT", "CHIEF-PC");
    await team.checkin(team.chief, { "Fin.SLDPRT": "fin v2" }, { host: "CHIEF-PC", comment: "from the web" });

    // v2's model would be read from the file, which isn't a real SolidWorks part.
    const finPage = renderApp(team.chief, caliperUrl(fin!.id));
    expect(await screen.findByText(/v2, the latest, has no 3D model, so this is v1\./)).toBeTruthy();
    expect(screen.getByText("This isn't the latest version.")).toBeTruthy();
    expect(screen.getByText(/v2: It isn't a SolidWorks part that Caliper can read/)).toBeTruthy();
    expect(await screen.findByRole("checkbox", { name: "Show Fin" })).toBeTruthy();
    const version = screen.getByRole("combobox", { name: "Version" }) as HTMLSelectElement;
    expect([...version.options].map((option) => option.textContent)).toEqual(["v2 (latest, no 3D model)", "v1"]);

    await userEvent.selectOptions(version, "2");
    expect(await screen.findByText("v2 of Fin.SLDPRT has no 3D model.")).toBeTruthy();
    expect(screen.getByText(/Vault for SolidWorks makes models too/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "v1" }).getAttribute("href")).toBe(caliperUrl(fin!.id, 1));

    finPage.unmount(); // or it follows the next page too, and shows it twice

    // Other files aren't Caliper's (drawings are: drawing.test.tsx).
    const [notes] = await team.checkin(team.chief, { "Notes.pdf": "notes" });
    renderApp(team.chief, caliperUrl(notes!.id));
    expect(await screen.findByText(/Caliper shows SolidWorks parts, assemblies, and drawings/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Notes.pdf" }).getAttribute("href")).toBe(fileUrl(notes!.id));
});

test("a SolidWorks file without a model shows the 3D view SolidWorks saved in it", async () => {
    // SparkFun's servo (server/tests/fixtures/solidworks/README.md): a part of two bodies, and its assembly.
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
    // It says it's the 3D view SolidWorks saved in the file, and what that is.
    await userEvent.click(screen.getByRole("button", { name: "Where it came from: SolidWorks' saved 3D view" }));
    expect(screen.getByText(/The triangles SolidWorks drew of it when it last saved this version/)).toBeTruthy();
    part.unmount();

    renderApp(team.chief, caliperUrl(assembly!.id));
    expect(await screen.findByRole("checkbox", { name: "Show Servomoteur-1" })).toBeTruthy();
    expect(tree().getByRole("link", { name: "Open Embout-1 in Caliper" }).getAttribute("href")).toBe(
        caliperUrl(spline!.id, 1, "Default"),
    );
    expect(screen.queryByText(/no 3D model/)).toBeNull();
    // Its parts are where its file says, each as the assembly's own 3D view keeps it.
    await userEvent.click(screen.getByRole("button", { name: "Where it came from: Placed as its file says" }));
    expect(screen.getByText("Where each part is, as SolidWorks saved v1 of the assembly in its file.")).toBeTruthy();
    expect(screen.getByText("2 from SolidWorks' saved 3D views")).toBeTruthy();
    const row = tree().getByRole("checkbox", { name: "Show Embout-1" }).closest("li")!;
    expect(within(row).getByRole("img", { name: "SolidWorks' saved 3D view" })).toBeTruthy();
});

test("a part's configurations: each its file kept opens, and one it didn't says what to do", async () => {
    const team = await Team.create();
    const [caseFile] = await team.checkin(team.chief, { "Servo/Servomoteur.SLDPRT": await caseInConfigurations() });

    renderApp(team.chief, caliperUrl(caseFile!.id));
    // The one SolidWorks saved it in shows first, from its 3D view; the others are offered.
    expect(await screen.findByRole("checkbox", { name: "Show Boss-Extrude1" })).toBeTruthy();
    const choice = () => screen.getByRole("combobox", { name: "Configuration" }) as HTMLSelectElement;
    await waitFor(() =>
        expect([...choice().options].map((option) => option.textContent)).toEqual([
            "Default",
            "Spline",
            "Old (no 3D model)",
        ]),
    );
    expect(choice().value).toBe("Default");

    // Spline is read from the solid SolidWorks kept of it: the spline's two bodies, here, which the page says.
    await userEvent.selectOptions(choice(), "Spline");
    expect(await screen.findByRole("checkbox", { name: "Show Body 2" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Show Body 1" })).toBeTruthy();
    expect(choice().value).toBe("Spline");
    expect(screen.getByRole("button", { name: "Where it came from: Caliper's triangles of the solid" })).toBeTruthy();

    // Old needed a rebuild when SolidWorks saved the file, so it kept nothing of it: the page says what to do.
    await userEvent.selectOptions(choice(), "Old");
    expect(await screen.findByText("The Old configuration of v1 of Servomoteur.SLDPRT has no 3D model.")).toBeTruthy();
    expect(screen.getByText(/marked its Old configuration as needing a rebuild/)).toBeTruthy();
    expect(screen.getByText(/click Add Rebuild\/Save Mark/)).toBeTruthy();
    expect(choice().value).toBe("Old");
    expect(screen.getByRole("link", { name: "Spline" }).getAttribute("href")).toBe(
        caliperUrl(caseFile!.id, 1, "Spline"),
    );
});

test("an assembly's part shows in the configuration it's used in, where its file kept that", async () => {
    const team = await Team.create();
    const [caseFile, fin] = await team.checkin(team.chief, {
        "Servo/Servomoteur.SLDPRT": await caseInConfigurations(),
        "Fins/Fin.SLDPRT": "fin",
    });
    const [assembly] = await team.checkin(
        team.chief,
        { "Rocket/Rocket.SLDASM": "rocket" },
        { refs: { "Rocket/Rocket.SLDASM": ["Servo/Servomoteur.SLDPRT", "Fins/Fin.SLDPRT"] } },
    );
    await team.model(team.chief, fin!, { mesh: tetrahedra("Fin") });
    await team.model(team.chief, assembly!, {
        components: [
            component("Case-1", caseFile!, { configuration: "Spline" }),
            component("Case-2", caseFile!, { configuration: "Old" }),
            component("Fin-1", fin!),
        ],
    });

    renderApp(team.chief, caliperUrl(assembly!.id));
    expect(await screen.findByText("1 component isn't shown:")).toBeTruthy();
    expect(screen.getByText("1 part is in a configuration its file has no 3D view of.")).toBeTruthy();
    const row = (name: string) =>
        tree()
            .getByRole("checkbox", { name: `Show ${name}` })
            .closest("li")!;
    expect(within(row("Case-1")).queryByText(/No 3D model|Other configuration/)).toBeNull();
    expect(within(row("Case-2")).getByText("Other configuration").getAttribute("title")).toMatch(
        /marked its Old configuration as needing a rebuild/,
    );
    // The part's models were made on the way: first the one it was saved in, which shows when none is asked for.
    expect((await team.caliperModels(caseFile!.id)).map((model) => model.configuration)).toEqual(["Default", "Spline"]);
});

test("an assembly's parts without models of their own have them made from their files", async () => {
    // SparkFun's servo again, its assembly without a 3D view of its own (its display list renamed: SolidWorks stores a
    // stream's name with each byte's halves swapped), checked in as the web app does, with no references. Its parts are
    // found by the paths SolidWorks saved for them, ...\Servomoteur SM-S4303R\, and each is read from its own file.
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

test("a STEP file placed in an assembly (3D Interconnect) is read as it is, where the assembly puts it", async () => {
    const team = await Team.create();
    const step = await readFile(resolve(import.meta.dirname, "fixtures/tab.step"), "utf8");
    const [tab, fin] = await team.checkin(team.chief, { "Avionics/Tab.STEP": step, "Fins/Fin.SLDPRT": "fin" });
    const [bay] = await team.checkin(
        team.chief,
        { "Avionics/Bay.SLDASM": "bay" },
        { refs: { "Avionics/Bay.SLDASM": ["Avionics/Tab.STEP", "Fins/Fin.SLDPRT"] } },
    );
    await team.model(team.chief, fin!, { mesh: tetrahedra("Fin") });
    await team.model(team.chief, bay!, {
        components: [component("Tab-1", tab!), component("Fin-1", fin!)],
    });
    const wasm = resolve(import.meta.dirname, "../node_modules/occt-import-js/dist/occt-import-js.wasm");
    wasmFrom(async () => (await readFile(wasm)).buffer as ArrayBuffer);

    renderApp(team.chief, caliperUrl(bay!.id));
    const tabRow = (await screen.findByRole("checkbox", { name: "Show Tab-1" }, { timeout: 20_000 })).closest("li")!;
    // It loads as the parts do: nothing says it has no 3D model, and the page sums up nothing missing.
    await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull(), { timeout: 20_000 });
    expect(within(tabRow).queryByText(/No 3D model|Unreadable|didn't load/i)).toBeNull();
    expect(screen.queryByText(/don't show|no 3D model/i)).toBeNull();
    expect(tree().getByRole("link", { name: "Open Tab-1 in Caliper" }).getAttribute("href")).toBe(
        caliperUrl(tab!.id, 1, "Default"),
    );
});

test("an STL file is read as it is: its shells are bodies, and its numbers millimeters", async () => {
    const team = await Team.create();
    // Two boxes as one STL file, written out as text.
    const facet = (a: number[], b: number[], c: number[]) =>
        `facet normal 0 0 0\nouter loop\nvertex ${a.join(" ")}\nvertex ${b.join(" ")}\nvertex ${c.join(" ")}\nendloop\nendfacet\n`;
    const cube = (x: number) => {
        const p = (i: number, j: number, k: number) => [x + i, j, k];
        const quads = [
            [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)],
            [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
            [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)],
            [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)],
            [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)],
            [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
        ];
        return quads.map(([a, b, c, d]) => facet(a!, b!, c!) + facet(a!, c!, d!)).join("");
    };
    const [stl] = await team.checkin(team.chief, {
        "Brackets.STL": `solid brackets\n${cube(0)}${cube(5)}endsolid brackets\n`,
    });

    renderApp(team.chief, caliperUrl(stl!.id));
    expect(await screen.findByRole("heading", { name: "Brackets.STL" })).toBeTruthy();
    expect(await screen.findByRole("checkbox", { name: "Show Body 1" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Show Body 2" })).toBeTruthy();
    expect(screen.queryByText(/no 3D model/)).toBeNull();
});

test("a part kept inside its assembly with no shape there (a routed tube) says so", async () => {
    // The servo's assembly without a 3D view of its own, as SolidWorks 2024 and later save one, and its case kept inside
    // it, as SolidWorks Routing keeps tubes, but without the case's own file in it: nothing in the file has its shape.
    const caseInside = (xml: Buffer) => {
        const at = xml.indexOf('swName="Servomoteur" swReferenceNumber');
        const rest = xml
            .subarray(at)
            .toString("latin1")
            .replace('swIsVirtualComponent="NO"', 'swIsVirtualComponent="YES"');
        return Buffer.concat([xml.subarray(0, at), Buffer.from(rest, "latin1")]);
    };
    const team = await Team.create();
    const [assembly] = await team.checkin(
        team.chief,
        {
            "Servo/9347.SLDASM": repacked(
                viewless(await servo("9347.SLDASM")),
                "swXmlContents/COMPINSTANCETREE",
                caseInside,
            ),
            "Servo/Embout.SLDPRT": await servo("Embout.SLDPRT"),
        },
        { refs: { "Servo/9347.SLDASM": ["Servo/Embout.SLDPRT"] } },
    );

    renderApp(team.chief, caliperUrl(assembly!.id));
    const caseRow = (await screen.findByRole("checkbox", { name: "Show Servomoteur-1" })).closest("li")!;
    expect(within(caseRow).getByText("No shape inside")).toBeTruthy();
    expect(screen.getByText(/1 part is kept inside its assembly \(routed tubes\) with no shape there/)).toBeTruthy();
    expect(screen.queryByText(/not in the vault/)).toBeNull();
    expect(
        within(tree().getByRole("checkbox", { name: "Show Embout-1" }).closest("li")!).queryByText(/No shape|No 3D/),
    ).toBeNull();
});
