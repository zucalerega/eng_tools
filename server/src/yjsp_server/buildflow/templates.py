"""What a new program starts from: the milestones every program starts with, and the starting layouts admins pick from,
a rocket's, a hopper's, or a test stand's: its drawing, its subsystems, and its components, placed on it. They're only a
start: admins change all of it on the program's layout page."""

from dataclasses import dataclass
from typing import Any

from .models import Phase

# Every program's milestones, in order in each phase: (phase, name, what it stands for, a review). The design reviews and
# the test and flight reviews are the team's; the work between them is what the build and test phases are for. DCR and
# QRR are said differently from team to team, so what they stand for is left for admins to say.
MILESTONES: tuple[tuple[Phase, str, str, bool], ...] = (
    (Phase.DESIGN, "DCR", "", True),
    (Phase.DESIGN, "CoDR", "Conceptual Design Review", True),
    (Phase.DESIGN, "PDR", "Preliminary Design Review", True),
    (Phase.DESIGN, "CDR", "Critical Design Review", True),
    (Phase.BUILD, "Drawings", "Drawings released for manufacturing", False),
    (Phase.BUILD, "Procurement", "Stock and bought parts in hand", False),
    (Phase.BUILD, "Manufacturing", "Made", False),
    (Phase.BUILD, "Inspection", "Checked against its drawings", False),
    (Phase.TEST, "TRR", "Test Readiness Review", True),
    (Phase.TEST, "Testing", "Tested, its data in Yorg", False),
    (Phase.TEST, "QRR", "", True),
    (Phase.LAUNCH, "Integration", "On the vehicle", False),
    (Phase.LAUNCH, "FRR", "Flight Readiness Review", True),
    (Phase.LAUNCH, "Flight", "Flown", False),
)


@dataclass(frozen=True)
class Part:
    """A component a layout starts with: its subsystem, its name, whether it's bought, and where it's drawn (None: not
    on the drawing, as a test stand's DAQ)."""

    subsystem: str
    name: str
    x: float | None = None
    y: float | None = None
    bought: bool = False


@dataclass(frozen=True)
class Layout:
    profile: dict[str, Any]
    subsystems: tuple[str, ...]
    parts: tuple[Part, ...]


def _section(kind: str, length: float, diameter: float, label: str, **more: Any) -> dict[str, Any]:
    return {"kind": kind, "length": length, "diameter": diameter, "label": label, **more}


# A liquid bipropellant rocket, in inches: its engine, thrust section and fins, the LOX tank, the fuel tank, its
# pressurant, avionics, recovery, and the nose, from the aft end.
ROCKET = Layout(
    profile={
        "sections": [
            _section("engine", 12, 7, "Engine"),
            _section("body", 30, 8, "Thrust section", fins=True),
            _section("tank", 48, 8, "LOX tank"),
            _section("coupler", 12, 8, "Intertank"),
            _section("tank", 40, 8, "Fuel tank"),
            _section("tank", 22, 8, "Pressurant tank"),
            _section("body", 18, 8, "Avionics bay"),
            _section("body", 24, 8, "Recovery bay"),
            _section("nose", 32, 8, "Nose cone"),
        ],
        "stand": False,
    },
    subsystems=("Propulsion", "Fluids", "Structures", "Avionics", "Recovery"),
    parts=(
        Part("Propulsion", "Thrust chamber", 6, 0),
        Part("Propulsion", "Injector", 13, 0),
        Part("Propulsion", "Igniter", 15, -2),
        Part("Fluids", "Main oxidizer valve", 30, 1.8, bought=True),
        Part("Fluids", "Main fuel valve", 36, -1.8, bought=True),
        Part("Fluids", "LOX tank", 66, 0),
        Part("Fluids", "LOX vent valve", 86, 2.2, bought=True),
        Part("Fluids", "Fuel tank", 122, 0),
        Part("Fluids", "Pressurant tank", 153, 0, bought=True),
        Part("Fluids", "Pressure regulator", 144, -2.2, bought=True),
        Part("Structures", "Thrust structure", 22, 0),
        Part("Structures", "Fins", 33, 5.6),
        Part("Structures", "Intertank", 96, 0),
        Part("Structures", "Nose cone", 220, 0),
        Part("Avionics", "Flight computer", 173, 0),
        Part("Avionics", "Telemetry radio", 177, 2.2, bought=True),
        Part("Avionics", "Batteries", 169, -2.2, bought=True),
        Part("Recovery", "Drogue parachute", 190, 1.8),
        Part("Recovery", "Main parachute", 198, -1.8),
    ),
)

# A hopper: an engine on landing legs, under its tanks and avionics.
HOPPER = Layout(
    profile={
        "sections": [
            _section("engine", 10, 8, "Engine"),
            _section("body", 16, 16, "Engine bay", legs=True),
            _section("tank", 28, 16, "LOX tank"),
            _section("tank", 24, 16, "Fuel tank"),
            _section("tank", 14, 16, "Pressurant tank"),
            _section("body", 12, 16, "Avionics"),
        ],
        "stand": False,
    },
    subsystems=("Propulsion", "Fluids", "Structures", "GNC"),
    parts=(
        Part("Propulsion", "Engine", 5, 0),
        Part("Propulsion", "Throttle valve", 18, 3.5, bought=True),
        Part("Fluids", "LOX tank", 40, 0),
        Part("Fluids", "Fuel tank", 66, 0),
        Part("Fluids", "Pressurant tank", 85, 0, bought=True),
        Part("Fluids", "Pressure regulator", 80, 4.5, bought=True),
        Part("Structures", "Landing legs", 12, -10),
        Part("Structures", "Engine mount", 20, -3.5),
        Part("GNC", "Flight computer", 98, 0),
        Part("GNC", "IMU", 98, 4, bought=True),
        Part("GNC", "Thrust vector control", 14, 3),
    ),
)

# A static test stand: an engine on its thrust mount, fed from its tanks, on the stand's frame; its DAQ and controls
# aren't on the drawing.
STAND = Layout(
    profile={
        "sections": [
            _section("engine", 12, 7, "Engine"),
            _section("body", 14, 9, "Thrust mount"),
            _section("tank", 36, 10, "Oxidizer tank"),
            _section("coupler", 8, 10, "Manifold"),
            _section("tank", 30, 10, "Fuel tank"),
            _section("tank", 20, 10, "Pressurant"),
        ],
        "stand": True,
    },
    subsystems=("Engine", "Feed system", "Structure", "DAQ and controls"),
    parts=(
        Part("Engine", "Thrust chamber", 6, 0),
        Part("Engine", "Injector", 12.5, 0),
        Part("Engine", "Igniter", 13, 2.2),
        Part("Feed system", "Oxidizer tank", 44, 0),
        Part("Feed system", "Main valves", 66, 2.4, bought=True),
        Part("Feed system", "Fuel tank", 85, 0),
        Part("Feed system", "Pressurant bottles", 110, 0, bought=True),
        Part("Feed system", "Pressure regulator", 104, -3, bought=True),
        Part("Structure", "Thrust mount", 19, 0),
        Part("Structure", "Load cell", 19, -3.5, bought=True),
        Part("Structure", "Stand frame", 60, -9),
        Part("DAQ and controls", "DAQ", bought=True),
        Part("DAQ and controls", "Control box"),
        Part("DAQ and controls", "Sequencer software"),
    ),
)

BLANK = Layout(profile={"sections": [], "stand": False}, subsystems=(), parts=())

LAYOUTS = {"rocket": ROCKET, "hopper": HOPPER, "stand": STAND, "blank": BLANK}
