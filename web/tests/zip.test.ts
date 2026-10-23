import { expect, test } from "vitest";
import { readZip } from "../src/zip";
import { makeZip } from "./zips";

// Reading zips in the browser (no server needed).

const blob = (bytes: Uint8Array<ArrayBuffer>) => new Blob([bytes]);
const text = async (read: () => Promise<Uint8Array>) => new TextDecoder().decode(await read());

test("a zip's files, stored or deflated, in their folders, without the zip's own notes", async () => {
    const zip = makeZip([
        { name: "Rocket/", contents: "" },
        { name: "Rocket/Nose.SLDPRT", contents: "nose ".repeat(100), deflate: true },
        { name: "Rocket\\Body\\Tube.SLDPRT", contents: "tube" }, // backslashes, as some Windows tools write them
        { name: "__MACOSX/Rocket/._Nose.SLDPRT", contents: "what a Mac knows about it" },
        { name: new Uint8Array([0x44, 0x81, 0x73, 0x65, 0x2e, 0x53, 0x54, 0x45, 0x50]), contents: "düse" }, // CP437
    ]);
    const { entries, skipped } = await readZip(blob(zip), "Rocket.zip");
    expect(entries.map((entry) => [entry.path, entry.size])).toEqual([
        ["Rocket/Nose.SLDPRT", 500],
        ["Rocket/Body/Tube.SLDPRT", 4],
        ["Düse.STEP", 5],
    ]);
    expect(await text(entries[0]!.read)).toBe("nose ".repeat(100));
    expect(await text(entries[1]!.read)).toBe("tube");
    expect(skipped).toEqual([]);
});

test("files it can't open are left out, saying why, and damage shows when a file is read", async () => {
    const zip = makeZip([
        { name: "Secret.SLDPRT", contents: "x", flags: 1 },
        { name: "Old.SLDPRT", contents: "x", method: 14 }, // LZMA
        { name: "../Outside.SLDPRT", contents: "x" },
        { name: "Good.SLDPRT", contents: "good contents" },
    ]);
    const at = Buffer.from(zip).indexOf("good contents");
    zip[at] = zip[at]! ^ 0xff;
    const { entries, skipped } = await readZip(blob(zip), "Parts.zip");
    expect(skipped.map(({ path }) => path)).toEqual(["Secret.SLDPRT", "Old.SLDPRT", "../Outside.SLDPRT"]);
    expect(skipped[0]!.reason).toContain("encrypted");
    expect(skipped[1]!.reason).toContain("method 14");
    await expect(entries[0]!.read()).rejects.toThrow("Good.SLDPRT is damaged in Parts.zip");
    await expect(readZip(blob(new TextEncoder().encode("not a zip")), "Notes.zip")).rejects.toThrow(
        "Notes.zip isn't a zip file",
    );
});

test("big zips (zip64) too", async () => {
    const zip = makeZip([{ name: "Rocket.SLDASM", contents: "a big assembly", deflate: true }], { zip64: true });
    const { entries } = await readZip(blob(zip), "Big.zip");
    expect(entries.map((entry) => entry.path)).toEqual(["Rocket.SLDASM"]);
    expect(await text(entries[0]!.read)).toBe("a big assembly");
});
