import { useMemo } from "react";
import type { Commands } from "./commands";
import { partTable, type PartRow } from "./exports";
import { CATEGORIES, PRESETS } from "./library/index";
import { useEditor, type EditorStore } from "./store";

// The parts table, under the drawing: every valve, sensor, tank, and the rest, by what they are, with how many of each
// and their specs (MAWP, size, Cv, range, channel...), and the lines after them. A tag goes to its part on the drawing.
// It's the parts list a CSV saves (exports.ts), in groups.

interface Group {
    name: string;
    rows: PartRow[];
    columns: number[]; // which of the list's cells it shows: those that any of its rows has
}

/** Each kind's place in the library's order (valves first, then instruments, vessels...), by its kind's id. */
const ORDER = new Map<string, number>();
PRESETS.forEach((preset) => {
    if (!ORDER.has(preset.kind)) {
        ORDER.set(
            preset.kind,
            CATEGORIES.findIndex((category) => category.id === preset.category),
        );
    }
});

export function PartsPanel({
    store,
    commands,
    onCsv,
    onClose,
}: {
    store: EditorStore;
    commands: Commands;
    onCsv: () => void;
    onClose: () => void;
}) {
    const drawing = useEditor(store, (state) => state.drawing);
    const selection = useEditor(store, (state) => state.selection);
    const { head, groups, parts, lines } = useMemo(() => {
        const { head, rows } = partTable(drawing);
        const kinds = new Map(drawing.parts.map((part) => [part.id, part.kind]));
        const byName = new Map<string, PartRow[]>();
        for (const row of rows) {
            const name = row.line ? "Lines" : row.cells[2]!;
            byName.set(name, [...(byName.get(name) ?? []), row]);
        }
        const place = (rows: PartRow[]) => (rows[0]!.line ? 99 : (ORDER.get(kinds.get(rows[0]!.id) ?? "") ?? 50));
        const groups: Group[] = [...byName]
            .sort(([a, one], [b, other]) => place(one) - place(other) || a.localeCompare(b))
            .map(([name, rows]) => ({
                name,
                rows: rows.sort((a, b) =>
                    a.cells[1]!.localeCompare(b.cells[1]!, undefined, { numeric: true, sensitivity: "base" }),
                ),
                // Its tag, then what any of them has: not the list's own columns (part or line, what it is).
                columns: [
                    1,
                    ...head
                        .map((_, index) => index)
                        .filter((index) => index > 2 && rows.some((row) => row.cells[index])),
                ],
            }));
        return {
            head,
            groups,
            parts: rows.filter((row) => !row.line).length,
            lines: rows.filter((row) => row.line).length,
        };
    }, [drawing]);
    const chosen = new Set(selection);

    return (
        <section className="piper-test piper-parts" aria-label="Parts">
            <div className="piper-test-head">
                <h2>Parts</h2>
                <span className="muted piper-small">
                    {parts} {parts === 1 ? "part" : "parts"}, {lines} {lines === 1 ? "line" : "lines"}
                </span>
                <button type="button" className="button-small" onClick={onCsv}>
                    Save as CSV
                </button>
                <button type="button" className="piper-close" aria-label="Close the parts" onClick={onClose}>
                    ×
                </button>
            </div>
            {groups.length === 0 ? (
                <p className="muted piper-small">Parts from the library are listed here as they're placed.</p>
            ) : (
                <div className="piper-parts-body">
                    {groups.map((group) => (
                        <table key={group.name} className="table piper-parts-table" aria-label={group.name}>
                            <caption>
                                {group.name} <span className="muted">{group.rows.length}</span>
                            </caption>
                            <thead>
                                <tr>
                                    {group.columns.map((index) => (
                                        <th key={index}>{head[index]}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {group.rows.map((row) => (
                                    <tr key={row.id} aria-selected={chosen.has(row.id)}>
                                        {group.columns.map((index) =>
                                            index === 1 ? (
                                                <td key={index}>
                                                    <button
                                                        type="button"
                                                        className="piper-parts-tag"
                                                        title="Show it on the drawing"
                                                        onClick={() => commands.show([row.id])}
                                                    >
                                                        {row.cells[1] || "Untagged"}
                                                    </button>
                                                </td>
                                            ) : (
                                                <td key={index}>{row.cells[index]}</td>
                                            ),
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ))}
                </div>
            )}
        </section>
    );
}
