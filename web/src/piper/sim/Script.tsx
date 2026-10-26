import { useEffect, useState } from "react";
import { Dialog, Notice } from "../../components";
import { simApi, type AnchorPick, type ScriptLibrary, type ScriptRequest } from "./api";

// The simulation's script, to read: the FullFlow code a run of the P&ID's model runs on the server, as Yorg writes it
// (for the run as it's set up, with the last anchored run's anchors if asked), and the files it imports (yorg_models).

const MODEL_FILE = "model.py";

export function ScriptDialog({
    request,
    anchors,
    onClose,
}: {
    request: ScriptRequest; // the run as it's set up
    anchors: AnchorPick[]; // the last anchored run's, to write its script with (none: there's been none)
    onClose: () => void;
}) {
    const [anchored, setAnchored] = useState(false);
    const [script, setScript] = useState<string | null>(null);
    const [library, setLibrary] = useState<ScriptLibrary | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [file, setFile] = useState(MODEL_FILE);
    const [copied, setCopied] = useState(false);
    const message = (error: unknown) => setProblem(error instanceof Error ? error.message : String(error));

    useEffect(() => {
        simApi.library().then(setLibrary, message);
    }, []);
    // The run as it was set up when this opened: with the anchors, or not.
    useEffect(() => {
        setScript(null);
        setProblem(null);
        simApi.script(anchored ? { ...request, anchors } : request).then((found) => setScript(found.script), message);
    }, [anchored]);

    const files = [MODEL_FILE, ...Object.keys(library?.files ?? {})];
    const text = file === MODEL_FILE ? script : (library?.files[file] ?? null);
    const fullflow = library?.packages.find((one) => one.toLowerCase().startsWith("fullflow=="))?.split("==")[1];
    return (
        <Dialog title="The simulation's script" cancel="Close" onCancel={onClose} tall wide>
            <p className="muted piper-small">
                The FullFlow code that runs the P&amp;ID&apos;s model on the server
                {fullflow ? ` (FullFlow ${fullflow})` : ""}, written from it for the run as it&apos;s set up: each part
                adds its components to the network, and the run solves it. To read, or copy: Run runs it as it is.
            </p>
            <div className="piper-sim-files" role="group" aria-label="Files">
                {files.map((one) => (
                    <button key={one} type="button" aria-pressed={one === file} onClick={() => setFile(one)}>
                        {one}
                    </button>
                ))}
                {anchors.length > 0 && (
                    <label
                        className="check piper-small"
                        title="As the last anchored run (Tune…) ran: its script, without its fit of what its anchors don't settle"
                    >
                        <input
                            type="checkbox"
                            checked={anchored}
                            onChange={(event) => setAnchored(event.target.checked)}
                        />
                        With its anchors
                    </label>
                )}
                {text !== null && navigator.clipboard && (
                    <button
                        type="button"
                        className="button-small"
                        onClick={() =>
                            void navigator.clipboard.writeText(text).then(
                                () => setCopied(true),
                                () => setCopied(false),
                            )
                        }
                    >
                        {copied ? "Copied" : "Copy"}
                    </button>
                )}
            </div>
            {problem ? (
                <Notice tone="error">{problem}</Notice>
            ) : text === null ? (
                <p className="muted">Writing the script…</p>
            ) : (
                <pre className="piper-sim-code" aria-label={file} tabIndex={0}>
                    <code>{text}</code>
                </pre>
            )}
        </Dialog>
    );
}
