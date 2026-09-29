"""A checked system model as a FullFlow network, run over a test's window, with each part's outputs read back.

Runs in the runner's process only: it imports FullFlow, ThermoProp, NumPy, and SciPy. The network runs on its own
clock from 0 at the window's start; channels it follows (pressures, temperatures, valve commands) are put on the same
clock, and results go back on the dataset's.
"""

import re
import time
from collections.abc import Callable
from typing import Any

import numpy as np
from fullflow import Actuator, DarcyWeisbach, FullFlowError, Network, Sequence, State, Transient
from thermoprop import Fluid, IdealGas

from .catalog import ATMOSPHERE, PSI
from .components import GasRestriction, Junction, Probe, Restriction, UllageTank

MAX_POINTS = 2000  # results per output: plenty to plot, small to send


class ModelError(Exception):
    """What's wrong with a model or its run, in words, for the dev page."""


Series = tuple[np.ndarray, np.ndarray]


def run(job: dict[str, Any], inputs: dict[str, Series], progress: Callable[[float], None]) -> dict[str, Any]:
    """Simulate job's model from job["start"] to job["end"], with time steps of job["dt"]; inputs are the linked
    channels' samples (SI units, on the dataset's clock) by part.link."""
    built = _Builder(job, inputs, progress)
    duration = job["end"] - job["start"]
    started = time.monotonic()
    try:
        records = Transient(built.net).solve(
            dt=job["dt"],
            t_final=duration,
            save_dt=max(job["dt"], duration / MAX_POINTS),
            jacobian_method="2-point",
            ftol=1e-8,
            xtol=1e-8,
            rtol=1e-6,
            max_step_retries=8,
        )
    except FullFlowError as error:
        raise ModelError(built.explain(error)) from error
    elapsed = time.monotonic() - started
    series: dict[str, dict[float, float]] = {name: {} for name in built.probes}
    for record in records:
        found = series.get(record["component_name"])
        if found is not None and record["attribute"] == "reading":
            found[record["time"]] = float(record["value"])
    times = sorted({t for values in series.values() for t in values})
    result = {
        "times": [job["start"] + t for t in times],
        "series": {name: [values.get(t) for t in times] for name, values in series.items()},
        "liquids": built.liquids,
        "notes": built.notes + built.dry(series),
        "steps": len(times),
        "elapsed": elapsed,
    }
    return result


