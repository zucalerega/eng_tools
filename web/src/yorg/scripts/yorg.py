"""yorg: a script's way to Yorg's test data, in the Python window.

The script runs in your browser (Pyodide: CPython compiled to WebAssembly), not on the server, in a sandbox that can't
reach the site: channels come to it from the page, and what it plots and saves goes back to the page.

    pt = yorg.channel("PT-TANK")                      # the first test attached to the script (Data)
    other = yorg.channel("PT-TANK", dataset="Hotfire 4")  # another test attached
    print(pt.values.max(), pt.unit)
    yorg.plot(pt)                                     # on the page, with Yorg's plots

    fm = await yorg.load("FM-" + "OX", dataset="Hotfire 3")  # any channel of any test, named as it runs
    for info in await yorg.datasets():
        print(info["name"])

A channel named in the script in quotes ("PT-TANK" above) is loaded before it starts, from the first test attached, and
from another attached test the script names too (dataset="Hotfire 4", or by its id, dataset=12: two tests in two
folders can have one name); yorg.channel() gives those. Times are seconds on each test's own clock
(its T0 on that clock is yorg.attached[i]["t0"], if this browser has one); values are in the channel's unit, and
Channel.si() puts pressures, temperatures, and mass flows in SI units.

Python stays open while the browser tab does: what a script imported, and the channels it had, are there for the next
run. A notebook's cells share their variables (load the data in one, work it over in the next); a script on its own
starts afresh each run.

On a dataset's or view's page (its Python, docked beside the plots), yorg.window is the time in view and yorg.t0 the
page's T0, both on the first test's clock; yorg.shifts has how far each other test is moved to line up with it; and
yorg.plot draws on the page's own plots, on its time axis (a Channel where its test is; other times on the first
test's clock).

    start, end = yorg.window
    part = yorg.channel("PT-CHAMBER").between(start, end)
    yorg.plot(part.t, part.values * 6.895, name="PT-CHAMBER", unit="kPa")
"""

import ast
import builtins
import importlib.util
import io
import json
import os
import sys
import time

os.environ.setdefault("MPLBACKEND", "Agg")  # before matplotlib: a worker has no page to draw on

import _yorg_page  # noqa: E402  the page, through the worker (worker.js)
import js  # noqa: E402
import numpy as np  # noqa: E402
from pyodide.ffi import to_js  # noqa: E402

PSI = 6894.757
ATMOSPHERE = 101325.0

attached = []  # the tests attached to the script, the first first: {"id", "name", "t0", "channels": [{"name", ...}]}
dataset = None  # the first of them (None: none attached)
t0 = None  # its T0, on its clock, if this browser has one for it (a page's: the page's)
window = None  # a page's time in view, (start, end), on the first test's clock (None: not run from a page)
shifts = {}  # a page's: how far each test (by id) is moved on its time axis to line up with the first
_loaded = {}  # (test's id, channel's name): Channel, this run's, loaded before it started


class Channel:
    """A channel's samples: t (s, on its dataset's clock) and values (in unit). A state channel's values number its
    labels: 0 for labels[0], 1 for labels[1] (CLOSED, OPEN). dataset is its test's name, dataset_id its id."""

    def __init__(self, name, unit, t, values, labels=(), dataset=None, dataset_id=None):
        self.name, self.unit, self.labels, self.dataset = name, unit, list(labels), dataset
        self.dataset_id = dataset_id
        self.t = np.asarray(t, dtype=float)
        self.values = np.asarray(values, dtype=float)

    def __repr__(self):
        of = f" of {self.dataset}" if self.dataset else ""
        return f"<Channel {self.name}{of}: {len(self.t)} samples, {self.unit or 'no unit'}>"

    def __len__(self):
        return len(self.t)

    def si(self, ambient=ATMOSPHERE):
        """The values in SI units (see yorg.si)."""
        return si(self.values, self.unit, ambient)

    def between(self, start, end):
        """The samples from start to end (s, on the dataset's clock), as a Channel."""
        keep = (self.t >= start) & (self.t <= end)
        return Channel(
            self.name, self.unit, self.t[keep], self.values[keep], self.labels, self.dataset, self.dataset_id
        )

    def at(self, times):
        """The values at times (s), interpolated between samples."""
        return np.interp(np.asarray(times, dtype=float), self.t, self.values)

    def label(self, value):
        """A state channel's label for a value (OPEN for 1, say)."""
        return self.labels[int(round(value))] if self.labels else None

    def _copy(self):
        """The same samples in a Channel of its own: a run can change what it has without the next run seeing it."""
        return Channel(self.name, self.unit, self.t, self.values, self.labels, self.dataset, self.dataset_id)


