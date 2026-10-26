"""A checked system model as a FullFlow script: the code a run runs (network.run executes it), which Piper's Simulation
mode shows (its Script).

The script is the model as FullFlow's own models are written: FullFlow's components, with each fluid's properties from
ThermoProp through FullFlow's Lookup. Gas valves, orifices, and regulators are CompressibleOrifices; liquid valves and
orifices DischargeCoefficients; lines DarcyWeisbach; venturis CavitatingVenturis; a valve's travel an Actuator. What a
node holds is a Volume: a junction's balance, a gas junction's gas, and a tank's liquid and ullage gas, which a Balance
holds at one pressure, beside its wall (a Solid) and the heat through it (Convection). A gas is real or ideal at its
node's pressure and temperature; a liquid is its tank's at each node's pressure. Yorg's own (library.py and
components.py, which the script imports as yorg_models) puts the test's channels in, anchors knobs, and reads the
results out.

The script adds components in the order values flow (commands and properties, then flows, then what nodes hold), so
FullFlow settles each trial in one pass. It depends on the job alone, so the copy Piper shows and the one the server runs
are the same text. It reads the test's channels from data["part.link"] (their times on the test's clock, values in SI units), which
whoever runs it provides.

What goes into the script from the model goes in as Python literals (repr), never as code: a part's name, a channel's,
a setting; a comment gets words on one line. Writing it imports neither FullFlow nor the library, so the site's own
process can.
"""

import builtins
import keyword
import math
import re
import textwrap
from dataclasses import dataclass, field
from typing import Any

from .catalog import BY_TYPE, applies, in_words, output_of

POINTS = 2000  # results per output, unless asked for fewer (library.MAX_POINTS)
WIDTH = 110  # a line's length, past which a call is broken into one argument a line
SHORT = 72  # a dict's or list's, past which it's one entry a line

# Names a script's variables don't take: Python's, the lowercase names the script imports (its own are lowercase), and
# its own.
RESERVED = (
    set(keyword.kwlist)
    | set(keyword.softkwlist)
    | set(dir(builtins))
    | {"math", "net", "run", "data", "result", "above", "cavitating", "eased", "entering", "leaving", "enthalpy_in"}
    | {"annotations", "dataclass", "dataset_names", "field", "h5py", "hdf5_filename", "hdf5_path", "hdf5_target"}
    | {"inspect", "is_assignable_state_like", "is_state_like", "json", "label_state_refs", "main", "np"}
    | {"object_path", "resolve_numeric", "resolve_value", "run_group_path", "safe_group_name", "sys", "wrightomega"}
    | {"write_failures", "write_model_option_results", "write_solution", "write_tables", "write_transient_solution"}
)

UNITS = {
    "pressure": "Pa",
    "pressure_abs": "Pa",
    "pressure_drop": "Pa",
    "temperature": "K",
    "length": "m",
    "diameter": "m",
    "area": "m²",
    "volume": "m³",
    "density": "kg/m³",
    "mass": "kg",
    "mass_flow": "kg/s",
    "specific_heat": "J/kg·K",
    "conductance": "W/K",
    "time": "s",
}

# A liquid's ThermoProp class and name, where it isn't Fluid's of the catalog's name: RP-1 is a propellant there.
PROPELLANTS = {"RP1": "RP-1"}


def _thermoprop(fluid: str) -> tuple[str, str]:
    """A liquid's ThermoProp class, and its name there."""
    return ("Propellant", PROPELLANTS[fluid]) if fluid in PROPELLANTS else ("Fluid", fluid)


class Unrunnable(Exception):
    """A model that checks out but can't be run as asked (a knob anchored that nothing reads), in words."""


def script(job: dict[str, Any], max_points: int = POINTS) -> str:
    """The FullFlow script that runs job's model over its window (see runner.py for the job)."""
    return _Writer(job, max_points).text()


def _number(value: float) -> str:
    """A float as Python that reads back as the same float."""
    value = float(value)
    if math.isnan(value):
        return 'float("nan")'
    if math.isinf(value):
        return 'float("inf")' if value > 0 else '-float("inf")'
    return repr(value)


def _words(text: str) -> str:
    """Text for a comment: on one line, whatever it held."""
    return re.sub(r"\s+", " ", "".join(char if char.isprintable() else " " for char in str(text))).strip()


def _identifier(text: str) -> str:
    name = re.sub(r"[^0-9a-zA-Z]+", "_", str(text)).strip("_").lower()
    return f"part_{name}" if name[:1].isdigit() else name


@dataclass
class _Call:
    """A call in the script: on one line if it fits (indented as much as it will be), else an argument a line."""

    function: str
    args: tuple["str | _Call", ...] = ()
    kwargs: dict[str, "str | _Call"] = field(default_factory=dict)

    def render(self, prefix: str = "", indent: int = 0) -> str:
        flat = [*map(str, self.args), *(f"{key}={value}" for key, value in self.kwargs.items())]
        one = f"{prefix}{self.function}({', '.join(flat)})"
        if indent + len(one) <= WIDTH and "\n" not in one:
            return one
        parts = [
            *(one.render("", indent + 4) if isinstance(one, _Call) else one for one in self.args),
            *(
                value.render(f"{key}=", indent + 4) if isinstance(value, _Call) else f"{key}={value}"
                for key, value in self.kwargs.items()
            ),
        ]
        return f"{prefix}{self.function}(\n" + "".join(textwrap.indent(part, "    ") + ",\n" for part in parts) + ")"

    def __str__(self) -> str:
        return self.render()


