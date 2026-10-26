// What Python is doing, in words: each step of starting it, getting a script's imports ready, and running it; why a
// step takes as long as it does; and, once a run is over, where its time went. The steps come from the worker
// (worker.js) and the page (python.ts); this only words them.

/** What a step is doing. */
export type Phase = "python" | "server" | "packages" | "install" | "import" | "channels" | "code";

/** A step of starting Python, getting it ready, or a run. */
export interface Step {
    phase: Phase;
    since: number; // when it started (Date.now())
    packages?: string[]; // packages: those loading, as Pyodide names them (scipy, coolprop); install: from PyPI
    module?: string; // import: the module (CoolProp, scipy.signal)
    channels?: string[]; // server: the channels coming, by name
    attempt?: number; // python: its download's try (the network dropped the first)
}

/** A part of a run's time: from the worker (packages, imports, channels), or the page (the server, waiting). */
export interface Timing {
    kind: "waiting" | "server" | "packages" | "install" | "import" | "channels";
    seconds: number;
    packages?: string[]; // packages, install: which
    module?: string; // import: which
    reason?: "start" | "prepare" | "tools" | "run"; // waiting: for Python to start, imports, suggestions, or a run
}

// Pyodide names its packages in lower case; these are the names people know them by.
const KNOWN_NAMES: Record<string, string> = {
    numpy: "NumPy",
    scipy: "SciPy",
    pandas: "pandas",
    matplotlib: "matplotlib",
    coolprop: "CoolProp",
    sympy: "SymPy",
    pillow: "Pillow",
    micropip: "micropip",
};

/** A package's name as people know it: SciPy for scipy, CoolProp for coolprop==6.8.0. */
export function packageName(name: string): string {
    const bare = name.split("==")[0]!.trim();
    return KNOWN_NAMES[bare.toLowerCase()] ?? bare;
}

/** Things in a list, as a sentence has them: "A", "A and B", "A, B, and C". */
export function listed(items: string[]): string {
    if (items.length <= 2) {
        return items.join(" and ");
    }
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * The packages a step loads, those the script imports first (asked: its imports' top-level names): "SciPy and pandas",
 * or "CoolProp and 11 packages it needs" (Pyodide loads what a package needs with it).
 */
export function packagesText(packages: string[], asked: string[] = []): string {
    const wanted = new Set(asked.map((name) => name.toLowerCase()));
    const named = packages.filter((name) => wanted.has(name.toLowerCase()));
    const others = packages.length - named.length;
    if (named.length === 0 || others === 0) {
        return packages.length > 4 ? `${packages.length} packages` : listed(packages.map(packageName)) || "packages";
    }
    return `${listed(named.map(packageName))} and ${others} ${others === 1 ? "package" : "packages"} ${named.length === 1 ? "it needs" : "they need"}`;
}

/** What a step is doing, in a few words: "Importing CoolProp". */
export function stepText(step: Step, asked: string[] = []): string {
    switch (step.phase) {
        case "python":
            return step.attempt
                ? `Starting Python (try ${step.attempt} of 3: the network dropped it)`
                : "Starting Python";
        case "server": {
            const names = step.channels ?? [];
            if (names.length === 0) {
                return "Loading the tests from the server";
            }
            const some =
                names.length > 3 ? `${names.slice(0, 3).join(", ")}, and ${names.length - 3} more` : listed(names);
            return `Loading ${some} from the server`;
        }
        case "packages":
            return `Loading ${packagesText(step.packages ?? [], asked)}`;
        case "install":
            return `Installing ${listed((step.packages ?? []).map(packageName)) || "packages"} from PyPI`;
        case "import":
            return `Importing ${step.module ?? "a module"}`;
        case "channels":
            return "Handing the channels to Python";
        case "code":
            return "Running your code";
    }
}

// Modules that take long enough to import that it's worth saying why, and that it's only once.
const IMPORT_NOTES: Record<string, string> = {
    CoolProp:
        "CoolProp reads its whole fluid library the first time it's imported: 20 seconds to a minute, by the computer, and only once while Python stays open.",
};

/** Why a step takes as long as it does, and whether it will again (null: nothing worth saying). */
export function stepNote(step: Step): string | null {
    switch (step.phase) {
        case "python":
            return "Python starts once while this tab is open. The first time on a computer it downloads about 9 MB too.";
        case "server":
            return "Channels come from the server once; after that this tab has them.";
        case "packages":
            return "Packages load once while Python stays open. The first time on a computer they download too (SciPy is about 14 MB).";
        case "install":
            return "Packages from PyPI install once while Python stays open. The first time on a computer they download too, with what they need: a minute or two.";
        case "import": {
            const top = (step.module ?? "").split(".")[0] ?? "";
            return IMPORT_NOTES[top] ?? "Each module is imported once while Python stays open.";
        }
        case "channels":
        case "code":
            return null;
    }
}

/** Seconds, as a run's time is shown: 40 ms, 2.1 s, 21 s, 1 min 5 s. */
export function formatSeconds(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "0 ms";
    }
    if (seconds < 0.995) {
        return `${Math.round(seconds * 1000)} ms`;
    }
    if (Math.round(seconds * 10) < 100) {
        return `${seconds.toFixed(1)} s`;
    }
    if (seconds < 60) {
        return `${Math.round(seconds)} s`;
    }
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/** How long something has been going, as a timer beside it shows it: 0 s, 12 s, 1 min 5 s. */
export function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

const WAITING_FOR = {
    start: "Python to start",
    prepare: "imports to get ready",
    tools: "the editor's suggestions to get ready",
    run: "the run before",
} as const;

/** One part of a run's time, in words: "importing CoolProp". */
function timingLabel(timing: Timing, asked: string[]): string {
    switch (timing.kind) {
        case "waiting":
            return `waiting for ${WAITING_FOR[timing.reason ?? "start"]}`;
        case "server":
            return "channels from the server";
        case "packages":
            return `loading ${packagesText(timing.packages ?? [], asked)}`;
        case "install":
            return `installing ${listed((timing.packages ?? []).map(packageName))}`;
        case "import":
            return `importing ${timing.module ?? "a module"}`;
        case "channels":
            return "handing channels to Python";
    }
}

/**
 * Where a run's time went (total: all of it, from Run to done), the longest first, then the rest, which was the
 * script's own: "importing CoolProp 21 s", …, "your code 0.9 s". Parts too short to matter are left out.
 */
export function breakdown(
    timings: Timing[],
    total: number,
    asked: string[] = [],
): { label: string; seconds: number }[] {
    const parts = timings
        .filter((timing) => timing.seconds >= 0.05)
        .map((timing) => ({ label: timingLabel(timing, asked), seconds: timing.seconds }))
        .sort((a, b) => b.seconds - a.seconds);
    const counted = timings.reduce((sum, timing) => sum + Math.max(0, timing.seconds), 0);
    return [...parts, { label: "your code", seconds: Math.max(0, total - counted) }];
}