def _find(test):
    """An attached test by its id or name (None: none is). Two tests attached can have one name (in two folders), and
    then only an id says which."""
    for info in attached:
        if test in (info["id"], str(info["id"])):
            return info
    named = [info for info in attached if test == info["name"]] or [
        info for info in attached if str(test).lower() == info["name"].lower()
    ]
    if len(named) > 1:
        ids = " or ".join(str(info["id"]) for info in named)
        raise LookupError(f"{len(named)} tests attached are called {test}: say which by its id (dataset={ids})")
    return named[0] if named else None


def _attached(test=None):
    """An attached test, by its id or name (None: the first)."""
    if not attached:
        raise LookupError("Attach a test to the script (Data, beside it) to take its channels")
    if test is None:
        return attached[0]
    found = _find(test)
    if found is None:
        raise LookupError(
            f"{test} isn't attached to the script: attach it under Data, or `await yorg.load(name, dataset={test!r})`"
        )
    return found


def _ref(info):
    """How the code names an attached test: "Hotfire 4", or its id when another attached test has its name."""
    shared = sum(other["name"].lower() == info["name"].lower() for other in attached) > 1
    return str(info["id"]) if shared else f'"{info["name"]}"'


def channels(dataset=None):
    """The names of an attached test's channels (the first's, unless told another)."""
    return [one["name"] for one in _attached(dataset)["channels"]]


def channel(name, dataset=None):
    """A channel of an attached test (the first, unless told another), named in the script in quotes: it's loaded
    before the script starts."""
    info = _attached(dataset)
    found = _loaded.get((info["id"], name))
    if found is not None:
        return found
    if name not in [one["name"] for one in info["channels"]]:
        raise LookupError(f"{info['name']} has no channel {name}")
    more = "" if info is attached[0] else f", with dataset={_ref(info)} there too"
    raise LookupError(
        f"{name} of {info['name']} isn't loaded: a channel is loaded before the script starts when it's named in "
        f"quotes{more}; for a name made as it runs, use `await yorg.load({name!r}, dataset={_ref(info)})`"
    )


async def load(name, dataset=None):
    """Any channel of any test: an attached one's (the first's unless told another), or any test's by name or id."""
    found = _find(dataset) if dataset is not None else (attached[0] if attached else None)
    test = found["id"] if found else dataset
    handed = await _yorg_page.ask("channel", _js({"name": name, "dataset": test}))
    return _keep(json.loads(handed.meta), handed.t, handed.v)._copy()


async def datasets():
    """Every test (dataset) there is, each a dict: id, name, rows, t_min, t_max."""
    return json.loads(await _yorg_page.ask("datasets", _js({})))


def plot(x, y=None, name=None, unit="", title=None):
    """Plot y against x (s) on the page with Yorg's plots (drag to zoom, a shared cursor). Series with the same title
    share a plot; the title is the name unless given. plot(channel) plots a Channel; plot(y), y against its index."""
    of = None
    if isinstance(x, Channel):
        name, unit, of = name or x.name, unit or x.unit, x.dataset_id
        x, y = x.t, x.values
    elif y is None:
        y = np.asarray(x, dtype=float)
        x = np.arange(len(y), dtype=float)
    x = np.asarray(x, dtype="<f8").ravel()
    y = np.asarray(y, dtype="<f8").ravel()
    if len(x) != len(y):
        raise ValueError(f"x has {len(x)} values and y {len(y)}: they go in pairs")
    name = str(name or "Series")
    message = {"title": str(title or name), "name": name, "unit": str(unit), "x": x.tobytes(), "y": y.tobytes()}
    if of is not None:
        message["dataset"] = of  # its times are its test's: a page puts them where that test is
    _send("plot", message)


def download(filename, content):
    """Offer a file on the page for you to save: text (a CSV, say), bytes, or a pandas DataFrame (saved as CSV)."""
    if hasattr(content, "to_csv"):
        content = content.to_csv(index=False)
    if isinstance(content, str):
        content = content.encode("utf-8")
    _send("file", {"name": str(filename), "data": bytes(content)})


