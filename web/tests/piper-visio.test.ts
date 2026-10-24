import { expect, test } from "vitest";
import { isPortEnd } from "../src/piper/drawing";
import { readVisio, tagIn, VisioError } from "../src/piper/visio";
import { FEED, GLUE, vsdx } from "./visio";
import { makeZip } from "./zips";

// Visio drawings into Piper's: a .vsdx made here as Visio makes them (a zip of XML: pages, masters, and which connector
// is glued to which shape), read as an upload is.

test("a Visio page's shapes become Piper's parts, by their masters' names, tagged with their text", async () => {
    const pages = await readVisio(new Blob([vsdx(FEED, GLUE)]), "Feed system.vsdx");
    expect(pages.map((page) => page.name)).toEqual(["Feed system"]); // its background page left out
    const { drawing, report } = pages[0]!;
    const byKind = (kind: string) => drawing.parts.filter((part) => part.kind === kind);
    const tank = byKind("tank")[0]!;
    expect([tank.x, tank.y, tank.props.fluid]).toEqual([200, 350, "lox"]); // a hundred units to the inch; its text, its fluid
    const valve = byKind("valve")[0]!;
    expect([valve.tag, valve.props.body, valve.rotation, valve.x, valve.y]).toEqual(["V-1", "gate", 270, 200, 550]);
    const sensor = byKind("instrument")[0]!;
    expect([sensor.tag, sensor.props.type]).toEqual(["PT-101", "pressure"]);
    expect(byKind("text").map((part) => part.text)).toEqual(["LOX feed"]);
    expect(byKind("block").map((part) => part.text)).toEqual(["DAQ"]);
    expect(report).toMatchObject({ page: "Feed", parts: 3, notes: 1, boxes: ["Sheet"], dropped: 0 });
});

test("connectors become lines between the ports nearest where they were glued, carrying what they say", async () => {
    const { drawing, report } = (await readVisio(new Blob([vsdx(FEED, GLUE)]), "Feed system.vsdx"))[0]!;
    expect(report.lines).toBe(4);
    const tank = drawing.parts.find((part) => part.kind === "tank")!;
    const valve = drawing.parts.find((part) => part.kind === "valve")!;
    const sensor = drawing.parts.find((part) => part.kind === "instrument")!;
    const box = drawing.parts.find((part) => part.kind === "block")!;
    const between = (a: string, b: string) =>
        drawing.lines.find(
            (line) =>
                isPortEnd(line.from) &&
                isPortEnd(line.to) &&
                [line.from.part, line.to.part].sort().join() === [a, b].sort().join(),
        );
    const feed = between(tank.id, valve.id)!;
    expect(feed.from).toEqual({ part: tank.id, port: "bottom" });
    expect(feed.fluid).toBe("lox"); // what the tank it's drawn from holds, before its color
    expect(between(tank.id, sensor.id)!.fluid).toBe("gn2"); // what its text says
    const signal = drawing.lines.find((line) => line.kind === "pneumatic")!;
    expect(signal.from).toEqual({ part: sensor.id, port: "bottom" });
    expect(isPortEnd(signal.to)).toBe(false); // glued to nothing: it ends where it ended
    // A line colored red, with nothing else to say what it carries: a fluid of the diagram's own, named for its color.
    const red = drawing.lines.find((line) => isPortEnd(line.from) && line.from.part === box.id)!;
    expect(drawing.fluids.find((fluid) => fluid.id === red.fluid)).toMatchObject({
        name: "Red lines",
        color: "#ff0000",
    });
});

test("tags are read as P&IDs write them", () => {
    expect(tagIn("PT 101")).toBe("PT-101");
    expect(tagIn("pt\n101")).toBe("PT-101");
    expect(tagIn("V-12A")).toBe("V-12A");
    expect(tagIn("MOV-OX")).toBe("MOV-OX");
    expect(tagIn("LOX")).toBeNull();
    expect(tagIn("Main oxidizer valve")).toBeNull();
});

test("a drawing Piper can't read says what to do instead", async () => {
    const old = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(readVisio(new Blob([old]), "Stand.vsd")).rejects.toThrow(/save it as a \.vsdx/);
    await expect(readVisio(new Blob(["not a drawing at all"]), "notes.vsdx")).rejects.toBeInstanceOf(VisioError);
    await expect(readVisio(new Blob([makeZip([{ name: "a.txt", contents: "hi" }])]), "a.vsdx")).rejects.toThrow(
        /no pages/,
    );
});
