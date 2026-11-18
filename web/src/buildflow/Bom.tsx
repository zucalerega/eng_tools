import { useEffect, useMemo, useState } from "react";
import { Dialog, Notice } from "../components";
import { Link } from "../router";
import { useDemo } from "../session";
import { BOM_STATUS_NAMES, buildflow, type BomLine, type BomLineIn, type BomStatus, type ProgramDetail } from "./api";
import {
    componentNamed,
    dollars,
    FIELDS,
    guessColumns,
    guessHeader,
    guessLeadUnit,
    partsPlan,
    readLines,
    type Field,
    type LeadUnit,
    type PartPlan,
    type ReadLine,
} from "./billOfMaterials";
import { leadInWords } from "./planning";
import { readSheets, SheetError, type Sheet } from "./sheets";
import { formatDay, today } from "./vehicle";

// A program's bill of materials (/buildflow/programs/{id}/bom): each part to buy, the component it's for, how many,
// from whom, what it costs, how long it takes to come, the day to order it by (to have it when its component's build
// has to start), and where it is. It's read in from the team's own BOM spreadsheet (Excel or CSV), and read in again as
// that changes; anyone signed in keeps it.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STATUSES: BomStatus[] = ["to_order", "ordered", "received"];

type Order = "order_by" | "component";

