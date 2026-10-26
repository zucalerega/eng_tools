import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api";
import { Dialog, Notice } from "../components";
import { FolderPicker } from "../FolderPicker";
import { formatTime } from "../format";
import { navigate, usePathname, useSearch } from "../router";
import { useSession } from "../session";
import { piper, type Diagram, type RevisionDetail, type Scheme } from "./api";
import { monochrome } from "./fluids";
import { Canvas } from "./Canvas";
import { usePalette, withStates } from "./colors";
import { commandsOf, useEditorKeys } from "./commands";
import { DiagramView } from "./DiagramView";
import { useEditLock } from "./editing";
import { pageOf, readDocument, type Document, type Drawing, type Point } from "./drawing";
import { addPart, drawingBox, updatePart, withPicture } from "./edit";
import { download, fileName, partsList, pngOf, printDrawing, svgOf } from "./exports";
import { HistoryPanel } from "./History";
import { Inspector } from "./Inspector";
import { LibraryPanel } from "./LibraryPanel";
import { kindOf, presetOf } from "./library/index";
import type { DiagramMeta } from "./library/kinds";
import { useSaving } from "./saving";
import { EditorStore, useEditor } from "./store";
import { channelNames, findChannel, plotLink, type Samples } from "./testdata";
import { PAPERS, pdfOfPages, type Sheet } from "./pdf";
import { TestPanel } from "./TestPanel";
import { Toolbar, type ExportKind, type Panel } from "./Toolbar";
import { findInDocument } from "./find";
import { PageTabs } from "./PageTabs";
import { PartsPanel } from "./PartsPanel";
import { readers, useTest } from "./useTest";
import { simApi, type Catalog } from "./sim/api";
import { simLive } from "./sim/live";
import { buildModel } from "./sim/model";
import { NO_SIM, SimPanel, type SimState } from "./sim/SimPanel";
import type { LiveValue } from "./DiagramView";

