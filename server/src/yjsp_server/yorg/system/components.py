"""FullFlow components of Yorg's own, where FullFlow's catalog has nothing that fits (they follow FullFlow's recipe for
custom components: constructor arguments become states in setup(), evaluate_states() computes, and balances or
dynamics give the solver its equations). Imported only by the runner's process.

Flows through restrictions go as the square root of the pressure drop, which has no slope at zero: a node between a
closed valve and an open orifice then takes the solver many tries to settle. Below SMOOTH_DP the flow turns linear in
the pressure drop instead, which changes nothing at the pressure drops a test runs at.
"""

import math

import numpy as np
from fullflow import CavitatingVenturi, Component, Sensor

SMOOTH_DP = 500.0  # Pa (0.07 psi)


def _smooth_root(dp: float) -> float:
    """sqrt(dp) with dp's sign, turned linear below SMOOTH_DP."""
    return dp / (dp * dp + SMOOTH_DP * SMOOTH_DP) ** 0.25


def split(inflows, outflows) -> tuple[float, float]:
    """What enters and what leaves a node, from the flows of the edges into it and out of it (either can be
    negative: flowing the other way)."""
    entering = sum(max(flow.value, 0.0) for flow in inflows) + sum(max(-flow.value, 0.0) for flow in outflows)
    leaving = sum(max(-flow.value, 0.0) for flow in inflows) + sum(max(flow.value, 0.0) for flow in outflows)
    return entering, leaving


class Restriction(Component):
    """A liquid orifice or valve: mdot = CdA * opening * sqrt(2 rho dP), positive from upstream to downstream."""

    def __init__(
        self, name, network, upstream_pressure, downstream_pressure, density, cda, opening=1.0, mass_flow=None
    ):
        self.setup()

    def evaluate_states(self):
        dp = self.upstream_pressure.value - self.downstream_pressure.value
        area = self.cda.value * min(1.0, max(0.0, self.opening.value))
        self.mass_flow.value = area * math.sqrt(2.0 * self.density.value) * _smooth_root(dp)


class GasRestriction(Component):
    """An ideal-gas orifice or valve, choked or not, from the pressure and temperature it flows from: upstream's, or
    downstream's when it flows back. With check, nothing flows back."""

    def __init__(
        self,
        name,
        network,
        upstream_pressure,
        upstream_temperature,
        downstream_pressure,
        gas_constant,
        specific_heat_ratio,
        cda,
        opening=1.0,
        check=True,
        downstream_temperature=None,
        mass_flow=None,
        choked=None,
    ):
        self.setup()

    def _flow(self, area: float, high: float, low: float, temperature: float) -> tuple[float, bool]:
        """What flows from high to low (and whether it's choked)."""
        gamma, gas_constant = self.specific_heat_ratio.value, self.gas_constant.value
        ratio = max(low, 1.0) / high
        critical = (2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0))
        if ratio <= critical:
            flow_function = math.sqrt(gamma) * (2.0 / (gamma + 1.0)) ** ((gamma + 1.0) / (2.0 * (gamma - 1.0)))
        else:
            flow_function = math.sqrt(
                2.0 * gamma / (gamma - 1.0) * (ratio ** (2.0 / gamma) - ratio ** ((gamma + 1.0) / gamma))
            )
        flow = area * high * flow_function / math.sqrt(gas_constant * max(temperature, 1.0))
        # Near equal pressures the flow goes as sqrt(dP): this turns it linear there, as Restriction does.
        dp = high - low
        return flow * math.sqrt(dp) / (dp * dp + SMOOTH_DP * SMOOTH_DP) ** 0.25, ratio <= critical

    def evaluate_states(self):
        p1, p2 = self.upstream_pressure.value, self.downstream_pressure.value
        dp = p1 - p2
        area = self.cda.value * min(1.0, max(0.0, self.opening.value))
        forward = self.upstream_temperature.value
        if dp >= 0.0:
            flow, choked = self._flow(area, p1, p2, forward)
        elif self.check.value:
            flow, choked = 0.0, False
        else:
            back = self.downstream_temperature.value if self.downstream_temperature.is_assigned else forward
            flow, choked = self._flow(area, p2, p1, back)
            flow = -flow
        self.mass_flow.value = flow
        self.choked.value = choked


class Regulator(Component):
    """A pressure regulator's opening: fully open at its droop below its set pressure, closed above it, from the
    pressure where it flows to; it gets there as a first-order lag of its response time.

    The opening is a state FullFlow solves with the rest in each time step. A controller whose actuator moves once a
    step (FullFlow's PID and Actuator) opens on the last step's pressure instead, a step behind the little volume of
    tubing after a regulator; this is steadier, and ran the pressurized example a sixth faster.
    """

    def __init__(self, name, network, sensed, setpoint, droop, response_time, position):
        self.rate = 0.0
        self.setup()

    def evaluate_states(self):
        wanted = min(1.0, max(0.0, (self.setpoint.value - self.sensed.value) / self.droop.value))
        self.rate = (wanted - self.position.value) / self.response_time.value

    @property
    def dynamics(self):
        return [(self.position, self.rate)]


class Venturi(CavitatingVenturi):
    """FullFlow's cavitating venturi, with its noncavitating flow smoothed near zero as Restriction's is, and
    is_cavitating set (FullFlow 2.0.2 documents it but leaves it unset)."""

    def evaluate_states(self):
        super().evaluate_states()
        p1, p2 = self.upstream_pressure.value, self.downstream_pressure.value
        vapor = self.vapor_pressure.value
        cavitating = p1 > p2 and p2 <= vapor + self.pressure_recovery_factor.value * (p1 - vapor)
        self.is_cavitating.value = 1.0 if cavitating else 0.0
        if not cavitating:
            area = self.noncavitating_discharge_coefficient.value * self.throat_area.value
            self.mass_flow.value = area * math.sqrt(2.0 * self.density.value) * _smooth_root(p1 - p2)


