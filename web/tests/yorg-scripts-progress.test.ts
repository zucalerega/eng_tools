import { describe, expect, test } from "vitest";
import {
    breakdown,
    formatElapsed,
    formatSeconds,
    listed,
    packagesText,
    stepNote,
    stepText,
} from "../src/yorg/scripts/progress";
import { importsOf, slowImports } from "../src/yorg/scripts/tree";

// What the Python window says about what Python's doing: each step, why it takes as long as it does, and where a
// run's time went.

describe("steps", () => {
    const since = 0;

    test("say what they're doing", () => {
        expect(stepText({ phase: "python", since })).toBe("Starting Python");
        expect(stepText({ phase: "python", since, attempt: 2 })).toBe(
            "Starting Python (try 2 of 3: the network dropped it)",
        );
        expect(stepText({ phase: "import", since, module: "CoolProp.CoolProp" })).toBe("Importing CoolProp.CoolProp");
        expect(stepText({ phase: "channels", since })).toBe("Handing the channels to Python");
        expect(stepText({ phase: "code", since })).toBe("Running your code");
        expect(stepText({ phase: "server", since, channels: ["PT-TANK"] })).toBe("Loading PT-TANK from the server");
        expect(stepText({ phase: "server", since, channels: ["A", "B", "C", "D", "E"] })).toBe(
            "Loading A, B, C, and 2 more from the server",
        );
    });

    test("name packages as people know them, those the script asked for first", () => {
        expect(stepText({ phase: "packages", since, packages: ["scipy"] })).toBe("Loading SciPy");
        expect(packagesText(["scipy", "pandas"], ["scipy", "pandas"])).toBe("SciPy and pandas");
        const coolprop = ["Pillow", "contourpy", "coolprop", "cycler", "fonttools", "kiwisolver", "matplotlib"];
        expect(packagesText(coolprop, ["CoolProp"])).toBe("CoolProp and 6 packages it needs");
        expect(packagesText(["scipy", "pandas", "six"], ["scipy", "pandas"])).toBe(
            "SciPy and pandas and 1 package they need",
        );
        expect(packagesText(coolprop, [])).toBe("7 packages");
        expect(listed(["A", "B", "C"])).toBe("A, B, and C");
    });

    test("say why the slow ones are slow, and that they're once", () => {
        expect(stepNote({ phase: "import", since, module: "CoolProp.CoolProp" })).toMatch(
            /CoolProp reads its whole fluid library.*once while Python stays open/,
        );
        expect(stepNote({ phase: "import", since, module: "scipy.signal" })).toMatch(/once while Python stays open/);
        expect(stepNote({ phase: "packages", since, packages: ["scipy"] })).toMatch(/download/);
        expect(stepNote({ phase: "python", since })).toMatch(/once while this tab is open/);
        expect(stepNote({ phase: "code", since })).toBeNull();
    });
});

describe("where a run's time went", () => {
    test("the longest first, then the script's own", () => {
        const parts = breakdown(
            [
                { kind: "packages", seconds: 2.1, packages: ["scipy"] },
                { kind: "import", seconds: 20.8, module: "CoolProp.CoolProp" },
                { kind: "waiting", seconds: 1.2, reason: "start" },
                { kind: "channels", seconds: 0.01 }, // too short to mention
            ],
            25,
            ["scipy", "CoolProp"],
        );
        expect(parts.map((part) => [part.label, formatSeconds(part.seconds)])).toEqual([
            ["importing CoolProp.CoolProp", "21 s"],
            ["loading SciPy", "2.1 s"],
            ["waiting for Python to start", "1.2 s"],
            ["your code", "0.9 s"],
        ]);
    });

    test("the script's own is never less than nothing", () => {
        expect(breakdown([{ kind: "server", seconds: 3 }], 2)).toEqual([
            { label: "channels from the server", seconds: 3 },
            { label: "your code", seconds: 0 },
        ]);
    });

    test("times read as people say them", () => {
        expect(formatSeconds(0.43)).toBe("0.4 s");
        expect(formatSeconds(9.94)).toBe("9.9 s");
        expect(formatSeconds(9.96)).toBe("10 s");
        expect(formatSeconds(21.4)).toBe("21 s");
        expect(formatSeconds(65)).toBe("1 min 5 s");
        expect(formatElapsed(999)).toBe("0 s");
        expect(formatElapsed(12_500)).toBe("12 s");
        expect(formatElapsed(125_000)).toBe("2 min 5 s");
    });
});

describe("a script's imports", () => {
    test("are found however they're written", () => {
        const code = [
            "import numpy as np",
            "import scipy.signal as sig, pandas",
            "from CoolProp.CoolProp import PropsSI",
            "from . import nearby  # relative: not a package",
            "# import commented_out",
            "x = 1; import json",
            "def f():",
            "    import matplotlib.pyplot as plt",
            "from scipy import (",
            "    optimize,",
            ")",
        ].join("\n");
        expect(importsOf(code)).toEqual([
            "numpy",
            "scipy.signal",
            "pandas",
            "CoolProp.CoolProp",
            "json",
            "matplotlib.pyplot",
            "scipy",
        ]);
    });

    test("the slow ones are those Python gets ready ahead of a run", () => {
        expect(slowImports("import json\nfrom CoolProp.CoolProp import PropsSI\nimport numpy as np\n")).toEqual([
            "CoolProp.CoolProp",
            "numpy",
        ]);
        expect(slowImports("print(1)")).toEqual([]);
    });
});
