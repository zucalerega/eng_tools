// The Python window's worker: Pyodide (CPython in WebAssembly) running scripts. It lives in a sandboxed iframe with an
// origin of its own (sandbox.ts), so it can't reach the site, its API, or who's signed in: what it knows comes from the
// page, in messages. This file is sent to the iframe as text (a ?raw import) and started there as a module
// worker from a data: URL (Pyodide 314 runs only in module workers, and a sandboxed frame can't start one from a
// blob).
//
// From the page (python.ts), done one after another: init (with the yorg module's source), prepare (a script's code:
// its slow imports, ahead of its run), run (a script, its tests as JSON, the keys of the channels it names); and, any
// time, response (to a request). To the page: progress (each step as it starts: starting Python, loading packages,
// importing a module, taking channels, running the code), ready, prepared, stdout/stderr and plot/figure/file (each
// with the run it's from), request (channels, a channel, the tests), done or error (with where the time went), and
// failed (Python couldn't start).

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";

let pyodide = null;
let yorg = null; // the yorg module (yorg.py), once Python is ready
let current = null; // the run whose output and steps these are (null: getting a script's imports ready)
let asked = 0;
const waiting = new Map();
let queue = Promise.resolve(); // what the page asked for, one thing after another

const post = (message) => self.postMessage(message);
const errorText = (error) => String(error && error.message ? error.message : error);
const secondsSince = (since) => (performance.now() - since) / 1000;

/** A step, as it starts (a phase, and what it's on: the packages loading, the module importing). */
function progress(phase, detail = {}) {
    post({ type: "progress", run: current, phase, ...detail });
}

/** Ask the page for something (channels, a channel, the tests): a promise of its answer. */
function ask(what, args) {
    const id = ++asked;
    const plain = args && typeof args.toJs === "function" ? args.toJs({ dict_converter: Object.fromEntries }) : args;
    return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        post({ type: "request", id, run: current, what, args: plain });
    });
}

/** Something for the page to show, from the run it's from: a plot's series, a figure, a file to save. */
function send(kind, payload) {
    const plain =
        payload && typeof payload.toJs === "function" ? payload.toJs({ dict_converter: Object.fromEntries }) : payload;
    post({ type: kind, run: current, ...plain });
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
            progress("python", { attempt: attempt + 1 });
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
    }
}

async function start(moduleSource) {
    progress("python");
    // A module that failed to load stays failed under its URL: another try asks for it under another.
    const { loadPyodide } = await withRetries(
        (attempt) => import(`${PYODIDE}pyodide.mjs${attempt > 1 ? `?try=${attempt}` : ""}`),
    );
    pyodide = await withRetries(() => loadPyodide({ indexURL: PYODIDE }));
    pyodide.setStdout({ batched: (text) => post({ type: "stdout", run: current, text }) });
    pyodide.setStderr({ batched: (text) => post({ type: "stderr", run: current, text }) });
    pyodide.setStdin({
        stdin: () => {
            throw new Error("A script can't ask for input here: put values in the script instead");
        },
    });
    progress("packages", { packages: ["numpy"] });
    await pyodide.loadPackage(["numpy"], { messageCallback: () => {} });
    pyodide.registerJsModule("_yorg_page", {
        ask,
        send,
        progress: (phase, module) => progress(phase, module ? { module } : {}),
    });
    pyodide.FS.mkdirTree("/home/pyodide/yorg_module");
    pyodide.FS.writeFile("/home/pyodide/yorg_module/yorg.py", moduleSource);
    pyodide.runPython("import sys; sys.path.insert(0, '/home/pyodide/yorg_module'); import yorg");
    yorg = pyodide.pyimport("yorg");
    post({ type: "ready", version: pyodide.runPython("import sys; sys.version.split()[0]") });
}

/** Load the packages code imports, from Pyodide's own (NumPy, SciPy, pandas, matplotlib, CoolProp...), saying which. */
async function loadImports(code, timings) {
    let packages = null;
    const started = performance.now();
    await pyodide.loadPackagesFromImports(code, {
        messageCallback: (text) => {
            const loading = /^Loading (.+)$/.exec(text);
            if (loading && !packages) {
                packages = loading[1]
                    .replace(/ from .*$/, "")
                    .split(",")
                    .map((name) => name.trim())
                    .filter(Boolean);
                progress("packages", { packages });
            }
        },
        errorCallback: (text) => post({ type: "stderr", run: current, text }),
    });
    if (packages && timings) {
        timings.push({ kind: "packages", packages, seconds: secondsSince(started) });
    }
}

/** A Python error's traceback from the script's own lines on (Pyodide's frames above them say nothing useful). */
function traceback(error) {
    const text = errorText(error);
    const lines = text.split("\n");
    const first = lines.findIndex((line) => line.includes('File "script.py"'));
    return first < 0 ? text.trim() : ["Traceback (most recent call last):", ...lines.slice(first)].join("\n").trim();
}

/** The script's line an error happened on (its last frame in the script), if it's there. */
function lineOf(error) {
    const found = [...errorText(error).matchAll(/File "script\.py", line (\d+)/g)];
    return found.length ? Number(found[found.length - 1][1]) : null;
}

/** Get a script's slow imports ready before it runs: its packages loaded, and the slow modules imported. */
async function prepare({ code }) {
    current = null;
    try {
        await loadImports(code, null);
        yorg._warm(code);
    } catch {
        // Whatever's wrong, the run says.
    }
    post({ type: "prepared" });
}

async function run({ run: id, code, context, keys }) {
    current = id;
    const started = performance.now();
    const timings = [];
    const imports = () => JSON.parse(yorg._import_times());
    let globals = null;
    try {
        try {
            await loadImports(code, timings);
        } catch (error) {
            post({ type: "stderr", run: id, text: `Couldn't load the packages it imports: ${errorText(error)}` });
        }
        // Python keeps the channels it's had: the page hands over only those it hasn't, their times once.
        const missing = JSON.parse(yorg._missing(JSON.stringify(keys)));
        if (missing.length) {
            progress("channels");
            const since = performance.now();
            const found = await ask("channels", { keys: missing, times: JSON.parse(yorg._time_keys()) });
            for (const one of found) {
                yorg._store(one.meta, one.t ?? false, one.v);
            }
            timings.push({ kind: "channels", seconds: secondsSince(since) });
        }
        progress("code");
        yorg._begin(context, JSON.stringify(keys));
        globals = pyodide.toPy({ __name__: "__main__" });
        globals.set("yorg", yorg);
        await pyodide.runPythonAsync(code, { globals, filename: "script.py" });
        yorg._finish();
        post({ type: "done", run: id, elapsed: secondsSince(started), timings: [...timings, ...imports()] });
    } catch (error) {
        try {
            yorg._finish();
        } catch {
            // It's the script's error that matters.
        }
        post({
            type: "error",
            run: id,
            text: traceback(error),
            line: lineOf(error),
            elapsed: secondsSince(started),
            timings: [...timings, ...imports()],
        });
    } finally {
        globals?.destroy();
        current = null;
    }
}

async function handle(message) {
    if (message.type === "init") {
        try {
            await start(message.module);
        } catch (error) {
            post({ type: "failed", error: errorText(error) });
        }
    } else if (message.type === "prepare") {
        await prepare(message);
    } else if (message.type === "run") {
        await run(message);
    }
}

self.onmessage = (event) => {
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
        return;
    }
    // One thing at a time, in the order asked: a run waits for the imports getting ready before it.
    queue = queue.then(() => handle(message)).catch((error) => post({ type: "failed", error: errorText(error) }));
};