// A diagram's page: the editor, the whole window under the top bar. The drawing's in the middle, the inspector on the
// right, and under them, when they're open, the test the drawing's read against and its history. A test and the time on
// its timeline are in the address (?test=5&t=12.5), so a link opens the same moment, and this browser keeps them for the
// diagram, so it opens to them again until the test's panel is closed. Its pages are tabs under the
// drawing; the drawing is the page being worked on. It opens to be looked at: Edit makes it yours to change, with the
// library on the left, until you're done (editing.ts). A diagram just made opens to edit (?edit=1). Simulation mode
// (?sim=1, for admins while it's tried out) shows what the P&ID is as a model, run against the test: its settings on
// each part in the inspector, and its panel in place of Test data's.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function EditorPage({ id }: { id: number }) {
    const [diagram, setDiagram] = useState<Diagram | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [panel, setPanel] = useState<Panel | null>(null);
    const [looking, setLooking] = useState<RevisionDetail | null>(null);
    const [renaming, setRenaming] = useState(false);
    const [pdfing, setPdfing] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [schemes, setSchemes] = useState<Scheme[] | null>(null);
    const [takingOver, setTakingOver] = useState(false);
    const { me } = useSession();
    const store = useMemo(() => {
        const made = new EditorStore();
        made.setReadOnly(true); // until it's yours to edit
        return made;
    }, []);
    const commands = useMemo(() => commandsOf(store), [store]);
    const drawing = useEditor(store, (state) => state.drawing);
    const page = useEditor(store, (state) => state.page);
    const pageCount = useEditor(store, (state) => state.document.pages.length);
    // A revision looked at: all its pages, and which of them is shown.
    const lookedAt = useMemo(() => (looking ? readDocument(looking.drawing) : null), [looking]);
    const [lookPage, setLookPage] = useState(0);
    const palette = withStates(usePalette(), drawing);
    const saving = useSaving(store, diagram, setDiagram);
    const lock = useEditLock(diagram, saving, setDiagram);
    const fitted = useRef(false);
    const opened = useRef(false); // asked to edit it as it opened (?edit), and did
    const pathname = usePathname();
    const search = new URLSearchParams(useSearch());
    const testParam = Number(search.get("test"));
    const testId = Number.isInteger(testParam) && testParam > 0 ? testParam : null;
    const finding = search.get("find");
    const toEdit = search.has("edit");
    const [time, setTime] = useState(() => Number(search.get("t")) || 0);
    const { reading, problem: testProblem } = useTest(drawing, testId, time);
    const canSimulate = me?.is_admin === true;
    const simulating = canSimulate && search.get("sim") === "1";
    const pages = useEditor(store, (state) => state.document); // all its pages: the model is all of them
    const [catalog, setCatalog] = useState<Catalog | null>(null);
    const [catalogProblem, setCatalogProblem] = useState<string | null>(null);
    // What Simulation mode's panel has (its settings, a run going, what it found), kept while the diagram's open.
    const [sim, setSim] = useState<SimState>(NO_SIM);
    const built = useMemo(
        () => (simulating && catalog ? buildModel(pages, catalog, reading?.detail ?? null) : null),
        [simulating, catalog, pages, reading?.detail],
    );

    useEffect(() => {
        let current = true;
        piper.diagram(id).then(
            (found) => {
                if (current) {
                    store.load(readDocument(found.drawing));
                    setDiagram(found);
                }
            },
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
        return () => {
            current = false;
        };
    }, [id, store]);

    // The team's color schemes, for the diagram's panel to take one's colors from.
    useEffect(() => {
        piper.schemes().then(setSchemes, () => setSchemes([]));
    }, []);

    // The parts a model can have (Yorg's), once Simulation mode first wants them.
    useEffect(() => {
        if (simulating && !catalog) {
            simApi.catalog().then(setCatalog, (error: unknown) => setCatalogProblem(message(error)));
        }
    }, [simulating, catalog]);

    // Opened at the whole drawing, once the canvas has its size.
    useEffect(() => {
        if (diagram && !fitted.current) {
            fitted.current = true;
            commands.fit();
            // Opened from a search (the diagrams' list): at what it found, on whichever page.
            const first = finding ? findInDocument(store.getState().document, finding)[0] : undefined;
            if (first) {
                commands.goTo(first.page, [first.id]);
            }
        }
    }, [diagram, commands, store, finding]);

    // Made just now (or a copy of yours): opened to edit, and the address left as a link to look at it.
    useEffect(() => {
        if (diagram && toEdit && !opened.current) {
            opened.current = true;
            void lock.start();
            const query = new URLSearchParams(window.location.search);
            query.delete("edit");
            const text = query.toString();
            navigate(`${pathname}${text ? `?${text}` : ""}`, { replace: true });
        }
    }, [diagram, toEdit]);

    // Saving refused: someone else is editing it now. It's only looked at here, and its banner asks what becomes of
    // the changes that weren't saved.
    useEffect(() => {
        if (saving.status === "locked") {
            lock.lose(saving.locked, false);
        }
    }, [saving.status]);

    // A link to a test opens its panel; the test's start, if the time's not in it.
    useEffect(() => {
        if (testId !== null) {
            setPanel((now) => now ?? "test");
        }
    }, [testId]);

    // Opened again without a test in its address (from the diagrams' list, say): the test it was last read against
    // here, at the time it was at. One in its address, a link's, is kept for next time instead.
    useEffect(() => {
        if (testId !== null) {
            keepTest(id, testId, time);
        } else if (!new URLSearchParams(window.location.search).has("test")) {
            const kept = keptTest(id);
            if (kept) {
                setTime(kept.at);
                address(kept.test, kept.at);
            }
        }
    }, [id, testId]);
    useEffect(() => {
        const detail = reading?.detail;
        if (detail && detail.t_min !== null && detail.t_max !== null && (time < detail.t_min || time > detail.t_max)) {
            setTime(detail.t_min);
        }
        // Only when a test arrives: the timeline keeps the time in it after that.
    }, [reading?.detail]);

    // The drawing as it is (not a revision, nor deleted): to look at, and, while it's yours, to change.
    const live = diagram !== null && !diagram.deleted_at && looking === null;
    const editing = live && lock.mine && saving.status !== "locked";
    useEffect(() => store.setReadOnly(!editing), [store, editing]);
    useEditorKeys(store, commands, live && !renaming && !takingOver);

    if (problem) {
        return <Notice tone="error">{problem}</Notice>;
    }
    if (!diagram) {
        return <p className="muted piper-loading">Loading…</p>;
    }

    const meta: DiagramMeta = {
        name: diagram.name,
        revision: revisionLabel(diagram, diagram.revision, latestRelease(diagram)),
        savedAt: diagram.updated_at,
        by: diagram.created_by?.name ?? "",
        sheet: sheetLabel(lookedAt ? lookPage : page, lookedAt?.pages.length ?? pageCount),
    };
    // What's shown: the page worked on, or the revision's looked at.
    const shownPage = lookedAt ? Math.min(lookPage, lookedAt.pages.length - 1) : page;
    const whole = (): Document => lookedAt ?? store.getState().document;

    /** Simulation mode on, or off: kept in the address, as the test is. */
    function simulate(on: boolean) {
        const query = new URLSearchParams(window.location.search);
        if (on) {
            query.set("sim", "1");
            setPanel((now) => (now === "test" ? null : now)); // its panel has the test
        } else {
            query.delete("sim");
        }
        const text = query.toString();
        navigate(`${pathname}${text ? `?${text}` : ""}`, { replace: true });
    }

    /** The test and the time in the address, and kept by this browser for the next time it's opened (null: neither). */
    function address(test: number | null, at: number | null) {
        keepTest(id, test, at === null ? null : Math.round(at * 1000) / 1000);
        const query = new URLSearchParams(window.location.search);
        if (test === null) {
            query.delete("test");
            query.delete("t");
        } else {
            query.set("test", String(test));
            if (at === null) {
                query.delete("t");
            } else {
                query.set("t", String(Math.round(at * 1000) / 1000));
            }
        }
        const text = query.toString();
        navigate(`${pathname}${text ? `?${text}` : ""}`, { replace: true });
    }

    async function plot(channels: string[]) {
        if (testId === null || channels.length === 0) {
            return;
        }
        window.open(await plotLink(testId, channels), "_blank", "noopener");
    }

    async function exportAs(as: ExportKind) {
        // A picture of the page shown (named for it, if there's more than one); the parts of all of them.
        const document = whole();
        const shown = pageOf(document, shownPage);
        const named = document.pages.length > 1 ? `${diagram!.name} ${document.pages[shownPage]!.name}` : diagram!.name;
        try {
            if (as === "pdf") {
                setPdfing(true); // which paper, first
            } else if (as === "svg") {
                const { svg } = await svgOf(shown, meta);
                download(fileName(named, "svg"), new Blob([svg], { type: "image/svg+xml" }));
            } else if (as === "png") {
                download(fileName(named, "png"), await pngOf(shown, meta));
            } else if (as === "print") {
                await printDrawing(shown, meta);
            } else {
                // A byte-order mark first, so Excel reads it as UTF-8 (µm, Ø).
                download(
                    fileName(`${diagram!.name} parts`, "csv"),
                    new Blob(["﻿", partsList(document)], { type: "text/csv" }),
                );
            }
        } catch (error) {
            setNotice(`The export didn't work: ${message(error)}`);
        }
    }

    /** A library entry double-clicked: placed in the middle of what's in view. */
    function placeInView(presetId: string) {
        const preset = presetOf(presetId);
        const { view, size, drawing: now } = store.getState();
        if (preset) {
            const at = { x: view.x + size.width / view.zoom / 2, y: view.y + size.height / view.zoom / 2 };
            const added = addPart(now, preset, at);
            store.commit(added.drawing, [added.id]);
        }
    }

    /** A part double-clicked: its tag (or its words) to type; or, an off-page connector that goes somewhere, there. */
    function edit(partId: string) {
        const { drawing: now, document: saved } = store.getState();
        const part = now.parts.find((entry) => entry.id === partId);
        const target = part?.kind === "offpage" ? saved.pages.findIndex((page) => page.id === part.props.page) : -1;
        if (part && target >= 0) {
            commands.goTo(target, part.props.part ? [part.props.part] : []);
            return;
        }
        store.select([partId]);
        const field = part && kindOf(part.kind).text ? "text" : "tag";
        setTimeout(() => {
            const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
                `.piper-inspector [data-piper-field="${field}"]`,
            );
            input?.focus();
            input?.select();
        });
    }

    /** A file dropped on the drawing: added to Piper, and a picture of it put where it was let go. */
    async function dropPicture(file: File, at: Point) {
        try {
            const image = await piper.addImage(file);
            const added = addPart(store.getState().drawing, presetOf("picture")!, at);
            store.commit(
                updatePart(added.drawing, added.id, (part) => withPicture(part, image)),
                [added.id],
            );
        } catch (error) {
            setNotice(`${file.name} isn't on the drawing: ${message(error)}`);
        }
    }

    /** What's here, kept as a diagram of its own (beside the one it was opened from), to go on editing. */
    async function saveMineAsNew() {
        try {
            const copy = await piper.create({
                name: `${diagram!.name} (my changes)`,
                folder_id: diagram!.folder_id ?? null,
                description: diagram!.description,
                drawing: store.getState().document,
            });
            navigate(`/piper/diagrams/${copy.id}?edit=1`);
        } catch (error) {
            setNotice(`Yours isn't saved as a new diagram: ${message(error)}`);
        }
    }

    async function restoreRevision(number: number) {
        const restored = await piper.restoreRevision(diagram!.id, number, diagram!.version);
        setLooking(null);
        saving.adopt(restored);
        setNotice(`Revision ${number} is the drawing again, as revision ${restored.revision}.`);
    }

    // What the drawing shows of the test at the time shown, and in Simulation mode, of the model's run beside it: an
    // instrument's measured value then in the model's units too, to compare.
    const modeled = simulating && sim.shown ? simLive(sim.shown, time, reading) : null;
    const values: Map<string, LiveValue> | null = modeled
        ? new Map(
              [...new Set([...(reading?.live.keys() ?? []), ...modeled.keys()])].map((id) => {
                  const tested = reading?.live.get(id) ?? { text: "", state: null, missing: false };
                  const run = modeled.get(id);
                  return [id, run ? { ...tested, text: run.measured ?? tested.text, model: run.model } : tested];
              }),
          )
        : (reading?.live ?? null);

    const linked = reading
        ? [
              ...new Set(
                  readers(drawing)
                      .flatMap((part) => channelNames(part).map((name) => findChannel(reading.detail, name)?.name))
                      .filter((name) => name !== undefined),
              ),
          ]
        : [];

    return (
        <div className="piper-editor">
            <Toolbar
                diagram={diagram}
                store={store}
                commands={commands}
                status={saving.status}
                problem={saving.problem}
                edit={lock}
                me={me}
                panel={panel}
                onPanel={(next) => {
                    setPanel(next);
                    if (next !== "history") {
                        setLooking(null);
                    }
                }}
                onRename={() => setRenaming(true)}
                onTakeOver={() => setTakingOver(true)}
                onExport={(as) => void exportAs(as)}
                simulating={simulating}
                onSimulate={canSimulate ? simulate : null}
            />
            {saving.status === "changed" && saving.changed && (
                <div className="piper-banner" role="alert">
                    <span>
                        {saving.changed.updated_by && saving.changed.updated_by.id === me?.id
                            ? "You saved this diagram in another window at "
                            : `${saving.changed.updated_by?.name ?? "Someone"} saved this diagram at `}
                        {formatTime(saving.changed.updated_at)}, after it was opened here. Your changes since aren't
                        saved yet.
                    </span>
                    <button
                        type="button"
                        className="button-small button-primary"
                        onClick={() => void saving.keepMine()}
                    >
                        Keep mine
                    </button>
                    <button type="button" className="button-small" onClick={() => void saveMineAsNew()}>
                        Save mine as a new diagram
                    </button>
                    <button
                        type="button"
                        className="button-small"
                        onClick={() =>
                            saving.loadTheirs().catch((error: unknown) => {
                                setNotice(`Theirs didn't load: ${message(error)}`);
                            })
                        }
                    >
                        Load theirs
                    </button>
                </div>
            )}
            {saving.status === "locked" && (
                <div className="piper-banner" role="alert">
                    <span>
                        {saving.locked?.by.name ?? "Someone else"} is editing this diagram now
                        {saving.locked ? ` (since ${formatTime(saving.locked.since)})` : ""}, so your changes since your
                        last save aren't saved.
                    </span>
                    <button type="button" className="button-small button-primary" onClick={() => void saveMineAsNew()}>
                        Save mine as a new diagram
                    </button>
                    <button
                        type="button"
                        className="button-small"
                        onClick={() =>
                            saving.loadTheirs().catch((error: unknown) => {
                                setNotice(`Theirs didn't load: ${message(error)}`);
                            })
                        }
                    >
                        Load theirs
                    </button>
                </div>
            )}
            {lock.taken && saving.status !== "locked" && (
                <div className="piper-banner piper-banner-info" role="status">
                    <span>
                        {lock.taken.by.name} is editing this diagram now, so it's only looked at here. Everything you
                        changed was saved.
                    </span>
                    <button type="button" className="piper-close" aria-label="Dismiss" onClick={lock.dismiss}>
                        ×
                    </button>
                </div>
            )}
            {lock.problem && (
                <div className="piper-banner piper-banner-info" role="alert">
                    <span>{lock.problem}</span>
                    <button type="button" className="piper-close" aria-label="Dismiss" onClick={lock.dismiss}>
                        ×
                    </button>
                </div>
            )}
            {diagram.deleted_at && (
                <div className="piper-banner" role="alert">
                    <span>This diagram is deleted: it can be looked at, but not changed.</span>
                    {diagram.can_delete && (
                        <button
                            type="button"
                            className="button-small button-primary"
                            onClick={async () => {
                                try {
                                    setDiagram(await piper.restore(diagram.id));
                                    saving.resume();
                                } catch (error) {
                                    setNotice(`It isn't restored: ${message(error)}`);
                                }
                            }}
                        >
                            Restore it
                        </button>
                    )}
                </div>
            )}
            {notice && (
                <div className="piper-banner piper-banner-info" role="status">
                    <span>{notice}</span>
                    <button type="button" className="piper-close" aria-label="Dismiss" onClick={() => setNotice(null)}>
                        ×
                    </button>
                </div>
            )}
            <div className="piper-body">
                {editing && <LibraryPanel store={store} palette={palette} onPlace={placeInView} />}
                <div className="piper-stage">
                    {live ? (
                        <Canvas
                            store={store}
                            commands={commands}
                            palette={palette}
                            meta={meta}
                            live={values}
                            onEdit={edit}
                            onPicture={(file, at) => void dropPicture(file, at)}
                        />
                    ) : (
                        <StillDrawing drawing={lookedAt ? pageOf(lookedAt, shownPage) : drawing} meta={meta} />
                    )}
                    {looking && (
                        <div className="piper-banner piper-looking" role="status">
                            <span>
                                Revision {looking.number}
                                {looking.released ? `, Rev ${looking.released}, released` : ""}
                                {looking.note ? ` (${looking.note})` : ""}, by {looking.author?.name ?? "someone"},{" "}
                                {formatTime(looking.saved_at)}
                            </span>
                            <button type="button" className="button-small" onClick={() => setLooking(null)}>
                                Back to the drawing
                            </button>
                        </div>
                    )}
                    {live && drawing.parts.length === 0 && <EmptyHint editing={editing} />}
                    {(pageCount > 1 || editing || (lookedAt?.pages.length ?? 0) > 1) && (
                        <PageTabs
                            store={store}
                            commands={commands}
                            editing={editing}
                            looking={lookedAt && { pages: lookedAt.pages, at: shownPage, onGo: setLookPage }}
                        />
                    )}
                </div>
                {live && (
                    <Inspector
                        store={store}
                        commands={commands}
                        palette={palette}
                        test={reading}
                        onPlot={(channels) => void plot(channels)}
                        schemes={schemes}
                        sim={simulating && catalog && built ? { catalog, built, test: reading?.detail ?? null } : null}
                    />
                )}
                {panel === "history" && (
                    <HistoryPanel
                        diagram={diagram}
                        looking={looking?.number ?? null}
                        onLook={(revision) => {
                            setLooking(revision);
                            setLookPage(store.getState().page); // at the page worked on, if it has it
                        }}
                        onRestore={restoreRevision}
                        onReleased={(release) =>
                            setDiagram(
                                (now) =>
                                    now && { ...now, released: release.letter, released_revision: release.revision },
                            )
                        }
                        onClose={() => {
                            setPanel(null);
                            setLooking(null);
                        }}
                    />
                )}
            </div>
            {panel === "parts" && (
                <PartsPanel
                    store={store}
                    commands={commands}
                    onCsv={() => void exportAs("csv")}
                    onClose={() => setPanel(null)}
                />
            )}
            {simulating && (
                <SimPanel
                    store={store}
                    commands={commands}
                    catalog={catalog}
                    catalogProblem={catalogProblem}
                    built={built}
                    testId={testId}
                    test={reading?.detail ?? null}
                    testSamples={reading?.samples ?? NO_SAMPLES}
                    testProblem={testProblem}
                    time={time}
                    state={sim}
                    onState={setSim}
                    onTest={(test) => {
                        setTime(0);
                        address(test, null);
                    }}
                    onTime={(at, settled) => {
                        setTime(at);
                        if (settled && testId !== null) {
                            address(testId, at);
                        }
                    }}
                    onClose={() => simulate(false)}
                />
            )}
            {panel === "test" && !simulating && (
                <TestPanel
                    testId={testId}
                    time={time}
                    reading={reading}
                    problem={testProblem}
                    onTest={(test) => {
                        setTime(0);
                        address(test, null);
                    }}
                    onTime={(at, settled) => {
                        setTime(at);
                        if (settled && testId !== null) {
                            address(testId, at);
                        }
                    }}
                    onPlot={() => void plot(linked)}
                    onClose={() => {
                        setPanel(null);
                        address(null, null);
                    }}
                />
            )}
            {pdfing && (
                <PdfDialog
                    onCancel={() => setPdfing(false)}
                    onSave={async (paper, framed, mono) => {
                        // Every page, a sheet each: which of how many it is in its title block.
                        const document = whole();
                        const printed = looking
                            ? { ...meta, revision: revisionLabel(diagram, looking.number, looking.released) }
                            : meta;
                        const revisions = framed ? await sheetRevisions(diagram.id) : [];
                        const drawn = document.pages.map((_, index) => {
                            const each = pageOf(document, index);
                            return {
                                drawing: mono ? monochrome(each) : each,
                                meta: { ...printed, sheet: sheetLabel(index, document.pages.length) },
                                // On a sheet: its title block the sheet's, unless the page has its own.
                                sheet: framed
                                    ? {
                                          project: diagram.folder,
                                          diagram: diagram.id,
                                          revisions,
                                          titleBlock: !each.parts.some((part) => part.kind === "titleblock"),
                                      }
                                    : null,
                            };
                        });
                        download(fileName(diagram.name, "pdf"), await pdfOfPages(drawn, paper));
                        setPdfing(false);
                    }}
                />
            )}
            {takingOver && (
                <Dialog
                    title="Take over editing"
                    confirm="Take over"
                    onConfirm={() => {
                        setTakingOver(false);
                        void lock.start(true);
                    }}
                    onCancel={() => setTakingOver(false)}
                >
                    <p>
                        {diagram.editing?.by.name ?? "Someone"} is editing this diagram. Taking it over makes it yours
                        to edit instead: what they've saved stays, and they're told, with anything they hadn't saved yet
                        left in their window for them to save as a diagram of its own.
                    </p>
                </Dialog>
            )}
            {renaming && (
                <RenameDialog
                    diagram={diagram}
                    onDone={(changed) => {
                        setRenaming(false);
                        if (changed) {
                            setDiagram(changed);
                        }
                    }}
                />
            )}
        </div>
    );
}

