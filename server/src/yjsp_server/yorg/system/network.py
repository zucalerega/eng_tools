"""A checked system model as a FullFlow network, run over a test's window, with each part's outputs read back.

Runs in the runner's process only: it imports FullFlow, ThermoProp, NumPy, and SciPy. The network runs on its own
clock from 0 at the window's start; channels it follows (pressures, temperatures, valve commands) are put on the same
clock, and results go back on the dataset's.

Gas is ideal, one gas in each connected set of gas lines (spec.py checks), with its gas constant and specific heats
from ThermoProp. A gas junction and a tank's ullage are FullFlow Volumes, which keep their gas's mass and energy: gas
flowing in brings its enthalpy from where it came from, gas flowing out takes the node's own.

A run is transient (FullFlow's Transient), or steady: FullFlow's quasi-steady sweep (SteadyState over time), where
every line's inertia, junction's gas, and regulator settles in each time step, and tanks hold the pressure measured
(or set) instead of draining. Anchors are FullFlow Sensors: each moves a knob (a tunable setting) in each time step so
that what the model reads at a sensor is what its channel measured, and the run reports the knob's history.
"""

import math
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np
from fullflow import (
    Actuator,
    Convection,
    DarcyWeisbach,
    FullFlowError,
    Network,
    Sequence,
    Solid,
    State,
    SteadyState,
    Transient,
    Volume,
)
from fullplot import Trace
from thermoprop import Fluid, IdealGas

from .catalog import ATMOSPHERE, BY_TYPE, PSI, in_words, output_of
from .components import (
    Anchor,
    GasRestriction,
    Junction,
    LiquidStore,
    Recorder,
    Regulator,
    Restriction,
    UllageTank,
    Venturi,
)

MAX_POINTS = 2000  # results per output: plenty to plot, small to send
TABLE = 25  # temperatures a liquid's properties are tabulated at, over those its temperature channel goes through
OUTSIDE = 293.15  # K: gas that flows back in from an outlet
RECORDER = "results"  # the component whose attributes are a run's outputs
KNOB = "knob:"  # what an anchored knob is recorded under, before its part.key
ON = "on:"  # and whether its anchor held it
HELD = 0.9  # an anchor that held its knob for less of its span than this says so
COMMANDED = 1e-6  # s: how long a valve's command takes to change
# FullFlow's transient solver (and its steady sweep): a 2-point Jacobian (a 3-point one costs half as much again, for
# nothing a test can see), and each time step solved to within rtol of its implicit equations, with SciPy's gradient
# test off (Transient's own default; SteadyState's stops a step early, at a junction's flow of 1e-6 kg/s). Each trial
# of a step evaluates every component; FullFlow repeats that until nothing changes, but _Builder adds components in the
# order values flow (commands, then valves and flows, then what nodes hold), so one pass settles it: a second only
# confirmed that, and cost as much again.
SOLVER = {
    "jacobian_method": "2-point",
    "ftol": 1e-8,
    "xtol": 1e-8,
    "gtol": None,
    "rtol": 1e-6,
    "max_step_retries": 8,
    "state_max_passes": 1,
}


class ModelError(Exception):
    """What's wrong with a model or its run, in words, for the dev page."""


Series = tuple[np.ndarray, np.ndarray]


def run(
    job: dict[str, Any],
    inputs: dict[str, Series],
    progress: Callable[[float], None],
    max_points: int = MAX_POINTS,
) -> dict[str, Any]:
    """Simulate job's model from job["start"] to job["end"], with time steps of job["dt"] (steady, if job["solver"]
    says so), anchoring job["anchors"]; inputs are the linked channels' samples (SI units, on the dataset's clock) by
    part.link."""
    built = _Builder(job, inputs, progress)
    duration = job["end"] - job["start"]
    solve = SteadyState(built.net).solve if built.steady else Transient(built.net).solve
    started = time.monotonic()
    try:
        # Results every so many steps: FullFlow lands a step on each, so they keep the steps on a grid of dt.
        save_dt = job["dt"] * max(1, math.ceil(duration / max_points / job["dt"] - 1e-9))
        records = solve(dt=job["dt"], t_final=duration, save_dt=save_dt, **SOLVER)
    except FullFlowError as error:
        raise ModelError(built.explain(error)) from error
    elapsed = time.monotonic() - started
    recorded: dict[str, dict[float, float]] = {}
    for record in records:
        if record["component_name"] == RECORDER:
            recorded.setdefault(record["attribute"], {})[record["time"]] = float(record["value"])
    series = {name: recorded.get(name, {}) for name in built.probes}
    knobs = {anchor["knob"]: recorded.get(KNOB + anchor["knob"], {}) for anchor in built.anchors}
    times = sorted({t for values in series.values() for t in values})
    anchors = [
        built.anchored(anchor, knobs[anchor["knob"]], recorded.get(ON + anchor["knob"], {})) for anchor in built.anchors
    ]
    result = {
        "times": [job["start"] + t for t in times],
        "series": {name: [values.get(t) for t in times] for name, values in series.items()},
        "liquids": built.liquids,
        "initial": built.initial,
        "notes": built.notes + built.dry(series),
        "steps": len(times),
        "elapsed": elapsed,
    }
    if anchors:
        result["anchored"] = {key: [values.get(t) for t in times] for key, values in knobs.items()}
        result["anchors"] = anchors
    return result


