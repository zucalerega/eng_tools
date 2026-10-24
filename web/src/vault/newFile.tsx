import { useEffect, useState } from "react";
import { vaultApi, type Numbering, type PartKind, type PartNumber, type VaultFile } from "./api";
import { Dialog, Notice } from "../components";
import { solidWorksLink } from "./components";
import { fileUrl, nameProblem, namedAfter, parentOf, partNumberOf, pathKey } from "./paths";
import { Link } from "../router";
import { contentsOf, useVault, type VaultState } from "./store";

// Starting new SolidWorks files from the web app: you name it here, and the add-in on this computer
// makes it (a new link, solidWorksLink), saves it in your workspace, and checks it in, checked out to you.
// Once part numbers are on (docs/vault.md, "Part numbers"), a new part or assembly gets one here first: its name
// is the number, and the title you give it says what it is.

export type NewKind = "part" | "assembly" | "drawing";

const EXTENSIONS: Record<NewKind, string> = { part: ".SLDPRT", assembly: ".SLDASM", drawing: ".SLDDRW" };

const stemOf = (name: string) => (name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name);

export function fileAt(vault: VaultState, path: string): VaultFile | undefined {
    const key = pathKey(path);
    return contentsOf(vault, parentOf(path)).files.find((file) => pathKey(file.path) === key);
}

interface Props {
    kind: NewKind;
    folder: string;
    model?: VaultFile; // what a new drawing shows
    onCancel: () => void;
    onStart: (path: string) => void;
}

/**
 * A new part or assembly in a folder, or a drawing of a part or assembly (in its folder, named after it, as the
 * vault requires). SolidWorks on this computer starts it from your default template, checks it in as version 1,
 * and keeps it checked out to you, so everyone sees it's taken. Parts and assemblies take part numbers, once they're
 * on; until then, and for drawings, you name it.
 */
export function NewFileDialog(props: Props) {
    const [numbering, setNumbering] = useState<{ mode: Numbering["mode"]; kinds: PartKind[] } | null>(null);
    const [ownName, setOwnName] = useState(false);
    useEffect(() => {
        if (props.kind === "drawing") {
            return;
        }
        let current = true;
        Promise.all([vaultApi.numbering(), vaultApi.partKinds()]).then(
            ([state, kinds]) => current && setNumbering({ mode: state.mode, kinds }),
            () => current && setNumbering({ mode: "off", kinds: [] }), // as before part numbers
        );
        return () => {
            current = false;
        };
    }, [props.kind]);
    if (props.kind !== "drawing" && numbering === null) {
        return (
            <Dialog title={`New ${props.kind} in ${props.folder || "the top folder"}`} onCancel={props.onCancel}>
                <p className="muted">Loading…</p>
            </Dialog>
        );
    }
    if (props.kind === "drawing" || numbering === null || numbering.mode === "off" || ownName) {
        return <NamedFileDialog {...props} />;
    }
    return (
        <NumberedFileDialog
            {...props}
            kinds={numbering.kinds}
            onOwnName={numbering.mode === "offer" ? () => setOwnName(true) : undefined}
        />
    );
}