# --- units -----------------------------------------------------------------------------------------------------------

_PRESSURE = {
    "pa": 1.0,
    "kpa": 1e3,
    "mpa": 1e6,
    "bar": 1e5,
    "mbar": 100.0,
    "psi": PSI,
    "ksi": 1000 * PSI,
    "atm": ATMOSPHERE,
    "torr": 133.322,
    "mmhg": 133.322,
    "inhg": 3386.39,
}
_MASS_FLOW = {
    "kg/s": 1.0,
    "g/s": 1e-3,
    "kg/min": 1 / 60,
    "lb/s": 0.45359237,
    "lbm/s": 0.45359237,
    "lbs/s": 0.45359237,
    "lb/min": 0.45359237 / 60,
    "lbm/min": 0.45359237 / 60,
}


def si(values, unit, ambient=ATMOSPHERE):
    """values in unit, in SI units: pressures in Pa absolute, temperatures in K, mass flows in kg/s; other units as
    they are. A pressure unit ending in g (psig, barg) is gauge and one ending in a (psia) absolute; plain psi counts
    as gauge, as test stands mostly mean it, and every other plain pressure unit as absolute."""
    values = np.asarray(values, dtype=float)
    key = "".join(unit.lower().replace("°", "").replace("deg", "").split())
    gauge = key == "psi"
    if key[-1:] in ("g", "a") and key[:-1] in _PRESSURE:
        gauge, key = key.endswith("g"), key[:-1]
    if key in _PRESSURE:
        return values * _PRESSURE[key] + (ambient if gauge else 0.0)
    if key in ("k", "c", "f", "r"):
        return {"k": values, "c": values + 273.15, "f": (values - 32.0) * 5 / 9 + 273.15, "r": values * 5 / 9}[key]
    if key in _MASS_FLOW:
        return values * _MASS_FLOW[key]
    return values


# --- helpers ---------------------------------------------------------------------------------------------------------


def resample(*channels_, dt=None, start=None, end=None):
    """Channels on one clock (every dt seconds, by default the finest of theirs, over the time they all have), as
    (t, [values of each]): for arithmetic between channels logged at different rates."""
    if not channels_:
        raise ValueError("resample what? Give it channels")
    start = max(one.t[0] for one in channels_) if start is None else start
    end = min(one.t[-1] for one in channels_) if end is None else end
    if dt is None:
        dt = min(float(np.median(np.diff(one.t))) for one in channels_ if len(one.t) > 1)
    t = np.arange(start, end + dt / 2, dt)
    return t, [one.at(t) for one in channels_]


def cda(mass_flow, pressure_drop, density):
    """An orifice's (an injector's) CdA, m², from its mass flow (kg/s), pressure drop (Pa), and liquid density
    (kg/m³): mdot / sqrt(2 rho dP)."""
    mass_flow = np.asarray(mass_flow, dtype=float)
    pressure_drop = np.maximum(np.asarray(pressure_drop, dtype=float), 1e-9)
    return mass_flow / np.sqrt(2.0 * density * pressure_drop)


# --- between the page and the script ---------------------------------------------------------------------------------


def _js(value):
    return to_js(value, dict_converter=js.Object.fromEntries)


def _send(kind, payload):
    _yorg_page.send(kind, _js(payload))


# --- the channels the page hands over, kept while Python stays open ---------------------------------------------------

_cache = {}  # the page's key for a read of a channel: Channel, the least recently used first
_times = {}  # a read's time arrays, by key: a test's channels mostly share one, which comes once
_CACHE_BYTES = 512 * 1024 * 1024  # of samples kept once runs are done with them (a run keeps all it names)


def _array(data):
    """A JavaScript Uint8Array of little-endian float64s, as NumPy's (read-only: runs share it)."""
    return np.frombuffer(data.to_bytes(), dtype="<f8")


def _keep(meta, t, v):
    """Keep a channel the page handed over: its times from t, or those kept under its time key (t is False)."""
    if t is not False:
        _times[meta["time_key"]] = _array(t)
    channel = Channel(
        meta["name"],
        meta.get("unit", ""),
        _times[meta["time_key"]],
        _array(v),
        meta.get("labels") or (),
        meta.get("dataset"),
        meta.get("dataset_id"),
    )
    channel._key, channel._time_key = meta["key"], meta["time_key"]
    _cache.pop(meta["key"], None)
    _cache[meta["key"]] = channel
    return channel


