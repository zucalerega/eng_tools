import { expect, test } from "vitest";
import { documentOf, emptyDrawing, linkName, linkUrl, newPart, readDocument, readDrawing } from "../src/piper/drawing";
import { readClip } from "../src/piper/edit";

// Links on parts, to pages about them (a valve's Notion page, its spec sheet): only http, https, and mailto, so that
// opening one from a part can never run anything in the site. The server checks the same (test_piper.py).

test("a part's link is http, https, or mailto: nothing that would run in the site", () => {
    for (const url of [
        "https://www.notion.so/yjsp/FMV-1234",
        "http://example.com/valve.pdf",
        "HTTPS://EXAMPLE.COM",
        "mailto:prop@example.test",
    ]) {
        expect(linkUrl(url), url).toBe(url);
    }
    expect(linkUrl("  https://example.com  ")).toBe("https://example.com"); // as it's typed, trimmed
    for (const url of [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "file:///C:/secret.txt",
        "https:nohost", // a browser reads it as a host, as the server doesn't
        "https:///path",
        "https:\\evil.example",
        "https://",
        "mailto:",
        "notion.so/page",
        "https://exa mple.com",
        "https://example.com/\u0000",
        "",
        "   ",
    ]) {
        expect(linkUrl(url), url).toBeNull();
    }
    // A link without a name is called by where it goes.
    expect(linkName("https://www.notion.so/yjsp/FMV-1234")).toBe("notion.so/yjsp/FMV-1234");
    expect(linkName("https://example.com/")).toBe("example.com");
    expect(linkName("mailto:prop@example.test")).toBe("prop@example.test");
});

test("a drawing read back keeps its parts' links, and leaves out any that aren't one, so it's never opened", () => {
    const part = {
        ...newPart("valve", { x: 0, y: 0 }),
        links: [
            { label: "Notion", url: "https://www.notion.so/yjsp/FMV-1234" },
            { label: "Run me", url: "javascript:alert(1)" },
            { url: "mailto:prop@example.test" },
            "https://not-an-object.test",
        ],
    };
    const read = readDrawing({ ...emptyDrawing(), parts: [part] });
    expect(read.parts[0]!.links).toEqual([
        { label: "Notion", url: "https://www.notion.so/yjsp/FMV-1234" },
        { label: "", url: "mailto:prop@example.test" },
    ]);
    // A part with none has none, left out of what's saved.
    expect("links" in readDrawing({ ...emptyDrawing(), parts: [newPart("valve", { x: 0, y: 0 })] }).parts[0]!).toBe(
        false,
    );
    // Saved as format 4, which a tab from before links can't save over: the server refuses it (drawing_newer).
    expect(documentOf(read).format).toBe(4);
    expect(readDocument({ format: 3, pages: [{ id: "a", parts: [part], lines: [] }] }).format).toBe(4);
});

test("a part pasted from the clipboard brings only its links that are links, as anything can be on a clipboard", () => {
    const valve = newPart("valve", { x: 0, y: 0 });
    const clip = (links: unknown[]) => JSON.stringify({ piper: 1, parts: [{ ...valve, links }], lines: [] });
    const pasted = readClip(
        clip([
            { label: "Run me", url: "javascript:alert(1)" },
            { label: "Notion", url: "https://notion.so/x" },
        ]),
    );
    expect(pasted!.parts[0]!.links).toEqual([{ label: "Notion", url: "https://notion.so/x" }]);
    expect("links" in readClip(clip([{ url: "data:text/html,hi" }]))!.parts[0]!).toBe(false);
});