/** A new part or assembly named by a part number: a kind, and a title for it, then the number, then SolidWorks. */
function NumberedFileDialog({
    kind,
    folder,
    kinds,
    onCancel,
    onStart,
    onOwnName,
}: Props & { kinds: PartKind[]; onOwnName?: () => void }) {
    const fitting = kinds.filter((k) => !k.retired && (k.applies === "any" || k.applies === kind));
    const [code, setCode] = useState(fitting[0]?.code ?? "");
    const [title, setTitle] = useState("");
    const [unused, setUnused] = useState<PartNumber[]>([]);
    const [number, setNumber] = useState<PartNumber | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        let current = true;
        vaultApi.myNumbers().then(
            (mine) => current && setUnused(mine.numbers),
            () => undefined, // none to offer
        );
        return () => {
            current = false;
        };
    }, []);
    const yours = unused.filter((n) => fitting.some((k) => k.code === n.kind));
    const fileName = number ? number.number + EXTENSIONS[kind] : "";
    const path = folder ? `${folder}/${fileName}` : fileName;

    async function getNumber() {
        setBusy(true);
        setProblem(null);
        try {
            const [issued] = (await vaultApi.reserveNumbers(code, title.trim())).numbers;
            setNumber(issued!);
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }

    const heading = `New ${kind} in ${folder || "the top folder"}`;
    if (number) {
        return (
            <Dialog
                title={heading}
                confirm="Start it in SolidWorks"
                link
                confirmHref={solidWorksLink("new", path)}
                onConfirm={() => onStart(path)}
                onCancel={onCancel}
            >
                <p>
                    It will be <strong>{path}</strong>
                    {number.title && <>, “{number.title}”</>}.
                </p>
                <p className="muted">
                    {number.number} is yours: SolidWorks on this computer starts it from your default {kind} template,
                    saves it in your Vault workspace, and checks it in as version 1, checked out to you. Not now? It
                    stays yours, offered the next time you start a {kind}.
                </p>
            </Dialog>
        );
    }
    return (
        <Dialog
            title={heading}
            confirm="Get a number"
            busy={busy}
            disabled={code === "" || title.trim() === ""}
            onConfirm={() => void getNumber()}
            onCancel={onCancel}
        >
            <label className="field">
                Kind
                <select value={code} onChange={(event) => setCode(event.target.value)}>
                    {fitting.map((k) => (
                        <option key={k.code} value={k.code}>
                            {k.code} {k.label}
                        </option>
                    ))}
                </select>
            </label>
            <label className="field">
                Title
                <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={kind === "assembly" ? "Fin can" : "Fin bracket"}
                    maxLength={200}
                    autoFocus
                />
            </label>
            <p className="muted">
                Its name is its part number, which the vault hands out, in order, and which never changes; its title
                says what it is, and can change.
            </p>
            {yours.length > 0 && (
                <div className="field">
                    Or use one you got before and haven't used:
                    <ul className="plain">
                        {yours.map((n) => (
                            <li key={n.number}>
                                <button type="button" className="button-small" onClick={() => setNumber(n)}>
                                    {n.number}
                                    {n.title && `, “${n.title}”`}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {onOwnName && (
                <p>
                    <button type="button" className="button-small" onClick={onOwnName}>
                        Name it yourself instead
                    </button>
                </p>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

/** A new file you name: a drawing of a part or assembly, or any file before part numbers are on. */
function NamedFileDialog({ kind, folder, model, onCancel, onStart }: Props) {
    const vault = useVault();
    const [name, setName] = useState(model ? stemOf(model.name) : "");
    const extension = EXTENSIONS[kind];
    const typed = name.trim();
    const fileName = typed.toLowerCase().endsWith(extension.toLowerCase()) ? typed : typed + extension;
    const path = folder ? `${folder}/${fileName}` : fileName;
    const taken = fileAt(vault, path) ?? vault.folders.get(pathKey(path));
    const base = model && stemOf(model.name);
    const problem =
        typed === ""
            ? null
            : (nameProblem(fileName, path) ??
              (taken
                  ? `${taken.path} is already in the vault.`
                  : model && !namedAfter(fileName, model.name)
                    ? `Name it after ${model.name}: "${base}", or "${base}" followed by a space or a symbol, like "${base} - machining".`
                    : !model && partNumberOf(fileName)
                      ? "That's a part number: the vault hands those out, with Get a number."
                      : null));
    return (
        <Dialog
            title={model ? `New drawing of ${model.name}` : `New ${kind} in ${folder || "the top folder"}`}
            confirm="Start it in SolidWorks"
            link
            confirmHref={
                typed === "" || problem ? undefined : solidWorksLink("new", path, model ? { model: model.path } : {})
            }
            onConfirm={() => onStart(path)}
            onCancel={onCancel}
        >
            <label className="field">
                Name
                <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={kind === "assembly" ? "Fin Can" : "Fin Bracket"}
                    autoFocus
                    aria-invalid={problem !== null}
                />
            </label>
            {problem ? (
                <p className="field-problem" role="alert">
                    {problem}
                </p>
            ) : (
                typed !== "" && <p className="muted">It will be {path}</p>
            )}
            <p className="muted">
                {model
                    ? `SolidWorks on this computer starts it from your default drawing template, with a view of ${model.name}`
                    : `SolidWorks on this computer starts it from your default ${kind} template`}
                , saves it in your Vault workspace, and checks it in as version 1, checked out to you, so everyone sees
                it's yours while you work on it.
            </p>
        </Dialog>
    );
}

/** A new file on its way from SolidWorks on this computer, then there. */
export function StartedNotice({ path, onDismiss }: { path: string; onDismiss: () => void }) {
    const vault = useVault();
    const arrived = fileAt(vault, path);
    return arrived ? (
        <Notice>
            <Link to={fileUrl(arrived.id)}>{arrived.name}</Link> is in the vault, checked out to you. Finish it in
            SolidWorks, then check it in.{" "}
            <button type="button" className="button-small" onClick={onDismiss}>
                OK
            </button>
        </Notice>
    ) : (
        <Notice>
            Starting {path.slice(path.lastIndexOf("/") + 1)} in SolidWorks on this computer. It shows up here once
            SolidWorks has saved it. (This needs the Vault add-in for SolidWorks.){" "}
            <button type="button" className="button-small" onClick={onDismiss}>
                Dismiss
            </button>
        </Notice>
    );
}
