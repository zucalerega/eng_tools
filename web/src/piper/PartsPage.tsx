import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api";
import { Notice } from "../components";
import { Link } from "../router";
import { piper, type DiagramDetail } from "./api";
import { pageOf, readDocument } from "./drawing";
import { download, fileName } from "./exports";
import { fluidOf } from "./fluids";
import {
    columnsOf,
    csvOf,
    leftOutOf,
    PART_CATEGORIES,
    partsOf,
    sortRows,
    type PartsRow,
    type PartsSort,
} from "./parts";

// A diagram's parts, on a page of their own (the editor's Parts opens it): every part on its pages in one table, sorted
// by any column, and narrowed to one kind of part (valves, instruments...), one fluid, one page, or what has some words
// in it. A tag opens the drawing at its part; what's shown saves as a CSV. It's the drawing as it was last saved, read
// again on coming back to the tab.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether a row has every word looked for, in any of its cells. */
const hasWords = (row: PartsRow, words: string[]) => {
    const text = Object.values(row.cells).join("\n").toLowerCase();
    return words.every((word) => text.includes(word));
};

export function PartsPage({ id }: { id: number }) {
    const [diagram, setDiagram] = useState<DiagramDetail | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [category, setCategory] = useState("all");
    const [fluid, setFluid] = useState(""); // a fluid's id; "": any
    const [page, setPage] = useState(-1); // which page's; -1: every page's
    const [find, setFind] = useState("");
    const [sort, setSort] = useState<PartsSort>(null);

    useEffect(() => {
        let current = true;
        const load = () =>
            piper.diagram(id).then(
                (found) => current && setDiagram(found),
                (error: unknown) => {
                    if (current) {
                        setProblem(
                            error instanceof ApiError && error.status === 404
                                ? "There's no such diagram: someone may have deleted it for good, or the link is wrong."
                                : message(error),
                        );
                    }
                },
            );
        void load();
        // Back to the tab (from the drawing, say): what's been saved since.
        const back = () => {
            if (document.visibilityState === "visible") {
                void load();
            }
        };
        document.addEventListener("visibilitychange", back);
        window.addEventListener("focus", back);
        return () => {
            current = false;
            document.removeEventListener("visibilitychange", back);
            window.removeEventListener("focus", back);
        };
    }, [id]);

    const drawn = useMemo(() => (diagram ? readDocument(diagram.drawing) : null), [diagram]);
    const all = useMemo(() => (drawn ? partsOf(drawn) : []), [drawn]);
    const leftOut = useMemo(() => (drawn ? leftOutOf(drawn) : 0), [drawn]);
    const words = find.toLowerCase().split(/\s+/).filter(Boolean);
    // Each narrowing but the kind of part's: how many of each kind there are, as the others narrow them.
    const others = all.filter(
        (row) => (!fluid || row.fluids.includes(fluid)) && (page < 0 || row.page === page) && hasWords(row, words),
    );
    const narrowed = others.filter((row) => category === "all" || row.category === category);
    const shown = sortRows(narrowed, sort);

    if (problem) {
        return <Notice tone="error">{problem}</Notice>;
    }
    if (!diagram || !drawn) {
        return <p className="muted piper-loading">Loading…</p>;
    }
    const columns = columnsOf(drawn, all, narrowed);
    const categories = PART_CATEGORIES.map((each) => ({
        ...each,
        count: others.filter((row) => row.category === each.id).length,
    })).filter((each) => all.some((row) => row.category === each.id));
    const fluids = [...new Set(all.flatMap((row) => row.fluids))].map((each) => ({
        id: each,
        label: fluidOf(pageOf(drawn, 0), each)?.label ?? each,
    }));
    const heading = (key: string, label: string) => {
        const on = sort?.key === key;
        return (
            <th key={key} aria-sort={on ? (sort.descending ? "descending" : "ascending") : undefined}>
                <button
                    type="button"
                    className="sort-button"
                    onClick={() =>
                        setSort(on ? (sort.descending ? null : { key, descending: true }) : { key, descending: false })
                    }
                >
                    {label}
                </button>
            </th>
        );
    };

    return (
        <section className="piper-parts-page">
            <div className="page-head">
                <div className="page-title">
                    <nav className="breadcrumbs" aria-label="Where">
                        <Link to="/piper">Diagrams</Link>
                        {diagram.folder && (
                            <span>
                                <span className="separator" aria-hidden="true">
                                    /
                                </span>
                                <Link to={diagram.folder_id ? `/piper/folders/${diagram.folder_id}` : "/piper"}>
                                    {diagram.folder}
                                </Link>
                            </span>
                        )}
                        <span>
                            <span className="separator" aria-hidden="true">
                                /
                            </span>
                            <Link to={`/piper/diagrams/${id}`}>{diagram.name}</Link>
                        </span>
                    </nav>
                    <h1>Parts</h1>
                </div>
                <div className="page-actions">
                    <Link to={`/piper/diagrams/${id}`} className="button">
                        Open the drawing
                    </Link>
                    <button
                        type="button"
                        disabled={shown.length === 0}
                        onClick={() =>
                            download(
                                fileName(`${diagram.name} parts`, "csv"),
                                // A byte-order mark first, so Excel reads it as UTF-8 (µm, Ø).
                                new Blob(["﻿", csvOf(columns, shown)], { type: "text/csv" }),
                            )
                        }
                    >
                        Save as CSV
                    </button>
                </div>
            </div>
            <p className="muted piper-lead">
                Every part on the diagram&apos;s pages, with what it is, the fluids on it, and its specs. Click a column
                to sort by it (again to turn it around), or show only one kind of part, one fluid, or one page. A tag
                opens the drawing at it. <em>Save as CSV</em> saves what&apos;s shown, as it&apos;s sorted.
                {leftOut > 0 && ` ${leftOutSaid(leftOut)}`}
            </p>
            <div className="piper-parts-filters">
                <div className="piper-parts-kinds" role="group" aria-label="Show">
                    <button type="button" aria-pressed={category === "all"} onClick={() => setCategory("all")}>
                        All <span className="muted">{others.length}</span>
                    </button>
                    {categories.map((each) => (
                        <button
                            key={each.id}
                            type="button"
                            aria-pressed={category === each.id}
                            onClick={() => setCategory(each.id)}
                        >
                            {each.name} <span className="muted">{each.count}</span>
                        </button>
                    ))}
                </div>
                {fluids.length > 0 && (
                    <label className="piper-parts-filter">
                        Fluid
                        <select value={fluid} onChange={(event) => setFluid(event.target.value)}>
                            <option value="">Any</option>
                            {fluids.map((each) => (
                                <option key={each.id} value={each.id}>
                                    {each.label}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                {drawn.pages.length > 1 && (
                    <label className="piper-parts-filter">
                        Page
                        <select value={page} onChange={(event) => setPage(Number(event.target.value))}>
                            <option value={-1}>Every page</option>
                            {drawn.pages.map((each, index) => (
                                <option key={each.id} value={index}>
                                    {each.name}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                <input
                    type="search"
                    className="piper-parts-find"
                    aria-label="Find parts"
                    placeholder="Find a tag, a model, a size…"
                    value={find}
                    onChange={(event) => setFind(event.target.value)}
                />
            </div>
            {all.length === 0 ? (
                <p className="muted">
                    Nothing on the drawing yet. <Link to={`/piper/diagrams/${id}`}>Open the drawing</Link> to place
                    parts from its library; they&apos;re listed here once it&apos;s saved.
                </p>
            ) : shown.length === 0 ? (
                <p className="muted">No part is all of that. Show all of them, or another fluid or page.</p>
            ) : (
                <div className="table-scroll">
                    <table className="table piper-parts-table" aria-label="Parts">
                        <thead>
                            <tr>{columns.map((column) => heading(column.key, column.label))}</tr>
                        </thead>
                        <tbody>
                            {shown.map((row) => (
                                <tr key={row.id}>
                                    {columns.map((column) =>
                                        column.key === "tag" ? (
                                            <td key={column.key}>
                                                <Link
                                                    to={`/piper/diagrams/${id}?part=${encodeURIComponent(row.id)}`}
                                                    className="piper-parts-tag"
                                                    title="Open the drawing at it"
                                                >
                                                    {row.cells.tag || "Untagged"}
                                                </Link>
                                            </td>
                                        ) : (
                                            <td key={column.key}>{row.cells[column.key]}</td>
                                        ),
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

/** What the parts page says of the parts left out of it: copies of parts drawn on another page too. */
const leftOutSaid = (count: number): string =>
    count === 1
        ? "1 part is left out: a copy of one drawn on another page too, taken out of the list in the drawing."
        : `${count} parts are left out: copies of ones drawn on another page too, taken out of the list in the drawing.`;
