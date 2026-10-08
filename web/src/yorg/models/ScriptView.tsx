import { useState } from "react";
import { Notice } from "../../components";
import { CodeEditor, type EditorKeys, type RunError } from "../scripts/CodeEditor";
import type { ScriptLibrary } from "./api";

// The Models page's Script view: the model as the FullFlow script that runs it (script.py writes it on the server, from
// the P&ID), to read and change; and the files it imports from Yorg (yorg_models), to read. Run runs the script as
// it's shown: on the server while it's as written, in the browser once it's changed (ModelsPage.tsx).

export const MODEL_FILE = "model.py";

interface Props {
    script: string | null; // as written from the P&ID (null: not yet)
    problem: string | null; // why there's no script: the model can't run as it is
    text: string; // what's in the editor
    onChange: (text: string) => void;
    changed: boolean;
    stale: boolean; // changed, and the P&ID or the run's settings have changed since it was written
    onReset: () => void;
    library: ScriptLibrary | null;
    note: string | null; // about how it's written: the window it's for
    anchors: { offered: boolean; on: boolean; onChange: (on: boolean) => void }; // with Anchor…'s last anchors
    error: RunError | null; // where its last run in the browser failed
    onRun: () => void;
}

const nothing = () => {};

export function ScriptView(props: Props) {
    const [file, setFile] = useState(MODEL_FILE);
    const files = [MODEL_FILE, ...Object.keys(props.library?.files ?? {})];
    const shown = files.includes(file) ? file : MODEL_FILE;
    const keys: EditorKeys = {
        run: props.onRun,
        runNext: props.onRun,
        runInsert: nothing,
        save: nothing,
        leave: nothing,
        up: nothing,
        down: nothing,
    };
    return (
        <section className="dev-script" aria-label="Script">
            <div className="dev-script-head">
                <div className="dev-segmented" role="group" aria-label="Files">
                    {files.map((one) => (
                        <button key={one} type="button" aria-pressed={one === shown} onClick={() => setFile(one)}>
                            {one}
                        </button>
                    ))}
                </div>
                <span className="muted dev-script-state" role="status">
                    {shown !== MODEL_FILE
                        ? "Yorg's own, which the script imports: to read"
                        : props.changed
                          ? "Changed: Run runs it in your browser"
                          : "Written from the P&ID: Run runs it on the server"}
                </span>
                {props.changed && (
                    <button type="button" className="button-small" onClick={props.onReset}>
                        Back to the P&amp;ID&apos;s
                    </button>
                )}
                {props.anchors.offered && shown === MODEL_FILE && (
                    <label
                        className="check dev-script-anchors"
                        title="As Anchor… last ran: the anchored run's script, without its fit of what its anchors don't settle"
                    >
                        <input
                            type="checkbox"
                            checked={props.anchors.on}
                            onChange={(event) => props.anchors.onChange(event.target.checked)}
                        />
                        With its anchors
                    </label>
                )}
            </div>
            {props.note && shown === MODEL_FILE && <p className="muted dev-script-note">{props.note}</p>}
            {props.stale && shown === MODEL_FILE && (
                <Notice tone="warning">
                    The P&amp;ID or the run&apos;s settings have changed since this script was written from them. Go
                    back to the P&amp;ID&apos;s to see its script now, or run yours as it is.
                </Notice>
            )}
            {props.problem && !props.changed && shown === MODEL_FILE ? (
                <Notice tone="error">{props.problem}</Notice>
            ) : props.script === null && !props.changed && shown === MODEL_FILE ? (
                <p className="muted">Writing the script…</p>
            ) : (
                <CodeEditor
                    key={shown}
                    value={shown === MODEL_FILE ? props.text : (props.library?.files[shown] ?? "")}
                    onChange={shown === MODEL_FILE ? props.onChange : nothing}
                    label={shown}
                    kind="code"
                    attached={[]}
                    namespace={null}
                    error={shown === MODEL_FILE ? props.error : null}
                    keys={keys}
                    readOnly={shown !== MODEL_FILE}
                />
            )}
        </section>
    );
}