def _call(callee: str, /, *args: object, **kwargs: object) -> _Call:
    keep = lambda value: value if isinstance(value, _Call) else str(value)  # noqa: E731
    return _Call(callee, tuple(map(keep, args)), {key: keep(value) for key, value in kwargs.items()})


def _listed(opening: str, items: list[str], closing: str) -> str:
    """A dict's entries or a list's items as code: on one line if short, else one a line."""
    one = f"{opening}{', '.join(items)}{closing}"
    if len(one) <= SHORT:
        return one
    return f"{opening}\n" + "".join(f"    {item},\n" for item in items) + closing


def _derived(start: str, expression: str) -> _Call:
    """A State FullFlow works out from others (start: its first value)."""
    return _call(f"State({start}).derive_from", f"lambda: {expression}")


def _total(flows: list[str]) -> str:
    """Flows added up, as a FullFlow expression (none: nothing flows)."""
    return " + ".join(flows) if flows else "0.0"


class _Names:
    """Variable names, each taken once."""

    def __init__(self) -> None:
        self.taken: set[str] = set(RESERVED)

    def take(self, wanted: str) -> str:
        name = wanted if wanted.isidentifier() else "part"
        found, count = name, 1
        while found in self.taken:
            count += 1
            found = f"{name}_{count}"
        self.taken.add(found)
        return found


