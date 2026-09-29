"""What a system model is made of: its parts, each part's settings (in SI units), what each can be linked to in a
test's data, and what a run reports for it. The web app draws its P&ID and forms from this; network.py builds the
simulation from the same list, so the two can't drift apart.
"""

from dataclasses import asdict, dataclass
from typing import Any

PSI = 6894.757
ATMOSPHERE = 101325.0

# ThermoProp's names (Fluid for liquids, IdealGas for pressurants). "Custom" is a liquid of a density you give: IPA,
# Jet-A, or anything ThermoProp doesn't have.
LIQUIDS = ("Water", "Ethanol", "Methanol", "RP1", "Oxygen", "Nitrogen", "NitrousOxide", "Methane", "Custom")
GASES = ("Nitrogen", "Helium", "Air")


@dataclass(frozen=True)
class Setting:
    key: str
    label: str
    quantity: str  # pressure, temperature, length, diameter, area, volume, density, time, ratio, number, or choice
    default: float | str
    minimum: float | None = None
    maximum: float | None = None
    tunable: bool = False  # a knob to fit the model to what was measured
    choices: tuple[str, ...] = ()
    only_when: tuple[str, str] | None = None  # (setting, value): the setting only matters then
    help: str = ""


@dataclass(frozen=True)
class Link:
    key: str
    label: str
    quantity: str  # what the channel measures: pressure, temperature, mass_flow, or command
    role: str  # boundary: the model follows it; sensor: compared with the model; command: opens and closes a valve
    help: str = ""


@dataclass(frozen=True)
class Output:
    key: str
    label: str
    quantity: str


@dataclass(frozen=True)
class Part:
    type: str
    label: str
    kind: str  # node (a point with a pressure) or edge (a flow path from one node to another)
    phase: str  # liquid or gas: what flows through it, or what it holds
    help: str
    settings: tuple[Setting, ...] = ()
    links: tuple[Link, ...] = ()
    outputs: tuple[Output, ...] = ()


_ULLAGE = ("mode", "ullage")
_COMMAND = (
    Setting("opening_time", "Opening time", "time", 0.05, 0.001, 60.0, tunable=True, help="Fully closed to fully open"),
    Setting("closed_value", "Command when closed", "number", 0.0, help="The command channel's value when closed"),
    Setting("open_value", "Command when open", "number", 1.0, help="The command channel's value when fully open"),
    Setting("position", "Position without a command", "ratio", 1.0, 0.0, 1.0, help="0 closed, 1 open"),
)
_FLOW = Link("flow", "Flow meter", "mass_flow", "sensor")