const NO_SAMPLES: ReadonlyMap<string, Samples> = new Map<string, Samples>();

const PAPER = "piper.paper"; // the paper last chosen for a PDF, in this browser
const SHEET = "piper.sheet"; // and whether it was on a sheet ("no": it wasn't)
const MONO = "piper.mono"; // and whether it was in black and white ("yes": it was)

function remembered(key: string, fallback: string): string {
    try {
        return window.localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

/** Where this browser keeps the test a diagram was last read against, and the time on its timeline: "5@12.5". */
const keptTestKey = (id: number) => `piper.test.${id}`;

function keptTest(id: number): { test: number; at: number } | null {
    const [test, at] = remembered(keptTestKey(id), "").split("@").map(Number);
    return test !== undefined && Number.isInteger(test) && test > 0
        ? { test, at: at !== undefined && Number.isFinite(at) ? at : 0 }
        : null;
}

/** Keeps a diagram's test and its time for the next time it's opened here, or forgets it (test null). */
function keepTest(id: number, test: number | null, at: number | null) {
    try {
        if (test === null) {
            window.localStorage.removeItem(keptTestKey(id));
        } else {
            window.localStorage.setItem(keptTestKey(id), `${test}@${at ?? 0}`);
        }
    } catch {
        // storage blocked: the test is only in the address, as it was
    }
}

/**
 * A PDF of the drawing: on which paper (turned to the drawing's way), or at the drawing's own size; and on a drawing
 * sheet (a border with its zones, a title block, and the named revisions), as a P&ID from Visio is, or bare.
 */
function PdfDialog({
    onSave,
    onCancel,
}: {
    onSave: (paper: string, sheet: boolean, mono: boolean) => Promise<void>;
    onCancel: () => void;
}) {
    const [paper, setPaper] = useState(() => remembered(PAPER, "tabloid"));
    const [sheet, setSheet] = useState(() => remembered(SHEET, "yes") !== "no");
    const [mono, setMono] = useState(() => remembered(MONO, "no") === "yes");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function save() {
        setBusy(true);
        try {
            window.localStorage.setItem(PAPER, paper);
            window.localStorage.setItem(SHEET, sheet ? "yes" : "no");
            window.localStorage.setItem(MONO, mono ? "yes" : "no");
        } catch {
            // storage blocked: the choices last this once
        }
        try {
            await onSave(paper, sheet, mono);
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }
    return (
        <Dialog title="Save as PDF" confirm="Save PDF" busy={busy} onConfirm={() => void save()} onCancel={onCancel}>
            <label className="field">
                Paper
                <select value={paper} onChange={(event) => setPaper(event.target.value)}>
                    {PAPERS.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                            {entry.name}
                        </option>
                    ))}
                </select>
            </label>
            <label className="check">
                <input type="checkbox" checked={sheet} onChange={(event) => setSheet(event.target.checked)} />
                On a drawing sheet: a border with its zones, a title block, and the named revisions
            </label>
            <label className="check">
                <input type="checkbox" checked={mono} onChange={(event) => setMono(event.target.checked)} />
                In black and white, for a printer without color: lines in ink, normally closed valves filled, normally
                open ones left white
            </label>
            <p className="muted piper-small">
                Each page of the diagram on a sheet of its own. A page whose printed sheet is set (in its panel, with
                nothing selected) prints where its outline shows, on its own paper; the others are fitted on this paper,
                turned their way. In the light colors, as on paper: its lines and words stay sharp at any size, and its
                tags can be searched.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

/** Which sheet of how many a page is, as its title block says: "2 OF 3". */
const sheetLabel = (index: number, count: number) => `${Math.min(index, count - 1) + 1} OF ${count}`;

/** The diagram's latest revision's letter, if that's the one released. */
const latestRelease = (diagram: Diagram): string | null =>
    diagram.released && diagram.released_revision === diagram.revision ? diagram.released : null;

/**
 * A revision as its title block writes it (DiagramMeta.revision): a released one's letter ("B"), else its number, and
 * if it's after the diagram's latest release, which ("7 (after B)").
 */
function revisionLabel(diagram: Diagram, number: number, letter: string | null | undefined): string {
    if (letter) {
        return letter;
    }
    const after = diagram.released && number > (diagram.released_revision ?? 0) ? ` (after ${diagram.released})` : "";
    return `${number}${after}`;
}

/**
 * What a sheet lists in its revisions block, the latest first: the diagram's releases, each with its letter, what it
 * was for, when, and who approved it; or, before it has any, its named revisions.
 */
async function sheetRevisions(id: number): Promise<Sheet["revisions"]> {
    const day = (at: string) => new Date(at).toLocaleDateString("en-CA");
    const released = (await piper.releases(id)).filter((release) => release.state === "released");
    if (released.length > 0) {
        return released.map((release) => ({
            rev: release.letter ?? "",
            note: release.note,
            date: release.decided_at ? day(release.decided_at) : "",
            by: release.approvals.map((approval) => approval.approver.name).join(", "),
        }));
    }
    return (await piper.revisions(id))
        .filter((revision) => revision.note)
        .map((revision) => ({
            rev: String(revision.number),
            note: revision.note,
            date: day(revision.saved_at),
            by: revision.author?.name ?? "",
        }));
}

/** A drawing to look at, not change: a revision from the history, or a deleted diagram. */
function StillDrawing({ drawing, meta }: { drawing: Drawing; meta: DiagramMeta }) {
    const palette = withStates(usePalette(), drawing);
    const box = drawingBox(drawing) ?? { x0: -200, y0: -150, x1: 200, y1: 150 };
    return (
        <svg
            className="piper-canvas piper-still"
            role="img"
            aria-label="Drawing"
            viewBox={`${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}`}
        >
            <rect x={box.x0} y={box.y0} width={box.x1 - box.x0} height={box.y1 - box.y0} fill={palette.paper} />
            <DiagramView drawing={drawing} palette={palette} meta={meta} />
        </svg>
    );
}

function EmptyHint({ editing }: { editing: boolean }) {
    if (!editing) {
        return (
            <div className="piper-empty">
                <h2>An empty diagram</h2>
                <p>Nothing's drawn on it yet. Edit, at the top, to start drawing it.</p>
            </div>
        );
    }
    return (
        <div className="piper-empty">
            <h2>An empty diagram</h2>
            <ol>
                <li>Drag parts here from the library on the left (or click one, then click here).</li>
                <li>Drag from a part's port (the dots that show on it) to another to draw a line.</li>
                <li>Drop a valve on a line to put it in the line.</li>
                <li>Select anything to name it and say what it is, on the right.</li>
            </ol>
        </div>
    );
}

/** The folders there are, by their paths ("Vespula/GSE"), to pick one from; a new path typed makes its folders. */
function useFolders(): string[] {
    const [folders, setFolders] = useState<string[]>([]);
    useEffect(() => {
        piper.folders().then(
            (found) => setFolders(found.map((one) => one.path).sort((a, b) => a.localeCompare(b))),
            () => {}, // none to pick from: a path can still be typed
        );
    }, []);
    return folders;
}

function RenameDialog({ diagram, onDone }: { diagram: Diagram; onDone: (changed: Diagram | null) => void }) {
    const [name, setName] = useState(diagram.name);
    const [folder, setFolder] = useState(diagram.folder);
    const folders = useFolders();
    const [description, setDescription] = useState(diagram.description);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function save() {
        setBusy(true);
        try {
            onDone(await piper.change(diagram.id, { name: name.trim(), folder, description }));
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }
    return (
        <Dialog
            title="Rename, move, or describe"
            confirm="Save"
            busy={busy}
            disabled={!name.trim()}
            onConfirm={() => void save()}
            onCancel={() => onDone(null)}
        >
            <label className="field">
                Name
                <input autoFocus value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field">
                Folder
                <FolderPicker
                    value={folder}
                    onChange={setFolder}
                    folders={folders}
                    placeholder="None, or a new one, like Vespula/GSE"
                />
            </label>
            <label className="field">
                Description
                <textarea
                    value={description}
                    rows={3}
                    maxLength={5000}
                    onChange={(event) => setDescription(event.target.value)}
                />
            </label>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}
