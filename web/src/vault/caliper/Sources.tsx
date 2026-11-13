import { usePopover } from "../../components";
import { formatTime } from "../../format";
import type { CaliperModel } from "../api";
import { walk, type Model, type Source } from "./model";

// Where Caliper's shapes come from, said where they show: the model's in the page's head, with what that means for how
// far it can be trusted; each part's beside its name in an assembly's tree; and how many came from where.

/** Each source, short: in the tree, and in the head's button. */
export const SOURCE_NAMES: Record<Source, string> = {
    solidworks: "Made in SolidWorks",
    saved_view: "SolidWorks' saved 3D view",
    solid: "Caliper's triangles of the solid",
    file: "Read from the file",
    browser: "Read in your browser",
};

/** What each source means for a part's shape. */
export const SOURCE_ABOUT: Record<Source, string> = {
    solidworks:
        "What SolidWorks drew: Vault for SolidWorks saved the triangles SolidWorks shows of it, from the version as it " +
        "was checked in.",
    saved_view:
        "The triangles SolidWorks drew of it when it last saved this version, which it keeps in the file (as eDrawings " +
        "shows it): the same shape SolidWorks shows.",
    solid:
        "The file has no 3D view Caliper reads, so Caliper made its own triangles of the solid SolidWorks saved in it: " +
        "its true shape, to within 0.05% of its size. Its colors may differ from SolidWorks'.",
    file: "Read from the file by an earlier release of the server: from the 3D view SolidWorks saved in it, or its solid.",
    browser: "Read from the file as it is.",
};

// How many parts came from each, in the order they're listed (the most exact first): said of one, and of more.
const COUNTED: [Source, string, string][] = [
    ["solidworks", "made in SolidWorks", "made in SolidWorks"],
    ["saved_view", "from SolidWorks' saved 3D view", "from SolidWorks' saved 3D views"],
    ["file", "read from its file", "read from their files"],
    ["solid", "drawn by Caliper from its solid", "drawn by Caliper from their solids"],
    ["browser", "STEP or IGES file read in your browser", "STEP or IGES files read in your browser"],
];

const MEASURING =
    "Measurements fit the true surfaces through the triangles' corners, which lie on them, so flat, cylindrical, " +
    "conical, and spherical faces measure exactly.";

/** A dot of a source's color, named for screen readers; or only a mark, beside the name in words. */
export function SourceDot({ source, mark = false }: { source: Source; mark?: boolean }) {
    return mark ? (
        <span className={`caliper-source-dot caliper-source-${source}`} aria-hidden="true" />
    ) : (
        <span
            className={`caliper-source-dot caliper-source-${source}`}
            role="img"
            aria-label={SOURCE_NAMES[source]}
            title={`${SOURCE_NAMES[source]}: ${SOURCE_ABOUT[source]}`}
        />
    );
}

/**
 * Where the model shown came from, in the page's head: a part's shape, or where an assembly's parts are (each part's
 * shape says its own in the tree); opened, what that means, who made it and when.
 */
export function ModelSource({ model }: { model: CaliperModel | null }) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const source: Source = model ? model.source : "browser";
    const assembly = model?.kind === "assembly";
    const label = assembly && source === "file" ? "Placed as its file says" : SOURCE_NAMES[source];
    const made = model ? `${model.created_by.name}, ${formatTime(model.created_at)}` : "";
    return (
        <div className="popover caliper-source" ref={within}>
            <button
                type="button"
                className={`caliper-source-button caliper-source-${source}`}
                aria-haspopup="true"
                aria-expanded={open}
                aria-label={`Where it came from: ${label}`}
                title="Where this 3D model came from, and what that means"
                onClick={() => setOpen(!open)}
            >
                <SourceDot source={source} mark />
                {label}
            </button>
            {open && (
                <div className="menu menu-left caliper-source-about" role="dialog" aria-label="Where it came from">
                    {model === null ? (
                        <p>{SOURCE_ABOUT.browser} Nothing is made of it on the server.</p>
                    ) : assembly ? (
                        <>
                            <p>
                                {source === "solidworks"
                                    ? `Where each part is, as SolidWorks had it when Vault for SolidWorks made this model (${made}).`
                                    : `Where each part is, as SolidWorks saved v${model.version} of the assembly in its file.`}
                            </p>
                            <p>Each part's shape says where it came from, beside its name.</p>
                        </>
                    ) : (
                        <>
                            <p>{SOURCE_ABOUT[source]}</p>
                            {source === "solidworks" && <p>{`Made by ${made}.`}</p>}
                        </>
                    )}
                    {model !== null && <p className="muted">{MEASURING}</p>}
                </div>
            )}
        </div>
    );
}

/** How many of an assembly's parts' shapes came from where: one line for each source, with its dot. */
export function ShapeSources({ model }: { model: Model }) {
    const tally = new Map<Source, number>();
    for (const node of walk(model.nodes)) {
        const source = node.shape?.source;
        if (source && node.kind !== "body") {
            tally.set(source, (tally.get(source) ?? 0) + 1);
        }
    }
    if (tally.size === 0) {
        return null;
    }
    return (
        <div className="caliper-side-note caliper-sources">
            <p className="muted">Where the parts' shapes come from:</p>
            <ul>
                {COUNTED.filter(([source]) => tally.has(source)).map(([source, one, many]) => (
                    <li key={source} title={SOURCE_ABOUT[source]}>
                        <SourceDot source={source} mark />
                        {tally.get(source)} {tally.get(source) === 1 ? one : many}
                    </li>
                ))}
            </ul>
        </div>
    );
}
