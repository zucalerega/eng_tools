// A notebook: a script in cells, each run on its own in the notebook's variables, so a cell that loads the data runs
// once and those after it again and again. It's kept as the script's code, with a "# %%" line starting each cell (as
// VS Code, Spyder, and Jupytext write them), so a notebook downloads as a .py that runs as it is, and opens as cells in
// those; a script without the marks is a notebook of one cell, and stays as it was.
//
//     # %% Load the data
//     pt = yorg.channel("PT-TANK")
//
//     # %% [markdown]
//     # The tank's pressure, **in psig**.
//
//     # %%
//     yorg.plot(pt)

export interface Cell {
    id: string; // for as long as it's open (not kept)
    kind: "code" | "markdown";
    title: string; // after the mark: "Load the data"
    source: string; // a markdown cell's text without the "# " each line has in the code
}

let made = 0;
const page = Date.now().toString(36); // this page's: cells kept from before a reload have another

/** A new cell's id: unique while the tab's open, reloads and all. */
export function cellId(): string {
    made += 1;
    return `cell-${page}-${made}`;
}

/** A new cell. */
export const newCell = (kind: Cell["kind"] = "code", source = "", title = ""): Cell => ({
    id: cellId(),
    kind,
    title,
    source,
});

const MARK = /^# %%(.*)$/;
const MARKDOWN = /\[(markdown|md)\]/i;

/** A cell's lines without the blank lines at its end (which are the space before the next). */
function trimEnd(lines: string[]): string[] {
    let end = lines.length;
    while (end > 0 && !lines[end - 1]!.trim()) {
        end -= 1;
    }
    return lines.slice(0, end);
}

/** A script's cells: one for each mark, and one for any code before the first; without marks, one of all of it. */
export function parseCells(code: string): Cell[] {
    const parts: { kind: Cell["kind"]; title: string; lines: string[] }[] = [];
    let current: { kind: Cell["kind"]; title: string; lines: string[] } = { kind: "code", title: "", lines: [] };
    let marked = false;
    for (const line of code.replace(/\r\n?/g, "\n").split("\n")) {
        const mark = MARK.exec(line);
        if (!mark) {
            current.lines.push(line);
            continue;
        }
        if (marked || current.lines.some((one) => one.trim())) {
            parts.push(current);
        }
        marked = true;
        const rest = mark[1]!;
        current = {
            kind: MARKDOWN.test(rest) ? "markdown" : "code",
            title: rest.replace(MARKDOWN, "").trim(),
            lines: [],
        };
    }
    parts.push(current);
    return parts.map(({ kind, title, lines }) => {
        const kept = trimEnd(lines);
        // Markdown in a script is comments: "# text", or "#" for a blank line.
        const source = kind === "markdown" ? kept.map((line) => line.replace(/^# ?/, "")).join("\n") : kept.join("\n");
        return { id: cellId(), kind, title, source };
    });
}

/** Cells as a script's code: the reverse of parseCells (a notebook of one untitled code cell is just its code). */
export function joinCells(cells: Cell[]): string {
    const only = cells[0];
    if (cells.length === 1 && only!.kind === "code" && !only!.title) {
        return only!.source ? `${only!.source}\n` : "";
    }
    const parts = cells.map((cell) => {
        const mark = `# %%${cell.title ? ` ${cell.title}` : ""}${cell.kind === "markdown" ? " [markdown]" : ""}`;
        const body =
            cell.kind === "markdown"
                ? cell.source
                      .split("\n")
                      .map((line) => (line ? `# ${line}` : "#"))
                      .join("\n")
                : cell.source;
        return cell.source ? `${mark}\n${body}` : mark;
    });
    return `${parts.join("\n\n")}\n`;
}

/** The code a notebook runs (its code cells), to get its imports and channels ready. */
export const codeOf = (cells: Cell[]): string =>
    cells
        .filter((cell) => cell.kind === "code")
        .map((cell) => cell.source)
        .join("\n");