def _store(meta, t, v):
    """A channel handed over before a run (worker.js): meta is JSON, t and v its times (or False) and values."""
    _keep(json.loads(meta), t, v)


def _missing(keys):
    """Of the channels a run names (keys, as JSON), those Python hasn't got, as JSON."""
    return json.dumps([key for key in json.loads(keys) if key not in _cache])


def _time_keys():
    """The keys of the time arrays Python has (as JSON): the page doesn't hand those over again."""
    return json.dumps(list(_times))


def _trim(keep):
    """Let the least recently used channels go while more than _CACHE_BYTES are kept (not those in keep)."""

    def size():
        arrays = {id(array): array for channel in _cache.values() for array in (channel.t, channel.values)}
        return sum(array.nbytes for array in arrays.values())

    for key in list(_cache):
        if size() <= _CACHE_BYTES:
            break
        if key not in keep:
            del _cache[key]
    used = {channel._time_key for channel in _cache.values()}
    for key in [key for key in _times if key not in used]:
        del _times[key]


# --- imports, said as they start (some take a while), and timed -------------------------------------------------------

_real_import = builtins.__import__
_reporting = False  # during a run, or getting a script's imports ready: say what's importing
_after = None  # what a run is back to once an import's done ("code")
_importing = False  # in an import that's been said: those it makes are part of it
_imported = []  # this run's imports, timed: {"kind": "import", "module", "seconds"}


def _import(name, globals=None, locals=None, fromlist=(), level=0):
    global _importing
    if not _reporting or _importing or level or name in sys.modules:
        return _real_import(name, globals, locals, fromlist, level)
    _importing = True
    _yorg_page.progress("import", name)
    started = time.perf_counter()
    try:
        return _real_import(name, globals, locals, fromlist, level)
    finally:
        _importing = False
        _imported.append({"kind": "import", "module": name, "seconds": time.perf_counter() - started})
        _patch_pyplot()
        if _after:
            _yorg_page.progress(_after, None)


builtins.__import__ = _import


def _import_times():
    """This run's imports and how long each took, as JSON."""
    return json.dumps(_imported)


# Slow to import, and nothing happens on import but getting ready: worth importing before a script runs (as slowImports
# in tree.ts has them).
_WARM = {"numpy", "scipy", "pandas", "matplotlib", "CoolProp", "sympy"}


