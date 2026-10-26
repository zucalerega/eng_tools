"""What a system model is made of: its parts, each part's settings (in SI units), what each can be linked to in a
test's data, and what a run reports for it. The web app draws its P&ID and forms from this; script.py writes the
simulation from the same list, so the two can't drift apart.
"""

from dataclasses import asdict, dataclass
from typing import Any

PSI = 6894.757
ATMOSPHERE = 101325.0

# Liquids and gases as ThermoProp has them (script.py says which of its classes, by name). "Custom" is a liquid of a
# density you give: IPA, Jet-A, or anything ThermoProp doesn't have.
LIQUIDS = ("Water", "Ethanol", "Methanol", "RP1", "Oxygen", "Nitrogen", "NitrousOxide", "Methane", "Custom")
LIQUID_LABELS = tuple("RP-1" if liquid == "RP1" else liquid for liquid in LIQUIDS)
GASES = ("Nitrogen", "Helium", "Air")

# When a setting or link matters: (setting, value) pairs that must all hold. None of them: always.
Conditions = tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class Setting:
    key: str
    label: str
    # pressure (absolute, shown gauge or absolute), pressure_abs (always absolute), pressure_drop (a difference),
    # temperature, length, diameter, area, volume, density, mass, specific_heat, conductance, time, ratio, number,
    # or choice
    quantity: str
    default: float | str
    minimum: float | None = None
    maximum: float | None = None
    tunable: bool = False  # a knob to fit the model to what was measured
    choices: tuple[str, ...] = ()
    choice_labels: tuple[str, ...] = ()  # how each choice reads, if not as it is
    only_when: Conditions = ()
    help: str = ""


@dataclass(frozen=True)
class Link:
    key: str
    label: str
    quantity: str  # what the channel measures: pressure, temperature, mass_flow, or command
    # boundary: the model follows it; start: its value at the run's start starts the model, which it's then compared
    # with; sensor: compared with the model; command: opens and closes a valve
    role: str
    help: str = ""
    only_when: Conditions = ()
    start_when: Conditions | None = None  # a boundary that's a start instead, then: an ullage tank's pressure


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
    phase: str  # liquid, gas, or any: what flows through it, or what it holds
    help: str
    settings: tuple[Setting, ...] = ()
    links: tuple[Link, ...] = ()
    outputs: tuple[Output, ...] = ()


def in_words(label: str) -> str:
    """A label as it reads in a sentence: lowercase, but for symbols and names like CdA, hA, K, and n."""
    return " ".join(
        word if len(word) == 1 or any(letter.isupper() for letter in word[1:]) else word.lower()
        for word in label.split(" ")
    )


def applies(conditions: Conditions | None, settings: dict[str, Any]) -> bool:
    """Whether every condition holds for a part set up as settings (no conditions: yes)."""
    return conditions is not None and all(settings.get(key) == value for key, value in conditions)


_ULLAGE: Conditions = (("mode", "ullage"),)
_CUSTOM: Conditions = (("fluid", "Custom"),)
_WALL: Conditions = (("wall", "vessel"),)


def _wall(only_when: Conditions, mass: float, mass_help: str) -> tuple[Setting, ...]:
    """The wall around a gas, which trades heat with it: an ullage's tank, or a vessel like a COPV."""
    return (
        Setting("wall_mass", "Wall mass", "mass", mass, 0.001, 1e5, only_when=only_when, help=mass_help),
        Setting(
            "wall_specific_heat",
            "Wall specific heat",
            "specific_heat",
            900.0,
            1.0,
            1e5,
            only_when=only_when,
            help="Aluminum 900, steel 500, carbon fiber about 800 J/kg·K",
        ),
        Setting(
            "wall_temperature",
            "Wall temperature at the start",
            "temperature",
            293.15,
            1.0,
            2000.0,
            only_when=only_when,
        ),
        Setting(
            "heat_transfer",
            "Wall hA",
            "conductance",
            20.0,
            0.0,
            1e6,
            tunable=True,
            only_when=only_when,
            help="Heat transfer coefficient times the wall's area the gas touches: the more, the nearer the gas stays "
            "to the wall's temperature; 0, none moves",
        ),
    )


