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
"""

import io
import os
import sys

os.environ.setdefault("MPLBACKEND", "Agg")  # before matplotlib: a worker has no page to draw on

import _yorg_page  # noqa: E402  the page, through the worker (worker.js)
import js  # noqa: E402
import numpy as np  # noqa: E402
from pyodide.ffi import to_js  # noqa: E402

PSI = 6894.757
ATMOSPHERE = 101325.0

attached = []  # the tests attached to the script, the first first: {"id", "name", "t0", "channels": [{"name", ...}]}
dataset = None  # the first of them (None: none attached)
t0 = None  # its T0, on its clock, if this browser has one for it
_loaded = {}  # (test's id, channel's name): Channel, loaded before the script started


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
    return _channel(await _ask("channel", {"name": name, "dataset": test}))


async def datasets():
    """Every test (dataset) there is, each a dict: id, name, rows, t_min, t_max."""
    return await _ask("datasets", {})


def plot(x, y=None, name=None, unit="", title=None):
    """Plot y against x (s) on the page with Yorg's plots (drag to zoom, a shared cursor). Series with the same title
    share a plot; the title is the name unless given. plot(channel) plots a Channel; plot(y), y against its index."""
    if isinstance(x, Channel):
        name, unit = name or x.name, unit or x.unit
        x, y = x.t, x.values
    elif y is None:
        y = np.asarray(x, dtype=float)
        x = np.arange(len(y), dtype=float)
    x = np.asarray(x, dtype="<f8").ravel()
    y = np.asarray(y, dtype="<f8").ravel()
    if len(x) != len(y):
        raise ValueError(f"x has {len(x)} values and y {len(y)}: they go in pairs")
    name = str(name or "Series")
    _send("plot", {"title": str(title or name), "name": name, "unit": str(unit), "x": x.tobytes(), "y": y.tobytes()})


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


async def _ask(what, args):
    found = await _yorg_page.ask(what, _js(args))
    return found.to_py() if hasattr(found, "to_py") else found


def _channel(found):
    """A Channel from what the page sent: its times and values as little-endian float64 bytes."""
    return Channel(
        found["name"],
        found.get("unit", ""),
        np.frombuffer(bytes(found["t"]), dtype="<f8"),
        np.frombuffer(bytes(found["v"]), dtype="<f8"),
        found.get("labels") or (),
        found.get("dataset"),
        found.get("dataset_id"),
    )


def _begin(context, preloaded):
    """Before a script: the tests attached, the channels it names, and matplotlib drawing to the page."""
    global dataset, t0
    context = context.to_py() if hasattr(context, "to_py") else context
    attached[:] = context.get("datasets") or []
    dataset = attached[0] if attached else None
    t0 = dataset.get("t0") if dataset else None
    _loaded.clear()
    for found in preloaded.to_py() if hasattr(preloaded, "to_py") else preloaded:
        _loaded[found["dataset_id"], found["name"]] = _channel(found)
    if "matplotlib" in sys.modules or _installed("matplotlib"):
        import matplotlib.pyplot as plt

        plt.close("all")
        plt.show = _show


def _installed(name):
    import importlib.util

    return importlib.util.find_spec(name) is not None


def _show(*args, **kwargs):
    """matplotlib's show: each open figure to the page, as a PNG."""
    import matplotlib.pyplot as plt

    for number in plt.get_fignums():
        buffer = io.BytesIO()
        plt.figure(number).savefig(buffer, format="png", dpi=110, bbox_inches="tight")
        _send("figure", {"png": buffer.getvalue()})
    plt.close("all")


def _end():
    """After a script: the figures it drew but didn't show, shown (as a notebook would)."""
    if "matplotlib.pyplot" in sys.modules:
        _show()