def _warm(code):
    """Import the slow modules a script imports (only those), before it runs, saying which as each starts."""
    global _reporting, _after
    try:
        tree = compile(code, "<script>", "exec", ast.PyCF_ONLY_AST | ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    except (SyntaxError, ValueError):
        return  # the run says what's wrong
    wanted = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            wanted += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            # from scipy import signal: signal is a module of its own, which the import brings.
            wanted += [node.module] + [f"{node.module}.{alias.name}" for alias in node.names if alias.name != "*"]
    _reporting, _after = True, None
    try:
        for name in dict.fromkeys(wanted):
            if name.partition(".")[0] not in _WARM or name in sys.modules:
                continue
            try:
                if "." in name and importlib.util.find_spec(name) is None:
                    continue
                __import__(name)
            except Exception:  # noqa: BLE001  not a module (from x import a_function), or broken: the run says
                pass
    finally:
        _reporting = False


# --- a notebook's variables, and the editor's help with them ------------------------------------------------------------

_namespaces = {}  # a notebook's name for itself: its variables, kept from one cell's run to the next


def _namespace(name):
    """A notebook's variables (worker.js runs its cells in them), made the first time it runs a cell."""
    found = _namespaces.get(name)
    if found is None:
        found = _namespaces[name] = {"__name__": "__main__", "yorg": sys.modules[__name__]}
    return found


def _names(namespace):
    """What the editor's suggestions know: a notebook's variables (or just yorg, for a script on its own)."""
    return [_namespaces.get(namespace) or {"__name__": "__main__", "yorg": sys.modules[__name__]}]


def _jedi():
    """jedi, the editor's suggestions, if it's loaded (worker.js loads it once Python's otherwise idle)."""
    return sys.modules.get("jedi") or (importlib.import_module("jedi") if importlib.util.find_spec("jedi") else None)


def _complete(namespace, code, line, column):
    """What could go at a place in a cell (line from 1, column from 0), knowing what the notebook has now, as JSON:
    [{"label", "type"}]. Names starting with _ only when that's what's typed."""
    jedi = _jedi()
    if jedi is None:
        return "[]"
    try:
        found = jedi.Interpreter(code, _names(namespace)).complete(line, column)
    except Exception:  # noqa: BLE001  whatever jedi can't make of it: no suggestions
        return "[]"
    items = []
    for completion in found[:400]:
        typed = completion.name[: len(completion.name) - len(completion.complete or "")]
        if completion.name.startswith("_") and not typed.startswith("_"):
            continue
        items.append({"label": completion.name, "type": completion.type})
    return json.dumps(items)


def _inspect(namespace, code, line, column):
    """What the name at a place in a cell is: its signature and the start of its docstring ("" if nothing's known)."""
    jedi = _jedi()
    if jedi is None:
        return ""
    try:
        found = jedi.Interpreter(code, _names(namespace)).help(line, column)
    except Exception:  # noqa: BLE001  nothing known
        return ""
    for name in found:
        text = name.docstring().strip()
        if text:
            return text[:1500]
    return ""


def _check(code):
    """A cell's code, checked as Python reads it: its first syntax error, as JSON (line from 1, column from 0), or
    null."""
    try:
        compile(code, "<cell>", "exec", ast.PyCF_ONLY_AST | ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    except SyntaxError as error:
        line = error.lineno or 1
        column = max(0, (error.offset or 1) - 1)
        end_line = error.end_lineno or line
        end_column = (error.end_offset or 0) - 1
        if end_line == line and end_column <= column:
            end_column = column + 1  # at least the character it's at
        return json.dumps(
            {"line": line, "column": column, "end_line": end_line, "end_column": end_column, "message": error.msg}
        )
    except (ValueError, OverflowError):
        return "null"
    return "null"


def _warm_tools():
    """Get the editor's suggestions ready: jedi imported, and what it takes it longest to learn the first time (NumPy
    and its arrays) learned."""
    jedi = _jedi()
    if jedi is None:
        return
    try:
        jedi.Interpreter("numpy.li", [{"numpy": np}]).complete(1, 8)
        jedi.Interpreter("x.me", [{"x": np.zeros(1)}]).complete(1, 4)
        jedi.Interpreter("c.va", [{"c": Channel("", "", (), ())}]).complete(1, 4)
    except Exception:  # noqa: BLE001  the suggestions get ready as they're asked for, then
        pass


# --- a run --------------------------------------------------------------------------------------------------------------


def _begin(context, keys):
    """Before a run: the tests attached (context, JSON), the channels it names (keys, JSON: kept here already), its
    imports said as they start, and matplotlib's figures from before it gone."""
    global dataset, t0, window, shifts, _reporting, _after
    context, keys = json.loads(context), json.loads(keys)
    attached[:] = context.get("datasets") or []
    dataset = attached[0] if attached else None
    t0 = dataset.get("t0") if dataset else None
    page = context.get("view") or {}
    window = tuple(page["window"]) if page.get("window") else None
    shifts = {int(test): float(by) for test, by in (page.get("shifts") or {}).items()}
    if "t0" in page:
        t0 = page["t0"]
    _loaded.clear()
    for key in keys:
        channel = _cache.pop(key)
        _cache[key] = channel  # the most recently used, last
        _loaded[channel.dataset_id, channel.name] = channel._copy()
    _trim(set(keys))
    _imported.clear()
    _reporting, _after = True, "code"
    _patch_pyplot()
    if "matplotlib.pyplot" in sys.modules:
        sys.modules["matplotlib.pyplot"].close("all")


def _finish():
    """After a run, however it went: imports no longer said, and the figures it drew but didn't show, shown (as a
    notebook would)."""
    global _reporting, _after
    _reporting, _after = False, None
    if "matplotlib.pyplot" in sys.modules:
        _show()


def _patch_pyplot():
    """Once pyplot's imported, its show() shows the figures on the page."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None and plt.show is not _show:
        plt.show = _show


def _show(*args, **kwargs):
    """matplotlib's show: each open figure to the page, as a PNG."""
    plt = sys.modules["matplotlib.pyplot"]
    for number in plt.get_fignums():
        buffer = io.BytesIO()
        plt.figure(number).savefig(buffer, format="png", dpi=110, bbox_inches="tight")
        _send("figure", {"png": buffer.getvalue()})
    plt.close("all")
