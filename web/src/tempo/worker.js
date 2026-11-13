// Tempo's isolated Pyodide worker.
// Runs inside an <iframe sandbox="allow-scripts"> from a data: URL, so it has no access to
// the authenticated site's cookies, storage, or APIs.

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";

let pyodide = null;
let initializing = null;

async function withRetries(load, tries = 3) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await load(attempt);
        } catch (error) {
            if (attempt >= tries) {
                throw error;
            }
            self.postMessage({
                type: "progress",
                message: `Retrying Python runtime load (attempt ${attempt + 1})…`,
            });
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
    }
}

async function initialize(files) {
    self.postMessage({ type: "progress", message: "Initializing Python runtime…" });
    const { loadPyodide } = await withRetries(
        (attempt) => import(`${PYODIDE}pyodide.mjs${attempt > 1 ? `?try=${attempt}` : ""}`),
    );
    pyodide = await withRetries(() => loadPyodide({ indexURL: PYODIDE }));
    self.postMessage({ type: "progress", message: "Loading Luna validation engine…" });
    for (const [filename, content] of Object.entries(files)) {
        pyodide.FS.writeFile(`/home/pyodide/${filename}`, content);
    }
    pyodide.runPython("import sys; sys.path.insert(0, '/home/pyodide'); from engine import *");
    self.postMessage({ type: "ready" });
    return pyodide;
}

self.onmessage = async ({ data }) => {
    if (data.type === "init") {
        initializing = initialize(data.files).catch((error) => {
            self.postMessage({ type: "startup-error", message: String(error) });
            throw error;
        });
        return;
    }
    if (data.type === "run") {
        try {
            const instance = await initializing;
            instance.globals.set("__sequence_source", data.source);
            instance.globals.set("__sequence_mapping", data.mapping);
            instance.globals.set("__sequence_execute", data.mode === "simulate");
            instance.globals.set("__sequence_options", JSON.stringify(data.options ?? {}));
            const raw = instance.runPython(
                "json.dumps(run_sequence(__sequence_source, __sequence_mapping, __sequence_execute, json.loads(__sequence_options)))",
            );
            self.postMessage({ type: "result", id: data.id, result: JSON.parse(raw) });
        } catch (error) {
            self.postMessage({ type: "failure", id: data.id, message: String(error) });
        }
    }
};
