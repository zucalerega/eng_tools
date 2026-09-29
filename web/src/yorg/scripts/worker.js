// The Python window's worker: Pyodide (CPython in WebAssembly) running scripts. It lives in a sandboxed iframe with an
// origin of its own (sandbox.ts), so it can't reach the site, its API, or who's signed in: what it knows comes from the
// page, in messages. This file is sent to the iframe as text (a ?raw import) and started there as a module
// worker from a data: URL (Pyodide 314 runs only in module workers, and a sandboxed frame can't start one from a
// blob).
//
// From the page: init (with the yorg module's source), run (a script, the test it works on, the channels it names),
// response (to a request). To the page: status, ready, stdout/stderr, plot/figure/file (from the yorg module),
// request (a channel, the datasets), done, error, failed (Python couldn't start).

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";

let pyodide = null;
let asked = 0;
const waiting = new Map();

const post = (message) => self.postMessage(message);

/** Ask the page for something (a channel's samples, the datasets): a promise of its answer. */
function ask(what, args) {
    const id = ++asked;
    const plain = args && typeof args.toJs === "function" ? args.toJs({ dict_converter: Object.fromEntries }) : args;
    return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        post({ type: "request", id, what, args: plain });
    });
}

/** Something for the page to show: a plot's series, a figure, a file to save. */
function send(kind, payload) {
    const plain =
        payload && typeof payload.toJs === "function" ? payload.toJs({ dict_converter: Object.fromEntries }) : payload;
    post({ type: kind, ...plain });
}

/** What load() gives, trying again (a few seconds apart) if the network drops it: Python is 10 MB from a CDN. */
async function withRetries(load, tries = 3) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await load(attempt);
        } catch (error) {
            if (attempt >= tries) {
                throw error;
            }
            post({ type: "status", text: `Loading Python again (try ${attempt + 1} of ${tries})…` });
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
    }
}

async function start(moduleSource) {
    post({ type: "status", text: "Loading Python…" });
    // A module that failed to load stays failed under its URL: another try asks for it under another.
    const { loadPyodide } = await withRetries(
        (attempt) => import(`${PYODIDE}pyodide.mjs${attempt > 1 ? `?try=${attempt}` : ""}`),
    );
    pyodide = await withRetries(() => loadPyodide({ indexURL: PYODIDE }));
    pyodide.setStdout({ batched: (text) => post({ type: "stdout", text }) });
    pyodide.setStderr({ batched: (text) => post({ type: "stderr", text }) });
    pyodide.setStdin({
        stdin: () => {
            throw new Error("A script can't ask for input here: put values in the script instead");
        },
    });
    post({ type: "status", text: "Loading NumPy…" });
    await pyodide.loadPackage(["numpy"]);
    pyodide.registerJsModule("_yorg_page", { ask, send });
    pyodide.FS.mkdirTree("/home/pyodide/yorg_module");
    pyodide.FS.writeFile("/home/pyodide/yorg_module/yorg.py", moduleSource);
    pyodide.runPython("import sys; sys.path.insert(0, '/home/pyodide/yorg_module'); import yorg");
    post({ type: "ready", version: pyodide.runPython("import sys; sys.version.split()[0]") });
}

/** A Python error's traceback from the script's own lines on (Pyodide's frames above them say nothing useful). */
function traceback(error) {
    const text = String(error && error.message ? error.message : error);
    const lines = text.split("\n");
    const first = lines.findIndex((line) => line.includes('File "script.py"'));
    return first < 0 ? text.trim() : ["Traceback (most recent call last):", ...lines.slice(first)].join("\n").trim();
}

async function run({ code, context, preloaded }) {
    const started = performance.now();
    try {
        // The packages the script imports, from Pyodide's own (NumPy, SciPy, pandas, matplotlib, CoolProp...).
        await pyodide.loadPackagesFromImports(code, {
            messageCallback: (text) => post({ type: "status", text }),
            errorCallback: (text) => post({ type: "stderr", text }),
        });
        const yorg = pyodide.pyimport("yorg");
        yorg._begin(context, preloaded);
        const globals = pyodide.toPy({ __name__: "__main__" });
        globals.set("yorg", yorg);
        await pyodide.runPythonAsync(code, { globals, filename: "script.py" });
        yorg._end();
        globals.destroy();
        post({ type: "done", elapsed: (performance.now() - started) / 1000 });
    } catch (error) {
        post({ type: "error", text: traceback(error), elapsed: (performance.now() - started) / 1000 });
    }
}

self.onmessage = async (event) => {
    const message = event.data;
    if (message.type === "response") {
        const found = waiting.get(message.id);
        waiting.delete(message.id);
        if (found) {
            if (message.error) {
                found.reject(new Error(message.error));
            } else {
                found.resolve(message.value);
            }
        }
    } else if (message.type === "init") {
        try {
            await start(message.module);
        } catch (error) {
            post({ type: "failed", error: String(error && error.message ? error.message : error) });
        }
    } else if (message.type === "run") {
        await run(message);
    }
};
