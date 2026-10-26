"""yorg_models: what a Yorg model's script needs besides FullFlow and ThermoProp.

Yorg writes each model as a FullFlow script (script.py) and runs it on the server, for Piper's Simulation mode, which
shows the script and these files (with components.py, the package yorg_models) to read. The script
builds the model from FullFlow's own components, with ThermoProp's properties through FullFlow's Lookup; Run does the
rest. It reads the test's channels into the model (data["part.link"]: a linked channel's times on the test's clock, and
its values in SI units), keeps what Piper says about the run (where it started from, its liquids, its notes), anchors
knobs (components.Anchor), and solves it.

The network runs on its own clock from 0 at the window's start: channels are put on that clock, and results go back on
the test's.

It imports nothing of the server's, since it runs in the browser too: ATMOSPHERE and PSI are catalog.py's.
"""

import math
import re
import time
from collections.abc import Callable
from typing import Any

import numpy as np
from fullflow import FullFlowError, Network, Sequence, State, SteadyState, Transient
from fullplot import Trace

from .components import Anchor, Recorder

__all__ = [
    "ATMOSPHERE",
    "OUTSIDE",
    "Anchor",
    "ModelError",
    "Recorder",
    "Run",
    "above",
    "cavitating",
    "eased",
    "enthalpy_in",
    "entering",
    "leaving",
]

ATMOSPHERE = 101325.0  # Pa
PSI = 6894.757  # Pa
OUTSIDE = 293.15  # K: gas that flows back in from an outlet
MAX_POINTS = 2000  # results per output: plenty to plot, small to send
BOILING = 1.0001  # a liquid's properties are read this much above where it would boil, if its node's pressure is below
EASE = 500.0  # Pa (0.07 psi): within this pressure drop of none, a restriction's flow turns linear (see eased)
RECORDER = "results"  # the component whose attributes are a run's outputs
KNOB = "knob:"  # what an anchored knob is recorded under, before its part.key
ON = "on:"  # and whether its anchor held it
HELD = 0.9  # an anchor that held its knob for less of its span than this says so
COMMANDED = 1e-6  # s: how long a valve's command takes to change
# FullFlow's transient solver (and its steady sweep): a 2-point Jacobian (a 3-point one costs half as much again, for
# nothing a test can see), and each time step solved to within rtol of its implicit equations, with SciPy's gradient
# test off (Transient's own default; SteadyState's stops a step early, at a junction's flow of 1e-6 kg/s). Each trial
# of a step evaluates every component; FullFlow repeats that until nothing changes, but a model's script adds
# components in the order values flow (commands, then valves and flows, then what nodes hold), so one pass settles it:
# a second only confirmed that, and cost as much again.
SOLVER = {
    "jacobian_method": "2-point",
    "ftol": 1e-8,
    "xtol": 1e-8,
    "gtol": None,
    "rtol": 1e-6,
    "max_step_retries": 8,
    "state_max_passes": 1,
}

# Told the run's time as it goes, by whoever runs the script (the server's runner, to say how far a run has got).
progress: Callable[[float], None] | None = None

Series = tuple[np.ndarray, np.ndarray]


class ModelError(Exception):
    """What's wrong with a model or its run, in words, for Piper to say."""


# A gas node's lines: each (its flow, 1.0 if it flows into the node or -1.0 if out of it, the enthalpy of the gas at
# its other end). Gas flowing in brings the enthalpy of where it came from; gas flowing out takes the node's own.


def entering(edges: list[tuple[Any, float, Any]]) -> float:
    """What flows into a gas node, kg/s."""
    return sum(max(sign * flow.value, 0.0) for flow, sign, _ in edges)


def leaving(edges: list[tuple[Any, float, Any]]) -> float:
    """What flows out of a gas node, kg/s."""
    return sum(max(-sign * flow.value, 0.0) for flow, sign, _ in edges)


def enthalpy_in(edges: list[tuple[Any, float, Any]], own: Any) -> float:
    """The enthalpy of what flows into a gas node (own: the node's, when nothing does), J/kg."""
    mass = energy = 0.0
    for flow, sign, enthalpy in edges:
        inflow = max(sign * flow.value, 0.0)
        if inflow > 0.0:  # a line that can't bring gas in has no enthalpy to read
            mass += inflow
            energy += inflow * enthalpy.value
    return energy / mass if mass > 0.0 else own.value


