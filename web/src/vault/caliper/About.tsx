import type { ReactNode } from "react";
import { formatDate } from "../../format";
import { Link } from "../../router";
import type { CaliperModel } from "../api";
import { caliperUrl } from "../paths";
import type { Source, Tally } from "./model";

// What Caliper is showing, said plainly where nobody can miss it: which version (and whether that's the latest), where
// the view is from, and, for an assembly, how much of it is there. A view is only useful if you can trust it, so this
// says when to and when not to: a check for a view that's the latest and exact, a warning for one that isn't the latest
// or that's missing parts, and a note for one the server rebuilt from a solid.

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Where a model is from, as a sentence about it. */
function sourceOf(model: CaliperModel): string {
    const layout = model.kind === "assembly";
    switch (model.source) {
        case "solidworks":
            return layout
                ? `Its layout is from SolidWorks: ${model.created_by.name} made it there on ${formatDate(model.created_at)}.`
                : `From SolidWorks: ${model.created_by.name} made this view there on ${formatDate(model.created_at)}.`;
        case "view":
            return "Read from the file: the 3D view SolidWorks saved in it.";
        case "solid":
            return (
                "Rebuilt from the solid in the file, which has no saved 3D view of this configuration: its shape and " +
                "sizes are the part's, but colors, and what's only drawn on it (cosmetic threads), may differ. " +
                "Checking it in from SolidWorks gives its exact view."
            );
        case "file":
            return layout
                ? "Its layout is read from the file: where SolidWorks last saved each component."
                : "Read from the file.";
    }
}

/** How many parts are from where: "380 from SolidWorks, 30 read from their files". */
export function sourcesOf(sources: Record<Source, number>): string {
    const read = sources.view + sources.file;
    return [
        sources.solidworks > 0 && `${sources.solidworks} from SolidWorks`,
        read > 0 && `${read} read from ${read === 1 ? "its file" : "their files"}`,
        sources.cad > 0 &&
            `${count(sources.cad, "STEP or IGES file", "STEP or IGES files")} read as ${sources.cad === 1 ? "it is" : "they are"}`,
        sources.solid > 0 && `${sources.solid} rebuilt from ${sources.solid === 1 ? "its solid" : "their solids"}`,
    ]
        .filter((part): part is string => Boolean(part))
        .join(", ");
}

/** How much of an assembly is shown, and from where. */
function partsOf(tally: Tally, latest: boolean): string {
    const each = latest ? "each as it is now" : "each as it was then";
    const all = tally.shown === tally.parts;
    const shown = all
        ? `${tally.parts === 1 ? "Its part is" : `All ${tally.parts} parts are`} shown, ${each}`
        : `${tally.shown} of ${count(tally.parts, "part is", "parts are")} shown, ${each}`;
    const standIns = tally.older + tally.reconfigured;
    const caveats = [
        standIns > 0 && `${count(standIns, "shows", "show")} something else in place of what's wanted`,
        tally.layouts > 0 && `${count(tally.layouts, "sub-assembly shows", "sub-assemblies show")} an older layout`,
    ].filter((part): part is string => Boolean(part));
    const from =
        tally.shown > 0 && tally.sources.solidworks === tally.shown
            ? `${tally.shown === 1 ? "It's" : "All are"} from SolidWorks.`
            : tally.shown > 0
              ? `${sourcesOf(tally.sources)}.`
              : "";
    return `${shown}${caveats.length > 0 ? `; ${caveats.join(", and ")}` : ""}. ${from}`.trim();
}

type Tone = "ok" | "note" | "warning" | "loading";

/**
 * The strip under Caliper's header: the version shown and whether it's the latest; where its view is from; and, of an
 * assembly once it's loaded, how much of it is shown. model is null for a STEP, IGES, or STL file, read as it is.
 */
