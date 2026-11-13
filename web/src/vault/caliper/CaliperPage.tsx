import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Notice, usePopover } from "../../components";
import { Link, navigate, useSearch } from "../../router";
import { vaultApi, type CaliperConfigurations, type CaliperModel, type CaliperParts, type FileDetail } from "../api";
import { FileIcon, OpenInSolidWorks } from "../components";
import { caliperUrl, fileFormat, fileUrl, kindOf, sheetFormat } from "../paths";
import { ComponentTree } from "./ComponentTree";
import { useBelowTopBar } from "./layout";
import { assemblyModel, cadModel, partModel } from "./load";
import { formatLength, measureOne, measureTwo, UNITS } from "./measure";
import { MeasurePanel } from "./MeasurePanel";
import { ModelSource, ShapeSources } from "./Sources";
import { unlessBusy } from "./turns";
import { initiallyHidden, shownNodes, walk, type Model, type Units, type Why } from "./model";
import { Viewer, type Pick, type Section, type View } from "./viewer";
import "./caliper.css";

// Caliper: a part or assembly in 3D, in the browser, to look at and measure, not to change. SolidWorks parts and
// assemblies show their versions' 3D models: the ones Vault for SolidWorks makes, or else the server reads one from the
// 3D view SolidWorks saved in the file, or another configuration's from the solid SolidWorks kept of it. STEP, IGES, and
// STL files are read as they are. At /vault/caliper/<file id>, with ?version= and ?configuration= for which. Drawings
// and DXF files are flat: DrawingPage shows them.

// The vault's routes send drawings and DXF files to their own page, without this one or three.js; here it's only for a
// file the vault's index doesn't have (one in the trash, say).
const DrawingPage = lazy(() => import("./DrawingPage").then((module) => ({ default: module.DrawingPage })));