PARTS: tuple[Part, ...] = (
    Part(
        "tank",
        "Tank",
        "node",
        "liquid",
        "A propellant tank. At a fixed pressure (a regulated tank, or one whose pressure you measured), or with a gas "
        "ullage whose pressure falls as the liquid drains and rises with pressurant from a press line.",
        settings=(
            Setting("fluid", "Liquid", "choice", "Water", choices=LIQUIDS),
            Setting("density", "Density", "density", 1000.0, 1.0, 30000.0, only_when=("fluid", "Custom")),
            Setting("temperature", "Liquid temperature", "temperature", 293.15, 1.0, 2000.0),
            Setting("mode", "Pressure", "choice", "fixed", choices=("fixed", "ullage")),
            Setting("pressure", "Pressure", "pressure", 300 * PSI, 0.0, 1e9, help="Ullage: at the start"),
            Setting("volume", "Tank volume", "volume", 0.02, 1e-6, 1000.0, only_when=_ULLAGE),
            Setting("liquid_volume", "Liquid at the start", "volume", 0.015, 0.0, 1000.0, only_when=_ULLAGE),
            Setting("gas", "Ullage gas", "choice", "Nitrogen", choices=GASES, only_when=_ULLAGE),
            Setting("gas_temperature", "Ullage temperature", "temperature", 293.15, 1.0, 2000.0, only_when=_ULLAGE),
            Setting(
                "polytropic_exponent",
                "Ullage exponent n",
                "ratio",
                1.2,
                1.0,
                1.7,
                tunable=True,
                only_when=_ULLAGE,
                help="Heat transfer: 1 isothermal, 1.4 (nitrogen) or 1.67 (helium) with none",
            ),
            Setting(
                "collapse_factor",
                "Collapse factor",
                "ratio",
                1.0,
                1.0,
                10.0,
                tunable=True,
                only_when=_ULLAGE,
                help="Pressurant that flows in, per what stays as gas: 1 when none cools or condenses away",
            ),
        ),
        links=(
            Link(
                "pressure",
                "Pressure",
                "pressure",
                "boundary",
                "Fixed: the tank's pressure follows it. Ullage: compared with the model, and its first value is the "
                "starting pressure.",
            ),
            Link(
                "temperature", "Liquid temperature", "temperature", "boundary", "Its average sets the liquid's density"
            ),
        ),
        outputs=(Output("pressure", "Pressure", "pressure"), Output("liquid_volume", "Liquid", "volume")),
    ),
    Part(
        "source",
        "Gas supply",
        "node",
        "gas",
        "Pressurant from a regulator or a bottle, at a fixed pressure or one you measured.",
        settings=(
            Setting("gas", "Gas", "choice", "Nitrogen", choices=GASES),
            Setting("pressure", "Pressure", "pressure", 350 * PSI, 0.0, 1e9),
            Setting("temperature", "Temperature", "temperature", 293.15, 1.0, 2000.0),
        ),
        links=(
            Link("pressure", "Pressure", "pressure", "boundary", "The supply's pressure follows it"),
            Link("temperature", "Temperature", "temperature", "boundary", "Its average is the gas's temperature"),
        ),
        outputs=(Output("pressure", "Pressure", "pressure"),),
    ),
    Part(
        "junction",
        "Junction",
        "node",
        "liquid",
        "A point in the lines between parts: a tee, a manifold, where a pressure transducer sits. Its pressure is "
        "whatever makes what flows in flow out.",
        links=(Link("pressure", "Pressure transducer", "pressure", "sensor"),),
        outputs=(Output("pressure", "Pressure", "pressure"),),
    ),
    Part(
        "outlet",
        "Outlet",
        "node",
        "liquid",
        "Where the liquid goes: the atmosphere, a chamber, a catch tank. At a fixed pressure or one you measured.",
        settings=(Setting("pressure", "Pressure", "pressure", ATMOSPHERE, 0.0, 1e9),),
        links=(
            Link("pressure", "Pressure", "pressure", "boundary", "The outlet's pressure follows it (chamber pressure)"),
        ),
        outputs=(Output("pressure", "Pressure", "pressure"),),
    ),
    Part(
        "line",
        "Line",
        "edge",
        "liquid",
        "Tubing: friction along it, fittings' losses, and the liquid's inertia.",
        settings=(
            Setting("length", "Length", "length", 1.0, 0.001, 1000.0),
            Setting("diameter", "Inner diameter", "diameter", 0.0127, 0.0001, 2.0),
            Setting("friction_factor", "Friction factor f", "ratio", 0.02, 0.0, 1.0, tunable=True, help="Darcy"),
            Setting(
                "loss_coefficient",
                "Fittings' K",
                "ratio",
                0.0,
                0.0,
                10000.0,
                tunable=True,
                help="Bends, tees, and fittings, added up",
            ),
        ),
        links=(_FLOW,),
        outputs=(Output("mass_flow", "Flow", "mass_flow"),),
    ),
    Part(
        "valve",
        "Valve",
        "edge",
        "liquid",
        "A valve that opens and closes as a command channel says (or stays at one position), over its opening time.",
        settings=(Setting("cda", "CdA when open", "area", 5e-5, 0.0, 1.0, tunable=True), *_COMMAND),
        links=(Link("command", "Command", "command", "command"), _FLOW),
        outputs=(Output("mass_flow", "Flow", "mass_flow"), Output("position", "Position", "ratio")),
    ),
    Part(
        "orifice",
        "Orifice",
        "edge",
        "liquid",
        "A fixed restriction: an injector, a metering orifice.",
        settings=(Setting("cda", "CdA", "area", 3e-5, 0.0, 1.0, tunable=True),),
        links=(_FLOW,),
        outputs=(Output("mass_flow", "Flow", "mass_flow"),),
    ),
    Part(
        "gas_line",
        "Press line",
        "edge",
        "gas",
        "Pressurant from a gas supply into a tank's ullage, through an orifice or a valve (choked or not).",
        settings=(
            Setting("cda", "CdA", "area", 2e-6, 0.0, 1.0, tunable=True),
            Setting("check", "Check valve", "choice", "yes", choices=("yes", "no"), help="Yes: no flow back"),
            *_COMMAND,
        ),
        links=(Link("command", "Command", "command", "command"), _FLOW),
        outputs=(Output("mass_flow", "Flow", "mass_flow"), Output("position", "Position", "ratio")),
    ),
)

BY_TYPE = {part.type: part for part in PARTS}


def settings_of(part_type: str, given: dict[str, Any]) -> dict[str, Any]:
    """A part's settings: what's given, with each missing one at its default."""
    return {setting.key: given.get(setting.key, setting.default) for setting in BY_TYPE[part_type].settings}


def as_json() -> dict[str, Any]:
    return {"parts": [asdict(part) for part in PARTS], "liquids": list(LIQUIDS), "gases": list(GASES)}