def _wall_link(only_when: Conditions) -> Link:
    return Link(
        "wall_temperature",
        "Wall temperature",
        "temperature",
        "start",
        "Its value at the start is the wall's, and it's compared with the model",
        only_when=only_when,
    )


def _gas_model(only_when: Conditions = ()) -> Setting:
    """A gas's properties, where it's held: real (ThermoProp's, at its pressure and temperature) or ideal."""
    return Setting(
        "gas_model",
        "Gas properties",
        "choice",
        "real",
        choices=("real", "ideal"),
        choice_labels=("Real (ThermoProp)", "Ideal"),
        only_when=only_when,
        help="Real: ThermoProp's, at the gas's pressure and temperature, as FullFlow models have them. Ideal: pV = mRT, "
        "which overstates a gas's mass at bottle pressures",
    )


_COMMAND = (
    Setting("opening_time", "Opening time", "time", 0.05, 0.001, 60.0, tunable=True, help="Fully closed to fully open"),
    Setting("closed_value", "Command when closed", "number", 0.0, help="The command channel's value when closed"),
    Setting("open_value", "Command when open", "number", 1.0, help="The command channel's value when fully open"),
    Setting("position", "Position without a command", "ratio", 1.0, 0.0, 1.0, help="0 closed, 1 open"),
)
_CHECK = Setting(
    "check",
    "Check valve",
    "choice",
    "yes",
    choices=("yes", "no"),
    choice_labels=("Yes: no flow back", "No: flows either way"),
)
_FLOW = Link("flow", "Flow meter", "mass_flow", "sensor")
_MASS_FLOW = Output("mass_flow", "Flow", "mass_flow")