class _Writer:
    def __init__(self, job: dict[str, Any], max_points: int):
        self.job, self.max_points = job, max_points
        self.steady = job.get("solver") == "steady"
        self.nodes: dict[str, dict[str, Any]] = job["model"]["nodes"]
        self.edges: dict[str, dict[str, Any]] = job["model"]["edges"]
        self.liquid_of: dict[str, str] = job["liquid_of"]
        self.gas_of: dict[str, str] = dict(job.get("gas_of", {}))
        self.gas_model_of: dict[str, str] = dict(job.get("gas_model_of", {}))
        parts = {**self.nodes, **self.edges}
        self.names = _Names()
        # Each part's own name in the script, taken first: its variables' names start with it.
        self.base = {
            part_id: self.names.take(_identifier(part["name"]) or _identifier(part_id) or "part")
            for part_id, part in parts.items()
        }
        # The channels the model is linked to, by part.link: each one's name in the test, and what it measures.
        self.channels = {
            f"{part['id']}.{link.key}": (part["links"][link.key], link.quantity)
            for part in parts.values()
            for link in BY_TYPE[part["type"]].links
            if part["links"].get(link.key) and applies(link.only_when, part["settings"])
        }
        self.sources = {edge["source"] for edge in self.edges.values()}  # nodes something flows from
        self.lines: list[str] = []
        self.pressure: dict[str, str] = {}  # every node's, by id (a tank under an ullage: its gas's)
        self.liquid_pressure: dict[str, str] = {}  # every liquid node's liquid's (a tank under an ullage: its liquid's)
        self.temperature: dict[str, str] = {}  # every gas node's
        self.gas: dict[str, str] = {}  # every gas node's gas: its Lookup
        self.liquid: dict[str, str] = {}  # each liquid node's liquid, where ThermoProp has it: its Lookup
        self.density: dict[str, str] = {}  # each liquid node's liquid's density
        self.vapor: dict[str, str] = {}  # each tank's liquid's vapor pressure
        self.liquid_temperature: dict[str, str] = {}  # each tank's
        self.flow: dict[str, str] = {}  # every edge's
        self.outputs: dict[str, str] = {}  # the other outputs, by part.output
        self.knobs: dict[str, str] = {}  # every tunable setting made a State, by part.key
        self.probes: dict[str, str] = {}

    # --- writing ---------------------------------------------------------------------------------------------------

    def text(self) -> str:
        self._head()
        # Tanks first: the liquids the other nodes hold are theirs.
        for node in sorted(self.nodes.values(), key=lambda node: node["type"] != "tank"):
            self._node(node)
        for edge in self.edges.values():
            self._edge(edge)
        self._storage()
        self._guess_junctions()
        self._record()
        for anchor in self.job.get("anchors", []):
            self._anchor(anchor)
        self.emit("")
        self.comment("Solve it: the result is what Piper shows (the outputs at each time, and what the run says)")
        self.emit(f"result = run.solve({'' if self.max_points == POINTS else f'max_points={self.max_points}'})")
        return "\n".join(self.lines) + "\n"

    def emit(self, line: str = "") -> None:
        self.lines.append(line)

    def comment(self, text: str) -> None:
        self.lines.extend(f"# {line}" for line in textwrap.wrap(_words(text), WIDTH - 2))

    def line(self, code: str, note: str | None = None) -> None:
        """A line (or lines) of code, with a note beside it if it fits, else above it."""
        note = _words(note) if note else ""
        if note and "\n" not in code and len(code) + len(note) + 4 <= WIDTH:
            self.lines.append(f"{code}  # {note}")
            return
        if note:
            self.comment(note[:1].upper() + note[1:])
        self.lines.append(code)

    def assign(self, wanted: str, code: str | _Call, note: str | None = None, own: bool = False) -> str:
        """A variable (named wanted, or near it; own: a part's own name) set to code: its name."""
        name = wanted if own else self.names.take(wanted)
        self.line(code.render(f"{name} = ") if isinstance(code, _Call) else f"{name} = {code}", note)
        return name

    def knob(self, part: dict[str, Any], key: str) -> str:
        """A tunable setting, as a State of its own that an anchor (or you) can move. Without bounds: see
        library.Run.anchor."""
        setting = next(one for one in BY_TYPE[part["type"]].settings if one.key == key)
        unit = UNITS.get(setting.quantity)
        name = self.assign(
            f"{self.base[part['id']]}_{key}",
            f"State({_number(part['settings'][key])})",
            f"knob: {setting.label}{f' ({unit})' if unit else ''}",
        )
        self.knobs[f"{part['id']}.{key}"] = name
        return name

    def linked(self, part: dict[str, Any], key: str) -> str | None:
        """The name of the channel a part's link is to, if it's linked and counts as the part is set up."""
        return self.channels.get(f"{part['id']}.{key}", (None, ""))[0]

    def unit(self, part: dict[str, Any], key: str) -> str:
        quantity = next(one.quantity for one in BY_TYPE[part["type"]].links if one.key == key)
        return UNITS.get(quantity, "")

    def following(self, part: dict[str, Any], key: str, constant: float, wanted: str) -> str:
        """A value that follows its channel through the run, or stays at constant."""
        channel = self.linked(part, key)
        if channel is None:
            return self.assign(wanted, f"State({_number(constant)})", self.unit(part, key))
        follows = _call("run.following", repr(f"{part['id']}.{key}"), otherwise=_number(constant))
        return self.assign(wanted, follows, f"follows {channel}")

    def starting(self, part: dict[str, Any], key: str, default: float, low: float | None = None) -> str:
        """Code for a value the model starts from: its channel's at the run's start, or the setting's (at least low)."""
        if self.linked(part, key) is None:
            return _number(max(float(default), low) if low is not None else float(default))
        extra = {} if low is None else {"low": _number(low)}
        return str(_call("run.starting", repr(f"{part['id']}.{key}"), otherwise=_number(default), **extra))

    def solving(self, part: dict[str, Any], key: str) -> str:
        """What a note says of a value FullFlow solves for, which starts from a link's channel or a setting."""
        channel = self.linked(part, key)
        return f"solved for, from {channel} at the start" if channel else f"{self.unit(part, key)}, solved for"

    def solved(self, code: str) -> _Call:
        """A State FullFlow solves for: without bounds, as FullFlow's own models have them. Bounded, SciPy's trust region
        takes steps the size of the distance to a bound, which made every step a third slower (and a steady junction
        from its first guess, a regulator shut at its bound, ran out of tries before it settled)."""
        return _call("State", code)

    # --- the script's head ------------------------------------------------------------------------------------------

    def _head(self) -> None:
        job = self.job
        how = "steady (FullFlow's quasi-steady sweep)" if self.steady else "transient"
        self.emit('"""A system model as a FullFlow script, as Yorg writes it from a Piper P&ID\'s.')
        self.emit("")
        self.emit(
            f"It runs from {_number(job['start'])} to {_number(job['end'])} s on the test's clock, {how}, in time steps "
            f"of {_number(job['dt'])} s."
        )
        self.emit("Piper's Simulation mode runs it on the server, as it's written.")
        self.emit("data['part.link'] is a linked channel's samples: their times on the test's clock, and their values")
        self.emit("in SI units (Pa, K, kg/s; a valve's command as it is). Settings are in SI units too.")
        self.emit('"""')
        self.emit("")
        self.emit("import math")
        self.emit("")
        self.emit("from fullflow import *")
        self.emit("from thermoprop import Fluid, IdealGas, Propellant  # fluids' properties, through FullFlow's Lookup")
        self.emit("from yorg_models import *  # Yorg's own: Run, which puts the test's data in and the results out")
        self.emit("")
        self.comment(
            "The run: its window on the test's clock, its time step, each part's name (for what the run says), and "
            "the channels the model is linked to, by part.link (data's keys): each one's name, and what it measures."
        )
        names = [f"{part_id!r}: {part['name']!r}" for part_id, part in {**self.nodes, **self.edges}.items()]
        channels = [f"{key!r}: ({channel!r}, {quantity!r})" for key, (channel, quantity) in self.channels.items()]
        run = _call(
            "Run",
            "data",
            start=_number(job["start"]),
            end=_number(job["end"]),
            dt=_number(job["dt"]),
            steady=repr(self.steady),
            names=_listed("{", names, "}"),
            channels=_listed("{", channels, "}"),
        )
        self.emit(run.render("run = "))
        self.emit("net = run.net  # FullFlow's Network: each component below is added to it")

    # --- nodes: their pressures, and what they hold ----------------------------------------------------------------

    def _node(self, node: dict[str, Any]) -> None:
        node_id, kind, settings = node["id"], node["type"], node["settings"]
        base = self.base[node_id]
        self.emit("")
        if kind == "tank":
            self._tank(node)
        elif kind == "source":
            self.comment(f"{node['name']}: a gas supply")
            pressure = self.following(node, "pressure", settings["pressure"], f"{base}_pressure")
            temperature = self.following(node, "temperature", settings["temperature"], f"{base}_temperature")
            self._gas(node, pressure, temperature)
        elif kind == "outlet":
            self.comment(f"{node['name']}: an outlet")
            pressure = self.following(node, "pressure", settings["pressure"], f"{base}_pressure")
            self.pressure[node_id] = self.liquid_pressure[node_id] = pressure
            if node_id in self.gas_of and self._gives_gas(node_id):
                temperature = self.assign(f"{base}_temperature", "State(OUTSIDE)", "K: gas that flows back in from it")
                self._gas(node, pressure, temperature)
            if node_id in self.liquid_of and node_id in self.sources:
                self._liquid(node, pressure)
        elif kind == "gas_junction" and self._holds(node):
            # Steady, what's stored holds what was measured, as a tank does: a bottle has no steady state of its own.
            self.comment(f"{node['name']}: a gas junction, which holds the pressure measured in a steady run")
            pressure = self.following(node, "pressure", settings["pressure"], f"{base}_pressure")
            temperature = self.following(node, "temperature", settings["temperature"], f"{base}_temperature")
            self._gas(node, pressure, temperature)
            self.outputs[f"{node_id}.temperature"] = temperature
        elif kind == "gas_junction":
            self.comment(f"{node['name']}: a gas junction, holding the gas in the tubing around it")
            start = self.starting(node, "pressure", settings["pressure"], low=1000.0)
            pressure = self.assign(f"{base}_pressure", self.solved(start), self.solving(node, "pressure"))
            start = self.starting(node, "temperature", settings["temperature"])
            temperature = self.assign(f"{base}_temperature", self.solved(start), self.solving(node, "temperature"))
            self._gas(node, pressure, temperature)
            self.outputs[f"{node_id}.temperature"] = temperature
        else:
            self.comment(f"{node['name']}: a junction, whose pressure makes what flows in flow out")
            pressure = self.assign(
                f"{base}_pressure", self.solved("ATMOSPHERE"), "Pa, solved for: see run.guess_junctions"
            )
            self.pressure[node_id] = self.liquid_pressure[node_id] = pressure
            self._liquid(node, pressure)

    def _tank(self, tank: dict[str, Any]) -> None:
        """A tank's pressure (its ullage's, solved for, or one it holds), and its liquid's and ullage gas's
        properties."""
        tank_id, settings = tank["id"], tank["settings"]
        base = self.base[tank_id]
        ullage = settings["mode"] == "ullage"
        stores = ullage and not self.steady  # its liquid and its ullage's gas are kept through the run
        if stores:
            what = "with a gas ullage"
        elif ullage:
            what = "with a gas ullage, which holds its pressure in a steady run"
        else:
            what = "whose pressure follows its channel" if self.linked(tank, "pressure") else "at a pressure"
        self.comment(f"{tank['name']}: a tank {what}")
        if stores:
            start = self.starting(tank, "pressure", settings["pressure"], low=1000.0)
            pressure = self.assign(f"{base}_pressure", self.solved(start), self.solving(tank, "pressure"))
            start = self.starting(tank, "gas_temperature", settings["gas_temperature"])
            temperature = self.assign(
                f"{base}_gas_temperature", self.solved(start), self.solving(tank, "gas_temperature")
            )
            liquid_pressure = self.assign(
                f"{base}_liquid_pressure",
                self.solved(f"{pressure}.value"),
                "its liquid's: its ullage's, as a Balance holds it",
            )
        else:
            pressure = self.following(tank, "pressure", settings["pressure"], f"{base}_pressure")
            liquid_pressure = pressure
            if ullage:
                temperature = self.following(
                    tank, "gas_temperature", settings["gas_temperature"], f"{base}_gas_temperature"
                )
        self.pressure[tank_id], self.liquid_pressure[tank_id] = pressure, liquid_pressure
        if settings["fluid"] == "Custom":
            density, vapor = self.names.take(f"{base}_density"), self.names.take(f"{base}_vapor_pressure")
            liquid = _call(
                "run.custom_liquid",
                repr(tank_id),
                density=_number(settings["density"]),
                vapor_pressure=_number(settings["vapor_pressure"]),
                temperature=_number(settings["temperature"]),
            )
            self.line(liquid.render(f"{density}, {vapor} = "), "a liquid of the density and vapor pressure given")
            self.density[tank_id], self.vapor[tank_id] = density, vapor
        else:
            self.liquid_temperature[tank_id] = self.following(
                tank, "temperature", settings["temperature"], f"{base}_liquid_temperature"
            )
            kind, name = _thermoprop(settings["fluid"])
            liquid = self.assign(
                f"{base}_liquid",
                _call(
                    "Lookup",
                    repr(f"{tank_id}:liquid"),
                    "net",
                    kind,
                    repr(name),
                    pressure=liquid_pressure,
                    temperature=self.liquid_temperature[tank_id],
                ),
                f"ThermoProp's {name}, at its pressure and temperature",
            )
            self.line(f"run.liquid({tank_id!r}, {liquid})", "what Piper says of it, and a check that it's liquid")
            self.liquid[tank_id] = liquid
            self.density[tank_id], self.vapor[tank_id] = f"{liquid}.density", f"{liquid}.saturation_pressure"
        if ullage:
            self._gas(tank, pressure, temperature)

    def _gas(self, node: dict[str, Any], pressure: str, temperature: str) -> None:
        """A gas node's gas: ThermoProp's, real or ideal, at the node's pressure and temperature."""
        node_id, settings = node["id"], node["settings"]
        gas = self.gas_of.get(node_id, settings.get("gas", "Nitrogen"))
        real = self.gas_model_of.get(node_id, settings.get("gas_model", "real")) == "real"
        lookup = self.assign(
            f"{self.base[node_id]}_gas",
            _call(
                "Lookup",
                repr(f"{node_id}:gas"),
                "net",
                "Fluid" if real else "IdealGas",
                repr(gas),
                pressure=pressure,
                temperature=temperature,
            ),
            f"{'real' if real else 'ideal'} {gas}, at its pressure and temperature",
        )
        self.line(f"run.gas({node_id!r}, {lookup})", "a check that ThermoProp has it at the start")
        self.pressure[node_id], self.temperature[node_id], self.gas[node_id] = pressure, temperature, lookup

    def _holds(self, node: dict[str, Any]) -> bool:
        """Whether a gas junction holds the pressure its transducer measured: in a steady run, where it has one."""
        return self.steady and self.linked(node, "pressure") is not None

    def _gives_gas(self, node_id: str) -> bool:
        """Whether gas can flow out of a node into the lines: from it, or back through a line with no check valve."""
        for edge in self.edges.values():
            kind = edge["type"]
            if BY_TYPE[kind].phase != "gas" or node_id not in (edge["source"], edge["target"]):
                continue
            checked = kind == "regulator" or (kind == "gas_valve" and edge["settings"]["check"] == "yes")
            if edge["source"] == node_id or not checked:
                return True
        return False

    def _liquid(self, node: dict[str, Any], pressure: str) -> None:
        """What a liquid junction (or outlet) holds: its tank's liquid, at its own pressure."""
        node_id = node["id"]
        tank = self.liquid_of[node_id]
        if tank not in self.liquid:  # a Custom liquid's density is the same everywhere
            self.density[node_id] = self.density[tank]
            return
        kind, name = _thermoprop(self.nodes[tank]["settings"]["fluid"])
        liquid = self.assign(
            f"{self.base[node_id]}_liquid",
            _call(
                "Lookup",
                repr(f"{node_id}:liquid"),
                "net",
                kind,
                repr(name),
                pressure=f"above({pressure}, {self.liquid[tank]}.saturation_pressure)",
                temperature=self.liquid_temperature[tank],
            ),
            f"{self.nodes[tank]['name']}'s {name}, at its pressure (where it would boil, just above it)",
        )
        self.liquid[node_id], self.density[node_id] = liquid, f"{liquid}.density"

    # --- edges: what flows ----------------------------------------------------------------------------------------

    def _edge(self, edge: dict[str, Any]) -> None:
        edge_id, kind, settings = edge["id"], edge["type"], edge["settings"]
        base = self.base[edge_id]
        source, target = edge["source"], edge["target"]
        label = in_words(BY_TYPE[kind].label)
        self.emit("")
        self.comment(
            f"{edge['name']}: {'an' if label[:1] in 'aeiou' else 'a'} {label}, "
            f"from {self.nodes[source]['name']} to {self.nodes[target]['name']}"
        )
        if BY_TYPE[kind].phase == "gas":
            upstream, downstream = self.pressure[source], self.pressure[target]
            position: str | None = None  # a valve's or a regulator's: 0 closed, 1 open
            if kind == "regulator":
                position, check = self._regulator(edge), True
            elif kind == "gas_valve":
                position, check = self._opening(edge), settings["check"] == "yes"
            else:  # a gas orifice
                check = False
            opening = position or "State(1.0)"
            if check:
                opening = self.assign(
                    f"{base}_open",
                    _derived("0.0", f"{position}.value if {upstream}.value >= {downstream}.value else 0.0"),
                    "as open as it is, but shut to gas flowing back",
                )
            discharge = self.eased(base, opening, upstream, downstream)
            cda = self.knob(edge, "cda")
            gas, temperature = self.gas[source], self.temperature[source]
            orifice = _call(
                "CompressibleOrifice",
                repr(edge_id),
                "net",
                upstream_total_pressure=upstream,
                upstream_total_temperature=temperature,
                downstream_pressure=downstream,
                discharge_coefficient=discharge,
                cross_sectional_area=cda,
                gas_constant=f"{gas}.gas_constant",
                specific_heat_ratio=f"{gas}.specific_heat_ratio",
                upstream_static_enthalpy=f"{gas}.enthalpy",
                upstream_static_temperature=temperature,
            )
            self.flow[edge_id] = f"{self.assign(base, orifice, own=True)}.mass_flow"
            if position is not None:
                self.outputs[f"{edge_id}.position"] = position
            return
        tank = self.liquid_of[edge_id]
        density = self.density[source]
        upstream, downstream = self.liquid_pressure[source], self.liquid_pressure[target]
        if kind == "line":
            f, k = self.knob(edge, "friction_factor"), self.knob(edge, "loss_coefficient")
            ratio = settings["diameter"] / settings["length"]
            start = settings["friction_factor"] + settings["loss_coefficient"] * ratio
            self.comment("Fittings' K added to the tubing's friction: (f L/D + K) ρv²/2 is (f + K D/L) L/D ρv²/2")
            friction = self.assign(
                f"{base}_friction", _derived(_number(start), f"{f}.value + {k}.value * {_number(ratio)}")
            )
            line = _call(
                "DarcyWeisbach",
                repr(edge_id),
                "net",
                mass_flow="State(0.0)",
                upstream_pressure=upstream,
                downstream_pressure=downstream,
                length=_number(settings["length"]),
                hydraulic_diameter=_number(settings["diameter"]),
                density=density,
                friction_factor=friction,
            )
            self.flow[edge_id] = f"{self.assign(base, line, own=True)}.mass_flow"
        elif kind in ("valve", "orifice"):
            opening = self._opening(edge) if kind == "valve" else "State(1.0)"
            discharge = self.eased(base, opening, upstream, downstream)
            cda = self.knob(edge, "cda")
            restriction = _call(
                "DischargeCoefficient",
                repr(edge_id),
                "net",
                upstream_pressure=upstream,
                downstream_pressure=downstream,
                density=density,
                discharge_coefficient=discharge,
                cross_sectional_area=cda,
            )
            self.flow[edge_id] = f"{self.assign(base, restriction, own=True)}.mass_flow"
            if kind == "valve":
                self.outputs[f"{edge_id}.position"] = opening
        else:  # a cavitating venturi
            vapor = self.vapor[tank]
            self.emit(f"run.needs_vapor_pressure({edge_id!r}, {tank!r}, {vapor})")
            recovery = self.knob(edge, "recovery")
            cda = self.knob(edge, "cda")
            self.comment(
                "Cavitating, its flow is CdA √(2ρ(P1 − Pv)); not, CdA/√(1 − R) √(2ρ ΔP): the two meet where it starts "
                "to cavitate, at ΔP = (1 − R)(P1 − Pv)"
            )
            unchoked = self.assign(
                f"{base}_noncavitating",
                _derived(
                    _number(1.0 / math.sqrt(1.0 - settings["recovery"])), f"1.0 / math.sqrt(1.0 - {recovery}.value)"
                ),
            )
            unchoked = self.eased(base, unchoked, upstream, downstream)
            venturi = _call(
                "CavitatingVenturi",
                repr(edge_id),
                "net",
                upstream_pressure=upstream,
                downstream_pressure=downstream,
                density=density,
                throat_area=cda,
                vapor_pressure=vapor,
                pressure_recovery_factor=recovery,
                cavitating_discharge_coefficient="1.0",
                noncavitating_discharge_coefficient=unchoked,
            )
            name = self.assign(base, venturi, own=True)
            self.flow[edge_id] = f"{name}.mass_flow"
            self.outputs[f"{edge_id}.cavitating"] = self.assign(
                f"{base}_cavitating",
                _derived("0.0", f"cavitating({upstream}, {downstream}, {vapor}, {recovery})"),
                "1 while it cavitates, as CavitatingVenturi decides it",
            )

    def eased(self, base: str, coefficient: str, upstream: str, downstream: str) -> str:
        """A restriction's discharge coefficient, eased off within 500 Pa of no pressure drop (library.eased): its
        variable."""
        return self.assign(
            f"{base}_cd",
            f"eased({coefficient}, {upstream}, {downstream})",
            "its discharge coefficient, eased off near no pressure drop",
        )

    def _opening(self, edge: dict[str, Any]) -> str:
        """A valve's position: fixed, or following its command channel (0 closed to 1 open), as fast as its opening
        time lets it move."""
        edge_id, settings = edge["id"], edge["settings"]
        base = self.base[edge_id]
        channel = self.linked(edge, "command")
        if channel is None:
            return self.assign(f"{base}_position", f"State({_number(settings['position'])})", "0 closed, 1 open")
        command = self.assign(
            f"{base}_command",
            _call(
                "run.command",
                repr(f"{edge_id}.command"),
                closed=_number(settings["closed_value"]),
                opened=_number(settings["open_value"]),
                otherwise=_number(settings["position"]),
            ),
            f"{channel}, as 0 closed to 1 open",
        )
        position = self.assign(f"{base}_position", f"State({command}.value)")
        opening_time = self.knob(edge, "opening_time")
        actuator = _call(
            "Actuator",
            repr(f"{edge_id}:actuator"),
            "net",
            command=command,
            position=position,
            minimum="0.0",
            maximum="1.0",
            rate_limit=_derived(_number(1.0 / settings["opening_time"]), f"1.0 / {opening_time}.value"),
        )
        self.line(actuator.render(), "It moves to its command, no faster than its opening time allows")
        return position

    def _regulator(self, edge: dict[str, Any]) -> str:
        """A regulator's opening: where the pressure it holds (where it flows to) puts it, solved with the rest in each
        step. (FullFlow's Actuator would move it once a step, a step behind the little volume of tubing after it.)"""
        base = self.base[edge["id"]]
        sensed = self.pressure[edge["target"]]
        setpoint, droop = self.knob(edge, "setpoint"), self.knob(edge, "droop")
        self.comment("It opens as the pressure it holds falls below its set pressure, fully open at its droop below it")
        return self.assign(
            f"{base}_position", f"(({setpoint} - {sensed}) / {droop}).clip(0.0, 1.0)", "0 closed, 1 open"
        )

    # --- what nodes hold ------------------------------------------------------------------------------------------

    def _storage(self) -> None:
        """Each liquid junction balances its flows; each gas junction keeps its gas, and each tank under an ullage its
        liquid and its gas."""
        liquid_in: dict[str, list[str]] = {node_id: [] for node_id in self.nodes}
        liquid_out: dict[str, list[str]] = {node_id: [] for node_id in self.nodes}
        for edge_id, edge in self.edges.items():
            if BY_TYPE[edge["type"]].phase != "gas":
                liquid_out[edge["source"]].append(self.flow[edge_id])
                liquid_in[edge["target"]].append(self.flow[edge_id])
        for node_id, node in self.nodes.items():
            settings = node["settings"]
            if node["type"] == "junction":
                self.emit("")
                self.comment(f"{node['name']}: what flows in flows out")
                junction = _call(
                    "Volume",
                    repr(node_id),
                    "net",
                    pressure=self.pressure[node_id],
                    mass_flow_in=_total(liquid_in[node_id]),
                    mass_flow_out=_total(liquid_out[node_id]),
                )
                self.assign(self.base[node_id], junction, own=True)
            elif node["type"] == "gas_junction" and not self._holds(node):
                self.emit("")
                vessel = settings["wall"] == "vessel"
                walled = vessel and self._walled(node)
                self.comment(
                    f"{node['name']}: its gas"
                    + (
                        ", exchanging heat with its vessel's wall"
                        if walled
                        else " (no heat moves through its vessel's wall: an hA of 0)"
                        if vessel
                        else ""
                    )
                )
                heat = self._wall(node) if walled else None
                self._gas_volume(node, _number(settings["volume"]), name=self.base[node_id], heat=heat)
            elif node["type"] == "tank" and settings["mode"] == "ullage" and not self.steady:
                self.emit("")
                self._tank_storage(node, liquid_in[node_id], liquid_out[node_id])

    def _tank_storage(self, tank: dict[str, Any], liquid_in: list[str], liquid_out: list[str]) -> None:
        """A tank's liquid, and its ullage's gas over it (a Balance holds them at one pressure), exchanging heat with
        the tank's wall (a Solid) by Convection."""
        tank_id, settings = tank["id"], tank["settings"]
        base = self.base[tank_id]
        walled = self._walled(tank)
        self.comment(
            f"{tank['name']}: its liquid, and its ullage's gas over it"
            + (", exchanging heat with its wall" if walled else " (no heat moves through its wall: an hA of 0)")
        )
        held = _call(
            "Volume",
            repr(f"{tank_id}:liquid"),
            "net",
            pressure=self.liquid_pressure[tank_id],
            volume=f"State({_number(settings['liquid_volume'])})",
            density=self.density[tank_id],
            mass_flow_in=_total(liquid_in),
            mass_flow_out=_total(liquid_out),
        )
        held = self.assign(f"{base}_liquid_node", held)
        heat = self._wall(tank) if walled else None
        collapse = self.knob(tank, "collapse_factor")
        self.comment("The ullage is what the liquid leaves of the tank")
        ullage = self._gas_volume(
            tank,
            f"{_number(settings['volume'])} - {held}.volume",
            collapse=collapse,
            heat=heat,
            name=f"{base}_ullage",
        )
        self.line(
            _call(
                "Balance",
                repr(f"{tank_id}:surface"),
                "net",
                variable=f"{held}.volume",
                function=f"{held}.pressure - {ullage}.pressure",
            ).render(),
            "The liquid's pressure is the ullage's, where they meet",
        )
        self.outputs[f"{tank_id}.liquid_volume"] = f"{held}.volume"
        self.outputs[f"{tank_id}.gas_temperature"] = self.temperature[tank_id]

    def _walled(self, part: dict[str, Any]) -> bool:
        """Whether heat moves between a part's gas and its wall: its hA isn't 0, it's anchored, or the wall's
        temperature is measured."""
        anchored = any(
            (one["part"], one["key"]) == (part["id"], "heat_transfer") for one in self.job.get("anchors", [])
        )
        return part["settings"]["heat_transfer"] > 0 or anchored or self.linked(part, "wall_temperature") is not None

    def _wall(self, part: dict[str, Any]) -> str:
        """A part's wall (a Solid) trading heat with its gas by Convection: a tank's around its ullage, or a vessel's.
        The heat into the gas."""
        part_id, settings = part["id"], part["settings"]
        base = self.base[part_id]
        wall = self.assign(
            f"{base}_wall_temperature",
            self.solved(self.starting(part, "wall_temperature", settings["wall_temperature"])),
            self.solving(part, "wall_temperature"),
        )
        heat_transfer = self.knob(part, "heat_transfer")
        convection = _call(
            "Convection",
            repr(f"{part_id}:convection"),
            "net",
            surface_temperature=wall,
            fluid_temperature=self.temperature[part_id],
            convective_area="1.0",
            convection_coefficient=heat_transfer,
        )
        convection = self.assign(f"{base}_convection", convection)
        self.emit(
            _call(
                "Solid",
                repr(f"{part_id}:wall"),
                "net",
                temperature=wall,
                mass=_number(settings["wall_mass"]),
                specific_heat=_number(settings["wall_specific_heat"]),
                heat_rate=f"{convection}.heat_rate",
            ).render()
        )
        self.comment("Convection's heat goes into the wall, out of the gas")
        self.outputs[f"{part_id}.wall_temperature"] = wall
        return f"-{convection}.heat_rate"

    def _gas_volume(
        self, node: dict[str, Any], volume: str, name: str, collapse: str | None = None, heat: str | None = None
    ) -> str:
        """A gas node's Volume: its gas, whose mass and energy FullFlow keeps as it iterates its pressure and
        temperature, with what flows in bringing the enthalpy of where it came from: its variable."""
        node_id = node["id"]
        gas = self.gas[node_id]
        # Each gas line at the node, which way it flows in, and the enthalpy of what's at its other end (None: nothing
        # comes back from there).
        lines = []
        for edge_id, edge in self.edges.items():
            if BY_TYPE[edge["type"]].phase != "gas":
                continue
            for end, other, sign in (("target", "source", "1.0"), ("source", "target", "-1.0")):
                if edge[end] == node_id:
                    enthalpy = f"{self.gas[edge[other]]}.enthalpy" if edge[other] in self.gas else "None"
                    lines.append(f"({self.flow[edge_id]}, {sign}, {enthalpy})")
        at = self.assign(
            f"{self.base[node_id]}_lines",
            _listed("[", lines, "]"),
            "each gas line's flow, 1.0 if it flows in (-1.0 out), and the enthalpy at its other end",
        )
        divided = f" / {collapse}.value" if collapse else ""
        if collapse:
            self.comment("Of the pressurant that flows in, 1 / collapse factor stays as gas")
        extra = {"heat_rate": heat} if heat else {}
        volume_call = _call(
            "Volume",
            repr(f"{node_id}:gas"),
            "net",
            pressure=self.pressure[node_id],
            temperature=self.temperature[node_id],
            volume=volume,
            density=f"{gas}.density",
            internal_energy=f"{gas}.internal_energy",
            enthalpy=f"{gas}.enthalpy",
            energy_variable='"temperature"',
            mass_flow_in=_derived("0.0", f"entering({at}){divided}"),
            total_enthalpy_in=_derived("0.0", f"enthalpy_in({at}, {gas}.enthalpy)"),
            mass_flow_out=_derived("0.0", f"leaving({at})"),
            **extra,
        )
        return self.assign(name, volume_call, own=name == self.base[node_id])

    def _guess_junctions(self) -> None:
        junctions = [node_id for node_id, node in self.nodes.items() if node["type"] == "junction"]
        if not junctions:
            return
        known = [f"{node_id!r}: {name}" for node_id, name in self.pressure.items() if node_id not in junctions]
        edges = [
            f"({edge['source']!r}, {edge['target']!r}, {self.outputs.get(f'{edge_id}.position', 'None')})"
            for edge_id, edge in self.edges.items()
            if edge["source"] in junctions or edge["target"] in junctions
        ]
        self.emit("")
        readings = [
            f"{node_id!r}: {node_id + '.pressure'!r}"
            for node_id in junctions
            if self.linked(self.nodes[node_id], "pressure")
        ]
        self.comment(
            "Each junction's pressure to start from: its pressure transducer's reading (readings), or the average of its "
            "neighbors' through paths open at the start (each path: its ends, and its valve's position), spreading out "
            "from the pressures known"
        )
        extra = {"readings": _listed("{", readings, "}")} if readings else {}
        self.emit(
            _call(
                "run.guess_junctions",
                _listed("{", [f"{node_id!r}: {self.pressure[node_id]}" for node_id in junctions], "}"),
                known=_listed("{", known, "}"),
                edges=_listed("[", edges, "]"),
                **extra,
            ).render()
        )

    def _record(self) -> None:
        self.probes = {
            **{f"{node_id}.pressure": self.pressure[node_id] for node_id in self.nodes},
            **{f"{edge_id}.mass_flow": name for edge_id, name in self.flow.items()},
            **self.outputs,
        }
        self.emit("")
        self.comment("What the run reports, by part.output: Piper plots them")
        self.emit("run.record({")
        for key, name in self.probes.items():
            self.emit(f"    {key!r}: {name},")
        self.emit("})")

    def _anchor(self, anchor: dict[str, Any]) -> None:
        parts = {**self.nodes, **self.edges}
        part, sensor = parts[anchor["part"]], parts[anchor["sensor"]]
        setting = next(one for one in BY_TYPE[part["type"]].settings if one.key == anchor["key"])
        link = next(one for one in BY_TYPE[sensor["type"]].links if one.key == anchor["link"])
        named = f"{part['name']}'s {in_words(setting.label)}"
        measured = f"{sensor['name']}'s {in_words(link.label)}"
        knob = f"{anchor['part']}.{anchor['key']}"
        variable = self.knobs.get(knob)
        if variable is None:
            raise Unrunnable(f"{named} doesn't change anything in this model, so it can't be anchored")
        reading = self.probes.get(f"{anchor['sensor']}.{output_of(link)}")
        if reading is None:
            raise Unrunnable(f"{measured} has nothing in the run's window to anchor {named} to")
        limits = tuple(_number(one) if one is not None else "None" for one in (setting.minimum, setting.maximum))
        self.emit("")
        self.comment(
            f"{named}, anchored to {measured}: in each time step from start to end, FullFlow moves the knob until the "
            "model reads what the channel measured"
        )
        self.emit(
            _call(
                "run.anchor",
                variable,
                reading,
                key=repr(f"{anchor['sensor']}.{anchor['link']}"),
                start=_number(anchor["start"]),
                end=_number(anchor["end"]),
                knob=repr(knob),
                named=repr(named),
                measured=repr(measured),
                limits=f"({limits[0]}, {limits[1]})",
            ).render()
        )
