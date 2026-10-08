import type { RunRequest as PythonRun } from "../scripts/python";
import type { Bytes } from "../scripts/sandbox";
import type { RunInputs, RunResult, ScriptLibrary } from "./api";

// A model's script, changed on the Script view, run in the browser: in the tab's Python (scripts/python.ts), as the
// server's runner runs it (network.execute on the server). FullFlow and ThermoProp come from PyPI at the server's
// versions, yorg_models and the run's data (in SI units) from the server: so an unchanged script gives what the
// server's run does. The server never runs a script from the page. The script reports how far it's got as it goes, and
// its result once it's solved, as JSON (python.ts keeps them in the run's reports).

const FOLDER = "/tmp/yorg-model";

/** Report the run's time as it goes (at most twice a second), and give the script its data. */
const SETUP = `
def _yorg_model_setup():
    import json, sys, time
    import numpy as np
    import _yorg_page

    folder = ${JSON.stringify(FOLDER)}
    if folder not in sys.path:
        sys.path.insert(0, folder)
    for name in [name for name in sys.modules if name == "yorg_models" or name.startswith("yorg_models.")]:
        del sys.modules[name]  # the files just written, not those of a run before
    import yorg_models

    last = [0.0]

    def progress(t):
        now = time.monotonic()
        if now - last[0] > 0.5:
            last[0] = now
            _yorg_page.send("report", {"key": "progress", "value": json.dumps(float(t))})

    yorg_models.progress = progress
    keys = json.load(open(folder + "/inputs/keys.json"))
    read = lambda name: np.fromfile(folder + "/inputs/" + name, dtype="<f8")
    return {key: (read(key + ".t.f64"), read(key + ".v.f64")) for key in keys}


data = _yorg_model_setup()
del _yorg_model_setup
`;

/** Send the page the script's result: what the Models page shows, as the server's run gives it. */
const FINISH = `
def _yorg_model_finish(result):
    import json, math
    import _yorg_page

    if not isinstance(result, dict) or "times" not in result or "series" not in result:
        raise RuntimeError("The script has to end with result = run.solve(): that's what the page shows")

    def plain(value):
        if hasattr(value, "tolist"):  # NumPy's
            value = value.tolist()
        if isinstance(value, float):
            return value if math.isfinite(value) else None
        if isinstance(value, dict):
            return {str(key): plain(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [plain(item) for item in value]
        return value

    _yorg_page.send("report", {"key": "result", "value": json.dumps(plain(result))})


_yorg_model_finish(globals().get("result"))
del _yorg_model_finish
`;

const text = (value: string): Bytes => new Uint8Array(new TextEncoder().encode(value));

const floats = (values: (number | null)[]): Bytes =>
    new Uint8Array(Float64Array.from(values, (value) => value ?? Number.NaN).buffer);

/** What the tab's Python is asked to run: the script, as model.py, with what it needs. */
export function browserRun(script: string, library: ScriptLibrary, data: RunInputs): PythonRun {
    const keys = Object.keys(data.inputs);
    const files = [
        ...Object.entries(library.files).map(([path, source]) => ({ path: `${FOLDER}/${path}`, data: text(source) })),
        { path: `${FOLDER}/inputs/keys.json`, data: text(JSON.stringify(keys)) },
        ...keys.flatMap((key) => [
            { path: `${FOLDER}/inputs/${key}.t.f64`, data: floats(data.inputs[key]!.times) },
            { path: `${FOLDER}/inputs/${key}.v.f64`, data: floats(data.inputs[key]!.values) },
        ]),
    ];
    return {
        code: script,
        datasets: [],
        filename: "model.py",
        install: library.packages,
        files,
        setup: SETUP,
        finish: FINISH,
    };
}

/** A browser run's result, once its script has sent it. */
export function browserResult(reports: Record<string, string>): RunResult | null {
    const found = reports.result;
    return found === undefined ? null : (JSON.parse(found) as RunResult);
}

/** How far a browser run has got: the run's time, in seconds from its start (null: not started solving). */
export function browserProgress(reports: Record<string, string>): number | null {
    const found = reports.progress;
    return found === undefined ? null : Number(JSON.parse(found));
}
