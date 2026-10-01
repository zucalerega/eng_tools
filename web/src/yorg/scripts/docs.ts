// What the yorg module (yorg.py) has, for people writing scripts: the Reference beside a notebook (Reference.tsx)
// shows it, and the editor suggests its names after "yorg." (complete.ts). Its names and signatures are yorg.py's
// (tests/yorg-reference.test.ts holds them to it); the words are written for reading, where yorg.py's docstrings
// (shown when you hover a name in the code) are written for Python.

export interface Entry {
    name: string; // as code names it: "channel", "PSI"; a Channel's own: "between"
    of: "yorg" | "Channel" | null; // whose it is (null: a note about Python here, not part of yorg)
    kind: "function" | "async" | "class" | "method" | "value" | "note";
    signature: string; // a function's parameters, as yorg.py has them: "(name, dataset=None)"; "" for a value or note
    summary: string; // a line: in the list, and beside the name in the editor's suggestions
    details?: string; // more, once it's opened
    example?: string; // code that uses it, to put in a cell
}

export interface Section {
    title: string;
    entries: Entry[];
}

export const REFERENCE: Section[] = [
    {
        title: "Channels",
        entries: [
            {
                name: "channel",
                of: "yorg",
                kind: "function",
                signature: "(name, dataset=None)",
                summary: "A channel of a test attached under Data: the first, unless dataset= names another.",
                details:
                    "Write the channel's name in quotes, so it loads before the cell runs. dataset= takes another " +
                    "attached test's name, or its id when two attached tests share a name.",
                example: 'pt = yorg.channel("PT-TANK")\nother = yorg.channel("PT-TANK", dataset="Hotfire 4")',
            },
            {
                name: "load",
                of: "yorg",
                kind: "async",
                signature: "(name, dataset=None)",
                summary: "Any channel of any test, attached or not, even a name made as the code runs.",
                details: "It loads while the cell runs, so it takes await. dataset= is a test's name or id.",
                example: 'fm = await yorg.load("FM-" + "OX", dataset="Hotfire 3")',
            },
            {
                name: "channels",
                of: "yorg",
                kind: "function",
                signature: "(dataset=None)",
                summary: "The names of an attached test's channels: the first test's, unless dataset= names another.",
                example: "print(yorg.channels())",
            },
            {
                name: "datasets",
                of: "yorg",
                kind: "async",
                signature: "()",
                summary: "Every test there is, each a dict of id, name, rows, t_min, and t_max.",
                example: 'for test in await yorg.datasets():\n    print(test["id"], test["name"])',
            },
        ],
    },
    {
        title: "A channel",
        entries: [
            {
                name: "Channel",
                of: "yorg",
                kind: "class",
                signature: "(name, unit, t, values, labels=(), dataset=None, dataset_id=None)",
                summary: "What channel() and load() give: .t (s), .values, .unit, .name, and .dataset.",
                details:
                    ".t is in seconds on its test's own clock, and .values in .unit, both NumPy arrays; len() is " +
                    "how many samples it has. Make one of your own to plot or resample what you've worked out.",
                example:
                    'pt = yorg.channel("PT-TANK")\nprint(pt.name, pt.unit, len(pt), pt.values.max())\n' +
                    'mine = yorg.Channel("Thrust", "lbf", t, thrust)',
            },
            {
                name: "between",
                of: "Channel",
                kind: "method",
                signature: "(start, end)",
                summary: "The samples from start to end (s, on its test's clock), as a Channel.",
                example: "burn = pt.between(2.0, 6.5)",
            },
            {
                name: "at",
                of: "Channel",
                kind: "method",
                signature: "(times)",
                summary: "Its values at times (s), interpolated between samples.",
                example: "pt.at([1.0, 2.5])",
            },
            {
                name: "si",
                of: "Channel",
                kind: "method",
                signature: "(ambient=ATMOSPHERE)",
                summary: "Its values in SI units, as yorg.si() has them.",
                example: "pascals = pt.si()",
            },
            {
                name: "label",
                of: "Channel",
                kind: "method",
                signature: "(value)",
                summary: "A state channel's label for a value: OPEN for 1, say.",
                example: 'valve = yorg.channel("MV-OX")\nprint(valve.label(valve.values[-1]))',
            },
        ],
    },
    {
        title: "Plots and files",
        entries: [
            {
                name: "plot",
                of: "yorg",
                kind: "function",
                signature: '(x, y=None, name=None, unit="", title=None)',
                summary: "A line on the page, zoomable like Yorg's plots: a Channel, or y against x.",
                details:
                    "Each call draws one line; lines from one cell with the same title share a plot. Any arrays " +
                    "work, not only channels. Beside a dataset's or view's plots, x is seconds on the first test's " +
                    "clock, and a Channel goes where its test is.",
                example:
                    'yorg.plot(pt, title="Pressures")\nyorg.plot(pc, title="Pressures")\n' +
                    'yorg.plot(t, thrust, name="Thrust", unit="lbf")',
            },
            {
                name: "download",
                of: "yorg",
                kind: "function",
                signature: "(filename, content)",
                summary: "A file for you to save: text, bytes, or a pandas DataFrame (as a CSV).",
                example: 'yorg.download("peaks.csv", table)',
            },
        ],
    },
    {
        title: "Units and helpers",
        entries: [
            {
                name: "si",
                of: "yorg",
                kind: "function",
                signature: "(values, unit, ambient=ATMOSPHERE)",
                summary: "Values in SI units: pressures in Pa absolute, temperatures in K, mass flows in kg/s.",
                details:
                    "A pressure unit ending in g (psig, barg) is gauge, and one ending in a (psia) absolute; plain " +
                    "psi counts as gauge, as test stands mostly mean it. Other units come back as they are.",
                example: "pascals = yorg.si(pt.values, pt.unit)",
            },
            {
                name: "resample",
                of: "yorg",
                kind: "function",
                signature: "(*channels, dt=None, start=None, end=None)",
                summary: "Channels on one clock, as (t, [values of each]): for math between different rates.",
                details:
                    "Every dt seconds (by default the finest of theirs), over the time they all have, values " +
                    "interpolated between samples.",
                example: "t, (tank, chamber) = yorg.resample(pt, pc)\ndrop = tank - chamber",
            },
            {
                name: "cda",
                of: "yorg",
                kind: "function",
                signature: "(mass_flow, pressure_drop, density)",
                summary: "An orifice's CdA (m²), from its mass flow (kg/s), pressure drop (Pa), and density (kg/m³).",
                example: "area = yorg.cda(mdot, drop_pa, 1141.0)",
            },
            {
                name: "PSI",
                of: "yorg",
                kind: "value",
                signature: "",
                summary: "6894.757: the pascals in a psi.",
            },
            {
                name: "ATMOSPHERE",
                of: "yorg",
                kind: "value",
                signature: "",
                summary: "101325.0: the pascals in an atmosphere.",
            },
        ],
    },
    {
        title: "The tests and the page",
        entries: [
            {
                name: "attached",
                of: "yorg",
                kind: "value",
                signature: "",
                summary: "The tests attached, the first first: each a dict of id, name, t0, and channels.",
            },
            {
                name: "dataset",
                of: "yorg",
                kind: "value",
                signature: "",
                summary: "The first test attached, as in yorg.attached (None when none is).",
            },
            {
                name: "t0",
                of: "yorg",
                kind: "value",
                signature: "",
                summary: "The first test's T0 (s, on its clock), when it has one; beside a page's plots, the page's.",
            },
            {
                name: "window",
                of: "yorg",
                kind: "value",
                signature: "",
                summary: "Beside a dataset's or view's plots: the time in view, (start, end). None elsewhere.",
                example: 'start, end = yorg.window\npart = yorg.channel("PT-CHAMBER").between(start, end)',
            },
            {
                name: "shifts",
                of: "yorg",
                kind: "value",
                signature: "",
                summary: "Beside a page's plots: how far each test (by id) is moved to line up with the first.",
            },
        ],
    },
    {
        title: "Python here",
        entries: [
            {
                name: "Packages",
                of: null,
                kind: "note",
                signature: "",
                summary: "Python 3.14 in your browser (Pyodide), with NumPy, SciPy, pandas, matplotlib, and CoolProp.",
                details:
                    "SymPy, scikit-learn, and the rest of Pyodide's packages are there too: import them. The first " +
                    "import of each takes a few seconds (CoolProp's, 20 seconds to a minute); after that, they're " +
                    "ready until Python restarts.",
                example: "import numpy as np\nfrom scipy import signal",
            },
            {
                name: "Packages from PyPI",
                of: null,
                kind: "note",
                signature: "",
                summary: "Pure-Python packages install with micropip, until Python restarts.",
                details:
                    "Packages with compiled code install only if Pyodide has built them. An installed package can " +
                    "read what your code loads and reach the internet, as your code can: install only those you trust.",
                example: 'import micropip\nawait micropip.install("tabulate")\nimport tabulate',
            },
            {
                name: "matplotlib",
                of: null,
                kind: "note",
                signature: "",
                summary: "plt.show() puts a figure on the page; figures not shown appear when the cell's done.",
                example: "import matplotlib.pyplot as plt\nplt.plot(pt.t, pt.values)\nplt.show()",
            },
            {
                name: "Cells",
                of: null,
                kind: "note",
                signature: "",
                summary: "A notebook's cells share their variables: load the data in one, work it over in the next.",
            },
        ],
    },
];

/** Every entry, each with its section's title. */
export const ENTRIES: (Entry & { section: string })[] = REFERENCE.flatMap((section) =>
    section.entries.map((entry) => ({ ...entry, section: section.title })),
);
