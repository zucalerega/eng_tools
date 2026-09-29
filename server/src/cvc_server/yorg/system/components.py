"""FullFlow components of Yorg's own, where FullFlow's catalog has nothing that fits (they follow FullFlow's recipe for
custom components: constructor arguments become states in setup(), evaluate_states() computes, and balances or
dynamics give the solver its equations). Imported only by the runner's process.

Flows through restrictions go as the square root of the pressure drop, which has no slope at zero: a node between a
closed valve and an open orifice then takes the solver many tries to settle. Below SMOOTH_DP the flow turns linear in
the pressure drop instead, which changes nothing at the pressure drops a test runs at.
"""

import math

from fullflow import Component

SMOOTH_DP = 500.0  # Pa (0.07 psi)


class Restriction(Component):
    """A liquid orifice or valve: mdot = CdA * opening * sqrt(2 rho dP), positive from upstream to downstream."""

    def __init__(
        self, name, network, upstream_pressure, downstream_pressure, density, cda, opening=1.0, mass_flow=None
    ):
        self.setup()

    def evaluate_states(self):
        dp = self.upstream_pressure.value - self.downstream_pressure.value
        area = self.cda.value * min(1.0, max(0.0, self.opening.value))
        self.mass_flow.value = (
            area * math.sqrt(2.0 * self.density.value) * dp / (dp * dp + SMOOTH_DP * SMOOTH_DP) ** 0.25
        )


class GasRestriction(Component):
    """An ideal-gas orifice or valve, choked or not, from a supply's total pressure and temperature. With check, no
    flow goes back into the supply."""

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
        mass_flow=None,
        choked=None,
    ):
        self.setup()

    def evaluate_states(self):
        p1, p2 = self.upstream_pressure.value, self.downstream_pressure.value
        high, low = max(p1, p2), max(min(p1, p2), 1.0)
        gamma, gas_constant = self.specific_heat_ratio.value, self.gas_constant.value
        area = self.cda.value * min(1.0, max(0.0, self.opening.value))
        ratio = low / high
        critical = (2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0))
        if ratio <= critical:
            flow_function = math.sqrt(gamma) * (2.0 / (gamma + 1.0)) ** ((gamma + 1.0) / (2.0 * (gamma - 1.0)))
        else:
            flow_function = math.sqrt(
                2.0 * gamma / (gamma - 1.0) * (ratio ** (2.0 / gamma) - ratio ** ((gamma + 1.0) / gamma))
            )
        mass_flow = area * high * flow_function / math.sqrt(gas_constant * self.upstream_temperature.value)
        dp = p1 - p2
        # Near equal pressures the flow goes as sqrt(dP): this turns it linear there, as Restriction does.
        mass_flow *= math.sqrt(abs(dp)) / (dp * dp + SMOOTH_DP * SMOOTH_DP) ** 0.25
        if dp < 0.0:
            mass_flow = 0.0 if self.check.value else -mass_flow
        self.mass_flow.value = mass_flow
        self.choked.value = ratio <= critical


class Junction(Component):
    """A point between parts: its pressure is whatever makes what flows in flow out. The residual is relative to the
    flows, so a junction balances as closely at 0.1 kg/s as at 10."""

    def __init__(self, name, network, pressure, inflows, outflows):
        self.residual = 0.0
        self.setup()

    def evaluate_states(self):
        flows_in = [flow.value for flow in self.inflows.value]
        flows_out = [flow.value for flow in self.outflows.value]
        scale = max(sum(abs(flow) for flow in flows_in + flows_out), 1e-3)
        self.residual = (sum(flows_in) - sum(flows_out)) / scale

    @property
    def balances(self):
        return [(self.pressure, self.residual)]


class UllageTank(Component):
    """A liquid tank under a gas ullage.

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
        liquid_in,
        liquid_out,
        gas_mass=None,
    ):
        self.gas_rate = 0.0
        self.liquid_rate = 0.0
        self.setup()

    def evaluate_states(self):
        ullage = max(self.volume.value - self.liquid_volume.value, 1e-9)
        ratio = max(self.pressure.value, 1.0) / self.initial_pressure.value
        density = self.initial_gas_density.value * ratio ** (1.0 / self.polytropic_exponent.value)
        self.gas_mass.value = density * ullage
        self.gas_rate = sum(flow.value for flow in self.gas_in.value) / self.collapse_factor.value
        liquid_in = sum(flow.value for flow in self.liquid_in.value)
        liquid_out = sum(flow.value for flow in self.liquid_out.value)
        self.liquid_rate = (liquid_in - liquid_out) / self.liquid_density.value

    @property
    def dynamics(self):
        return [(self.pressure, self.gas_mass, self.gas_rate), (self.liquid_volume, self.liquid_rate)]


class Probe(Component):
    """Reports one value (a node's pressure, an edge's flow) under a name of its own, so a run's results can be read
    back by part and output."""

    def __init__(self, name, network, reading):
        self.setup()

    def evaluate_states(self):
        pass
