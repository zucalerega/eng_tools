import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Notice, usePopover } from "../../components";
import { Link, navigate, useSearch } from "../../router";
import { vaultApi, type CaliperModel, type FileDetail } from "../api";
import { FileIcon, OpenInSolidWorks } from "../components";
import { cadFormat, caliperUrl, fileUrl, kindOf } from "../paths";
import { ComponentTree } from "./ComponentTree";
import { assemblyModel, cadModel, partModel } from "./load";
import { formatLength, measureOne, measureTwo, UNITS } from "./measure";
import { MeasurePanel } from "./MeasurePanel";
import { initiallyHidden, shownNodes, type Model, type Units, type Why } from "./model";
import { Viewer, type Pick, type Section, type View } from "./viewer";
import "./caliper.css";

// Caliper: a part or assembly in 3D, in the browser, to look at and measure, not to change. SolidWorks parts and
// assemblies show their versions' 3D models: the ones Vault for SolidWorks makes, or else the server reads one from the
// 3D view SolidWorks saved in the file. STEP and IGES files are read as they are. At /vault/caliper/<file id>, with
// ?version= and ?configuration= for which.

export function CaliperPage({ id }: { id: number }) {
    const search = useSearch();
    const params = new URLSearchParams(search);
    const askedVersion = Number(params.get("version")) || null;
    const askedConfiguration = params.get("configuration");
    const [detail, setDetail] = useState<FileDetail | null>(null);
    const [models, setModels] = useState<CaliperModel[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    // Versions the server couldn't read a model from ("<file id>:<version>"), with why; and the ones asked for, once
    // each.
    const [unreadable, setUnreadable] = useState<ReadonlyMap<string, string>>(new Map());
    const asked = useRef(new Set<string>());
    const page = useRef<HTMLDivElement>(null);

    // The page takes the rest of the window, under the top bar, however tall that is (it wraps on a phone).
    useLayoutEffect(() => {
        const element = page.current;
        if (!element) {
            return;
        }
        const place = () =>
            element.style.setProperty("--caliper-top", `${element.getBoundingClientRect().top + window.scrollY}px`);
        place();
        window.addEventListener("resize", place);
        return () => window.removeEventListener("resize", place);
    });

    useEffect(() => {
        let current = true;
        (async () => {
            const loaded = await vaultApi.file(id);
            const kind = kindOf(loaded.file.name);
            const found = kind === "part" || kind === "assembly" ? (await vaultApi.caliperModels(id)).models : [];
            if (current) {
                setDetail(loaded);
                setModels(found);
            }
        })().catch((error: Error) => current && setProblem(error.message));
        return () => {
            current = false;
        };
    }, [id]);

    // A SolidWorks version without a model: the server reads one from the file, once.
    const current = detail?.file.id === id ? detail : null;
    const kindHere = current ? kindOf(current.file.name) : null;
    const wanted = current ? (askedVersion ?? current.file.version) : null;
    const why = (version: number) => unreadable.get(`${id}:${version}`);
    const reading =
        models !== null &&
        wanted !== null &&
        (kindHere === "part" || kindHere === "assembly") &&
        !models.some((model) => model.version === wanted) &&
        why(wanted) === undefined;
    useEffect(() => {
        const key = `${id}:${wanted}`;
        if (!reading || wanted === null || asked.current.has(key)) {
            return;
        }
        asked.current.add(key);
        vaultApi.makeCaliperModel(id, wanted).then(
            (model) =>
                setModels((found) =>
                    [...(found ?? []).filter((m) => m.version !== model.version), model].sort(
                        (a, b) => b.version - a.version,
                    ),
                ),
            (error: Error) => setUnreadable((found) => new Map([...found, [key, error.message]])),
        );
    }, [reading, id, wanted]);

    if (problem) {
        return (
            <div className="caliper-page-message">
                <Notice tone="error">{problem}</Notice>
            </div>
        );
    }
    if (!detail || !models) {
        return <p className="muted caliper-page-message">Loading…</p>;
    }
    const file = detail.file;
    const kind = kindOf(file.name);
    const cad = cadFormat(file.name) !== null;
    if (kind !== "part" && kind !== "assembly" && !cad) {
        return (
            <div className="caliper-page-message">
                <Notice tone="info">
                    Caliper shows SolidWorks parts and assemblies, and STEP and IGES files, and {file.name} isn't one.{" "}
                    <Link to={fileUrl(file.id)}>Back to {file.name}</Link>
                </Notice>
            </div>
        );
    }

    if (reading) {
        return (
            <p className="muted caliper-page-message">
                Reading the 3D view SolidWorks saved in v{wanted} of {file.name}…
            </p>
        );
    }

    // The version asked for, or the latest; with none asked for, and the latest unreadable, a SolidWorks file's newest
    // version with a model.
    let version = askedVersion ?? file.version;
    const latestHasNone = !cad && !models.some((model) => model.version === version);
    const fellBack = askedVersion === null && latestHasNone && models.length > 0;
    if (fellBack) {
        version = models[0]!.version;
    }
    const here = models.filter((model) => model.version === version);
    const chosen = here.find((model) => model.configuration === askedConfiguration) ?? here[0] ?? null;
    const withModels = [...new Set(models.map((model) => model.version))];

    return (
        <div className="caliper" ref={page}>
            <header className="caliper-head">
                <h1>
                    <FileIcon name={file.name} />
                    <Link to={fileUrl(file.id)} title="This file's page: its history, what it uses, where it's used">
                        {file.name}
                    </Link>
                </h1>
                <label className="caliper-choice">
                    Version
                    <select
                        value={version}
                        onChange={(event) => navigate(caliperUrl(file.id, Number(event.target.value)))}
                    >
                        {detail.versions.map((v) => (
                            <option key={v.number} value={v.number}>
                                v{v.number}
                                {!cad && why(v.number) !== undefined ? " (no 3D model)" : ""}
                            </option>
                        ))}
                    </select>
                </label>
                {here.length > 1 && chosen && (
                    <label className="caliper-choice">
                        Configuration
                        <select
                            value={chosen.configuration}
                            onChange={(event) => navigate(caliperUrl(file.id, version, event.target.value))}
                        >
                            {here.map((model) => (
                                <option key={model.configuration}>{model.configuration}</option>
                            ))}
                        </select>
                    </label>
                )}
                {here.length === 1 && chosen && <span className="muted">{chosen.configuration}</span>}
                <span className="caliper-head-actions">
                    <OpenInSolidWorks path={file.path} />
                    <a className="button" href={vaultApi.downloadUrl(file.id, version)} download>
                        Download
                    </a>
                </span>
            </header>
            {fellBack && (
                <Notice tone="info">
                    <p>
                        v{file.version}, the latest version, has no 3D model, so this is v{version}.
                    </p>
                    {why(file.version) && <p>{why(file.version)}</p>}
                </Notice>
            )}
            {!cad && !chosen ? (
                <NoModel
                    name={file.name}
                    path={file.path}
                    version={version}
                    why={why(version) ?? null}
                    withModels={withModels}
                    id={file.id}
                />
            ) : (
                <CaliperView
                    key={`${version}|${chosen?.configuration ?? ""}`}
                    fileId={file.id}
                    name={file.name}
                    version={version}
                    model={chosen}
                />
            )}
        </div>
    );
}

function NoModel({
    id,
    name,
    path,
    version,
    why,
    withModels,
}: {
    id: number;
    name: string;
    path: string;
    version: number;
    why: string | null; // what the server said when it couldn't read one from the file
    withModels: number[];
}) {
    return (
        <div className="caliper-page-message">
            <Notice tone="info">
                <p>
                    v{version} of {name} has no 3D model.
                </p>
                {why && <p>{why}</p>}
                <p>
                    Vault for SolidWorks makes models too: when it checks a part or assembly in, or when you open it in
                    SolidWorks and click Make 3D view on the Vault tab.
                </p>
                <p>
                    <OpenInSolidWorks path={path} />
                </p>
                {withModels.length > 0 && (
                    <p>
                        These versions have one:{" "}
                        {withModels.map((number, i) => (
                            <span key={number}>
                                {i > 0 && ", "}
                                <Link to={caliperUrl(id, number)}>v{number}</Link>
                            </span>
                        ))}
                    </p>
                )}
            </Notice>
        </div>
    );
}

interface SectionState extends Section {
    on: boolean;
}

const AXES = ["X", "Y", "Z"] as const;

const VIEW_NAMES: [View, string][] = [
    ["iso", "Isometric"],
    ["front", "Front"],
    ["back", "Back"],
    ["top", "Top"],
    ["bottom", "Bottom"],
    ["left", "Left"],
    ["right", "Right"],
];

/** Ids of the nodes above one, from the top: "2" and "2/0" for "2/0/1". */
const ancestors = (id: string): string[] => {
    const parts = id.split("/");
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
};

function CaliperView({
    fileId,
    name,
    version,
    model: info,
}: {
    fileId: number;
    name: string;
    version: number;
    model: CaliperModel | null; // null: a STEP or IGES file, read as it is
}) {
    const container = useRef<HTMLDivElement>(null);
    const viewer = useRef<Viewer | null>(null);
    const [noWebgl, setNoWebgl] = useState(false);
    const [loaded, setLoaded] = useState<{ model: Model; leftOut: number } | null>(null);
    const [progress, setProgress] = useState<[number, number] | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    const [isolated, setIsolated] = useState<ReadonlySet<string> | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const [measuring, setMeasuring] = useState(false);
    const [picks, setPicks] = useState<Pick[]>([]);
    const [hovering, setHovering] = useState<Pick["entity"] | null>(null);
    const [units, setUnits] = useState<Units>("mm");
    const [edges, setEdges] = useState(true);
    const [perspective, setPerspective] = useState(false);
    const [origin, setOrigin] = useState(false);
    const [sections, setSections] = useState<SectionState[]>(
        ([0, 1, 2] as const).map((axis) => ({ axis, on: false, offset: 0, flipped: false })),
    );
    const [bounds, setBounds] = useState<{ min: number[]; max: number[] } | null>(null);

    // The model, from the vault or from the file.
    useEffect(() => {
        let current = true;
        const loading =
            info === null
                ? cadModel(fileId, version, name).then((model) => ({ model, leftOut: 0 }))
                : info.kind === "part"
                  ? partModel(fileId, info).then((model) => ({ model, leftOut: 0 }))
                  : assemblyModel(fileId, info, (done, total) => current && setProgress([done, total]));
        loading.then(
            (result) => {
                if (!current) {
                    return;
                }
                setLoaded(result);
                setHidden(initiallyHidden(result.model));
                setUnits(result.model.units);
                // A STEP file's top product open, to show what's in it; an assembly's components, each closed.
                const top = result.model.nodes.length === 1 ? result.model.nodes[0] : undefined;
                setOpen(new Set(top && top.children.length > 0 ? [top.id] : []));
                setProgress(null);
            },
            (error: Error) => current && setFailure(error.message),
        );
        return () => {
            current = false;
        };
    }, [fileId, version, name, info]);

    // The view, once there's somewhere to draw it.
    useEffect(() => {
        if (!container.current) {
            return;
        }
        let created: Viewer;
        try {
            created = new Viewer(container.current, {
                select: (node) => {
                    setSelected(node);
                    if (node) {
                        setOpen((previous) => new Set([...previous, ...ancestors(node)]));
                    }
                },
                hover: setHovering,
                pick: (pick) => setPicks((previous) => (previous.length >= 2 ? [pick] : [...previous, pick])),
            });
        } catch {
            setNoWebgl(true);
            return;
        }
        viewer.current = created;
        return () => {
            created.dispose();
            viewer.current = null;
        };
    }, []);

    useEffect(() => {
        const view = viewer.current;
        if (view && loaded) {
            view.setModel(loaded.model);
            const extent = view.bounds();
            setBounds(extent);
            setSections((previous) =>
                previous.map((section) => ({
                    ...section,
                    offset: ((extent.min[section.axis] ?? 0) + (extent.max[section.axis] ?? 0)) / 2,
                })),
            );
        }
    }, [loaded]);

    const shown = useMemo(
        () => (loaded ? shownNodes(loaded.model, hidden, isolated) : new Set<string>()),
        [loaded, hidden, isolated],
    );
    useEffect(() => viewer.current?.setShown(shown), [shown]);
    useEffect(() => viewer.current?.setSelected(new Set(selected ? [selected] : [])), [selected, loaded]);
    useEffect(() => viewer.current?.setEdges(edges), [edges]);
    useEffect(() => viewer.current?.setPerspective(perspective), [perspective]);
    useEffect(() => viewer.current?.setOrigin(origin), [origin]);
    useEffect(() => viewer.current?.setMeasuring(measuring), [measuring]);
    useEffect(() => viewer.current?.setPicked(picks), [picks]);
    useEffect(() => {
        const [first, second] = picks;
        const measurement =
            first && second
                ? measureTwo(first.entity, second.entity, units)
                : first
                  ? measureOne(first.entity, units)
                  : null;
        const line = measurement?.line;
        const text = measurement?.readings[0]?.value ?? "";
        viewer.current?.setAnnotation(line ? { line, text } : null);
    }, [picks, units]);
    useEffect(() => {
        viewer.current?.setSections(sections.filter((section) => section.on));
    }, [sections, loaded]);

    // F to fit, Esc to let go of what's picked, then of measuring, then of what's selected.
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest("input, select, textarea, [contenteditable]") || event.metaKey || event.ctrlKey) {
                return;
            }
            if (event.key === "f" || event.key === "F") {
                viewer.current?.fit();
            } else if (event.key === "Escape") {
                if (picks.length > 0) {
                    setPicks([]);
                } else if (measuring) {
                    setMeasuring(false);
                } else {
                    setSelected(null);
                }
            }
        };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, [picks, measuring]);

    const toggle = (set: ReadonlySet<string>, id: string): Set<string> => {
        const changed = new Set(set);
        if (!changed.delete(id)) {
            changed.add(id);
        }
        return changed;
    };
    const isolate = (id: string) => {
        setIsolated(new Set([id]));
        setHidden((previous) => {
            const changed = new Set(previous);
            [id, ...ancestors(id)].forEach((shownId) => changed.delete(shownId));
            return changed;
        });
        setSelected(id);
        viewer.current?.fit(new Set([id]));
    };
    const missing = loaded ? tallyMissing(loaded.model) : null;
    const isolatedName = isolated && loaded ? nameOf(loaded.model, [...isolated][0]!) : null;

    return (
        <div className="caliper-body">
            <aside className="caliper-side" aria-label="Components">
                <div className="caliper-side-head">
                    <h2>{info?.kind === "part" ? "Bodies" : "Components"}</h2>
                    <button
                        type="button"
                        className="button-small"
                        disabled={isolated === null && hidden.size === 0}
                        onClick={() => {
                            setHidden(new Set());
                            setIsolated(null);
                        }}
                    >
                        Show all
                    </button>
                </div>
                {isolatedName !== null && (
                    <p className="caliper-isolated">
                        Showing only {isolatedName}.{" "}
                        <button type="button" className="button-small" onClick={() => setIsolated(null)}>
                            Show the rest
                        </button>
                    </p>
                )}
                {loaded && loaded.leftOut > 0 && (
                    <p className="caliper-side-note muted">
                        {loaded.leftOut === 1 ? "1 component is" : `${loaded.leftOut} components are`} in folders you
                        can't see, so they're left out.
                    </p>
                )}
                {missing && <NotShown tally={missing} />}
                {loaded && (
                    <ComponentTree
                        nodes={loaded.model.nodes}
                        hidden={hidden}
                        isolated={isolated}
                        selected={selected}
                        open={open}
                        toggleOpen={(id) => setOpen((previous) => toggle(previous, id))}
                        toggleHidden={(id) => setHidden((previous) => toggle(previous, id))}
                        isolate={isolate}
                        select={setSelected}
                        zoomTo={(id) => viewer.current?.fit(new Set([id]))}
                        openHere={info === null ? isolate : undefined}
                    />
                )}
            </aside>
            <section className="caliper-stage" aria-label="3D view">
                <div className="caliper-viewport" ref={container} />
                {!noWebgl && (
                    <div className="caliper-toolbar" role="toolbar" aria-label="View">
                        <button type="button" title="Zoom to show it all (F)" onClick={() => viewer.current?.fit()}>
                            Fit
                        </button>
                        <ViewsMenu choose={(view) => viewer.current?.view(view)} />
                        <SectionsMenu sections={sections} bounds={bounds} units={units} change={setSections} />
                        <button
                            type="button"
                            aria-pressed={measuring}
                            className={measuring ? "caliper-on" : undefined}
                            title="Measure faces, edges, and corners (Esc to stop)"
                            onClick={() => {
                                setMeasuring(!measuring);
                                setPicks([]);
                            }}
                        >
                            Measure
                        </button>
                        <DisplayMenu
                            options={[
                                ["Edges", edges, setEdges],
                                ["Perspective", perspective, setPerspective],
                                ["Axes at the origin", origin, setOrigin],
                            ]}
                        />
                        <label className="caliper-units">
                            <span className="visually-hidden">Units</span>
                            <select value={units} onChange={(event) => setUnits(event.target.value as Units)}>
                                {UNITS.map((unit) => (
                                    <option key={unit}>{unit}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                )}
                {noWebgl && (
                    <div className="caliper-stage-message">
                        <Notice tone="warning">
                            This browser isn't drawing 3D (WebGL is off or unavailable), so Caliper can't show the
                            model. The components are listed beside it.
                        </Notice>
                    </div>
                )}
                {failure && (
                    <div className="caliper-stage-message">
                        <Notice tone="error">{failure}</Notice>
                    </div>
                )}
                {!loaded && !failure && (
                    <p className="caliper-loading-model" role="status">
                        {progress && progress[1] > 0
                            ? `Loading parts: ${progress[0]} of ${progress[1]}…`
                            : info === null
                              ? "Reading the file…"
                              : "Loading the model…"}
                    </p>
                )}
                {measuring && (
                    <MeasurePanel
                        hovering={hovering}
                        picked={picks.map((pick) => pick.entity)}
                        units={units}
                        clear={() => setPicks([])}
                    />
                )}
            </section>
        </div>
    );
}

/** How many components draw nothing, for each sort of reason. */
function tallyMissing(model: Model): Record<Why, number> {
    const tally: Record<Why, number> = { elsewhere: 0, configuration: 0, unreadable: 0, failed: 0 };
    const visit = (nodes: Model["nodes"]) =>
        nodes.forEach((node) => {
            if (node.problem) {
                tally[node.why ?? "unreadable"] += 1;
            }
            visit(node.children);
        });
    visit(model.nodes);
    return tally;
}

/**
 * What an assembly doesn't show, by why, and how to show it: Make 3D view in SolidWorks makes the models of parts in
 * other configurations and of files without a 3D view Caliper reads; parts not in the vault need checking in.
 */
function NotShown({ tally }: { tally: Record<Why, number> }) {
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const { configuration, unreadable, elsewhere, failed } = tally;
    const theirFiles = configuration === 1 ? "its file has" : "their files have";
    const theirParts = elsewhere === 1 ? "its" : "their";
    const reasons = [
        configuration > 0 &&
            `${count(configuration, "part is", "parts are")} in a configuration ${theirFiles} no 3D view of`,
        unreadable > 0 && `${count(unreadable, "part's file has", "parts' files have")} no 3D view Caliper can read`,
        elsewhere > 0 &&
            `${count(elsewhere, "sub-assembly has", "sub-assemblies have")} none of ${theirParts} parts in the vault`,
        failed > 0 && `${count(failed, "part", "parts")} didn't load`,
    ].filter((reason): reason is string => Boolean(reason));
    const total = configuration + unreadable + elsewhere + failed;
    if (total === 0) {
        return null;
    }
    return (
        <div className="caliper-side-note muted">
            <p>{count(total, "component isn't", "components aren't")} shown:</p>
            <ul>
                {reasons.map((reason) => (
                    <li key={reason}>{reason}.</li>
                ))}
            </ul>
            {configuration + unreadable > 0 && (
                <p>
                    Open the assembly in SolidWorks and click Make 3D view on the Vault tab to make those parts' models.
                </p>
            )}
            {elsewhere > 0 && <p>Parts that aren't in the vault show once someone checks them in.</p>}
        </div>
    );
}

function nameOf(model: Model, id: string): string {
    let found = id;
    const visit = (nodes: Model["nodes"]) =>
        nodes.forEach((node) => {
            if (node.id === id) {
                found = node.name;
            }
            visit(node.children);
        });
    visit(model.nodes);
    return found;
}

function ViewsMenu({ choose }: { choose(view: View): void }) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    return (
        <div className="popover" ref={within}>
            <button type="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
                Views
            </button>
            {open && (
                <div className="menu">
                    {VIEW_NAMES.map(([view, label]) => (
                        <button
                            key={view}
                            type="button"
                            className="menu-item"
                            onClick={() => {
                                setOpen(false);
                                choose(view);
                            }}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

function SectionsMenu({
    sections,
    bounds,
    units,
    change,
}: {
    sections: SectionState[];
    bounds: { min: number[]; max: number[] } | null;
    units: Units;
    change(sections: SectionState[]): void;
}) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const on = sections.filter((section) => section.on).length;
    const update = (axis: number, edit: Partial<SectionState>) =>
        change(sections.map((section) => (section.axis === axis ? { ...section, ...edit } : section)));
    return (
        <div className="popover" ref={within}>
            <button
                type="button"
                aria-haspopup="true"
                aria-expanded={open}
                className={on > 0 ? "caliper-on" : undefined}
                onClick={() => setOpen(!open)}
            >
                Section{on > 0 ? ` (${on})` : ""}
            </button>
            {open && (
                <div className="menu caliper-sections">
                    <p className="muted">
                        Cut across X, Y, or Z. With two or three, what's past all of them is cut away.
                    </p>
                    {sections.map((section) => {
                        const axis = AXES[section.axis];
                        const low = bounds?.min[section.axis] ?? 0;
                        const high = bounds?.max[section.axis] ?? 0;
                        return (
                            <div key={axis} className="caliper-section-row">
                                <label className="check">
                                    <input
                                        type="checkbox"
                                        aria-label={`Cut across ${axis}`}
                                        checked={section.on}
                                        onChange={(event) => update(section.axis, { on: event.target.checked })}
                                    />
                                    {axis}
                                </label>
                                <input
                                    type="range"
                                    aria-label={`Where the ${axis} section is`}
                                    min={low}
                                    max={high}
                                    step={(high - low) / 1000 || 1}
                                    value={section.offset}
                                    disabled={!section.on}
                                    onChange={(event) => update(section.axis, { offset: Number(event.target.value) })}
                                />
                                <span className="caliper-section-at">{formatLength(section.offset, units)}</span>
                                <button
                                    type="button"
                                    className="button-small"
                                    aria-pressed={section.flipped}
                                    aria-label={`Flip the ${axis} section`}
                                    title="Cut away the other side"
                                    disabled={!section.on}
                                    onClick={() => update(section.axis, { flipped: !section.flipped })}
                                >
                                    Flip
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function DisplayMenu({ options }: { options: [string, boolean, (on: boolean) => void][] }) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    return (
        <div className="popover" ref={within}>
            <button type="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
                Display
            </button>
            {open && (
                <div className="menu">
                    {options.map(([label, on, set]) => (
                        <label key={label} className="check menu-check">
                            <input type="checkbox" checked={on} onChange={(event) => set(event.target.checked)} />
                            {label}
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
}