@dataclass(frozen=True)
class _Gas:
    gas_constant: float  # J/kg·K
    gamma: float
    cp: float
    cv: float


class _Builder:
    def __init__(self, job: dict[str, Any], inputs: dict[str, Series], progress: Callable[[float], None]):
        self.start, self.duration, self.dt = job["start"], job["end"] - job["start"], job["dt"]
        self.steady = job.get("solver") == "steady"
        self.inputs = inputs
        model = job["model"]
        self.nodes: dict[str, dict[str, Any]] = model["nodes"]
        self.edges: dict[str, dict[str, Any]] = model["edges"]
        self.liquid_of: dict[str, str] = job["liquid_of"]
        self.gas_of: dict[str, str] = job.get("gas_of", {})
        self.net = Network("System model")
        self.notes: list[str] = []
        self.liquids: dict[str, dict[str, Any]] = {}  # each tank's liquid: what, at what temperatures, how dense
        self.initial: list[dict[str, Any]] = []  # values the run started from, taken from channels
        self.pressure: dict[str, State] = {}  # every node's
        self.temperature: dict[str, State] = {}  # every gas node's: supplies, gas junctions, ullages, outlets
        self.flow: dict[str, State] = {}
        self.outputs: dict[str, State] = {}  # the other outputs, by part.output
        self.density: dict[str, State] = {}  # each tank's liquid's
        self.vapor: dict[str, State] = {}
        self.gases: dict[str, _Gas] = {}
        self.knobs: dict[str, State] = {}  # every tunable setting's, by part.key: what an anchor moves
        self.anchors: list[dict[str, Any]] = []
        self.probes: dict[str, State] = {}
        self.recorder = Recorder(RECORDER, self.net)
        self.recorder.on_progress(progress)
        for node in self.nodes.values():
            self._node(node)
        for edge in self.edges.values():
            self._edge(edge)
        self._storage()
        self._guess_junctions()
        for node_id, state in self.pressure.items():
            self._probe(f"{node_id}.pressure", state)
        for edge_id, state in self.flow.items():
            self._probe(f"{edge_id}.mass_flow", state)
        for key, state in self.outputs.items():
            self._probe(key, state)
        self.anchors = [self._anchor(anchor) for anchor in job.get("anchors", [])]

    # --- a test's data -------------------------------------------------------------------------------------------

    def _series(self, part_id: str, link: str) -> Series | None:
        """A linked channel's samples on the run's clock (0 at the window's start), missing ones left out."""
        found = self.inputs.get(f"{part_id}.{link}")
        if found is None:
            return None
        times, values = found
        keep = np.isfinite(times) & np.isfinite(values)
        return (times[keep] - self.start, values[keep]) if keep.any() else None

    def _starting(self, part: dict[str, Any], link: str, default: float) -> float:
        """A value the model starts from: its linked channel's at the run's start (noted, for the page), or the
        part's setting."""
        found = self._series(part["id"], link)
        if found is None:
            return float(default)
        value = float(np.interp(0.0, *found))
        quantity = next(one.quantity for one in BY_TYPE[part["type"]].links if one.key == link)
        self.initial.append(
            {
                "part": part["id"],
                "key": link,
                "channel": part["links"].get(link, ""),
                "quantity": quantity,
                "value": value,
            }
        )
        return value

    def _solved(self, value: float, bounds: tuple[float | None, float | None]) -> State:
        """A state FullFlow solves for (a junction's pressure, a gas's temperature), within bounds in a transient run.
        Not in a steady one: bounded, SciPy's trust region takes steps the size of the distance to a bound, and a
        steady junction from its first guess (a regulator at its bound, shut) runs out of tries before it settles."""
        return State(value) if self.steady else State(value, bounds=bounds)

    def _following(self, name: str, part_id: str, link: str, constant: float) -> State:
        """A value that stays at constant, or follows a linked channel."""
        found = self._series(part_id, link)
        if found is None:
            return State(float(constant))
        times, values = found
        state = State(float(np.interp(0.0, times, values)))
        Sequence(f"{name}:data", self.net, target=state, function=lambda t: float(np.interp(t, times, values)))
        return state

    # --- parts ----------------------------------------------------------------------------------------------------

    def _node(self, node: dict[str, Any]) -> None:
        node_id, kind, settings = node["id"], node["type"], node["settings"]
        if kind == "tank":
            if settings["mode"] == "fixed" or self.steady:
                # Steady, an ullage holds the pressure measured (or set): no time for it to drain.
                self.pressure[node_id] = self._following(node_id, node_id, "pressure", settings["pressure"])
                if settings["mode"] == "ullage":
                    self.temperature[node_id] = self._following(
                        f"{node_id}:gas_temperature", node_id, "gas_temperature", settings["gas_temperature"]
                    )
            else:
                initial = max(self._starting(node, "pressure", settings["pressure"]), 1000.0)
                self.pressure[node_id] = self._solved(initial, (1.0, None))
                gas = self._starting(node, "gas_temperature", settings["gas_temperature"])
                self.temperature[node_id] = self._solved(gas, (10.0, 3000.0))
            self._liquid(node)
        elif kind == "source":
            self.pressure[node_id] = self._following(node_id, node_id, "pressure", settings["pressure"])
            self.temperature[node_id] = self._following(
                f"{node_id}:temperature", node_id, "temperature", settings["temperature"]
            )
        elif kind == "outlet":
            self.pressure[node_id] = self._following(node_id, node_id, "pressure", settings["pressure"])
            self.temperature[node_id] = State(OUTSIDE)
        elif kind == "gas_junction":
            pressure = max(self._starting(node, "pressure", settings["pressure"]), 1000.0)
            self.pressure[node_id] = self._solved(pressure, (1.0, None))
            temperature = self._starting(node, "temperature", settings["temperature"])
            self.temperature[node_id] = self._solved(temperature, (10.0, 3000.0))
            self.outputs[f"{node_id}.temperature"] = self.temperature[node_id]
        else:  # a liquid junction: its pressure is solved for, from a guess (see _guess_junctions)
            self.pressure[node_id] = self._solved(ATMOSPHERE, (1.0, None))

    def _liquid(self, tank: dict[str, Any]) -> None:
        """The tank's liquid's density and vapor pressure, from ThermoProp at its temperature: its setting's, or,
        linked to a channel, following it through the run (tabulated over the temperatures it reads)."""
        tank_id, settings = tank["id"], tank["settings"]
        if settings["fluid"] == "Custom":
            self.density[tank_id] = State(float(settings["density"]))
            self.vapor[tank_id] = State(float(settings["vapor_pressure"]))
            self.liquids[tank_id] = {
                "fluid": "Custom",
                "temperature": float(settings["temperature"]),
                "density": float(settings["density"]),
                "vapor_pressure": float(settings["vapor_pressure"]),
                "phase": "liquid",
                "follows": None,
            }
            return
        pressure = max(self.pressure[tank_id].value, 1000.0)
        found = self._series(tank_id, "temperature")
        if found is None:
            temperatures = np.array([float(settings["temperature"])])
        else:
            times, values = found
            inside = values[(times >= 0.0) & (times <= self.duration)]
            inside = inside if len(inside) else np.array([np.interp(0.0, times, values)])
            low, high = float(inside.min()), float(inside.max())
            temperatures = np.linspace(low, high, TABLE) if high - low > 0.01 else np.array([low])
        densities, vapors, phases = [], [], set()
        for temperature in temperatures:
            try:
                state = Fluid(settings["fluid"], pressure=pressure, temperature=float(temperature))
                densities.append(float(state.density))
                phases.add(str(state.phase))
            except Exception as error:  # ThermoProp says why: below its freezing point, out of range
                raise ModelError(
                    f"{tank['name']}: ThermoProp can't give {settings['fluid']}'s properties at {temperature:.1f} K and "
                    f"{pressure / PSI:.0f} psia ({error}). Check the liquid's temperature."
                ) from error
            try:
                vapors.append(float(state.saturation_pressure))
            except Exception:  # above its critical point: no vapor pressure (and no venturi can use it)
                vapors.append(math.nan)
        for phase in sorted(phases):
            if "liquid" not in phase.lower():
                self.notes.append(
                    f"{tank['name']}: {settings['fluid']} is {phase.lower()} at "
                    f"{temperatures.min():.1f}–{temperatures.max():.1f} K, not liquid: check the liquid's temperature."
                )
        table_t, table_rho, table_pv = temperatures, np.array(densities), np.array(vapors)
        start = float(np.interp(0.0, *found)) if found else float(temperatures[0])
        self.density[tank_id] = State(float(np.interp(start, table_t, table_rho)))
        self.vapor[tank_id] = State(float(np.interp(start, table_t, table_pv)))
        if found and len(table_t) > 1:
            times, values = found
            Sequence(
                f"{tank_id}:density",
                self.net,
                target=self.density[tank_id],
                function=lambda t: float(np.interp(np.interp(t, times, values), table_t, table_rho)),
            )
            Sequence(
                f"{tank_id}:vapor",
                self.net,
                target=self.vapor[tank_id],
                function=lambda t: float(np.interp(np.interp(t, times, values), table_t, table_pv)),
            )
        self.liquids[tank_id] = {
            "fluid": settings["fluid"],
            "temperature": start,
            "density": self.density[tank_id].value,
            "vapor_pressure": self.vapor[tank_id].value,
            "phase": ", ".join(sorted(phases)),
            "follows": tank["links"].get("temperature") if found else None,
            "temperatures": [float(table_t.min()), float(table_t.max())],
            "densities": [float(table_rho.min()), float(table_rho.max())],
        }

    def _gas(self, part_id: str) -> _Gas:
        """The gas in a gas part: an ideal gas, its properties from ThermoProp."""
        name = self.gas_of[part_id]
        if name not in self.gases:
            try:
                ideal = IdealGas(name, pressure=ATMOSPHERE, temperature=293.15)
                gas_constant, gamma = float(ideal.gas_constant), float(ideal.specific_heat_ratio)
            except Exception as error:
                raise ModelError(f"ThermoProp can't give {name}'s properties ({error})") from error
            cp = gamma * gas_constant / (gamma - 1.0)
            self.gases[name] = _Gas(gas_constant, gamma, cp, cp - gas_constant)
        return self.gases[name]

    def _knob(self, part: dict[str, Any], key: str) -> State:
        """A tunable setting, as a State of its own that an anchor can move. Without bounds: bounded, SciPy's trust
        region takes steps the size of the distance to a bound, so a CdA (1e-5 m² above its bound of 0) crawls and
        stops short of FullFlow's tolerance. An anchor can take a knob past its limits, then, which says the model
        and the test disagree somewhere."""
        state = State(float(part["settings"][key]))
        self.knobs[f"{part['id']}.{key}"] = state
        return state

    def _edge(self, edge: dict[str, Any]) -> None:
        edge_id, kind, settings = edge["id"], edge["type"], edge["settings"]
        upstream, downstream = self.pressure[edge["source"]], self.pressure[edge["target"]]
        if BY_TYPE[kind].phase == "gas":
            gas = self._gas(edge_id)
            if kind == "regulator":
                opening, check = self._regulator(edge), True
            elif kind == "gas_valve":
                opening, check = self._opening(edge), settings["check"] == "yes"
            else:  # a gas orifice
                opening, check = State(1.0), False
            restriction = GasRestriction(
                edge_id,
                self.net,
                upstream_pressure=upstream,
                upstream_temperature=self.temperature[edge["source"]],
                downstream_pressure=downstream,
                downstream_temperature=self.temperature[edge["target"]],
                gas_constant=gas.gas_constant,
                specific_heat_ratio=gas.gamma,
                cda=self._knob(edge, "cda"),
                opening=opening,
                check=check,
            )
            self.flow[edge_id] = restriction.mass_flow
            if kind != "gas_orifice":
                self.outputs[f"{edge_id}.position"] = opening
            return
        tank = self.liquid_of[edge_id]
        density = self.density[tank]
        if kind == "line":
            # Fittings' K added to the tubing's friction: (f L / D + K) rho v^2 / 2 is (f + K D / L) L / D rho v^2 / 2.
            f, k = self._knob(edge, "friction_factor"), self._knob(edge, "loss_coefficient")
            ratio = settings["diameter"] / settings["length"]
            friction = State(f.value + k.value * ratio).derive_from(lambda: f.value + k.value * ratio)
            line = DarcyWeisbach(
                edge_id,
                self.net,
                mass_flow=State(0.0),
                upstream_pressure=upstream,
                downstream_pressure=downstream,
                length=settings["length"],
                hydraulic_diameter=settings["diameter"],
                density=density,
                friction_factor=friction,
            )
            self.flow[edge_id] = line.mass_flow
        elif kind == "valve":
            opening = self._opening(edge)
            restriction = Restriction(
                edge_id,
                self.net,
                upstream_pressure=upstream,
                downstream_pressure=downstream,
                density=density,
                cda=self._knob(edge, "cda"),
                opening=opening,
            )
            self.flow[edge_id] = restriction.mass_flow
            self.outputs[f"{edge_id}.position"] = opening
        elif kind == "venturi":
            if not math.isfinite(self.vapor[tank].value):
                raise ModelError(
                    f"{edge['name']}: {self.nodes[tank]['name']}'s liquid is above its critical point, so it has no "
                    "vapor pressure to cavitate at"
                )
            recovery = self._knob(edge, "recovery")
            # Cavitating, the flow is CdA sqrt(2 rho (P1 - Pv)); not, CdA / sqrt(1 - R) sqrt(2 rho dP), which meet
            # where it starts to cavitate, at dP = (1 - R)(P1 - Pv).
            venturi = Venturi(
                edge_id,
                self.net,
                upstream_pressure=upstream,
                downstream_pressure=downstream,
                density=density,
                throat_area=self._knob(edge, "cda"),
                vapor_pressure=self.vapor[tank],
                pressure_recovery_factor=recovery,
                cavitating_discharge_coefficient=1.0,
                noncavitating_discharge_coefficient=State(1.0 / math.sqrt(1.0 - recovery.value)).derive_from(
                    lambda: 1.0 / math.sqrt(1.0 - recovery.value)
                ),
            )
            self.flow[edge_id] = venturi.mass_flow
            self.outputs[f"{edge_id}.cavitating"] = venturi.is_cavitating
        else:  # an orifice
            restriction = Restriction(
                edge_id,
                self.net,
                upstream_pressure=upstream,
                downstream_pressure=downstream,
                density=density,
                cda=self._knob(edge, "cda"),
            )
            self.flow[edge_id] = restriction.mass_flow

    def _opening(self, edge: dict[str, Any]) -> State:
        """A valve's position: fixed, or following its command channel (0 closed to 1 open), as fast as its opening
        time lets it move."""
        edge_id, settings = edge["id"], edge["settings"]
        found = self._series(edge_id, "command")
        if found is None:
            return State(float(settings["position"]))
        span = settings["open_value"] - settings["closed_value"]
        if span == 0:
            raise ModelError(f"{edge['name']}: its command's open and closed values are the same")
        times, raw = found
        commanded = np.round(np.clip((raw - settings["closed_value"]) / span, 0.0, 1.0), 2)
        before = max(int(np.searchsorted(times, 0.0, side="right")) - 1, 0)
        points_t, points_v = [0.0], [float(commanded[before])]
        for index in np.flatnonzero(np.diff(commanded) != 0) + 1:
            t, value = float(times[index]), float(commanded[index])
            if points_t[-1] < t and t + COMMANDED < self.duration:
                # A step, a hair after the sample, which the solver lands on: the step to the sample's time is a
                # whole one, so a run's results there (and an anchor's) are of a step like the rest.
                points_t += [t, t + COMMANDED]
                points_v += [points_v[-1], value]
        points_t.append(self.duration)
        points_v.append(points_v[-1])
        command, position = State(points_v[0]), State(points_v[0])
        Sequence(f"{edge_id}:command", self.net, target=command, times=points_t, values=points_v)
        opening_time = self._knob(edge, "opening_time")
        Actuator(
            f"{edge_id}:actuator",
            self.net,
            command=command,
            position=position,
            minimum=0.0,
            maximum=1.0,
            rate_limit=State(1.0 / opening_time.value).derive_from(lambda: 1.0 / opening_time.value),
        )
        return position

    def _regulator(self, edge: dict[str, Any]) -> State:
        """A regulator's opening, from the pressure where it flows to (see components.Regulator), starting where that
        pressure asks for. Steady, it's where that pressure puts it: an opening for the solver to find as well would
        get stuck past its stops, where it no longer changes the flow."""
        sensed = self.pressure[edge["target"]]
        setpoint, droop = self._knob(edge, "setpoint"), self._knob(edge, "droop")

        def wanted() -> float:
            return min(1.0, max(0.0, (setpoint.value - sensed.value) / droop.value))

        if self.steady:
            return State(wanted()).derive_from(wanted)
        position = self._solved(wanted(), (0.0, 1.0))
        Regulator(
            f"{edge['id']}:opening",
            self.net,
            sensed=sensed,
            setpoint=setpoint,
            droop=droop,
            response_time=self._knob(edge, "response_time"),
            position=position,
        )
        return position

    # --- what nodes hold ------------------------------------------------------------------------------------------

    def _storage(self) -> None:
        """Each liquid junction balances its flows; each gas junction and tank ullage keeps its gas (and each tank
        its liquid)."""
        liquid_in: dict[str, list[State]] = {node_id: [] for node_id in self.nodes}
        liquid_out: dict[str, list[State]] = {node_id: [] for node_id in self.nodes}
        gas_in: dict[str, list[State]] = {node_id: [] for node_id in self.nodes}
        gas_out: dict[str, list[State]] = {node_id: [] for node_id in self.nodes}
        for edge_id, edge in self.edges.items():
            gas = BY_TYPE[edge["type"]].phase == "gas"
            (gas_out if gas else liquid_out)[edge["source"]].append(self.flow[edge_id])
            (gas_in if gas else liquid_in)[edge["target"]].append(self.flow[edge_id])
        for node_id, node in self.nodes.items():
            settings = node["settings"]
            if node["type"] == "junction":
                Junction(
                    node_id,
                    self.net,
                    pressure=self.pressure[node_id],
                    inflows=liquid_in[node_id],
                    outflows=liquid_out[node_id],
                )
            elif node["type"] == "gas_junction":
                self._gas_volume(node_id, settings["volume"])
            elif node["type"] == "tank" and settings["mode"] == "ullage" and not self.steady:
                if settings["ullage_model"] == "wall":
                    self._wall_tank(node, liquid_in[node_id], liquid_out[node_id])
                else:
                    self._polytropic_tank(
                        node, gas_in[node_id], gas_out[node_id], liquid_in[node_id], liquid_out[node_id]
                    )

    def _polytropic_tank(self, node, gas_in, gas_out, liquid_in, liquid_out) -> None:
        node_id, settings = node["id"], node["settings"]
        pressure, temperature = self.pressure[node_id], self.temperature[node_id]
        gas = self._gas(node_id) if node_id in self.gas_of else self._tank_gas(node)
        initial = pressure.value
        tank = UllageTank(
            node_id,
            self.net,
            pressure=pressure,
            volume=settings["volume"],
            liquid_volume=State(float(settings["liquid_volume"])),
            liquid_density=self.density[node_id],
            initial_pressure=initial,
            initial_gas_density=initial / (gas.gas_constant * temperature.value),
            polytropic_exponent=self._knob(node, "polytropic_exponent"),
            collapse_factor=self._knob(node, "collapse_factor"),
            gas_in=gas_in,
            gas_out=gas_out,
            liquid_in=liquid_in,
            liquid_out=liquid_out,
        )
        # The gas's temperature goes with its pressure and density (for what flows out of it, and to plot).
        temperature.derive_from(lambda: max(pressure.value, 1.0) / (tank.gas_density() * gas.gas_constant))
        self.outputs[f"{node_id}.liquid_volume"] = tank.liquid_volume
        self.outputs[f"{node_id}.gas_temperature"] = temperature

    def _wall_tank(self, node, liquid_in, liquid_out) -> None:
        """An ullage whose gas FullFlow's Volume keeps, exchanging heat with the tank wall (a Solid) by Convection."""
        node_id, settings = node["id"], node["settings"]
        if node_id not in self.gas_of:
            self.gas_of[node_id] = settings["gas"]
        ullage = State(float(settings["volume"] - settings["liquid_volume"]))
        store = LiquidStore(
            f"{node_id}:liquid",
            self.net,
            ullage_volume=ullage,
            tank_volume=settings["volume"],
            density=self.density[node_id],
            liquid_in=liquid_in,
            liquid_out=liquid_out,
            liquid_volume=State(float(settings["liquid_volume"])),
        )
        wall = self._solved(self._starting(node, "wall_temperature", settings["wall_temperature"]), (10.0, 3000.0))
        convection = Convection(
            f"{node_id}:convection",
            self.net,
            surface_temperature=wall,
            fluid_temperature=self.temperature[node_id],
            convective_area=1.0,
            convection_coefficient=self._knob(node, "heat_transfer"),
        )
        Solid(
            f"{node_id}:wall",
            self.net,
            temperature=wall,
            mass=settings["wall_mass"],
            specific_heat=settings["wall_specific_heat"],
            heat_rate=convection.heat_rate,
        )
        # Convection's heat rate is into the wall: the gas loses what the wall gains.
        heat = State(0.0).derive_from(lambda: -convection.heat_rate.value)
        self._gas_volume(node_id, ullage, collapse=self._knob(node, "collapse_factor"), heat=heat)
        self.outputs[f"{node_id}.liquid_volume"] = store.liquid_volume
        self.outputs[f"{node_id}.gas_temperature"] = self.temperature[node_id]
        self.outputs[f"{node_id}.wall_temperature"] = wall

    def _tank_gas(self, node: dict[str, Any]) -> _Gas:
        """An ullage with no gas lines: its own gas."""
        self.gas_of[node["id"]] = node["settings"]["gas"]
        return self._gas(node["id"])

    def _gas_volume(
        self, node_id: str, volume: State | float, collapse: State | None = None, heat: State | None = None
    ) -> None:
        """A gas node's Volume: an ideal gas at the node's pressure and temperature, which FullFlow iterates while it
        keeps the gas's mass and energy."""
        gas = self._gas(node_id)
        if collapse is None:
            collapse = State(1.0)
        pressure, temperature = self.pressure[node_id], self.temperature[node_id]
        # Each edge at the node, which way it flows in, and the temperature of what it brings in.
        edges = []
        for edge_id, edge in self.edges.items():
            if BY_TYPE[edge["type"]].phase != "gas":
                continue
            if edge["target"] == node_id:
                edges.append((self.flow[edge_id], 1.0, self.temperature[edge["source"]]))
            if edge["source"] == node_id:
                edges.append((self.flow[edge_id], -1.0, self.temperature[edge["target"]]))

        def entering() -> float:
            return sum(max(sign * flow.value, 0.0) for flow, sign, _ in edges)

        def leaving() -> float:
            return sum(max(-sign * flow.value, 0.0) for flow, sign, _ in edges)

        def enthalpy_in() -> float:
            mass = entering()
            if mass <= 0.0:
                return gas.cp * temperature.value
            return sum(max(sign * flow.value, 0.0) * gas.cp * source.value for flow, sign, source in edges) / mass

        Volume(
            f"{node_id}:gas",
            self.net,
            pressure=pressure,
            volume=volume,
            temperature=temperature,
            density=State(0.0).derive_from(lambda: pressure.value / (gas.gas_constant * temperature.value)),
            internal_energy=State(0.0).derive_from(lambda: gas.cv * temperature.value),
            enthalpy=State(0.0).derive_from(lambda: gas.cp * temperature.value),
            energy_variable="T",
            mass_flow_in=State(0.0).derive_from(lambda: entering() / collapse.value),
            total_enthalpy_in=State(0.0).derive_from(enthalpy_in),
            mass_flow_out=State(0.0).derive_from(leaving),
            heat_rate=heat,
        )

    def _guess_junctions(self) -> None:
        """Start each liquid junction at the average of its neighbors through paths open at the start, spreading out
        from the pressures known (tanks, outlets): the solver then settles it in the first time step."""
        junctions = [node_id for node_id, node in self.nodes.items() if node["type"] == "junction"]
        known = {node_id: state.value for node_id, state in self.pressure.items() if node_id not in junctions}
        for _ in range(len(junctions)):
            changed = False
            for node_id in junctions:
                if node_id in known:
                    continue
                around = []
                for edge_id, edge in self.edges.items():
                    if node_id not in (edge["source"], edge["target"]):
                        continue
                    position = self.outputs.get(f"{edge_id}.position")
                    if position is not None and position.value <= 0.0:
                        continue  # closed at the start
                    other = edge["target"] if edge["source"] == node_id else edge["source"]
                    if other in known:
                        around.append(known[other])
                if around:
                    known[node_id] = sum(around) / len(around)
                    changed = True
            if not changed:
                break
        for node_id in junctions:
            self.pressure[node_id].value = max(known.get(node_id, ATMOSPHERE), 1.0)

    def _probe(self, name: str, state: State) -> None:
        self.recorder.add(name, state)
        self.probes[name] = state

    # --- anchors --------------------------------------------------------------------------------------------------

    def _anchor(self, anchor: dict[str, Any]) -> dict[str, Any]:
        """A FullFlow Sensor (components.Anchor) that moves a knob, in each time step of the anchor's span, so the
        model reads at a sensor what its channel measured; before the span the knob is its setting, and after it, it
        holds. The channel is averaged over each time step, which quiets its noise, and read between steps as a
        straight line."""
        knob = f"{anchor['part']}.{anchor['key']}"
        part = self.nodes.get(anchor["part"]) or self.edges[anchor["part"]]
        setting = next(one for one in BY_TYPE[part["type"]].settings if one.key == anchor["key"])
        sensor = self.nodes.get(anchor["sensor"]) or self.edges[anchor["sensor"]]
        link = next(one for one in BY_TYPE[sensor["type"]].links if one.key == anchor["link"])
        variable = self.knobs.get(knob)
        if variable is None:
            raise ModelError(
                f"{part['name']}'s {in_words(setting.label)} doesn't change anything in this model, so it can't be "
                "anchored"
            )
        reading = self.probes.get(f"{sensor['id']}.{output_of(link)}")
        found = self._series(sensor["id"], link.key)
        if reading is None or found is None:
            raise ModelError(
                f"{sensor['name']}'s {in_words(link.label)} has nothing in the run's window to anchor "
                f"{part['name']}'s {in_words(setting.label)} to"
            )
        times, values = found
        hair = 1e-6 * self.dt  # times this close are the same time: sums of dt, and a channel's, differ in last digits
        grid = np.arange(math.ceil(self.duration / self.dt) + 1) * self.dt
        grid = np.append(grid[grid < self.duration - hair], self.duration)
        means = np.interp(grid, times, values)  # for a step without samples
        steps = np.searchsorted(grid + hair, times, side="left")  # a sample in (grid[k - 1], grid[k]] is step k's
        inside = (steps > 0) & (steps < len(grid))
        counts = np.bincount(steps[inside], minlength=len(grid))
        sums = np.bincount(steps[inside], weights=values[inside], minlength=len(grid))
        means[counts > 0] = sums[counts > 0] / counts[counts > 0]
        start, end = anchor["start"] - self.start, anchor["end"] - self.start
        # The anchor's residual, the model's reading less the data, is FullFlow's to keep within rtol as it is: as a
        # share of the channel's size, like the rest, rather than in pascals, which swamp the others for SciPy.
        size = float(np.abs(means).max()) or 1.0
        sensor_component = Anchor(
            f"{knob}:anchor",
            self.net,
            reading=State(0.0).derive_from(lambda: reading.value / size),
            variable=variable,
            data=Trace(x=grid, y=means / size, name=f"{sensor['name']} {in_words(link.label)}", role="data"),
            times=grid,
            values=means / size,
            start=max(start, float(times[0])) - hair,
            end=min(end, float(times[-1])) + hair,
            shortest=self.dt / 3,  # a retried step's halves count (a hair short of dt / 2); its quarters don't
        )
        self.recorder.add(KNOB + knob, variable)
        self.recorder.add(ON + knob, sensor_component.active)
        return {**anchor, "knob": knob, "span": (start, end)}

    def anchored(self, anchor: dict[str, Any], history: dict[float, float], on: dict[float, float]) -> dict[str, Any]:
        """What an anchor found: its knob where it held it (in its span, as FullFlow matched the sensor), as the
        median (a value to apply) and the 10th and 90th percentiles (how much it moved). Where no value of the knob
        matched the sensor in a step, FullFlow retried the step in halves until the anchor was off for a sliver of one
        (components.Anchor), and held the knob: that's no finding, so it's left out. That's a valve's CdA while the
        valve is shut; and, in a transient run, an anchor starting partway through where the model is off from the
        test, since a line's flow (or a tank's pressure) can't jump to what was measured in one step."""
        start, end = anchor["span"]
        hair = 1e-6 * self.dt
        span = [t for t in history if t > 0.0 and start - hair <= t <= end + hair]
        found = np.array([history[t] for t in span if on.get(t) and math.isfinite(history[t])])
        part = self.nodes.get(anchor["part"]) or self.edges[anchor["part"]]
        setting = next(one for one in BY_TYPE[part["type"]].settings if one.key == anchor["key"])
        sensor = self.nodes.get(anchor["sensor"]) or self.edges[anchor["sensor"]]
        link = next(one for one in BY_TYPE[sensor["type"]].links if one.key == anchor["link"])
        named, measured = f"{part['name']}'s {in_words(setting.label)}", f"{sensor['name']}'s {in_words(link.label)}"
        if span and len(found) < HELD * len(span):
            self.notes.append(
                f"FullFlow anchored {named} to {measured} for {len(found) / len(span):.0%} of its span, and held it "
                "for the rest, where no value of it matched in a step: a valve's CdA while the valve is shut, or, "
                "starting partway through a transient run, a flow its line's inertia can't reach at once (start the "
                "anchor with the run, or anchor in a steady run). What it found is from where it anchored it."
            )
        low = -math.inf if setting.minimum is None else setting.minimum
        high = math.inf if setting.maximum is None else setting.maximum
        if len(found) and (found.min() < low or found.max() > high):
            self.notes.append(
                f"{named} went past its limits to match {measured}: no value it can really have does. If that channel "
                "is noisy, a longer time step averages more of it (a knob that acts through what a tank holds asks for "
                "its slope); if not, something else in the model is off."
            )

        def percentile(q: float) -> float | None:
            return float(np.percentile(found, q)) if len(found) else None

        return {
            "part": anchor["part"],
            "key": anchor["key"],
            "sensor": anchor["sensor"],
            "link": anchor["link"],
            "start": float(part["settings"][anchor["key"]]),
            "value": percentile(50),
            "low": percentile(10),
            "high": percentile(90),
            "share": len(found) / len(span) if span else 0.0,  # of its span, where it held the knob
        }

    # --- saying what happened -------------------------------------------------------------------------------------

    def _named(self, component: str) -> str:
        part_id = component.split(":")[0].split(".")[0]
        part = self.nodes.get(part_id) or self.edges.get(part_id)
        return part["name"] if part else component

    def explain(self, error: BaseException) -> str:
        causes = []
        while error is not None and len(causes) < 5:
            causes.append(error)
            error = error.__cause__
        text = "\n".join(str(cause) for cause in causes)
        at = re.search(r"^time = ([-+0-9.eE]+)", text, re.MULTILINE)
        # The residuals FullFlow lists, largest first ("- tank:liquid:ullage_volume.integration: -1.6e-05"): those within
        # its tolerance settled, so they aren't where it went wrong.
        listed = re.findall(r"^\s+- (\S+): ([-+0-9.eE]+)$", text, re.MULTILINE)
        where = [component for component, value in listed if abs(float(value)) > SOLVER["rtol"]]
        parts = list(dict.fromkeys(self._named(component) for component in where))[:3]
        anchored = " If it settles without its anchors, anchor over a shorter span." if self.anchors else ""
        if at:
            when = float(at.group(1)) + self.start
            around = f", around {' and '.join(parts)}" if parts else ""
            return (
                f"The simulation didn't settle at {when:.3f} s{around}. Try a shorter time step, or check the "
                f"settings there (a CdA of 0, a line with no length).{anchored}"
            )
        return (
            f"FullFlow couldn't run the model: {text.splitlines()[0] if text else type(causes[0]).__name__}{anchored}"
        )

    def dry(self, series: dict[str, dict[float, float]]) -> list[str]:
        """Tanks that ran out of liquid in the run."""
        notes = []
        for tank_id, node in self.nodes.items():
            volumes = series.get(f"{tank_id}.liquid_volume")
            empty = [t for t, volume in sorted(volumes.items()) if volume <= 0.0] if volumes else []
            if empty:
                notes.append(
                    f"{node['name']} ran out of liquid at {self.start + empty[0]:.2f} s: after that, the model isn't "
                    "meaningful."
                )
        return notes
