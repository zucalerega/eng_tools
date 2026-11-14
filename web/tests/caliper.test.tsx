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
    // The fin was checked in since the rocket was, so it's wanted as it is now, at v2, which has no 3D view to read
    // (it isn't a real SolidWorks part): v1, which the rocket was checked in with, stands in, and says so.
    const finRow = within(finOne.closest("li")!);
    expect(finRow.getByText("Shows v1").getAttribute("title")).toMatch(
        /^This is v1, the version the assembly was checked in with: v2 has no 3D view Caliper can show/,
    );
    expect(finRow.getByText("SW").parentElement!.getAttribute("title")).toBe(
        "v2; the assembly was checked in with v1. From SolidWorks: Vault for SolidWorks made this view there, so " +
            "it's what SolidWorks showed",
    );
    // Grain's file isn't a real SolidWorks part either, and it never had a model.
    expect(screen.getByText("1 component isn't shown:")).toBeTruthy();
    expect(screen.getByText("1 part's file has no 3D view Caliper can read.")).toBeTruthy();
    expect(screen.getByText("Shown, but not as the assembly has them:")).toBeTruthy();
    expect(
        screen.getByText("2 parts show an older version: their latest has no 3D view Caliper can read."),
    ).toBeTruthy();
    expect(
        screen.getByText(/2 components were checked in after this assembly was: they show as they are now/),
    ).toBeTruthy();
    const about = within(screen.getByRole("status", { name: "What this view shows" }));
    expect(about.getByText("Version 1, the latest.")).toBeTruthy();
    expect(
        about.getByText(/2 of 3 parts are shown, each as it is now; 2 show something else in place of/),
    ).toBeTruthy();
    await userEvent.click(tree().getByRole("button", { name: "Show what's in Motor-1" }));
    const grainRow = tree().getByRole("checkbox", { name: "Show Grain-1" }).closest("li")!;
    expect(within(grainRow).getByText("No 3D view")).toBeTruthy();

    await userEvent.click(tree().getByRole("button", { name: "Isolate Fin-1" }));
    expect(screen.getByText(/Showing only Fin-1/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show the rest" }));
    expect(screen.queryByText(/Showing only/)).toBeNull();
    expect(tree().getByRole("link", { name: "Open Fin-1 in Caliper" }).getAttribute("href")).toBe(
        caliperUrl(fin.id, 2, "Default"),
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
    // A part with a model; SparkFun's spline, in a configuration its file hasn't (it has Default only); a part whose
    // file has nothing to read; a sub-assembly with nothing in it; and a part that isn't in the vault.
    const [fin, spline, bolt, tail] = await team.checkin(team.chief, {
        "Fins/Fin.SLDPRT": "fin",
        "Servo/Embout.SLDPRT": await servo("Embout.SLDPRT"),
        "Fins/Bolt.SLDPRT": "bolt",
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
            component("Bolt-1", bolt!),
            component("Tail-1", tail!),
            component("Washer-1", null, { path: "C:\\Users\\alice\\Desktop\\Washer.SLDPRT" }),
        ],
    });

    renderApp(team.chief, caliperUrl(assembly!.id));
    expect(await screen.findByText("3 components aren't shown:")).toBeTruthy();
    expect(screen.getByText("1 part's file isn't in the vault.")).toBeTruthy();
    expect(screen.getByText("1 part's file has no 3D view Caliper can read.")).toBeTruthy();
    expect(screen.getByText("1 sub-assembly has no components.")).toBeTruthy();
    // The spline shows, as it was saved, in place of the configuration the rocket uses, which its file hasn't.
    expect(screen.getByText("Shown, but not as the assembly has them:")).toBeTruthy();
    expect(
        screen.getByText(
            "1 part shows another configuration than the assembly uses: its file has no 3D view of that one.",
        ),
    ).toBeTruthy();
    expect(screen.getByText(/open the assembly in SolidWorks and click Make 3D view on the Vault tab/)).toBeTruthy();
    const row = (name: string) =>
        tree()
            .getByRole("checkbox", { name: `Show ${name}` })
            .closest("li")!;
    expect(within(row("Embout-1")).getByText("Shows Default").getAttribute("title")).toBe(
        "This is its Default configuration: its file has no 3D view of Long, the one the assembly uses. " +
            `${team.path("Servo/Embout.SLDPRT")} v1: It has no configuration named Long`,
    );
    expect(within(row("Embout-1")).getByText("file").parentElement!.getAttribute("title")).toBe(
        "v1. Read from its file: the 3D view SolidWorks saved in it",
    );
    expect(within(row("Tail-1")).getByText("No components")).toBeTruthy();
    // One whose file isn't in the vault is listed all the same, by its file's name.
    expect(within(row("Washer-1")).getByText("Not in the vault").getAttribute("title")).toMatch(
        /^Washer\.SLDPRT isn't in the vault, so there's no shape of it to show/,
    );
    expect(within(row("Bolt-1")).getByText("No 3D view")).toBeTruthy();
    expect(within(row("Fin-1")).queryByText(/No 3D view|Shows|Not in the vault/)).toBeNull();
    const about = within(screen.getByRole("status", { name: "What this view shows" }));
    expect(
        about.getByText(/2 of 4 parts are shown, each as it is now; 1 shows something else in place of/),
    ).toBeTruthy();
    expect(about.getByText(/1 from SolidWorks, 1 read from its file\./)).toBeTruthy();
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

test("a version with no model says why, and the latest is never swapped for an older one unasked", async () => {
    const team = await Team.create();
    const [fin] = await team.checkin(team.chief, { "Fin.SLDPRT": "fin v1" });
    await team.model(team.chief, fin!, { mesh: tetrahedra("Fin") });
    await team.checkout(team.chief, "Fin.SLDPRT", "CHIEF-PC");
    await team.checkin(team.chief, { "Fin.SLDPRT": "fin v2" }, { host: "CHIEF-PC", comment: "from the web" });

    // v2's model would be read from the file, which isn't a real SolidWorks part. With no version asked for, the
    // page is v2's all the same: it says why there's nothing to see, and where there is, rather than show v1 as if it
    // were what's in the vault now.
    const finPage = renderApp(team.chief, caliperUrl(fin!.id));
    expect(await screen.findByText("v2 of Fin.SLDPRT has no 3D model.")).toBeTruthy();
    expect(screen.getByText(/v2: It isn't a SolidWorks part that Caliper can read/)).toBeTruthy();
    expect(screen.getByText(/Vault for SolidWorks makes models too/)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Show Fin" })).toBeNull();
    const version = screen.getByRole("combobox", { name: "Version" }) as HTMLSelectElement;
    expect(version.value).toBe("2");
    expect([...version.options].map((option) => option.textContent)).toEqual(["v2 (no 3D model)", "v1"]);

    // v1, asked for, shows, and says it isn't the latest.
    await userEvent.click(screen.getByRole("link", { name: "v1" }));
    expect(await screen.findByRole("checkbox", { name: "Show Fin" })).toBeTruthy();
    const about = within(screen.getByRole("status", { name: "What this view shows" }));
    expect(about.getByText("Version 1 of 2: not the latest.")).toBeTruthy();
    expect(about.getByRole("link", { name: "Show version 2" }).getAttribute("href")).toBe(caliperUrl(fin!.id));

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
    part.unmount();

    renderApp(team.chief, caliperUrl(assembly!.id));
    expect(await screen.findByRole("checkbox", { name: "Show Servomoteur-1" })).toBeTruthy();
    expect(tree().getByRole("link", { name: "Open Embout-1 in Caliper" }).getAttribute("href")).toBe(
        caliperUrl(spline!.id, 1, "Default"),
    );
    expect(screen.queryByText(/no 3D model/)).toBeNull();
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

    // Spline is read from the solid SolidWorks kept of it: the spline's two bodies, here.
    await userEvent.selectOptions(choice(), "Spline");
    expect(await screen.findByRole("checkbox", { name: "Show Body 2" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Show Body 1" })).toBeTruthy();
    expect(choice().value).toBe("Spline");

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
    // Every part shows: the case in Old, which its file kept nothing of, as it was saved, and it says so.
    expect(
        await screen.findByText(
            "1 part shows another configuration than the assembly uses: its file has no 3D view of that one.",
        ),
    ).toBeTruthy();
    expect(screen.queryByText(/isn't shown|aren't shown/)).toBeNull();
    const row = (name: string) =>
        tree()
            .getByRole("checkbox", { name: `Show ${name}` })
            .closest("li")!;
    expect(within(row("Case-1")).queryByText(/No 3D view|Shows/)).toBeNull();
    // The Spline configuration is the solid its file kept, which the server made triangles of: close, not exact.
    expect(within(row("Case-1")).getByText("rebuilt").parentElement!.getAttribute("title")).toMatch(
        /^v1\. Rebuilt from the solid in its file/,
    );
    expect(within(row("Case-2")).getByText("Shows Default").getAttribute("title")).toMatch(
        /^This is its Default configuration: its file has no 3D view of Old, the one the assembly uses\. .*marked its Old configuration as needing a rebuild/,
    );
    const about = within(screen.getByRole("status", { name: "What this view shows" }));
    expect(
        about.getByText(/All 3 parts are shown, each as it is now; 1 shows something else in place of/),
    ).toBeTruthy();
    expect(about.getByText(/1 from SolidWorks, 1 read from its file, 1 rebuilt from its solid\./)).toBeTruthy();
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

test("an assembly shows each part as it is now, and as it was checked in when an older version is asked for", async () => {
    const team = await Team.create();
    const { fin, rocket: assembly } = await rocket(team);
    await team.checkout(team.chief, "Fins/Fin.SLDPRT", "CHIEF-PC");
    const [fin2] = await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin v2" }, { host: "CHIEF-PC" });
    await team.model(team.chief, fin2!, { mesh: tetrahedra("Fin", "Doubler") });
    await team.checkout(team.chief, "Rocket/Rocket.SLDASM", "CHIEF-PC");
    const [rocket2] = await team.checkin(team.chief, { "Rocket/Rocket.SLDASM": "rocket v2" }, { host: "CHIEF-PC" });
    await team.model(team.chief, rocket2!, { components: [component("Fin-1", fin)] }); // checked in with the fin's v1

    // The latest rocket shows the latest fin, though it was checked in with the one before.
    const page = renderApp(team.chief, caliperUrl(assembly.id));
    const row = async () => within((await screen.findByRole("checkbox", { name: "Show Fin-1" })).closest("li")!);
    expect((await row()).getByText("SW").parentElement!.textContent).toBe("v2 · SW");
    expect((await row()).queryByText(/Shows/)).toBeNull();
    expect(tree().getByRole("link", { name: "Open Fin-1 in Caliper" }).getAttribute("href")).toBe(
        caliperUrl(fin.id, 2, "Default"),
    );
    const about = within(screen.getByRole("status", { name: "What this view shows" }));
    expect(about.getByText("Version 2, the latest.")).toBeTruthy();
    expect(
        about.getByText(
            /Its layout is from SolidWorks: chief made it there on .* Its part is shown, each as it is now\. It's from SolidWorks\./,
        ),
    ).toBeTruthy();
    expect(screen.getByText(/1 component was checked in after this assembly was: it shows as it is now/)).toBeTruthy();
    page.unmount();

    // An older version of the rocket, asked for, is as it was checked in: each part at the version it had then.
    renderApp(team.chief, caliperUrl(assembly.id, 1));
    expect((await row()).getByText("SW").parentElement!.textContent).toBe("v1 (now v2) · SW");
    const then = within(screen.getByRole("status", { name: "What this view shows" }));
    expect(then.getByText("Version 1 of 2: not the latest.")).toBeTruthy();
    expect(then.getByText(/each as it was then/)).toBeTruthy();
});

test("a sub-assembly checked in since its assembly shows its own components", async () => {
    // SparkFun's servo as a sub-assembly of the rocket: checked in first as a stand-in, with a model of the spline
    // alone, then as the real file, which nothing has made a model of. The rocket's model has the servo as it was.
    // (Its parts are found by its references: in a folder named as SolidWorks saved them, another test's would be
    // taken for them too.)
    const team = await Team.create();
    const [spline] = await team.checkin(team.chief, {
        "Servo/Embout.SLDPRT": await servo("Embout.SLDPRT"),
        "Servo/Servomoteur.SLDPRT": await servo("Servomoteur.SLDPRT"),
    });
    const [sub] = await team.checkin(team.chief, { "Servo/9347.SLDASM": "servo, to come" });
    const [assembly] = await team.checkin(team.chief, { "Rocket/Rocket.SLDASM": "rocket" });
    await team.model(team.chief, sub!, { components: [component("Embout-1", spline!)] });
    await team.model(team.chief, assembly!, {
        components: [component("Servo-1", sub!, { children: [component("Embout-1", spline!)] })],
    });
    await team.checkout(team.chief, "Servo/9347.SLDASM", "CHIEF-PC");
    await team.checkin(
        team.chief,
        { "Servo/9347.SLDASM": viewless(await servo("9347.SLDASM")) },
        { host: "CHIEF-PC", refs: { "Servo/9347.SLDASM": ["Servo/Embout.SLDPRT", "Servo/Servomoteur.SLDPRT"] } },
    );

    // The rocket, not checked in since, shows the servo as it is now: Caliper has its new version's model made from
    // its file, and then both its parts are there. (Its one component at the top is open from the start.)
    renderApp(team.chief, caliperUrl(assembly!.id));
    expect(await screen.findByRole("checkbox", { name: "Show Servomoteur-1" }, { timeout: 15000 })).toBeTruthy();
    expect(tree().getByRole("checkbox", { name: "Show Embout-1" })).toBeTruthy();
    const servoRow = within(tree().getByRole("checkbox", { name: "Show Servo-1" }).closest("li")!);
    expect(servoRow.getByText("v2")).toBeTruthy();
    expect(servoRow.queryByText(/layout/)).toBeNull();
    const about = within(screen.getByRole("status", { name: "What this view shows" }));
    expect(about.getByText(/All 2 parts are shown, each as it is now\. 2 read from their files\./)).toBeTruthy();
    expect((await team.caliperModels(sub!.id)).map((model) => model.version)).toEqual([2, 1]);
});

test("a sub-assembly whose latest version has no 3D view keeps the layout its assembly was checked in with", async () => {
    const team = await Team.create();
    const { rocket: assembly } = await rocket(team);
    await team.checkout(team.chief, "Motor/Motor.SLDASM", "CHIEF-PC");
    await team.checkin(team.chief, { "Motor/Motor.SLDASM": "motor v2" }, { host: "CHIEF-PC" }); // nothing to read

    renderApp(team.chief, caliperUrl(assembly.id));
    const motorRow = within((await screen.findByRole("checkbox", { name: "Show Motor-1" })).closest("li")!);
    expect(motorRow.getByText("v1's layout").getAttribute("title")).toMatch(
        /^These are the components it had at v1, when the assembly was checked in: v2, its latest, has no 3D view/,
    );
    expect(
        screen.getByText(
            "1 sub-assembly shows the components it had when this assembly was checked in: its latest has no 3D view yet.",
        ),
    ).toBeTruthy();
});

test("a view says which version it is and where it's from", async () => {
    const team = await Team.create();
    const [fin, caseFile, bare] = await team.checkin(team.chief, {
        "Fin.SLDPRT": "fin",
        "Servomoteur.SLDPRT": await servo("Servomoteur.SLDPRT"),
        "Bare/Embout.SLDPRT": viewless(await servo("Embout.SLDPRT")),
    });
    await team.model(team.chief, fin!, { mesh: tetrahedra("Fin") });
    const about = async () => within(await screen.findByRole("status", { name: "What this view shows" }));

    // One Vault for SolidWorks made: from SolidWorks, by whom and when.
    let page = renderApp(team.chief, caliperUrl(fin!.id));
    expect((await about()).getByText("Version 1, the latest.")).toBeTruthy();
    expect((await about()).getByText(/From SolidWorks: chief made this view there on /)).toBeTruthy();
    expect(screen.getByRole("status", { name: "What this view shows" }).className).toContain("caliper-about-ok");
    page.unmount();

    // One the server read from the 3D view SolidWorks saved in the file.
    page = renderApp(team.chief, caliperUrl(caseFile!.id));
    expect((await about()).getByText(/Read from the file: the 3D view SolidWorks saved in it\./)).toBeTruthy();
    expect(screen.getByRole("status", { name: "What this view shows" }).className).toContain("caliper-about-ok");
    page.unmount();

    // One whose file has no 3D view: rebuilt from its solid, which is close, and says it isn't exact.
    renderApp(team.chief, caliperUrl(bare!.id));
    expect(
        (await about()).getByText(
            /Rebuilt from the solid in the file.*Checking it in from SolidWorks gives its exact view\./,
        ),
    ).toBeTruthy();
    expect(screen.getByRole("status", { name: "What this view shows" }).className).toContain("caliper-about-note");
});

test("a version checked in while Caliper is open is offered at once", async () => {
    const team = await Team.create();
    const [fin] = await team.checkin(team.chief, { "Fin.SLDPRT": "fin" });
    await team.model(team.chief, fin!, { mesh: tetrahedra("Fin") });
    const { rocket: assembly } = await rocket(team);

    const page = renderApp(team.chief, caliperUrl(fin!.id));
    expect(await screen.findByRole("checkbox", { name: "Show Fin" })).toBeTruthy();
    await team.checkout(team.chief, "Fin.SLDPRT", "CHIEF-PC");
    const [fin2] = await team.checkin(team.chief, { "Fin.SLDPRT": "fin v2" }, { host: "CHIEF-PC" });
    await team.model(team.chief, fin2!, { mesh: tetrahedra("Fin", "Doubler") });
    expect(await screen.findByText(/Version 2 of Fin\.SLDPRT was checked in while this page was open\./)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Show Doubler" })).toBeNull(); // still v1, until asked
    await userEvent.click(screen.getByRole("button", { name: "Show version 2" }));
    expect(await screen.findByRole("checkbox", { name: "Show Doubler" })).toBeTruthy();
    expect(screen.queryByText(/was checked in while this page was open/)).toBeNull();
    page.unmount();

    // An assembly says when one of its parts was.
    renderApp(team.chief, caliperUrl(assembly.id));
    const row = async () => within((await screen.findByRole("checkbox", { name: "Show Fin-1" })).closest("li")!);
    expect((await row()).getByText("SW").parentElement!.textContent).toBe("v1 · SW");
    await team.checkout(team.chief, "Fins/Fin.SLDPRT", "CHIEF-PC");
    const [finB] = await team.checkin(team.chief, { "Fins/Fin.SLDPRT": "fin v2" }, { host: "CHIEF-PC" });
    await team.model(team.chief, finB!, { mesh: tetrahedra("Fin", "Doubler") });
    expect(await screen.findByText(/A part of this assembly was checked in while this page was open\./)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show it as it is now" }));
    await waitFor(async () => expect((await row()).getByText("SW").parentElement!.textContent).toBe("v2 · SW"));
    expect(screen.queryByText(/was checked in while this page was open/)).toBeNull();
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