export function About({
    fileId,
    version,
    latest,
    model,
    tally,
    children,
}: {
    fileId: number;
    version: number;
    latest: number; // the file's latest version
    model: CaliperModel | null;
    tally: Tally | null; // an assembly's, once it's loaded
    children?: ReactNode;
}) {
    const current = version === latest;
    const assembly = model?.kind === "assembly";
    const versionText = current
        ? `Version ${version}, the latest.`
        : `Version ${version} of ${latest}: not the latest.`;
    const incomplete =
        tally !== null &&
        (tally.shown < tally.parts ||
            tally.older + tally.reconfigured + tally.layouts > 0 ||
            Object.values(tally.missing).some((n) => n > 0));
    const rebuilt = assembly ? tally !== null && tally.sources.solid > 0 : model?.source === "solid";
    const tone: Tone =
        !current || incomplete ? "warning" : assembly && tally === null ? "loading" : rebuilt ? "note" : "ok";
    const mark = { ok: "✓", note: "≈", warning: "!", loading: "…" }[tone];
    return (
        <div className={`caliper-about caliper-about-${tone}`} role="status" aria-label="What this view shows">
            <span className="caliper-about-mark" aria-hidden="true">
                {mark}
            </span>
            <p>
                <strong>{versionText}</strong>{" "}
                {!current && (
                    <>
                        <Link to={caliperUrl(fileId)}>Show version {latest}</Link>.{" "}
                    </>
                )}
                {model === null ? "Read from the file as it is, in your browser." : sourceOf(model)}
                {assembly && tally !== null && <> {partsOf(tally, current)}</>}
                {children}
            </p>
        </div>
    );
}

/**
 * What an assembly doesn't show, or shows something else in place of, by why, and how to mend each; and what changed
 * since it was checked in. Beside the tree, where each component says its own.
 */
export function Details({ tally, latest }: { tally: Tally; latest: boolean }) {
    const { absent, configuration, unreadable, inside, elsewhere, failed } = tally.missing;
    const none = configuration + unreadable;
    const missing = [
        absent > 0 && `${count(absent, "part's file isn't", "parts' files aren't")} in the vault`,
        none > 0 && `${count(none, "part's file has", "parts' files have")} no 3D view Caliper can read`,
        inside > 0 &&
            `${count(inside, "part is", "parts are")} kept inside ${inside === 1 ? "its assembly" : "their assemblies"} (routed tubes) with no shape there that Caliper found`,
        elsewhere > 0 && `${count(elsewhere, "sub-assembly has", "sub-assemblies have")} no components`,
        failed > 0 && `${count(failed, "part", "parts")} didn't load`,
    ].filter((reason): reason is string => Boolean(reason));
    const total = absent + none + inside + elsewhere + failed;
    const standIns = [
        tally.older > 0 &&
            `${count(tally.older, "part shows", "parts show")} an older version: ${tally.older === 1 ? "its" : "their"} latest has no 3D view Caliper can read`,
        tally.reconfigured > 0 &&
            `${count(tally.reconfigured, "part shows", "parts show")} another configuration than the assembly uses: ${tally.reconfigured === 1 ? "its file has" : "their files have"} no 3D view of that one`,
        tally.layouts > 0 &&
            `${count(tally.layouts, "sub-assembly shows", "sub-assemblies show")} the components ${tally.layouts === 1 ? "it" : "they"} had when this assembly was checked in: ${tally.layouts === 1 ? "its" : "their"} latest has no 3D view yet`,
    ].filter((reason): reason is string => Boolean(reason));
    if (total === 0 && standIns.length === 0 && tally.changed === 0 && tally.deleted === 0) {
        return null;
    }
    return (
        <div className="caliper-side-note muted">
            {total > 0 && (
                <>
                    <p>{count(total, "component isn't", "components aren't")} shown:</p>
                    <ul>
                        {missing.map((reason) => (
                            <li key={reason}>{reason}.</li>
                        ))}
                    </ul>
                </>
            )}
            {standIns.length > 0 && (
                <>
                    <p>Shown, but not as the assembly has them:</p>
                    <ul>
                        {standIns.map((reason) => (
                            <li key={reason}>{reason}.</li>
                        ))}
                    </ul>
                </>
            )}
            {total - failed + standIns.length > 0 && (
                <p>
                    To mend those, open the assembly in SolidWorks and click Make 3D view on the Vault tab, or check it
                    in from there: SolidWorks then gives Caliper every part as it shows it.
                </p>
            )}
            {failed > 0 && <p>Reload the page to try the ones that didn't load again.</p>}
            {tally.deleted > 0 && (
                <p>{count(tally.deleted, "component's file is", "components' files are")} in the trash.</p>
            )}
            {latest && tally.changed > 0 && (
                <p>
                    {count(tally.changed, "component was", "components were")} checked in after this assembly was:{" "}
                    {tally.changed === 1 ? "it shows" : "they show"} as {tally.changed === 1 ? "it is" : "they are"}{" "}
                    now, where the assembly last had {tally.changed === 1 ? "it" : "them"}.
                </p>
            )}
        </div>
    );
}