def above(pressure: Any, boiling: Any) -> State:
    """Where to read a liquid's properties at a node: its pressure, or, below where the liquid would boil (boiling:
    its saturation pressure, None above its critical point), just above that. A junction drained to the atmosphere
    still holds liquid, as far as the model knows, and ThermoProp's vapor there would be no liquid's density."""

    def value() -> float:
        floor = boiling.value
        if floor is None or not math.isfinite(floor):
            return pressure.value
        return max(pressure.value, floor * BOILING)

    return State(value()).derive_from(value)


def eased(coefficient: Any, upstream: Any, downstream: Any) -> State:
    """A restriction's discharge coefficient, eased off within EASE of no pressure drop across it. A restriction's flow
    goes as the root of its pressure drop, which has no slope at none: a junction between a shut valve and an orifice
    then gives the solver nothing to settle it with. Eased, the flow turns linear in the pressure drop there instead,
    and is a part in a million less at 0.25 MPa."""

    def value() -> float:
        drop = abs(upstream.value - downstream.value)
        return coefficient.value * math.sqrt(drop / math.sqrt(drop * drop + EASE * EASE))

    return State(value()).derive_from(value)


def cavitating(upstream: Any, downstream: Any, vapor: Any, recovery: Any) -> float:
    """1 while a cavitating venturi cavitates, as FullFlow's CavitatingVenturi decides it (and doesn't say), else 0."""
    p1, p2, pv = upstream.value, downstream.value, vapor.value
    return 1.0 if p1 > p2 and p2 <= pv + recovery.value * (p1 - pv) else 0.0


def _start(state: Any) -> float:
    return float(state.value if hasattr(state, "value") else state)