PARTS: tuple[Part, ...] = (
    Part(
        "tank",
        "Tank",
        "node",
        "liquid",
        "A propellant tank. At a fixed pressure (a regulated tank, or one whose pressure you measured), or with a gas "
        "ullage whose pressure falls as the liquid drains, rises with pressurant from a gas valve or regulator, and "
        "falls through a vent.",
        settings=(
            Setting("fluid", "Liquid", "choice", "Water", choices=LIQUIDS, choice_labels=LIQUID_LABELS),
            Setting("density", "Density", "density", 1000.0, 1.0, 30000.0, only_when=_CUSTOM),
            Setting(
                "vapor_pressure",
                "Vapor pressure",
                "pressure_abs",
                5000.0,
                0.0,
                1e8,
                only_when=_CUSTOM,
                help="Where a cavitating venturi chokes",
            ),
            Setting(
                "temperature",
                "Liquid temperature",
                "temperature",
                293.15,
                1.0,
                2000.0,
                help="Sets its density and vapor pressure",
            ),
            Setting(
                "mode",
                "Pressurized by",
                "choice",
                "fixed",
                choices=("fixed", "ullage"),
                choice_labels=("A fixed pressure", "A gas ullage"),
            ),
            Setting("pressure", "Pressure", "pressure", 300 * PSI, 0.0, 1e9, help="Ullage: at the start"),
            Setting("volume", "Tank volume", "volume", 0.02, 1e-6, 1000.0, only_when=_ULLAGE),
            Setting("liquid_volume", "Liquid at the start", "volume", 0.015, 0.0, 1000.0, only_when=_ULLAGE),
            Setting("gas", "Ullage gas", "choice", "Nitrogen", choices=GASES, only_when=_ULLAGE),
            _gas_model(_ULLAGE),
            Setting(
                "gas_temperature",
                "Ullage temperature at the start",
                "temperature",
                293.15,
                1.0,
                2000.0,
                only_when=_ULLAGE,
            ),
            *_wall(_ULLAGE, 5.0, "Of the tank wall around the ullage"),
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
                "Fixed: the tank's pressure follows it. Ullage: its value at the start is the ullage's, and it's "
                "compared with the model.",
                start_when=_ULLAGE,
            ),
            Link(
                "temperature",
                "Liquid temperature",
                "temperature",
                "boundary",
                "The liquid's density and vapor pressure follow it",
            ),
            Link(
                "gas_temperature",
                "Ullage temperature",
                "temperature",
                "start",
                "Its value at the start is the ullage gas's, and it's compared with the model",
                only_when=_ULLAGE,
            ),
            _wall_link(_ULLAGE),
        ),
        outputs=(
            Output("pressure", "Pressure", "pressure"),
            Output("liquid_volume", "Liquid", "volume"),
            Output("gas_temperature", "Ullage temperature", "temperature"),
            Output("wall_temperature", "Wall temperature", "temperature"),
        ),
    ),
    Part(
        "source",
        "Gas supply",
        "node",
        "gas",
        "Pressurant from a bottle or a facility line, at a fixed pressure or one you measured.",
        settings=(
            Setting("gas", "Gas", "choice", "Nitrogen", choices=GASES),
            _gas_model(),
            Setting("pressure", "Pressure", "pressure", 2000 * PSI, 0.0, 1e9),
            Setting("temperature", "Temperature", "temperature", 293.15, 1.0, 2000.0),
        ),
        links=(
            Link("pressure", "Pressure", "pressure", "boundary", "The supply's pressure follows it"),
            Link("temperature", "Temperature", "temperature", "boundary", "The gas's temperature follows it"),
        ),
        outputs=(Output("pressure", "Pressure", "pressure"),),
    ),
    Part(
        "junction",
        "Junction",
        "node",
        "liquid",
        "A point in the liquid lines between parts: a tee, a manifold, where a pressure transducer sits. Its pressure "
        "is whatever makes what flows in flow out.",
        links=(Link("pressure", "Pressure transducer", "pressure", "sensor"),),
        outputs=(Output("pressure", "Pressure", "pressure"),),
    ),
    Part(
        "gas_junction",
        "Gas junction",
        "node",
        "gas",
        "A point in the gas lines: between a regulator and a valve, a press manifold, where a pressure transducer "
        "sits. It holds the gas in the tubing around it, or in a vessel (a COPV, a bottle) whose wall warms it as it "
        "blows down.",
        settings=(
            Setting(
                "wall",
                "Holds its gas in",
                "choice",
                "tubing",
                choices=("tubing", "vessel"),
                choice_labels=("Tubing: no heat moves", "A vessel, with a wall that trades heat"),
                help="A vessel's wall (a COPV's, a bottle's) keeps its gas warmer than it would be as it blows down",
            ),
            Setting(
                "volume",
                "Volume",
                "volume",
                0.0002,
                1e-8,
                10.0,
                help="The tubing's (1 m of 1/2 in tube: 0.1 L), or the vessel's",
            ),
            Setting("pressure", "Pressure at the start", "pressure", ATMOSPHERE, 0.0, 1e9),
            Setting("temperature", "Temperature at the start", "temperature", 293.15, 1.0, 2000.0),
            *_wall(_WALL, 10.0, "Of the vessel: its liner and overwrap"),
        ),
        links=(
            Link(
                "pressure",
                "Pressure transducer",
                "pressure",
                "start",
                "Its value at the start is the junction's, and it's compared with the model",
            ),
            Link(
                "temperature",
                "Temperature",
                "temperature",
                "start",
                "Its value at the start is the gas's, and it's compared with the model",
            ),
            _wall_link(_WALL),
        ),
        outputs=(
            Output("pressure", "Pressure", "pressure"),
            Output("temperature", "Temperature", "temperature"),
            Output("wall_temperature", "Wall temperature", "temperature"),
        ),
    ),
    Part(
        "outlet",
        "Outlet",
        "node",
        "any",
        "Where the flow goes: the atmosphere, a chamber, a catch tank, a vent stack. At a fixed pressure or one you "
        "measured.",
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
        outputs=(_MASS_FLOW,),
    ),
    Part(
        "valve",
        "Valve",
        "edge",
        "liquid",
        "A valve that opens and closes as a command channel says (or stays at one position), over its opening time.",
        settings=(Setting("cda", "CdA when open", "area", 5e-5, 0.0, 1.0, tunable=True), *_COMMAND),
        links=(Link("command", "Command", "command", "command"), _FLOW),
        outputs=(_MASS_FLOW, Output("position", "Position", "ratio")),
    ),
    Part(
        "orifice",
        "Orifice",
        "edge",
        "liquid",
        "A fixed restriction: an injector, a metering orifice.",
        settings=(Setting("cda", "CdA", "area", 3e-5, 0.0, 1.0, tunable=True),),
        links=(_FLOW,),
        outputs=(_MASS_FLOW,),
    ),
    Part(
        "venturi",
        "Cavitating venturi",
        "edge",
        "liquid",
        "A venturi whose throat cavitates once the pressure after it falls far enough: then its flow is set by the "
        "pressure before it and the liquid's vapor pressure alone.",
        settings=(
            Setting("cda", "Throat CdA", "area", 2e-5, 0.0, 1.0, tunable=True, help="Cavitating: Cd times throat area"),
            Setting(
                "recovery",
                "Pressure recovery",
                "ratio",
                0.85,
                0.05,
                0.99,
                tunable=True,
                help="It cavitates while the pressure after it is below the vapor pressure plus this share of the rest "
                "of the pressure before it: 0.8 to 0.9 for most venturis",
            ),
        ),
        links=(_FLOW,),
        outputs=(_MASS_FLOW, Output("cavitating", "Cavitating", "ratio")),
    ),
    Part(
        "gas_valve",
        "Gas valve",
        "edge",
        "gas",
        "A valve in the gas lines, choked or not: a press valve into a tank, a vent out of one. It opens and closes as "
        "a command channel says (or stays at one position), over its opening time.",
        settings=(Setting("cda", "CdA when open", "area", 1e-5, 0.0, 1.0, tunable=True), _CHECK, *_COMMAND),
        links=(Link("command", "Command", "command", "command"), _FLOW),
        outputs=(_MASS_FLOW, Output("position", "Position", "ratio")),
    ),
    Part(
        "gas_orifice",
        "Gas orifice",
        "edge",
        "gas",
        "A fixed restriction in the gas lines, choked or not: a metering orifice, a bleed.",
        settings=(Setting("cda", "CdA", "area", 1e-5, 0.0, 1.0, tunable=True),),
        links=(_FLOW,),
        outputs=(_MASS_FLOW,),
    ),
    Part(
        "regulator",
        "Regulator",
        "edge",
        "gas",
        "A pressure regulator: it opens as the pressure where it flows to falls below its set pressure, fully open "
        "at its droop below it, and closes above it. No flow goes back through it.",
        settings=(
            Setting(
                "setpoint",
                "Set pressure",
                "pressure",
                300 * PSI + ATMOSPHERE,
                0.0,
                1e9,
                tunable=True,
                help="Where it closes (lock-up)",
            ),
            Setting(
                "droop",
                "Droop",
                "pressure_drop",
                20 * PSI,
                1.0,
                1e8,
                tunable=True,
                help="How far below its set pressure it's fully open",
            ),
            Setting("cda", "CdA fully open", "area", 1e-5, 0.0, 1.0, tunable=True),
        ),
        links=(_FLOW,),
        outputs=(_MASS_FLOW, Output("position", "Opening", "ratio")),
    ),
)

BY_TYPE = {part.type: part for part in PARTS}


def settings_of(part_type: str, given: dict[str, Any]) -> dict[str, Any]:
    """A part's settings: what's given, with each missing one at its default."""
    return {setting.key: given.get(setting.key, setting.default) for setting in BY_TYPE[part_type].settings}


def link_role(link: Link, settings: dict[str, Any]) -> str:
    """What a link does for a part set up as settings: an ullage tank's pressure starts the model, where a fixed
    tank's is followed."""
    return "start" if applies(link.start_when, settings) else link.role


def output_of(link: Link) -> str:
    """The output a link's channel is compared with: an edge's flow, or the node's value of the link's name."""
    return "mass_flow" if link.quantity == "mass_flow" else link.key


def compared(link: Link, settings: dict[str, Any]) -> bool:
    """Whether a link's channel is compared with the model (and fitted to)."""
    return applies(link.only_when, settings) and link_role(link, settings) in ("start", "sensor")


def as_json() -> dict[str, Any]:
    return {"parts": [asdict(part) for part in PARTS], "liquids": list(LIQUIDS), "gases": list(GASES)}