class Junction(Component):
    """A point between liquid parts: its pressure is whatever makes what flows in flow out (in kg/s, as FullFlow's
    Volume balances: dividing by the flows themselves would leave the solver no slope when one side is still zero)."""

    def __init__(self, name, network, pressure, inflows, outflows):
        self.residual = 0.0
        self.setup()

    def evaluate_states(self):
        self.residual = sum(flow.value for flow in self.inflows.value) - sum(flow.value for flow in self.outflows.value)

    @property
    def balances(self):
        return [(self.pressure, self.residual)]


class UllageTank(Component):
    """A liquid tank under a gas ullage whose heat transfer is an exponent.

    The ullage gas follows p = p0 (rho / rho0)^n, where n sets how much heat moves between gas and tank (1 isothermal,
    the gas's gamma none); of the pressurant flowing in, 1 / collapse_factor stays as gas. The solver iterates the
    pressure while FullFlow conserves the ullage's gas and the tank's liquid.
    """

    def __init__(
        self,
        name,
        network,
        pressure,
        volume,
        liquid_volume,
        liquid_density,
        initial_pressure,
        initial_gas_density,
        polytropic_exponent,
        collapse_factor,
        gas_in,
        gas_out,
        liquid_in,
        liquid_out,
        gas_mass=None,
    ):
        self.gas_rate = 0.0
        self.liquid_rate = 0.0
        self.setup()

    def gas_density(self) -> float:
        ratio = max(self.pressure.value, 1.0) / self.initial_pressure.value
        return self.initial_gas_density.value * ratio ** (1.0 / self.polytropic_exponent.value)

    def evaluate_states(self):
        ullage = max(self.volume.value - self.liquid_volume.value, 1e-9)
        self.gas_mass.value = self.gas_density() * ullage
        entering, leaving = split(self.gas_in.value, self.gas_out.value)
        self.gas_rate = entering / self.collapse_factor.value - leaving
        liquid_in = sum(flow.value for flow in self.liquid_in.value)
        liquid_out = sum(flow.value for flow in self.liquid_out.value)
        self.liquid_rate = (liquid_in - liquid_out) / self.liquid_density.value

    @property
    def dynamics(self):
        return [(self.pressure, self.gas_mass, self.gas_rate), (self.liquid_volume, self.liquid_rate)]


class LiquidStore(Component):
    """A tank's liquid under an ullage whose gas FullFlow's Volume keeps (with the tank wall's heat): the ullage grows
    as liquid leaves. Its volume is a stored state, so FullFlow has its history for the gas's boundary work."""

    def __init__(self, name, network, ullage_volume, tank_volume, density, liquid_in, liquid_out, liquid_volume=None):
        self.rate = 0.0
        self.setup()

    def evaluate_states(self):
        net_out = sum(flow.value for flow in self.liquid_out.value) - sum(flow.value for flow in self.liquid_in.value)
        self.rate = net_out / self.density.value
        self.liquid_volume.value = self.tank_volume.value - self.ullage_volume.value

    @property
    def dynamics(self):
        return [(self.ullage_volume, self.rate)]


class Anchor(Sensor):
    """FullFlow's Sensor anchoring a knob to a channel, reading the channel as a straight line between its samples
    (times, values) rather than holding the last one, over [start, end]; and off for a step shorter than shortest.

    FullFlow lands a step on each change of a valve's command, and retries a hard one in halves, so some steps are a
    sliver of the rest: anchored over one, a knob that acts through what a tank holds would make up a whole step's
    difference from the data at once, far past anything real. Off, FullFlow holds the knob where it was."""

    def __init__(self, name, network, reading, variable, data, times, values, start, end, shortest):
        super().__init__(name, network, reading=reading, variable=variable, data=data)
        self._times, self._values = times, values
        self._span, self._shortest = (start, end), shortest
        self._solved = (math.nan, math.nan)  # the step solved last: its time, and the target it was solved to

    def target_value(self, time_value=None):
        t = float(self.network.time.value if time_value is None else time_value)
        try:
            previous = float(self.network.time.previous)
        except ValueError:  # no step taken yet: the run's start, which nothing is solved at
            return math.nan
        if t == previous:  # the step to t is done, and read for its results: as it was solved
            return self._solved[1] if self._solved[0] == t else math.nan
        if t - previous < self._shortest or not self._span[0] <= t <= self._span[1]:
            target = math.nan
        else:
            target = float(np.interp(t, self._times, self._values))
        self._solved = (t, target)
        return target


class Recorder(Component):
    """Reports the values a run's results need (nodes' pressures, edges' flows), each under a name of its own
    (part.output), so they can be read back by part and output; and tells how far the run has got.

    One component for them all: FullFlow evaluates every component many times in each time step, so a component for
    each value would cost more than some of the physics.
    """

    def __init__(self, name, network):
        self._readings = {}
        self._progress = None
        self.setup()

    def add(self, key, state) -> None:
        self._readings[key] = state

    def on_progress(self, progress) -> None:
        self._progress = progress

    @property
    def export_attributes(self):
        return self._readings

    def evaluate_states(self):
        if self._progress is not None:
            self._progress(float(self.network.time.value))