class Run:
    """A model's run: its FullFlow network (net), the test's channels it reads (data), and what Piper shows of it.

    start and end are the window, on the test's clock; dt the time step; steady, FullFlow's quasi-steady sweep instead
    of a transient. names are the parts', by id, for what the run says; channels, the channels the model is linked to,
    by part.link (data's keys): each one's name in the test, and what it measures.
    """

    def __init__(
        self,
        data: dict[str, Series],
        start: float,
        end: float,
        dt: float,
        steady: bool = False,
        names: dict[str, str] | None = None,
        channels: dict[str, tuple[str, str]] | None = None,
    ):
        self.data = data
        self.start, self.end, self.dt = float(start), float(end), float(dt)
        self.duration = self.end - self.start
        self.steady = steady
        self.names = dict(names or {})
        self.channels = dict(channels or {})
        self.net = Network("System model")
        self.notes: list[str] = []
        self.liquids: dict[str, dict[str, Any]] = {}  # each tank's liquid: what, at what temperatures, how dense
        self.initial: list[dict[str, Any]] = []  # values the run started from, taken from channels
        self.probes: dict[str, State] = {}  # what it reports, by part.output
        self.anchors: list[dict[str, Any]] = []
        self.recorder = Recorder(RECORDER, self.net)
        self.recorder.on_progress(progress)

    # --- a test's data -------------------------------------------------------------------------------------------

    def series(self, key: str) -> Series | None:
        """A linked channel's samples (data[key]) on the run's clock (0 at the window's start), missing ones left out."""
        found = self.data.get(key)
        if found is None:
            return None
        times, values = np.asarray(found[0], dtype=float), np.asarray(found[1], dtype=float)
        keep = np.isfinite(times) & np.isfinite(values)
        return (times[keep] - self.start, values[keep]) if keep.any() else None

    def starting(self, key: str, otherwise: float, low: float | None = None) -> float:
        """A value the model starts from: its channel's (data[key]) at the run's start, noted for Piper; or, with
        no samples, otherwise. At least low, if given."""
        found = self.series(key)
        if found is None:
            value = float(otherwise)
        else:
            value = float(np.interp(0.0, *found))
            part, link = key.split(".", 1)
            channel, quantity = self.channels.get(key, ("", ""))
            self.initial.append({"part": part, "key": link, "channel": channel, "quantity": quantity, "value": value})
        return value if low is None else max(value, float(low))

    def following(self, key: str, otherwise: float) -> State:
        """A value that follows its channel (data[key]) through the run; or, with no samples, stays at otherwise."""
        found = self.series(key)
        if found is None:
            return State(float(otherwise))
        times, values = found
        state = State(float(np.interp(0.0, times, values)))
        Sequence(f"{key}:data", self.net, target=state, function=lambda t: float(np.interp(t, times, values)))
        return state

    def command(self, key: str, closed: float, opened: float, otherwise: float) -> State:
        """A valve's command, 0 closed to 1 open, from its channel (data[key], read closed to opened). A sample says
        what the command was since the sample before it, as FullFlow records a run (each step's states at its end): so
        each change is a step the solver lands on, a hair after the sample before it, and the step from there to the
        sample is a whole one, as a run's results there (and an anchor's) want. A run of FullFlow's, fed back as a
        test, gets its commands when it had them. With no samples, otherwise."""
        found = self.series(key)
        if found is None:
            return State(float(otherwise))
        part = key.split(".", 1)[0]
        span = opened - closed
        if span == 0:
            raise ModelError(f"{self.names.get(part, part)}: its command's open and closed values are the same")
        times, raw = found
        commanded = np.round(np.clip((raw - closed) / span, 0.0, 1.0), 2)
        first = min(int(np.searchsorted(times, 0.0, side="left")), len(times) - 1)  # what holds from the start
        points_t, points_v = [0.0], [float(commanded[first])]
        for index in np.flatnonzero(np.diff(commanded) != 0) + 1:
            t, value = float(times[index - 1]), float(commanded[index])
            if t < points_t[-1] or t + COMMANDED >= self.duration:
                continue
            if t > points_t[-1]:
                points_t.append(t)
                points_v.append(points_v[-1])
            points_t.append(t + COMMANDED)
            points_v.append(value)
        points_t.append(self.duration)
        points_v.append(points_v[-1])
        state = State(points_v[0])
        Sequence(f"{part}:command", self.net, target=state, times=points_t, values=points_v)
        return state

    # --- properties ----------------------------------------------------------------------------------------------

    def liquid(self, tank: str, properties: Any) -> None:
        """Note a tank's liquid for Piper (properties: its Lookup of ThermoProp's): what it is, and its temperature,
        density, and vapor pressure at the run's start, as ThermoProp has them there; and, where its temperature follows
        a channel, over the temperatures that reads. ThermoProp says, in words, where it hasn't the liquid at all (below
        its freezing point, out of its range); where it has it as something else, the run says so."""
        name = self.names.get(tank, tank)
        fluid = str(properties.args[0])
        pressure, temperature = (_start(properties.kwargs[key]) for key in ("pressure", "temperature"))
        follows = f"{tank}.temperature"
        found = self.series(follows)
        temperatures = [temperature]
        if found is not None:
            times, values = found
            inside = values[(times >= 0.0) & (times <= self.duration)]
            temperatures = [float(inside.min()), float(inside.max())] if len(inside) else temperatures
        states, phases = [], set()
        for each in [temperature, *temperatures]:
            try:
                state = properties.callable(fluid, pressure=pressure, temperature=each)
                states.append(state)
                phases.add(str(state.phase))
            except Exception as error:  # ThermoProp says why: below its freezing point, out of range
                raise ModelError(
                    f"{name}: ThermoProp can't give {fluid}'s properties at {each:.1f} K and {pressure / PSI:.0f} psia "
                    f"({error}). Check the liquid's temperature."
                ) from error
        try:
            vapor = float(states[0].saturation_pressure)
        except Exception:  # above its critical point: no vapor pressure (and no venturi can use it)
            vapor = math.nan
        for phase in sorted(phases):
            if "liquid" not in phase.lower():
                self.notes.append(
                    f"{name}: {fluid} is {phase.lower()} at {min(temperatures):.1f}–{max(temperatures):.1f} K and "
                    f"{pressure / PSI:.0f} psia, not liquid: check the liquid's temperature."
                )
        self.liquids[tank] = {
            "fluid": fluid,
            "temperature": temperature,
            "density": float(states[0].density),
            "vapor_pressure": vapor,
            "phase": ", ".join(sorted(phases)),
            "follows": self.channels.get(follows, ("", ""))[0] if found is not None else None,
        }
        if found is not None:
            self.liquids[tank]["temperatures"] = [min(temperatures), max(temperatures)]
            densities = [float(state.density) for state in states[1:]]
            self.liquids[tank]["densities"] = [min(densities), max(densities)]

    def custom_liquid(
        self, tank: str, density: float, vapor_pressure: float, temperature: float
    ) -> tuple[State, State]:
        """A liquid of a density and vapor pressure given, for one ThermoProp doesn't have."""
        self.liquids[tank] = {
            "fluid": "Custom",
            "temperature": float(temperature),
            "density": float(density),
            "vapor_pressure": float(vapor_pressure),
            "phase": "liquid",
            "follows": None,
        }
        return State(float(density)), State(float(vapor_pressure))

    def gas(self, part: str, properties: Any) -> None:
        """Check ThermoProp has a node's gas (properties: its Lookup) at the run's start: where it hasn't, the run says
        why in words, before FullFlow would find it can't."""
        gas = str(properties.args[0])
        pressure, temperature = (_start(properties.kwargs[key]) for key in ("pressure", "temperature"))
        try:
            float(properties.callable(gas, pressure=pressure, temperature=temperature).density)
        except Exception as error:
            raise ModelError(
                f"{self.names.get(part, part)}: ThermoProp can't give {gas}'s properties at {temperature:.1f} K and "
                f"{pressure / PSI:.0f} psia ({error})"
            ) from error

    def needs_vapor_pressure(self, venturi: str, tank: str, vapor: Any) -> None:
        """A cavitating venturi chokes at its liquid's vapor pressure, which one above its critical point hasn't."""
        value = vapor.value
        if value is None or not math.isfinite(value):
            raise ModelError(
                f"{self.names.get(venturi, venturi)}: {self.names.get(tank, tank)}'s liquid is above its critical "
                "point, so it has no vapor pressure to cavitate at"
            )

    # --- the network's start --------------------------------------------------------------------------------------

    def guess_junctions(
        self,
        junctions: dict[str, State],
        known: dict[str, State],
        edges: list[tuple[str, str, State | None]],
        readings: dict[str, str] | None = None,
    ) -> None:
        """Start each liquid junction (junctions, by id) where its pressure transducer read at the start (readings: its
        channel's key, where it has one and the test has it); or else at the average of its neighbors through paths
        open at the start (edges: each one's ends, and its valve's position if it has one), spreading out from the
        pressures known (tanks, outlets). The solver then settles it in the first time step."""
        values = {node: state.value for node, state in known.items()}
        for node, key in (readings or {}).items():
            if self.series(key) is not None:
                values[node] = self.starting(key, ATMOSPHERE)
        for _ in range(len(junctions)):
            changed = False
            for node in junctions:
                if node in values:
                    continue
                around = []
                for source, target, position in edges:
                    if node not in (source, target):
                        continue
                    if position is not None and position.value <= 0.0:
                        continue  # closed at the start
                    other = target if source == node else source
                    if other in values:
                        around.append(values[other])
                if around:
                    values[node] = sum(around) / len(around)
                    changed = True
            if not changed:
                break
        for node, state in junctions.items():
            state.value = max(values.get(node, ATMOSPHERE), 1.0)

    # --- what it reports ------------------------------------------------------------------------------------------

    def record(self, probes: dict[str, State]) -> None:
        """Report these (by part.output) at each of the run's points."""
        for name, state in probes.items():
            self.recorder.add(name, state)
            self.probes[name] = state

    def anchor(
        self,
        variable: State,
        reading: State,
        key: str,
        start: float,
        end: float,
        knob: str,
        named: str,
        measured: str,
        limits: tuple[float | None, float | None],
    ) -> None:
        """Anchor a knob (variable, part.key knob, named in words) to a sensor's channel (data[key], measured in words):
        a FullFlow Sensor (components.Anchor) moves it, in each time step from start to end (the test's clock), so the
        model reads what the channel measured; before then the knob is its setting, and after, it holds. The channel is
        averaged over each time step, which quiets its noise, and read between steps as a straight line."""
        found = self.series(key)
        if found is None:
            raise ModelError(f"{measured} has nothing in the run's window to anchor {named} to")
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
        span = (start - self.start, end - self.start)
        # The anchor's residual, the model's reading less the data, is FullFlow's to keep within rtol as it is: as a
        # share of the channel's size, like the rest, rather than in pascals, which swamp the others for SciPy.
        size = float(np.abs(means).max()) or 1.0
        sensor = Anchor(
            f"{knob}:anchor",
            self.net,
            reading=State(0.0).derive_from(lambda: reading.value / size),
            variable=variable,
            data=Trace(x=grid, y=means / size, name=measured, role="data"),
            times=grid,
            values=means / size,
            start=max(span[0], float(times[0])) - hair,
            end=min(span[1], float(times[-1])) + hair,
            shortest=self.dt / 3,  # a retried step's halves count (a hair short of dt / 2); its quarters don't
        )
        self.recorder.add(KNOB + knob, variable)
        self.recorder.add(ON + knob, sensor.active)
        part, setting = knob.split(".", 1)
        sensor_part, link = key.split(".", 1)
        self.anchors.append(
            {
                "knob": knob,
                "part": part,
                "key": setting,
                "sensor": sensor_part,
                "link": link,
                "start": float(variable.value),  # its setting
                "span": span,
                "named": named,
                "measured": measured,
                "limits": limits,
            }
        )

    def _anchored(self, anchor: dict[str, Any], history: dict[float, float], on: dict[float, float]) -> dict[str, Any]:
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
        named, measured = anchor["named"], anchor["measured"]
        if span and len(found) < HELD * len(span):
            self.notes.append(
                f"FullFlow anchored {named} to {measured} for {len(found) / len(span):.0%} of its span, and held it "
                "for the rest, where no value of it matched in a step: a valve's CdA while the valve is shut, or, "
                "starting partway through a transient run, a flow its line's inertia can't reach at once (start the "
                "anchor with the run, or anchor in a steady run). What it found is from where it anchored it."
            )
        low, high = anchor["limits"]
        low, high = -math.inf if low is None else low, math.inf if high is None else high
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
            "start": anchor["start"],
            "value": percentile(50),
            "low": percentile(10),
            "high": percentile(90),
            "share": len(found) / len(span) if span else 0.0,  # of its span, where it held the knob
        }

    # --- solving --------------------------------------------------------------------------------------------------

    def solve(self, max_points: int = MAX_POINTS) -> dict[str, Any]:
        """Solve the network over the window (FullFlow's Transient, or its steady sweep), and give what Piper shows:
        each output's values at up to max_points times (on the test's clock), the liquids, where the run started
        from, its notes, and, with anchors, each knob's history and what it settled at."""
        solve = SteadyState(self.net).solve if self.steady else Transient(self.net).solve
        started = time.monotonic()
        try:
            # Results every so many steps: FullFlow lands a step on each, so they keep the steps on a grid of dt.
            save_dt = self.dt * max(1, math.ceil(self.duration / max_points / self.dt - 1e-9))
            records = solve(dt=self.dt, t_final=self.duration, save_dt=save_dt, **SOLVER)
        except FullFlowError as error:
            raise ModelError(self.explain(error)) from error
        elapsed = time.monotonic() - started
        recorded: dict[str, dict[float, float]] = {}
        for record in records:
            if record["component_name"] == RECORDER:
                recorded.setdefault(record["attribute"], {})[record["time"]] = float(record["value"])
        series = {name: recorded.get(name, {}) for name in self.probes}
        knobs = {anchor["knob"]: recorded.get(KNOB + anchor["knob"], {}) for anchor in self.anchors}
        times = sorted({t for values in series.values() for t in values})
        anchors = [
            self._anchored(anchor, knobs[anchor["knob"]], recorded.get(ON + anchor["knob"], {}))
            for anchor in self.anchors
        ]
        result: dict[str, Any] = {
            "times": [self.start + t for t in times],
            "series": {name: [values.get(t) for t in times] for name, values in series.items()},
            "liquids": self.liquids,
            "initial": self.initial,
            "notes": self.notes + self._dry(series),
            "steps": len(times),
            "elapsed": elapsed,
        }
        if anchors:
            result["anchored"] = {key: [values.get(t) for t in times] for key, values in knobs.items()}
            result["anchors"] = anchors
        return result

    # --- saying what happened -------------------------------------------------------------------------------------

    def _named(self, component: str) -> str:
        part = component.split(":")[0].split(".")[0]
        return self.names.get(part, component)

    def explain(self, error: BaseException) -> str:
        """A run that FullFlow couldn't solve, in words: when, and around which parts (those whose equations it
        couldn't meet)."""
        causes: list[BaseException] = []
        cause: BaseException | None = error
        while cause is not None and len(causes) < 5:
            causes.append(cause)
            cause = cause.__cause__
        text = "\n".join(str(one) for one in causes)
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

    def _dry(self, series: dict[str, dict[float, float]]) -> list[str]:
        """Tanks that ran out of liquid in the run."""
        notes = []
        for name, volumes in series.items():
            if not name.endswith(".liquid_volume"):
                continue
            empty = [t for t, volume in sorted(volumes.items()) if volume <= 0.0]
            if empty:
                tank = name.removesuffix(".liquid_volume")
                notes.append(
                    f"{self.names.get(tank, tank)} ran out of liquid at {self.start + empty[0]:.2f} s: after that, "
                    "the model isn't meaningful."
                )
        return notes
