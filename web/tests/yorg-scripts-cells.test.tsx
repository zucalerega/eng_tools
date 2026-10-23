import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { codeOf, joinCells, newCell, parseCells } from "../src/yorg/scripts/cells";
import { Markdown } from "../src/markdown";

// A notebook's cells, as a script keeps them ("# %%" marks, as VS Code, Spyder, and Jupytext write them), and a text
// cell's Markdown, shown.

const shape = (code: string) => parseCells(code).map(({ kind, title, source }) => ({ kind, title, source }));

describe("cells in a script", () => {
    test("a script without marks is one cell, and stays as it was", () => {
        expect(shape("import numpy as np\nprint(np.pi)\n")).toEqual([
            { kind: "code", title: "", source: "import numpy as np\nprint(np.pi)" },
        ]);
        expect(joinCells(parseCells("import numpy as np\nprint(np.pi)\n"))).toBe("import numpy as np\nprint(np.pi)\n");
        expect(joinCells(parseCells(""))).toBe("");
    });

    test("each mark starts a cell: titled, code or text, and code before the first is a cell too", () => {
        const code = [
            "import numpy as np",
            "",
            "# %% Load the data",
            'pt = yorg.channel("PT-TANK")',
            "",
            "",
            "# %% [markdown]",
            "# # The peak",
            "#",
            "# Where it's **highest**.",
            "",
            "# %% Notes [md]",
            "# more",
            "# %%",
            "print(pt.values.max())",
        ].join("\n");
        expect(shape(code)).toEqual([
            { kind: "code", title: "", source: "import numpy as np" },
            { kind: "code", title: "Load the data", source: 'pt = yorg.channel("PT-TANK")' },
            { kind: "markdown", title: "", source: "# The peak\n\nWhere it's **highest**." },
            { kind: "markdown", title: "Notes", source: "more" },
            { kind: "code", title: "", source: "print(pt.values.max())" },
        ]);
    });

    test("cells written as a script read back the same", () => {
        const cells = [
            newCell("code", 'pt = yorg.channel("PT-TANK")', "Load the data"),
            newCell("markdown", "# The peak\n\nWhere it's **highest**."),
            newCell("code", ""),
            newCell("code", "print(pt.values.max())"),
        ];
        const code = joinCells(cells);
        expect(code).toBe(
            [
                "# %% Load the data",
                'pt = yorg.channel("PT-TANK")',
                "",
                "# %% [markdown]",
                "# # The peak",
                "#",
                "# Where it's **highest**.",
                "",
                "# %%",
                "",
                "# %%",
                "print(pt.values.max())",
                "",
            ].join("\n"),
        );
        expect(shape(code)).toEqual(cells.map(({ kind, title, source }) => ({ kind, title, source })));
    });

    test("what a notebook runs is its code cells' code", () => {
        expect(
            codeOf([newCell("code", "import scipy"), newCell("markdown", "import pandas"), newCell("code", "x")]),
        ).toBe("import scipy\nx");
    });
});

describe("a text cell's Markdown", () => {
    test("shows headings, emphasis, code, lists, quotes, and rules", () => {
        render(
            <Markdown
                source={[
                    "# Tank",
                    "Its **pressure** in *psig*, from `PT-TANK`.",
                    "",
                    "- one",
                    "- two",
                    "",
                    "1. first",
                    "",
                    "> a quote",
                    "",
                    "---",
                    "```",
                    "x = 1",
                    "```",
                ].join("\n")}
            />,
        );
        expect(screen.getByRole("heading", { name: "Tank" }).tagName).toBe("H2");
        expect(screen.getByText("pressure").tagName).toBe("STRONG");
        expect(screen.getByText("psig").tagName).toBe("EM");
        expect(screen.getByText("PT-TANK").tagName).toBe("CODE");
        expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["one", "two", "first"]);
        expect(screen.getByText("a quote").closest("blockquote")).toBeTruthy();
        expect(screen.getByRole("separator")).toBeTruthy();
        expect(screen.getByText("x = 1").tagName).toBe("CODE");
    });

    test("links go to the web, mail, or the site's own pages; anything else is only text", () => {
        render(
            <Markdown source="[docs](https://example.com) [home](/yorg) [bad](javascript:alert(1)) [data](data:text/html,x)" />,
        );
        expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("https://example.com");
        expect(screen.getByRole("link", { name: "home" }).getAttribute("href")).toBe("/yorg");
        expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
        expect(screen.queryByRole("link", { name: "data" })).toBeNull();
        expect(screen.getByText("bad")).toBeTruthy();
    });
});