export function CaliperPage({ id }: { id: number }) {
    const search = useSearch();
    const params = new URLSearchParams(search);
    const askedVersion = Number(params.get("version")) || null;
    const askedConfiguration = params.get("configuration") || null;
    const askedParts = ((value) => (value === "latest" || value === "checked_in" ? value : null))(params.get("parts"));
    const [detail, setDetail] = useState<FileDetail | null>(null);
    const [models, setModels] = useState<CaliperModel[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    // Versions the server couldn't read a model from ("<file id>:<version>", and with ":<configuration>" in one asked
    // for), with why; and the ones asked for, once each.
    const [unreadable, setUnreadable] = useState<ReadonlyMap<string, string>>(new Map());
    const asked = useRef(new Set<string>());
    // The configurations of the version shown ("<file id>:<version>"), as its file lists them; null where they couldn't
    // be had, and those with models are offered.
    const [listed, setListed] = useState<{ key: string; found: CaliperConfigurations | null } | null>(null);
    const page = useRef<HTMLDivElement>(null);
    useBelowTopBar(page);

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

    // A SolidWorks version without a model: the server reads one from the file, once. So does one without a model in
    // the configuration asked for, where the file kept that configuration.
    const current = detail?.file.id === id ? detail : null;
    const kindHere = current ? kindOf(current.file.name) : null;
    const solidWorks = kindHere === "part" || kindHere === "assembly";
    const wanted = current ? (askedVersion ?? current.file.version) : null;
    const why = (version: number, configuration: string | null = null) =>
        unreadable.get(modelKey(id, version, configuration));
    const reading =
        models !== null &&
        wanted !== null &&
        solidWorks &&
        !models.some(
            (model) =>
                model.version === wanted && (askedConfiguration === null || model.configuration === askedConfiguration),
        ) &&
        why(wanted, askedConfiguration) === undefined;
    useEffect(() => {
        const key = wanted === null ? null : modelKey(id, wanted, askedConfiguration);
        if (!reading || wanted === null || key === null || asked.current.has(key)) {
            return;
        }
        asked.current.add(key);
        unlessBusy(() => vaultApi.makeCaliperModel(id, wanted, askedConfiguration ?? undefined)).then(
            (model) =>
                setModels((found) =>
                    [
                        ...(found ?? []).filter(
                            (m) => m.version !== model.version || m.configuration !== model.configuration,
                        ),
                        model,
                    ].sort((a, b) => b.version - a.version),
                ),
            (error: Error) => setUnreadable((found) => new Map([...found, [key, error.message]])),
        );
    }, [reading, id, wanted, askedConfiguration]);

    // The configurations of the version shown, to choose from (once it's known which that is).
    const shown =
        current && models && solidWorks && !(reading && askedConfiguration === null)
            ? shownVersion(current.file.version, models, askedVersion, askedConfiguration, false).version
            : null;
    useEffect(() => {
        if (shown === null) {
            return;
        }
        let live = true;
        const key = `${id}:${shown}`;
        vaultApi.caliperConfigurations(id, shown).then(
            (found) => live && setListed({ key, found }),
            () => live && setListed({ key, found: null }), // those with models are offered
        );
        return () => {
            live = false;
        };
    }, [id, shown]);

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
    const cad = fileFormat(file.name) !== null;
    if (sheetFormat(file.name) !== null) {
        return (
            <Suspense fallback={<p className="muted caliper-page-message">Loading…</p>}>
                <DrawingPage id={id} />
            </Suspense>
        );
    }
    if (kind !== "part" && kind !== "assembly" && !cad) {
        return (
            <div className="caliper-page-message">
                <Notice tone="info">
                    Caliper shows SolidWorks parts, assemblies, and drawings, and STEP, IGES, STL, and DXF files, and{" "}
                    {file.name} isn't one. <Link to={fileUrl(file.id)}>Back to {file.name}</Link>
                </Notice>
            </div>
        );
    }

    if (reading && askedConfiguration === null) {
        return (
            <p className="muted caliper-page-message">
                Reading the 3D view SolidWorks saved in v{wanted} of {file.name}…
            </p>
        );
    }

    const { version, fellBack } = shownVersion(file.version, models, askedVersion, askedConfiguration, cad);
    const here = models.filter((model) => model.version === version);
    const fromFile = listed?.key === `${id}:${version}` ? listed.found : null;
    const savedIn = fromFile?.configurations.find((c) => c.active)?.name;
    // The configuration asked for; or else the one SolidWorks saved the file in, or the first made (which it usually
    // is).
    const chosen =
        askedConfiguration === null
            ? (here.find((model) => model.configuration === savedIn) ?? here[0] ?? null)
            : (here.find((model) => model.configuration === askedConfiguration) ?? null);
    const withModels = [...new Set(models.map((model) => model.version))];
    // The configurations to choose from: the file's, then any others with models, and the one asked for. Those without
    // a model the server can read say so: SolidWorks didn't keep them, or the server said why not.
    const configurations = [
        ...new Set([
            ...(fromFile?.configurations.map((c) => c.name) ?? []),
            ...here.map((model) => model.configuration),
            ...(askedConfiguration === null ? [] : [askedConfiguration]),
        ]),
    ];
    const without = (name: string) =>
        !here.some((model) => model.configuration === name) &&
        (why(version, name) !== undefined ||
            fromFile?.configurations.some((c) => c.name === name && !c.saved && !c.model) === true);
    const showing = chosen?.configuration ?? askedConfiguration ?? savedIn ?? "";
    // An assembly's parts: each at its latest, as SolidWorks shows it with the latest files; or, for an older version
    // asked for, as it was checked in. Either, where asked.
    const parts: CaliperParts =
        askedParts ?? (askedVersion !== null && askedVersion !== file.version ? "checked_in" : "latest");

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
                        onChange={(event) =>
                            navigate(
                                caliperUrl(
                                    file.id,
                                    Number(event.target.value),
                                    askedConfiguration ?? undefined,
                                    askedParts ?? undefined,
                                ),
                            )
                        }
                    >
                        {detail.versions.map((v) => {
                            const notes = [
                                v.number === file.version && "latest",
                                !cad && why(v.number) !== undefined && "no 3D model",
                            ].filter(Boolean);
                            return (
                                <option key={v.number} value={v.number}>
                                    {`v${v.number}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`}
                                </option>
                            );
                        })}
                    </select>
                </label>
                {!cad && configurations.length > 1 && (
                    <label className="caliper-choice">
                        Configuration
                        <select
                            value={showing}
                            onChange={(event) =>
                                navigate(caliperUrl(file.id, version, event.target.value, askedParts ?? undefined))
                            }
                        >
                            {configurations.map((name) => (
                                <option key={name} value={name}>
                                    {name}
                                    {without(name) ? " (no 3D model)" : ""}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                {!cad && configurations.length === 1 && <span className="muted">{configurations[0]}</span>}
                {chosen?.kind === "assembly" && (
                    <label
                        className="caliper-choice"
                        title="Each part at its latest version, or at the one this version of the assembly was checked in with"
                    >
                        Parts
                        <select
                            value={parts}
                            onChange={(event) =>
                                navigate(
                                    caliperUrl(
                                        file.id,
                                        askedVersion ?? undefined,
                                        askedConfiguration ?? undefined,
                                        event.target.value as CaliperParts,
                                    ),
                                )
                            }
                        >
                            <option value="latest">Latest versions</option>
                            <option value="checked_in">As checked in</option>
                        </select>
                    </label>
                )}
                {!reading && (cad || chosen) && <ModelSource model={cad ? null : chosen} />}
                <span className="caliper-head-actions">
                    <OpenInSolidWorks path={file.path} />
                    <a className="button" href={vaultApi.downloadUrl(file.id, version)} download>
                        Download
                    </a>
                </span>
            </header>
            {fellBack && (
                <Notice tone="warning">
                    <p>
                        <strong>This isn't the latest version.</strong> v{file.version}, the latest, has no 3D model, so
                        this is v{version}.
                    </p>
                    {why(file.version) && <p>{why(file.version)}</p>}
                </Notice>
            )}
            {reading ? (
                <p className="muted caliper-page-message">
                    Reading the {askedConfiguration} configuration of v{version} of {file.name}…
                </p>
            ) : !cad && !chosen ? (
                <NoModel
                    name={file.name}
                    path={file.path}
                    version={version}
                    configuration={askedConfiguration}
                    why={why(version, askedConfiguration) ?? null}
                    withModels={withModels}
                    configurationsWithModels={here.map((model) => model.configuration)}
                    id={file.id}
                />
            ) : (
                <CaliperView
                    key={`${version}|${chosen?.configuration ?? ""}|${parts}`}
                    fileId={file.id}
                    name={file.name}
                    version={version}
                    model={chosen}
                    parts={parts}
                    setParts={(changed) =>
                        navigate(
                            caliperUrl(file.id, askedVersion ?? undefined, askedConfiguration ?? undefined, changed),
                        )
                    }
                />
            )}
        </div>
    );
}

/** What a model is asked for by: a file's version, and the configuration asked for, if one was. */
const modelKey = (id: number, version: number, configuration: string | null = null) =>
    configuration === null ? `${id}:${version}` : `${id}:${version}:${configuration}`;

/**
 * The version to show: the one asked for, or the latest; with neither it nor a configuration asked for, and the latest
 * without a model (the server couldn't read one), a SolidWorks file's newest version that has one (fellBack).
 */
function shownVersion(
    latest: number,
    models: CaliperModel[],
    askedVersion: number | null,
    askedConfiguration: string | null,
    cad: boolean,
): { version: number; fellBack: boolean } {
    const version = askedVersion ?? latest;
    const fellBack =
        askedVersion === null &&
        askedConfiguration === null &&
        !cad &&
        models.length > 0 &&
        !models.some((model) => model.version === version);
    return { version: fellBack ? models[0]!.version : version, fellBack };
}

function NoModel({
    id,
    name,
    path,
    version,
    configuration,
    why,
    withModels,
    configurationsWithModels,
}: {
    id: number;
    name: string;
    path: string;
    version: number;
    configuration: string | null; // the one asked for
    why: string | null; // what the server said when it couldn't read one from the file
    withModels: number[];
    configurationsWithModels: string[]; // of this version
}) {
    return (
        <div className="caliper-page-message">
            <Notice tone="info">
                <p>
                    {configuration === null
                        ? `v${version} of ${name} has no 3D model.`
                        : `The ${configuration} configuration of v${version} of ${name} has no 3D model.`}
                </p>
                {why && <p>{why}</p>}
                {configuration === null ? (
                    <p>
                        Vault for SolidWorks makes models too: when it checks a part or assembly in, or when you open it
                        in SolidWorks and click Make 3D view on the Vault tab.
                    </p>
                ) : (
                    <p>
                        Vault for SolidWorks makes models too, of the configuration SolidWorks shows when it checks a
                        part or assembly in.
                    </p>
                )}
                <p>
                    <OpenInSolidWorks path={path} />
                </p>
                {configuration !== null && configurationsWithModels.length > 0 && (
                    <p>
                        These configurations of v{version} have one:{" "}
                        {configurationsWithModels.map((other, i) => (
                            <span key={other}>
                                {i > 0 && ", "}
                                <Link to={caliperUrl(id, version, other)}>{other}</Link>
                            </span>
                        ))}
                    </p>
                )}
                {configuration === null && withModels.length > 0 && (
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
    parts,
    setParts,
}: {
    fileId: number;
    name: string;
    version: number;
    model: CaliperModel | null; // null: a STEP or IGES file, read as it is
    parts: CaliperParts; // an assembly's: as checked in, or each at its latest
    setParts(parts: CaliperParts): void;
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
                  : assemblyModel(fileId, info, parts, (done, total) => current && setProgress([done, total]));
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
    }, [fileId, version, name, info, parts]);

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
                {loaded && info?.kind === "assembly" && (
                    <PartVersions model={loaded.model} version={version} parts={parts} setParts={setParts} />
                )}
                {missing && <NotShown tally={missing} />}
                {loaded && info?.kind === "assembly" && <ShapeSources model={loaded.model} />}
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
                        one={measureOne}
                        two={measureTwo}
                        hint="Click a face, an edge, or a corner. Click a second to measure between them; a third starts over."
                    />
                )}
            </section>
        </div>
    );
}

/**
 * Which versions of an assembly's parts show, where that matters: at their latest, those changed since the assembly was
 * checked in, which are where it put the versions it was checked in with, and those whose latest has no 3D model, which
 * show that version instead; as checked in, how many have newer versions, and the way to see them.
 */
function PartVersions({
    model,
    version,
    parts,
    setParts,
}: {
    model: Model;
    version: number;
    parts: CaliperParts;
    setParts(parts: CaliperParts): void;
}) {
    const nodes = [...walk(model.nodes)].filter((node) => node.file);
    const newer = nodes.filter((node) => node.checkedIn != null && node.checkedIn !== node.file!.version);
    const older = nodes.filter((node) => node.older);
    const behind = nodes.filter((node) => node.latest !== undefined && node.latest > node.file!.version);
    // "2 parts and 1 sub-assembly"
    const what = (found: Model["nodes"]) => {
        const subs = found.filter((node) => node.kind === "assembly").length;
        const parts = found.length - subs;
        return [
            parts > 0 && `${parts} ${parts === 1 ? "part" : "parts"}`,
            subs > 0 && `${subs} ${subs === 1 ? "sub-assembly" : "sub-assemblies"}`,
        ]
            .filter(Boolean)
            .join(" and ");
    };
    if (parts === "checked_in") {
        return behind.length === 0 ? null : (
            <div className="caliper-side-note caliper-versions">
                <p>
                    {what(behind)} {behind.length === 1 ? "has a newer version" : "have newer versions"} than v{version}{" "}
                    was checked in with.
                </p>
                <button type="button" className="button-small" onClick={() => setParts("latest")}>
                    Show the latest
                </button>
            </div>
        );
    }
    if (newer.length === 0 && older.length === 0) {
        return null;
    }
    const one = newer.length === 1;
    return (
        <div className="caliper-side-note caliper-versions">
            {newer.length > 0 && (
                <p>
                    {what(newer)} changed since v{version} was checked in, and {one ? "shows" : "show"} at{" "}
                    {one ? "its" : "their"} latest, where the assembly had the older version. If a change moved what a
                    part's mates hold, check the assembly in again from SolidWorks.
                </p>
            )}
            {older.length > 0 && (
                <p>
                    {what(older)} {older.length === 1 ? "shows" : "show"} the version v{version} was checked in with:
                    the latest has no 3D model yet (Not latest, beside {older.length === 1 ? "it" : "each"}, says why).
                </p>
            )}
            <button type="button" className="button-small" onClick={() => setParts("checked_in")}>
                Show it as checked in
            </button>
        </div>
    );
}

/** How many components draw nothing, for each sort of reason. */
function tallyMissing(model: Model): Record<Why, number> {
    const tally: Record<Why, number> = { elsewhere: 0, configuration: 0, unreadable: 0, inside: 0, failed: 0 };
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
 * other configurations, of files without a 3D view Caliper reads, and of parts kept inside an assembly with no shape
 * there that Caliper found (routed tubes); parts not in the vault need checking in.
 */
function NotShown({ tally }: { tally: Record<Why, number> }) {
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const { configuration, unreadable, inside, elsewhere, failed } = tally;
    const theirFiles = configuration === 1 ? "its file has" : "their files have";
    const theirParts = elsewhere === 1 ? "its" : "their";
    const reasons = [
        configuration > 0 &&
            `${count(configuration, "part is", "parts are")} in a configuration ${theirFiles} no 3D view of`,
        unreadable > 0 && `${count(unreadable, "part's file has", "parts' files have")} no 3D view Caliper can read`,
        inside > 0 &&
            `${count(inside, "part is", "parts are")} kept inside ${inside === 1 ? "its assembly" : "their assemblies"} (routed tubes) with no shape there that Caliper found`,
        elsewhere > 0 &&
            `${count(elsewhere, "sub-assembly has", "sub-assemblies have")} none of ${theirParts} parts in the vault`,
        failed > 0 && `${count(failed, "part", "parts")} didn't load`,
    ].filter((reason): reason is string => Boolean(reason));
    const total = configuration + unreadable + inside + elsewhere + failed;
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
            {configuration + unreadable + inside > 0 && (
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