class _Builder:
    def __init__(self, job: dict[str, Any], inputs: dict[str, Series], progress: Callable[[float], None]):
        self.start, self.duration = job["start"], job["end"] - job["start"]
        self.inputs = inputs
        model = job["model"]
        self.nodes: dict[str, dict[str, Any]] = model["nodes"]
        self.edges: dict[str, dict[str, Any]] = model["edges"]
        self.liquid_of: dict[str, str] = job["liquid_of"]
        self.net = Network("System model")
        self.notes: list[str] = []
        self.liquids: dict[str, dict[str, Any]] = {}  # each tank's liquid: what, at what temperature, how dense
        self.pressure: dict[str, State] = {}
        self.flow: dict[str, State] = {}
        self.position: dict[str, State] = {}
        self.density: dict[str, State] = {}
        self.gas: dict[str, tuple[float, float, State]] = {}  # a gas supply's gas constant, gamma, and temperature
        self.probes: dict[str, State] = {}
        self.tanks: dict[str, UllageTank] = {}
        Sequence("progress", self.net, target=State(0.0), function=lambda t: progress(t) or 0.0)
        for node in self.nodes.values():
            self._node(node)
        for edge in self.edges.values():
            self._edge(edge)
        self._balances()
        self._guess_junctions()
        for node_id, state in self.pressure.items():
            self._probe(f"{node_id}.pressure", state)
        for tank_id, tank in self.tanks.items():
            self._probe(f"{tank_id}.liquid_volume", tank.liquid_volume)
        for edge_id, state in self.flow.items():
            self._probe(f"{edge_id}.mass_flow", state)
        for edge_id, state in self.position.items():
            self._probe(f"{edge_id}.position", state)

    # --- a test's data -------------------------------------------------------------------------------------------

    def _series(self, part_id: str, link: str) -> Series | None:
        """A linked channel's samples on the run's clock (0 at the window's start), missing ones left out."""
        found = self.inputs.get(f"{part_id}.{link}")
        if found is None:
            return None
        times, values = found
        keep = np.isfinite(times) & np.isfinite(values)
        return (times[keep] - self.start, values[keep]) if keep.any() else None

    def _at_start(self, part_id: str, link: str, default: float) -> float:
        found = self._series(part_id, link)
        return float(np.interp(0.0, *found)) if found else float(default)

    def _mean(self, part_id: str, link: str, default: float) -> float:
        found = self._series(part_id, link)
        if not found:
            return float(default)
        times, values = found
        inside = values[(times >= 0.0) & (times <= self.duration)]
        return float(inside.mean()) if len(inside) else float(np.interp(0.0, times, values))

    def _following(self, name: str, part_id: str, link: str, constant: float) -> State:
        """A pressure that stays at constant, or follows a linked channel."""
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
            self.density[node_id] = State(self._liquid(node))
            if settings["mode"] == "fixed":
                self.pressure[node_id] = self._following(node_id, node_id, "pressure", settings["pressure"])
            else:
                initial = max(self._at_start(node_id, "pressure", settings["pressure"]), 1000.0)
                self.pressure[node_id] = State(initial, bounds=(1.0, None))
        elif kind == "source":
            self.pressure[node_id] = self._following(node_id, node_id, "pressure", settings["pressure"])
            temperature = self._mean(node_id, "temperature", settings["temperature"])
            gas = self._gas(node["name"], settings["gas"], self.pressure[node_id].value, temperature)
            self.gas[node_id] = (gas.gas_constant, gas.specific_heat_ratio, State(temperature))
        elif kind == "outlet":
            self.pressure[node_id] = self._following(node_id, node_id, "pressure", settings["pressure"])
        else:  # a junction: its pressure is solved for, from a guess (see _guess_junctions)
            self.pressure[node_id] = State(ATMOSPHERE, bounds=(1.0, None))

    def _liquid(self, tank: dict[str, Any]) -> float:
        """The tank's liquid's density, from ThermoProp at its temperature (a linked channel's average over the run)."""
        settings = tank["settings"]
        temperature = self._mean(tank["id"], "temperature", settings["temperature"])
        pressure = max(self._at_start(tank["id"], "pressure", settings["pressure"]), 1000.0)
        if settings["fluid"] == "Custom":
            density, phase = float(settings["density"]), "liquid"
        else:
            try:
                state = Fluid(settings["fluid"], pressure=pressure, temperature=temperature)
                density, phase = float(state.density), str(state.phase)
            except Exception as error:  # ThermoProp says why: below its freezing point, out of range
                raise ModelError(
                    f"{tank['name']}: ThermoProp can't give {settings['fluid']}'s properties at {temperature:.1f} K and "
                    f"{pressure / PSI:.0f} psia ({error}). Check the liquid's temperature."
                ) from error
            if "liquid" not in phase.lower():
                self.notes.append(
                    f"{tank['name']}: {settings['fluid']} at {temperature:.1f} K is {phase.lower()}, not liquid: check "
                    "the liquid's temperature."
                )
        self.liquids[tank["id"]] = {
            "fluid": settings["fluid"],
            "temperature": temperature,
            "density": density,
            "phase": phase,
        }
        return density

    def _gas(self, name: str, gas: str, pressure: float, temperature: float):
        try:
            return IdealGas(gas, pressure=max(pressure, 1000.0), temperature=temperature)
        except Exception as error:
            raise ModelError(
                f"{name}: ThermoProp can't give {gas}'s properties at {temperature:.1f} K ({error})"
            ) from error

    def _edge(self, edge: dict[str, Any]) -> None:
        edge_id, kind, settings = edge["id"], edge["type"], edge["settings"]
        upstream, downstream = self.pressure[edge["source"]], self.pressure[edge["target"]]
        if kind == "gas_line":
            gas_constant, gamma, temperature = self.gas[edge["source"]]
            opening = self._opening(edge)
            restriction = GasRestriction(
                edge_id,
                self.net,
                upstream_pressure=upstream,
                upstream_temperature=temperature,
                downstream_pressure=downstream,
                gas_constant=gas_constant,
                specific_heat_ratio=gamma,
                cda=settings["cda"],
                opening=opening,
                check=settings["check"] == "yes",
            )
            self.flow[edge_id], self.position[edge_id] = restriction.mass_flow, opening
            return
        density = self.density[self.liquid_of[edge_id]]
        if kind == "line":
            # Fittings' K added to the tubing's friction: (f L / D + K) rho v^2 / 2 is (f + K D / L) L / D rho v^2 / 2.
            friction = (
                settings["friction_factor"] + settings["loss_coefficient"] * settings["diameter"] / settings["length"]
            )
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
                cda=settings["cda"],
                opening=opening,
            )
            self.flow[edge_id], self.position[edge_id] = restriction.mass_flow, opening
        else:  # an orifice
            restriction = Restriction(
                edge_id,
                self.net,
                upstream_pressure=upstream,
                downstream_pressure=downstream,
                density=density,
                cda=settings["cda"],
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
            if points_t[-1] < t - 1e-6 and t < self.duration:
                points_t += [t - 1e-6, t]  # a step: the solver lands on it
                points_v += [points_v[-1], value]
        points_t.append(self.duration)
        points_v.append(points_v[-1])
        command, position = State(points_v[0]), State(points_v[0])
        Sequence(f"{edge_id}:command", self.net, target=command, times=points_t, values=points_v)
        Actuator(
            f"{edge_id}:actuator",
            self.net,
            command=command,
            position=position,
            minimum=0.0,
            maximum=1.0,
            rate_limit=1.0 / settings["opening_time"],
        )
        return position

    def _balances(self) -> None:
        """Each junction balances its flows; each ullage tank keeps track of its gas and liquid."""
        inflows: dict[str, list[State]] = {node_id: [] for node_id in self.nodes}
        outflows: dict[str, list[State]] = {node_id: [] for node_id in self.nodes}
        gas_in: dict[str, list[State]] = {node_id: [] for node_id in self.nodes}
        for edge_id, edge in self.edges.items():
            if edge["type"] == "gas_line":
                gas_in[edge["target"]].append(self.flow[edge_id])
            else:
                outflows[edge["source"]].append(self.flow[edge_id])
                inflows[edge["target"]].append(self.flow[edge_id])
        for node_id, node in self.nodes.items():
            settings = node["settings"]
            if node["type"] == "junction":
                Junction(
                    node_id,
                    self.net,
                    pressure=self.pressure[node_id],
                    inflows=inflows[node_id],
                    outflows=outflows[node_id],
                )
            elif node["type"] == "tank" and settings["mode"] == "ullage":
                initial = self.pressure[node_id].value
                gas = self._gas(node["name"], settings["gas"], initial, settings["gas_temperature"])
                self.tanks[node_id] = UllageTank(
                    node_id,
                    self.net,
                    pressure=self.pressure[node_id],
                    volume=settings["volume"],
                    liquid_volume=State(float(settings["liquid_volume"])),
                    liquid_density=self.density[node_id],
                    initial_pressure=initial,
                    initial_gas_density=initial / (gas.gas_constant * settings["gas_temperature"]),
                    polytropic_exponent=settings["polytropic_exponent"],
                    collapse_factor=settings["collapse_factor"],
                    gas_in=gas_in[node_id],
                    liquid_in=inflows[node_id],
                    liquid_out=outflows[node_id],
                )

    def _guess_junctions(self) -> None:
        """Start each junction at the average of its neighbors through paths open at the start, spreading out from
        the pressures known (tanks, supplies, outlets): the solver then settles it in the first time step."""
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
                    if edge_id in self.position and self.position[edge_id].value <= 0.0:
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
        Probe(name, self.net, reading=state)
        self.probes[name] = state

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
        where = re.findall(r"^\s+- ([^:]+?)(?:\.balance\[\d+\]|:[\w.]+)?: [-+0-9.eE]+$", text, re.MULTILINE)
        parts = list(dict.fromkeys(self._named(component) for component in where))[:3]
        if at:
            when = float(at.group(1)) + self.start
            around = f", around {' and '.join(parts)}" if parts else ""
            return (
                f"The simulation didn't settle at {when:.3f} s{around}. Try a shorter time step, or check the "
                "settings there (a CdA of 0, a line with no length)."
            )
        return f"FullFlow couldn't run the model: {text.splitlines()[0] if text else type(causes[0]).__name__}"

    def dry(self, series: dict[str, dict[float, float]]) -> list[str]:
        """Tanks that ran out of liquid in the run."""
        notes = []
        for tank_id in self.tanks:
            empty = [t for t, volume in sorted(series.get(f"{tank_id}.liquid_volume", {}).items()) if volume <= 0.0]
            if empty:
                notes.append(
                    f"{self.nodes[tank_id]['name']} ran out of liquid at {self.start + empty[0]:.2f} s: after that, the model isn't meaningful."
                )
        return notes