export function BomPage({ id }: { id: number }) {
    const [program, setProgram] = useState<ProgramDetail | null>(null);
    const [lines, setLines] = useState<BomLine[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [said, setSaid] = useState<string | null>(null);
    const [reading, setReading] = useState(false);
    const [order, setOrder] = useState<Order>("order_by");
    const [status, setStatus] = useState<BomStatus | "">("");
    const [component, setComponent] = useState<string>(
        () => new URLSearchParams(window.location.search).get("component") ?? "",
    );
    const demo = useDemo();

    useEffect(() => {
        Promise.all([buildflow.program(id), buildflow.bom(id)]).then(
            ([loaded, found]) => {
                setProgram(loaded);
                setLines(found);
            },
            (error: unknown) => setProblem(message(error)),
        );
    }, [id]);

    const planned = useMemo(() => (program && lines ? partsPlan(lines, program, today()) : []), [program, lines]);

    async function change(line: BomLine, patch: { status?: BomStatus; note?: string }) {
        setProblem(null);
        try {
            const changed = await buildflow.changeBomLine(line.id, patch);
            setLines((now) => now && now.map((each) => (each.id === changed.id ? changed : each)));
        } catch (error) {
            setProblem(message(error));
        }
    }

    if (!program || !lines) {
        return problem ? <Notice tone="error">{problem}</Notice> : <p className="muted">Loading…</p>;
    }
    const locked = demo || program.archived_at !== null;
    const shown = planned
        .filter((p) => status === "" || p.line.status === status)
        .filter((p) => component === "" || String(p.line.component_id ?? "none") === component);
    const sorted =
        order === "order_by"
            ? [...shown].sort((a, b) => (a.orderBy ?? "9999").localeCompare(b.orderBy ?? "9999"))
            : shown;
    const open = planned.filter((p) => p.line.status !== "received");
    const cost = planned.reduce(
        (sum, p) =>
            sum + (p.line.unit_cost !== null && p.line.quantity !== null ? p.line.unit_cost * p.line.quantity : 0),
        0,
    );
    const counts = [
        {
            name: "Order now",
            count: open.filter((p) => p.late).length,
            tone: "danger",
            hint: "Past its day to order it by",
        },
        {
            name: "Long leads",
            count: open.filter((p) => p.long).length,
            tone: "warning",
            hint: "Six weeks or more to come",
        },
        { name: "To order", count: planned.filter((p) => p.line.status === "to_order").length, tone: "", hint: "" },
        { name: "Ordered", count: planned.filter((p) => p.line.status === "ordered").length, tone: "", hint: "" },
        { name: "Received", count: planned.filter((p) => p.line.status === "received").length, tone: "", hint: "" },
    ];
    return (
        <section className="bf-bom">
            <div className="page-head">
                <div className="page-title">
                    <nav className="breadcrumbs" aria-label="Programs">
                        <Link to="/buildflow">Programs</Link>
                        <span className="separator">/</span>
                        <Link to={`/buildflow/programs/${program.id}?phase=build`}>{program.name}</Link>
                    </nav>
                    <h1>Bill of materials</h1>
                </div>
                <div className="page-actions">
                    <Link to={`/buildflow/programs/${program.id}/plan`} className="button">
                        Build plan
                    </Link>
                    {!locked && (
                        <button type="button" className="button-primary" onClick={() => setReading(true)}>
                            Read in a spreadsheet…
                        </button>
                    )}
                </div>
            </div>
            <p className="muted bf-lead">
                Each part to buy, the component it&apos;s for, and the day to order it by: in hand when its
                component&apos;s build has to start, by the build plan.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            {said && <Notice tone="info">{said}</Notice>}

            {lines.length === 0 ? (
                <p className="empty">
                    No BOM yet. <em>Read in a spreadsheet…</em> takes the team&apos;s BOM, an Excel workbook (.xlsx) or
                    a CSV file: each row a part, with its part number or description, and what else it says (the
                    component it&apos;s for, how many, the vendor, the cost, the lead time, a link, where it is).
                </p>
            ) : (
                <>
                    <ul className="bf-plan-counts" aria-label="The BOM, in numbers">
                        {counts.map((each) => (
                            <li
                                key={each.name}
                                className={each.count > 0 && each.tone ? `bf-plan-count-${each.tone}` : undefined}
                                title={each.hint || undefined}
                            >
                                <span className="bf-plan-count">{each.count}</span> {each.name}
                            </li>
                        ))}
                        {cost > 0 && (
                            <li>
                                <span className="bf-plan-count">{dollars(cost)}</span> in all
                            </li>
                        )}
                    </ul>
                    <div className="bf-plan-controls">
                        <div className="segmented" role="group" aria-label="Order">
                            <button
                                type="button"
                                aria-pressed={order === "order_by"}
                                onClick={() => setOrder("order_by")}
                            >
                                By order date
                            </button>
                            <button
                                type="button"
                                aria-pressed={order === "component"}
                                onClick={() => setOrder("component")}
                            >
                                As the BOM has it
                            </button>
                        </div>
                        <label className="field bf-inline-field">
                            Component
                            <select value={component} onChange={(event) => setComponent(event.target.value)}>
                                <option value="">All</option>
                                {program.components.map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {c.name}
                                    </option>
                                ))}
                                <option value="none">None yet</option>
                            </select>
                        </label>
                        <label className="field bf-inline-field">
                            Status
                            <select
                                value={status}
                                onChange={(event) => setStatus(event.target.value as BomStatus | "")}
                            >
                                <option value="">All</option>
                                {STATUSES.map((each) => (
                                    <option key={each} value={each}>
                                        {BOM_STATUS_NAMES[each]}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                    <div className="table-scroll">
                        <table className="table bf-bom-table" aria-label="Bill of materials">
                            <thead>
                                <tr>
                                    <th>Part</th>
                                    <th>Component</th>
                                    <th className="numeric">Qty</th>
                                    <th>Vendor</th>
                                    <th className="numeric">Each</th>
                                    <th>Lead</th>
                                    <th>Order by</th>
                                    <th>Status</th>
                                    <th>Note</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sorted.map((p) => (
                                    <Row key={p.line.id} planned={p} locked={locked} onChange={change} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
            {reading && (
                <ReadIn
                    program={program}
                    onRead={(result, file) => {
                        setReading(false);
                        void buildflow.bom(program.id).then(setLines);
                        setSaid(
                            `Read in ${file}: ${result.added} new, ${result.changed} changed, ${result.removed} taken off.`,
                        );
                    }}
                    onCancel={() => setReading(false)}
                />
            )}
        </section>
    );
}

function Row({
    planned,
    locked,
    onChange,
}: {
    planned: PartPlan;
    locked: boolean;
    onChange: (line: BomLine, patch: { status?: BomStatus; note?: string }) => Promise<void>;
}) {
    const { line, component } = planned;
    const [note, setNote] = useState(line.note);
    useEffect(() => setNote(line.note), [line.note]);
    const name = line.part_number || line.description;
    return (
        <tr className={line.status === "received" ? "bf-plan-ready" : undefined}>
            <th scope="row">
                <span className="bf-bom-part">
                    {line.url ? (
                        <a href={line.url} target="_blank" rel="noopener noreferrer">
                            {name}
                        </a>
                    ) : (
                        name
                    )}
                    {planned.long && <span className="tag bf-plan-flag bf-plan-flag-long-lead">Long lead</span>}
                </span>
                {line.part_number && line.description && <span className="muted bf-small">{line.description}</span>}
            </th>
            <td>
                {component ? (
                    <Link to={`/buildflow/programs/${component.program_id}?phase=build&component=${component.id}`}>
                        {component.name}
                    </Link>
                ) : (
                    <span className="muted">—</span>
                )}
            </td>
            <td className="numeric">
                {line.quantity ?? ""} {line.unit}
            </td>
            <td>{line.vendor}</td>
            <td className="numeric">{line.unit_cost === null ? "" : dollars(line.unit_cost)}</td>
            <td>{line.lead_days === null ? "" : leadInWords(line.lead_days)}</td>
            <td className={planned.late ? "bf-late bf-due-day" : "bf-due-day"}>
                {planned.orderBy && line.status === "to_order"
                    ? `${formatDay(planned.orderBy)}${planned.late ? ", late" : ""}`
                    : ""}
            </td>
            <td>
                <select
                    aria-label={`${name}: status`}
                    value={line.status}
                    disabled={locked}
                    onChange={(event) => void onChange(line, { status: event.target.value as BomStatus })}
                >
                    {STATUSES.map((each) => (
                        <option key={each} value={each}>
                            {BOM_STATUS_NAMES[each]}
                        </option>
                    ))}
                </select>
            </td>
            <td>
                <input
                    className="bf-note"
                    aria-label={`${name}: note`}
                    value={note}
                    maxLength={2000}
                    placeholder="PO, tracking"
                    disabled={locked}
                    onChange={(event) => setNote(event.target.value)}
                    onBlur={() => note.trim() !== line.note && void onChange(line, { note: note.trim() })}
                    onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                />
            </td>
        </tr>
    );
}

/** The column letter of a sheet's nth column: A, B, …, Z, AA. */
function letterOf(index: number): string {
    let letters = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    }
    return letters;
}

/** Reading a BOM in: its file, its sheet, which column says what, and which component its lines are for. */
function ReadIn({
    program,
    onRead,
    onCancel,
}: {
    program: ProgramDetail;
    onRead: (result: { lines: BomLine[]; added: number; changed: number; removed: number }, file: string) => void;
    onCancel: () => void;
}) {
    const [file, setFile] = useState<string>("");
    const [sheets, setSheets] = useState<Sheet[] | null>(null);
    const [sheet, setSheet] = useState(0);
    const [header, setHeader] = useState(0);
    const [columns, setColumns] = useState<Partial<Record<Field, number>>>({});
    const [leadUnit, setLeadUnit] = useState<LeadUnit>("weeks");
    // Whose lines they are: those its Component column names ("column"), none yet ("none"), or one component's (its id:
    // its BOM alone).
    const [forWhat, setForWhat] = useState<string>("column");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);

    /** A sheet's columns guessed from its header row. */
    function guess(rows: string[][], at: number) {
        const headers = rows[at] ?? [];
        const guessed = guessColumns(headers);
        setColumns(guessed);
        setLeadUnit(guessed.lead === undefined ? "weeks" : guessLeadUnit(headers[guessed.lead] ?? ""));
        setForWhat(guessed.component === undefined ? "none" : "column");
    }

    async function choose(picked: File) {
        setProblem(null);
        try {
            const read = await readSheets(picked, picked.name);
            const first = Math.max(
                0,
                read.findIndex((s) => /bom|bill|parts/i.test(s.name)),
            );
            setFile(picked.name);
            setSheets(read);
            setSheet(first);
            const at = guessHeader(read[first]!.rows);
            setHeader(at);
            guess(read[first]!.rows, at);
        } catch (error) {
            setSheets(null);
            setProblem(error instanceof SheetError ? error.message : message(error));
        }
    }

    const rows = sheets?.[sheet]?.rows ?? [];
    const headers = rows[header] ?? [];
    const read: ReadLine[] = sheets ? readLines(rows, { header, columns, leadUnit }) : [];
    const one = program.components.find((c) => String(c.id) === forWhat) ?? null;
    const matched = read.map((line) => one ?? (forWhat === "column" ? componentNamed(program, line.component) : null));
    const unmatched = [
        ...new Set(read.filter((line, index) => !matched[index] && line.component).map((l) => l.component)),
    ];
    const named = columns.part_number !== undefined || columns.description !== undefined;

    async function readIn() {
        setBusy(true);
        setProblem(null);
        try {
            const lines: BomLineIn[] = read.map((line, index) => ({
                component_id: matched[index]?.id ?? null,
                part_number: line.part_number,
                description: line.description,
                quantity: line.quantity,
                unit: line.unit,
                vendor: line.vendor,
                unit_cost: line.unit_cost,
                lead_days: line.lead_days,
                url: line.url,
                status: line.status,
            }));
            const result = await buildflow.readBom(program.id, { lines, component_id: one?.id ?? null, file });
            onRead(result, file);
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }

    return (
        <Dialog
            title="Read in a BOM"
            confirm={sheets ? `Read in ${read.length} ${read.length === 1 ? "line" : "lines"}` : "Read in"}
            busy={busy}
            disabled={!sheets || read.length === 0 || !named}
            onConfirm={() => void readIn()}
            onCancel={onCancel}
            tall
            wide
        >
            {problem && <Notice tone="error">{problem}</Notice>}
            <label className="field">
                The team&apos;s BOM: an Excel workbook (.xlsx) or a CSV file
                <input
                    type="file"
                    accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                    onChange={(event) => {
                        const picked = event.target.files?.[0];
                        if (picked) {
                            void choose(picked);
                        }
                    }}
                />
            </label>
            {sheets && (
                <>
                    <div className="bf-bom-reading">
                        {sheets.length > 1 && (
                            <label className="field">
                                Sheet
                                <select
                                    value={sheet}
                                    onChange={(event) => {
                                        const next = Number(event.target.value);
                                        const at = guessHeader(sheets[next]!.rows);
                                        setSheet(next);
                                        setHeader(at);
                                        guess(sheets[next]!.rows, at);
                                    }}
                                >
                                    {sheets.map((each, index) => (
                                        <option key={index} value={index}>
                                            {each.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                        <label className="field">
                            Header row
                            <input
                                type="number"
                                className="bf-number"
                                min={1}
                                max={rows.length}
                                value={header + 1}
                                onChange={(event) => {
                                    const at = Math.max(0, Math.min(rows.length - 1, Number(event.target.value) - 1));
                                    setHeader(at);
                                    guess(rows, at);
                                }}
                            />
                        </label>
                        <label className="field">
                            Lines are for
                            <select value={forWhat} onChange={(event) => setForWhat(event.target.value)}>
                                {columns.component !== undefined && (
                                    <option value="column">The component its Component column names</option>
                                )}
                                <option value="none">No component yet</option>
                                {program.components.map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {c.name} (its BOM alone)
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                    <fieldset className="bf-bom-columns">
                        <legend>Which column says what</legend>
                        {FIELDS.map(({ field, name, hint }) => (
                            <label key={field} className="field" title={hint}>
                                {name}
                                <select
                                    value={columns[field] ?? ""}
                                    onChange={(event) =>
                                        setColumns({
                                            ...columns,
                                            [field]: event.target.value === "" ? undefined : Number(event.target.value),
                                        })
                                    }
                                >
                                    <option value="">None</option>
                                    {headers.map((text, index) => (
                                        <option key={index} value={index}>
                                            {letterOf(index)}: {text || "(no header)"}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        ))}
                        <label className="field">
                            Lead times in
                            <select value={leadUnit} onChange={(event) => setLeadUnit(event.target.value as LeadUnit)}>
                                <option value="weeks">Weeks</option>
                                <option value="days">Days</option>
                            </select>
                        </label>
                    </fieldset>
                    <p className="bf-small">
                        {read.length} {read.length === 1 ? "line" : "lines"} in {sheets[sheet]!.name}
                        {one
                            ? `, all ${one.name}'s: its BOM becomes them, and the rest of the BOM stays.`
                            : `: the program's whole BOM becomes them.`}{" "}
                        A part already on it keeps its note, and its status unless the sheet says one.
                        {!named && " Say which column is the part number, or the description."}
                    </p>
                    {unmatched.length > 0 && (
                        <Notice tone="warning">
                            No component is called {unmatched.slice(0, 5).join(", ")}
                            {unmatched.length > 5 ? `, and ${unmatched.length - 5} more` : ""}: their lines come in for
                            no component, to give one later.
                        </Notice>
                    )}
                    {read.length > 0 && (
                        <div className="table-scroll">
                            <table className="table bf-bom-preview" aria-label="The lines, as they'll be read in">
                                <thead>
                                    <tr>
                                        <th>Row</th>
                                        <th>Part</th>
                                        <th>Component</th>
                                        <th className="numeric">Qty</th>
                                        <th>Vendor</th>
                                        <th className="numeric">Each</th>
                                        <th>Lead</th>
                                        <th>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {read.slice(0, 8).map((line, index) => (
                                        <tr key={line.row}>
                                            <td className="muted">{line.row}</td>
                                            <td>{line.part_number || line.description}</td>
                                            <td>{matched[index]?.name ?? <span className="muted">—</span>}</td>
                                            <td className="numeric">
                                                {line.quantity ?? ""} {line.unit}
                                            </td>
                                            <td>{line.vendor}</td>
                                            <td className="numeric">
                                                {line.unit_cost === null ? "" : dollars(line.unit_cost)}
                                            </td>
                                            <td>{line.lead_days === null ? "" : leadInWords(line.lead_days)}</td>
                                            <td>{line.status ? BOM_STATUS_NAMES[line.status] : ""}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {read.length > 8 && <p className="muted bf-small">And {read.length - 8} more.</p>}
                        </div>
                    )}
                </>
            )}
        </Dialog>
    );
}
