"""A checked system model as a FullFlow script: the code a run runs (network.run executes it), which the Models page
shows, and runs in the browser once you've changed it.

The script builds the network from FullFlow's components and Yorg's own (library.py and components.py, which it imports
as yorg_models), in the order values flow (commands, then valves and flows, then what nodes hold), so FullFlow settles
each trial in one pass. It depends on the job alone, so the page's copy and the server's are the same text. It reads
the test's channels from data["part.link"] (their times on the test's clock, values in SI units), which whoever runs it
provides.

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
    | {"math", "net", "run", "data", "result", "entering", "leaving", "enthalpy_in"}
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


def _call(function: str, *args: object, **kwargs: object) -> _Call:
    keep = lambda value: value if isinstance(value, _Call) else str(value)  # noqa: E731
    return _Call(function, tuple(map(keep, args)), {key: keep(value) for key, value in kwargs.items()})


def _listed(opening: str, items: list[str], closing: str) -> str:
    """A dict's entries or a list's items as code: on one line if short, else one a line."""
    one = f"{opening}{', '.join(items)}{closing}"
    if len(one) <= SHORT:
        return one
    return f"{opening}\n" + "".join(f"    {item},\n" for item in items) + closing


def _derived(start: str, expression: str) -> _Call:
    """A State FullFlow works out from others (start: its first value)."""
    return _call(f"State({start}).derive_from", f"lambda: {expression}")


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
        self.lines: list[str] = []
        self.pressure: dict[str, str] = {}  # every node's variable, by id
        self.temperature: dict[str, str] = {}  # every gas node's
        self.flow: dict[str, str] = {}  # every edge's
        self.outputs: dict[str, str] = {}  # the other outputs, by part.output
        self.density: dict[str, str] = {}  # each tank's liquid's
        self.vapor: dict[str, str] = {}
        self.knobs: dict[str, str] = {}  # every tunable setting made a State, by part.key
        self.gases: dict[str, str] = {}  # by the gas's name
        self.probes: dict[str, str] = {}

    # --- writing ---------------------------------------------------------------------------------------------------

    def text(self) -> str:
        self._head()
        for node in self.nodes.values():
            self._node(node)
        for edge in self.edges.values():
            self._edge(edge)
        self._storage()
        self._guess_junctions()
        self._record()
        for anchor in self.job.get("anchors", []):
            self._anchor(anchor)
        self.emit("")
        self.comment(
            "Solve it: the result is what the Models page shows (the outputs at each time, and what the run says)"
        )
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

    def gas(self, name: str) -> str:
        """The variable holding a gas's properties, made where it's first wanted."""
        if name not in self.gases:
            self.gases[name] = self.assign(
                _identifier(name) or "gas", f"run.gas({name!r})", "an ideal gas: its gas constant and specific heats"
            )
        return self.gases[name]

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

    def solved(self, code: str, bounds: tuple[float | None, float | None]) -> _Call:
        """A State FullFlow solves for, within bounds in a transient run. Not in a steady one: bounded, SciPy's trust
        region takes steps the size of the distance to a bound, and a steady junction from its first guess (a regulator
        at its bound, shut) runs out of tries before it settles."""
        if self.steady:
            return _call("State", code)
        low, high = (_number(one) if one is not None else "None" for one in bounds)
        return _call("State", code, bounds=f"({low}, {high})")

    # --- the script's head ------------------------------------------------------------------------------------------

    def _head(self) -> None:
        job = self.job
        how = "steady (FullFlow's quasi-steady sweep)" if self.steady else "transient"
        self.emit('"""A Yorg system model as a FullFlow script, as Yorg writes it from the model\'s P&ID.')
        self.emit("")
        self.emit(
            f"It runs from {_number(job['start'])} to {_number(job['end'])} s on the test's clock, {how}, in time steps "
            f"of {_number(job['dt'])} s."
        )
        self.emit("The Models page's Run runs it on the server; changed, it runs in your browser.")
        self.emit("data['part.link'] is a linked channel's samples: their times on the test's clock, and their values")
        self.emit("in SI units (Pa, K, kg/s; a valve's command as it is). Settings are in SI units too.")
        self.emit('"""')
        self.emit("")
        self.emit("import math")
        self.emit("")
        self.emit("from fullflow import *")
        self.emit("from yorg_models import *  # Yorg's own components, and Run: the test's data in, results out")
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

    # --- parts ----------------------------------------------------------------------------------------------------

    def _node(self, node: dict[str, Any]) -> None:
        node_id, kind, settings = node["id"], node["type"], node["settings"]
        base = self.base[node_id]
        self.emit("")
        if kind == "tank":
            if settings["mode"] == "fixed" or self.steady:
                # Steady, an ullage holds the pressure measured (or set): no time for it to drain.
                if settings["mode"] == "ullage":
                    what = "with a gas ullage, which holds its pressure in a steady run"
                else:
                    what = "whose pressure follows its channel" if self.linked(node, "pressure") else "at a pressure"
                self.comment(f"{node['name']}: a tank {what}")
                self.pressure[node_id] = self.following(node, "pressure", settings["pressure"], f"{base}_pressure")
                if settings["mode"] == "ullage":
                    self.temperature[node_id] = self.following(
                        node, "gas_temperature", settings["gas_temperature"], f"{base}_gas_temperature"
                    )
            else:
                self.comment(f"{node['name']}: a tank with a gas ullage")
                start = self.starting(node, "pressure", settings["pressure"], low=1000.0)
                self.pressure[node_id] = self.assign(
                    f"{base}_pressure", self.solved(start, (1.0, None)), self.solving(node, "pressure")
                )
                gas = self.starting(node, "gas_temperature", settings["gas_temperature"])
                self.temperature[node_id] = self.assign(
                    f"{base}_gas_temperature", self.solved(gas, (10.0, 3000.0)), self.solving(node, "gas_temperature")
                )
            self._liquid(node)
        elif kind == "source":
            self.comment(f"{node['name']}: a gas supply")
            self.pressure[node_id] = self.following(node, "pressure", settings["pressure"], f"{base}_pressure")
            self.temperature[node_id] = self.following(
                node, "temperature", settings["temperature"], f"{base}_temperature"
            )
        elif kind == "outlet":
            self.comment(f"{node['name']}: an outlet")
            self.pressure[node_id] = self.following(node, "pressure", settings["pressure"], f"{base}_pressure")
            self.temperature[node_id] = self.assign(
                f"{base}_temperature", "State(OUTSIDE)", "K: gas that flows back in from it"
            )
        elif kind == "gas_junction":
            self.comment(f"{node['name']}: a gas junction, holding the gas in the tubing around it")
            start = self.starting(node, "pressure", settings["pressure"], low=1000.0)
            self.pressure[node_id] = self.assign(
                f"{base}_pressure", self.solved(start, (1.0, None)), self.solving(node, "pressure")
            )
            temperature = self.starting(node, "temperature", settings["temperature"])
            self.temperature[node_id] = self.assign(
                f"{base}_temperature", self.solved(temperature, (10.0, 3000.0)), self.solving(node, "temperature")
            )
            self.outputs[f"{node_id}.temperature"] = self.temperature[node_id]
        else:
            self.comment(f"{node['name']}: a junction, whose pressure makes what flows in flow out")
            self.pressure[node_id] = self.assign(
                f"{base}_pressure", self.solved("ATMOSPHERE", (1.0, None)), "Pa, solved for: see run.guess_junctions"
            )

    def _liquid(self, tank: dict[str, Any]) -> None:
        """The tank's liquid's density and vapor pressure (library.Run.liquid)."""
        tank_id, settings = tank["id"], tank["settings"]
        base = self.base[tank_id]
        density, vapor = self.names.take(f"{base}_density"), self.names.take(f"{base}_vapor_pressure")
        if settings["fluid"] == "Custom":
            liquid = _call(
                "run.custom_liquid",
                repr(tank_id),
                density=_number(settings["density"]),
                vapor_pressure=_number(settings["vapor_pressure"]),
                temperature=_number(settings["temperature"]),
            )
            note = "a liquid of the density and vapor pressure given"
        else:
            channel = self.linked(tank, "temperature")
            follows = {"follows": repr(f"{tank_id}.temperature")} if channel else {}
            liquid = _call(
                "run.liquid",
                repr(tank_id),
                repr(settings["fluid"]),
                temperature=_number(settings["temperature"]),
                pressure=self.pressure[tank_id],
                **follows,
            )
            note = f"ThermoProp's {settings['fluid']}{f', at the temperature {channel} reads' if channel else ''}"
        self.line(liquid.render(f"{density}, {vapor} = "), note)
        self.density[tank_id], self.vapor[tank_id] = density, vapor

    def _edge(self, edge: dict[str, Any]) -> None:
        edge_id, kind, settings = edge["id"], edge["type"], edge["settings"]
        base = self.base[edge_id]
        upstream, downstream = self.pressure[edge["source"]], self.pressure[edge["target"]]
        label = in_words(BY_TYPE[kind].label)
        self.emit("")
        self.comment(
            f"{edge['name']}: {'an' if label[:1] in 'aeiou' else 'a'} {label}, "
            f"from {self.nodes[edge['source']]['name']} to {self.nodes[edge['target']]['name']}"
        )
        if BY_TYPE[kind].phase == "gas":
            gas = self.gas(self.gas_of[edge_id])
            opening: dict[str, str] = {}
            if kind == "regulator":
                opening, check = {"opening": self._regulator(edge)}, "True"
            elif kind == "gas_valve":
                opening, check = {"opening": self._opening(edge)}, repr(settings["check"] == "yes")
            else:  # a gas orifice
                check = "False"
            cda = self.knob(edge, "cda")
            restriction = _call(
                "GasRestriction",
                repr(edge_id),
                "net",
                upstream_pressure=upstream,
                upstream_temperature=self.temperature[edge["source"]],
                downstream_pressure=downstream,
                downstream_temperature=self.temperature[edge["target"]],
                gas_constant=f"{gas}.gas_constant",
                specific_heat_ratio=f"{gas}.gamma",
                cda=cda,
                **opening,
                check=check,
            )
            self.flow[edge_id] = f"{self.assign(base, restriction, own=True)}.mass_flow"
            if opening:
                self.outputs[f"{edge_id}.position"] = opening["opening"]
            return
        tank = self.liquid_of[edge_id]
        density = self.density[tank]
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
        elif kind == "valve":
            opening = self._opening(edge)
            cda = self.knob(edge, "cda")
            restriction = _call(
                "Restriction",
                repr(edge_id),
                "net",
                upstream_pressure=upstream,
                downstream_pressure=downstream,
                density=density,
                cda=cda,
                opening=opening,
            )
            self.flow[edge_id] = f"{self.assign(base, restriction, own=True)}.mass_flow"
            self.outputs[f"{edge_id}.position"] = opening
        elif kind == "venturi":
            self.emit(f"run.needs_vapor_pressure({edge_id!r}, {tank!r}, {self.vapor[tank]})")
            recovery = self.knob(edge, "recovery")
            cda = self.knob(edge, "cda")
            self.comment(
                "Cavitating, its flow is CdA √(2ρ(P1 − Pv)); not, CdA/√(1 − R) √(2ρ ΔP): the two meet where it starts "
                "to cavitate, at ΔP = (1 − R)(P1 − Pv)"
            )
            unchoked = _derived(
                _number(1.0 / math.sqrt(1.0 - settings["recovery"])), f"1.0 / math.sqrt(1.0 - {recovery}.value)"
            )
            venturi = _call(
                "Venturi",
                repr(edge_id),
                "net",
                upstream_pressure=upstream,
                downstream_pressure=downstream,
                density=density,
                throat_area=cda,
                vapor_pressure=self.vapor[tank],
                pressure_recovery_factor=recovery,
                cavitating_discharge_coefficient="1.0",
                noncavitating_discharge_coefficient=unchoked,
            )
            name = self.assign(base, venturi, own=True)
            self.flow[edge_id] = f"{name}.mass_flow"
            self.outputs[f"{edge_id}.cavitating"] = f"{name}.is_cavitating"
        else:  # an orifice
            cda = self.knob(edge, "cda")
            restriction = _call(
                "Restriction",
                repr(edge_id),
                "net",
                upstream_pressure=upstream,
                downstream_pressure=downstream,
                density=density,
                cda=cda,
            )
            self.flow[edge_id] = f"{self.assign(base, restriction, own=True)}.mass_flow"

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
        """A regulator's opening, from the pressure where it flows to (components.Regulator), starting where that
        pressure asks for. Steady, it's where that pressure puts it: an opening for the solver to find as well would get
        stuck past its stops, where it no longer changes the flow."""
        edge_id = edge["id"]
        base = self.base[edge_id]
        sensed = self.pressure[edge["target"]]
        setpoint, droop = self.knob(edge, "setpoint"), self.knob(edge, "droop")
        wanted = f"min(1.0, max(0.0, ({setpoint}.value - {sensed}.value) / {droop}.value))"
        if self.steady:
            function = self.names.take(f"{base}_opening")
            self.emit(f"def {function}():  # where the pressure it holds puts it")
            self.emit(f"    return {wanted}")
            return self.assign(f"{base}_position", f"State({function}()).derive_from({function})")
        position = self.assign(f"{base}_position", self.solved(wanted, (0.0, 1.0)), "solved for")
        response_time = self.knob(edge, "response_time")
        regulator = _call(
            "Regulator",
            repr(f"{edge_id}:opening"),
            "net",
            sensed=sensed,
            setpoint=setpoint,
            droop=droop,
            response_time=response_time,
            position=position,
        )
        self.line(regulator.render(), "It opens as the pressure it holds falls below its set pressure")
        return position

    # --- what nodes hold ------------------------------------------------------------------------------------------

    def _storage(self) -> None:
        """Each liquid junction balances its flows; each gas junction and tank ullage keeps its gas (and each tank
        its liquid)."""
        liquid_in: dict[str, list[str]] = {node_id: [] for node_id in self.nodes}
        liquid_out: dict[str, list[str]] = {node_id: [] for node_id in self.nodes}
        gas_in: dict[str, list[str]] = {node_id: [] for node_id in self.nodes}
        gas_out: dict[str, list[str]] = {node_id: [] for node_id in self.nodes}
        for edge_id, edge in self.edges.items():
            gas = BY_TYPE[edge["type"]].phase == "gas"
            (gas_out if gas else liquid_out)[edge["source"]].append(self.flow[edge_id])
            (gas_in if gas else liquid_in)[edge["target"]].append(self.flow[edge_id])
        for node_id, node in self.nodes.items():
            settings = node["settings"]
            if node["type"] == "junction":
                self.emit("")
                self.comment(f"{node['name']}: what flows in flows out")
                junction = _call(
                    "Junction",
                    repr(node_id),
                    "net",
                    pressure=self.pressure[node_id],
                    inflows=_listed("[", liquid_in[node_id], "]"),
                    outflows=_listed("[", liquid_out[node_id], "]"),
                )
                self.assign(self.base[node_id], junction, own=True)
            elif node["type"] == "gas_junction":
                self.emit("")
                self.comment(f"{node['name']}: its gas")
                self._gas_volume(node, _number(settings["volume"]))
            elif node["type"] == "tank" and settings["mode"] == "ullage" and not self.steady:
                self.emit("")
                if settings["ullage_model"] == "wall":
                    self._wall_tank(node, liquid_in[node_id], liquid_out[node_id])
                else:
                    self._polytropic_tank(
                        node, gas_in[node_id], gas_out[node_id], liquid_in[node_id], liquid_out[node_id]
                    )

    def _polytropic_tank(self, node, gas_in, gas_out, liquid_in, liquid_out) -> None:
        node_id, settings = node["id"], node["settings"]
        base = self.base[node_id]
        pressure, temperature = self.pressure[node_id], self.temperature[node_id]
        self.comment(f"{node['name']}: its liquid, and its ullage gas, whose heat transfer is an exponent")
        gas = self.gas(self.gas_of.get(node_id, settings["gas"]))
        initial = self.assign(f"{base}_initial_pressure", f"{pressure}.value")
        exponent = self.knob(node, "polytropic_exponent")
        collapse = self.knob(node, "collapse_factor")
        tank = _call(
            "UllageTank",
            repr(node_id),
            "net",
            pressure=pressure,
            volume=_number(settings["volume"]),
            liquid_volume=f"State({_number(settings['liquid_volume'])})",
            liquid_density=self.density[node_id],
            initial_pressure=initial,
            initial_gas_density=f"{initial} / ({gas}.gas_constant * {temperature}.value)",
            polytropic_exponent=exponent,
            collapse_factor=collapse,
            gas_in=_listed("[", gas_in, "]"),
            gas_out=_listed("[", gas_out, "]"),
            liquid_in=_listed("[", liquid_in, "]"),
            liquid_out=_listed("[", liquid_out, "]"),
        )
        name = self.assign(base, tank, own=True)
        self.comment("The gas's temperature goes with its pressure and density (for what flows out of it, and to plot)")
        self.emit(
            f"{temperature}.derive_from(lambda: max({pressure}.value, 1.0) / ({name}.gas_density() * "
            f"{gas}.gas_constant))"
        )
        self.outputs[f"{node_id}.liquid_volume"] = f"{name}.liquid_volume"
        self.outputs[f"{node_id}.gas_temperature"] = temperature

    def _wall_tank(self, node, liquid_in, liquid_out) -> None:
        """An ullage whose gas FullFlow's Volume keeps, exchanging heat with the tank wall (a Solid) by Convection."""
        node_id, settings = node["id"], node["settings"]
        base = self.base[node_id]
        self.comment(f"{node['name']}: its liquid, its ullage gas, and its wall, which the gas exchanges heat with")
        self.gas_of.setdefault(node_id, settings["gas"])
        ullage = self.assign(
            f"{base}_ullage_volume", f"State({_number(settings['volume'] - settings['liquid_volume'])})", "m³"
        )
        store = _call(
            "LiquidStore",
            repr(f"{node_id}:liquid"),
            "net",
            ullage_volume=ullage,
            tank_volume=_number(settings["volume"]),
            density=self.density[node_id],
            liquid_in=_listed("[", liquid_in, "]"),
            liquid_out=_listed("[", liquid_out, "]"),
            liquid_volume=f"State({_number(settings['liquid_volume'])})",
        )
        liquid = self.assign(f"{base}_liquid", store)
        wall = self.assign(
            f"{base}_wall_temperature",
            self.solved(self.starting(node, "wall_temperature", settings["wall_temperature"]), (10.0, 3000.0)),
            self.solving(node, "wall_temperature"),
        )
        heat_transfer = self.knob(node, "heat_transfer")
        convection = _call(
            "Convection",
            repr(f"{node_id}:convection"),
            "net",
            surface_temperature=wall,
            fluid_temperature=self.temperature[node_id],
            convective_area="1.0",
            convection_coefficient=heat_transfer,
        )
        convection = self.assign(f"{base}_convection", convection)
        self.emit(
            _call(
                "Solid",
                repr(f"{node_id}:wall"),
                "net",
                temperature=wall,
                mass=_number(settings["wall_mass"]),
                specific_heat=_number(settings["wall_specific_heat"]),
                heat_rate=f"{convection}.heat_rate",
            ).render()
        )
        self.comment("Convection's heat rate is into the wall: the gas loses what the wall gains")
        heat = self.assign(f"{base}_heat", _derived("0.0", f"-{convection}.heat_rate.value"))
        collapse = self.knob(node, "collapse_factor")
        self._gas_volume(node, ullage, collapse=collapse, heat=heat, name=f"{base}_gas")
        self.outputs[f"{node_id}.liquid_volume"] = f"{liquid}.liquid_volume"
        self.outputs[f"{node_id}.gas_temperature"] = self.temperature[node_id]
        self.outputs[f"{node_id}.wall_temperature"] = wall

    def _gas_volume(
        self,
        node: dict[str, Any],
        volume: str,
        collapse: str | None = None,
        heat: str | None = None,
        name: str | None = None,
    ) -> None:
        """A gas node's Volume: an ideal gas at the node's pressure and temperature, which FullFlow iterates while it
        keeps the gas's mass and energy."""
        node_id = node["id"]
        base = self.base[node_id]
        gas = self.gas(self.gas_of[node_id])
        pressure, temperature = self.pressure[node_id], self.temperature[node_id]
        # Each gas line at the node, which way it flows in, and the temperature of what it brings in.
        lines = []
        for edge_id, edge in self.edges.items():
            if BY_TYPE[edge["type"]].phase != "gas":
                continue
            if edge["target"] == node_id:
                lines.append(f"({self.flow[edge_id]}, 1.0, {self.temperature[edge['source']]})")
            if edge["source"] == node_id:
                lines.append(f"({self.flow[edge_id]}, -1.0, {self.temperature[edge['target']]})")
        at = self.assign(
            f"{base}_lines",
            _listed("[", lines, "]"),
            "each gas line's flow, 1.0 if it flows in (-1.0 out), and the temperature at its other end",
        )
        divided = f" / {collapse}.value" if collapse else ""
        extra = {"heat_rate": heat} if heat else {}
        self.comment(
            "An ideal gas, whose mass and energy FullFlow keeps: what flows in brings the enthalpy of where it came "
            f"from{', and of what flows in, 1 / collapse factor stays as gas' if collapse else ''}"
        )
        volume_call = _call(
            "Volume",
            repr(f"{node_id}:gas"),
            "net",
            pressure=pressure,
            volume=volume,
            temperature=temperature,
            density=_derived("0.0", f"{pressure}.value / ({gas}.gas_constant * {temperature}.value)"),
            internal_energy=_derived("0.0", f"{gas}.cv * {temperature}.value"),
            enthalpy=_derived("0.0", f"{gas}.cp * {temperature}.value"),
            energy_variable='"T"',
            mass_flow_in=_derived("0.0", f"entering({at}){divided}"),
            total_enthalpy_in=_derived("0.0", f"enthalpy_in({at}, {gas}, {temperature})"),
            mass_flow_out=_derived("0.0", f"leaving({at})"),
            **extra,
        )
        if name is None:
            self.assign(base, volume_call, own=True)
        else:
            self.assign(name, volume_call)

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
        self.comment(
            "Each junction's pressure to start from: the average of its neighbors' through paths open at the start "
            "(each path: its ends, and its valve's position), spreading out from the pressures known"
        )
        self.emit(
            _call(
                "run.guess_junctions",
                _listed("{", [f"{node_id!r}: {self.pressure[node_id]}" for node_id in junctions], "}"),
                known=_listed("{", known, "}"),
                edges=_listed("[", edges, "]"),
            ).render()
        )

    def _record(self) -> None:
        self.probes = {
            **{f"{node_id}.pressure": name for node_id, name in self.pressure.items()},
            **{f"{edge_id}.mass_flow": name for edge_id, name in self.flow.items()},
            **self.outputs,
        }
        self.emit("")
        self.comment("What the run reports, by part.output: the Models page plots them")
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
