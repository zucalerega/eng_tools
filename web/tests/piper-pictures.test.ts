import { expect, test } from "vitest";
import { imageHref } from "../src/piper/api";
import { emptyDrawing, type Drawing } from "../src/piper/drawing";
import { addPart, updatePart, withPicture } from "../src/piper/edit";
import { svgOf } from "../src/piper/exports";
import { presetOf } from "../src/piper/library/index";
import { pdfOf } from "../src/piper/pdf";
import { bytesOf, dataUri, decodePng, pdfPicture } from "../src/piper/pictures";
import { jpegHeader, rgbaPng } from "./pngs";

// Pictures on a drawing (an injector, a TCA): sized to their shape, and in the exports, an SVG's and a PNG's in them
// as data, a PDF's as its own images (a PNG's pixels and transparency, a JPEG as it is).

const META = { name: "Engine", revision: "1", savedAt: "2026-10-25T12:00:00Z", by: "Chief" };
const RED = [255, 0, 0, 255];
const SEE_THROUGH = [0, 0, 255, 0];

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    const reader = input.pipeThrough(new DecompressionStream("deflate")).getReader();
    let text = "";
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
        text += latin1(read.value);
    }
    return text;
}

/** A drawing with a picture on it, showing a picture of this name. */
function withPictureOf(sha: string, width: number, height: number): { drawing: Drawing; id: string } {
    const added = addPart(emptyDrawing(), presetOf("picture")!, { x: 0, y: 0 });
    return {
        drawing: updatePart(added.drawing, added.id, (part) => withPicture(part, { sha256: sha, width, height })),
        id: added.id,
    };
}

test("a PNG's pixels are read as its rows were filtered, its transparency apart", async () => {
    // Five rows, so each of PNG's filters is used once.
    const rows = Array.from({ length: 5 }, (_, y) =>
        Array.from({ length: 3 }, (_, x) => (x === 1 && y === 2 ? SEE_THROUGH : [x * 100, y * 50, 7, 255])),
    );
    const decoded = (await decodePng(await rgbaPng(rows)))!;
    expect([decoded.width, decoded.height, decoded.gray]).toEqual([3, 5, false]);
    expect(Array.from(decoded.color.subarray(0, 9))).toEqual([0, 0, 7, 100, 0, 7, 200, 0, 7]);
    const middle = (2 * 3 + 1) * 3;
    expect(Array.from(decoded.color.subarray(middle, middle + 3))).toEqual([0, 0, 255]);
    expect(decoded.alpha![2 * 3 + 1]).toBe(0);
    expect(decoded.alpha![0]).toBe(255);
    // One that's opaque everywhere has no transparency to write.
    expect((await decodePng(await rgbaPng([[RED, RED]])))!.alpha).toBeNull();
});

test("a picture is as wide as its pixels (up to 240), as tall as its shape, and keeps its width replaced", () => {
    const { drawing, id } = withPictureOf("a".repeat(64), 640, 480);
    const part = drawing.parts.find((entry) => entry.id === id)!;
    expect([part.w, part.h, part.props.imageWidth, part.props.imageHeight]).toEqual([240, 180, "640", "480"]);
    const tall = withPicture(part, { sha256: "b".repeat(64), width: 100, height: 200 });
    expect([tall.w, tall.h, tall.props.image]).toEqual([240, 480, "b".repeat(64)]);
});

test("an SVG of a drawing has its pictures in it, as data", async () => {
    const png = await rgbaPng([[RED, RED]]);
    const { drawing } = withPictureOf("c".repeat(64), 2, 1);
    const { svg } = await svgOf(drawing, META, async () => png.buffer);
    expect(svg).not.toContain(imageHref("c".repeat(64)));
    const href = /<image[^>]* href="([^"]+)"/.exec(svg)![1]!;
    expect(href.startsWith("data:image/png;base64,")).toBe(true);
    expect(Array.from(bytesOf(href)!)).toEqual(Array.from(png));
    expect(dataUri(jpegHeader(4, 4)).startsWith("data:image/jpeg;base64,")).toBe(true);
    // One the server hasn't got stays a link.
    const missing = await svgOf(drawing, META, () => Promise.reject(new Error("404")));
    expect(missing.svg).toContain(imageHref("c".repeat(64)));
});

test("a PDF draws a PNG as an image with its transparency as a soft mask, and a JPEG as it is", async () => {
    const png = await rgbaPng([
        [RED, SEE_THROUGH],
        [RED, RED],
    ]);
    const pictured = withPictureOf("d".repeat(64), 2, 2);
    const both = addPart(pictured.drawing, presetOf("picture")!, { x: 400, y: 0 });
    const drawing = updatePart(both.drawing, both.id, (part) =>
        withPicture(part, { sha256: "e".repeat(64), width: 8, height: 4 }),
    );
    const sources: Record<string, Uint8Array<ArrayBuffer>> = {
        ["d".repeat(64)]: png,
        ["e".repeat(64)]: jpegHeader(8, 4),
    };
    const text = latin1(
        new Uint8Array(
            await (await pdfOf(drawing, META, "letter", null, async (sha) => sources[sha]!.buffer)).arrayBuffer(),
        ),
    );
    expect(text).toMatch(/\/XObject << \/Im1 \d+ 0 R \/Im2 \d+ 0 R >>/);
    expect(text).toMatch(
        /\/Width 2 \/Height 2 \/BitsPerComponent 8 \/ColorSpace \/DeviceRGB \/Filter \/FlateDecode \/SMask \d+ 0 R/,
    );
    expect(text).toMatch(/\/Width 2 \/Height 2 \/BitsPerComponent 8 \/ColorSpace \/DeviceGray \/Filter \/FlateDecode/);
    expect(text).toMatch(/\/Width 8 \/Height 4 \/BitsPerComponent 8 \/ColorSpace \/DeviceRGB \/Filter \/DCTDecode/);
    expect(text).toContain(latin1(jpegHeader(8, 4))); // the JPEG's own bytes
    // Each drawn on the page: its part's box, in its own shape (as the SVG's meet draws it).
    const start = text.indexOf("/Filter /FlateDecode >>\nstream\n") + "/Filter /FlateDecode >>\nstream\n".length;
    const content = await inflate(
        Uint8Array.from(text.slice(start, text.indexOf("\nendstream", start)), (c) => c.charCodeAt(0)),
    );
    expect(content).toMatch(/ 0 0 -\d+(\.\d+)? [-\d.]+ [-\d.]+ cm\n\/Im1 Do/);
    expect(content).toContain("/Im2 Do");
    const jpeg = await pdfPicture(jpegHeader(8, 4));
    expect([jpeg.width, jpeg.height, jpeg.alpha]).toEqual([8, 4, null]);
});
