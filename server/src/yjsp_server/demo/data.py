"""The demo's test data (seed.py): CSV files as a team's DAQ would write them, made from a few lines of physics and some
noise. A hot fire of a small pressure-fed LOX/RP-1 engine, water cold flows, and a tank's proof test, each named after
the tags on the demo's P&IDs (diagrams/), so Piper shows their values on the drawings. Nothing here is anyone's real
engine or test: the numbers are only plausible.

Each file is the same every time it's made (a seeded random number generator), so the demo is too.
"""

import io
import math
import random
from collections.abc import Callable
from dataclasses import dataclass

OPEN, CLOSED = "OPEN", "CLOSED"


@dataclass(frozen=True)
class Channel:
    name: str  # as the DAQ names it: the part's tag on the P&ID, where it has one
    unit: str  # in the column's name, as Yorg reads it ("PT-4 (psi)"); "" for a valve's state or the events
    value: Callable[[float], float | str]  # its value at a time, in seconds from the file's start
    digits: int = 1


def _csv(rate: float, duration: float, channels: list[Channel], events: dict[float, str]) -> bytes:
    """The file: a column of times, then each channel's, and the events (mostly empty, as a sequencer logs them)."""
    out = io.StringIO()
    names = ["time (s)"] + [f"{c.name} ({c.unit})" if c.unit else c.name for c in channels] + ["Event"]
    out.write(",".join(names) + "\n")
    steps = round(duration * rate)
    pending = sorted(events.items())
    for step in range(steps + 1):
        t = step / rate
        row = [f"{t:.3f}"]
        for channel in channels:
            value = channel.value(t)
            row.append(value if isinstance(value, str) else f"{value:.{channel.digits}f}")
        event = ""
        while pending and pending[0][0] <= t + 1e-9:
            event = pending.pop(0)[1]
        row.append(event)
        out.write(",".join(row) + "\n")
    return out.getvalue().encode()


def _rise(t: float, start: float, tau: float) -> float:
    """0 before start, then up to 1 as a first-order lag with time constant tau."""
    return 0.0 if t < start else 1.0 - math.exp(-(t - start) / tau)


def _window(t: float, start: float, end: float, rise: float, fall: float) -> float:
    """0, up to 1 from start (time constant rise), and back down from end (fall)."""
    if t < start:
        return 0.0
    up = 1.0 - math.exp(-(t - start) / rise)
    if t < end:
        return up
    at_end = 1.0 - math.exp(-(end - start) / rise)
    return at_end * math.exp(-(t - end) / fall)


def _state(t: float, opened: float, closed: float) -> str:
    return OPEN if opened <= t < closed else CLOSED


def _noise(seed: int, size: float) -> Callable[[], float]:
    rng = random.Random(seed)
    return lambda: rng.gauss(0.0, size)


def hot_fire(*, seed: int, burn: float, chamber_psi: float, thrust_lbf: float, mixture: float) -> bytes:
    """A hot fire on the stand: pressurant on (BV-1), the vent shut (SV-1), the tanks pressed through the regulator,
    the main valves opened (PV-1, fuel, a beat before PV-2, LOX), the burn, and shutdown. 200 samples a second."""
    t_press, t_vent, t0 = 4.0, 3.5, 12.0  # pressurant on, vent closed, ignition
    t_off = t0 + burn
    regulated = 500.0
    wobble = _noise(seed, 1.0)
    jitter = _noise(seed + 1, 1.0)
    tick = _noise(seed + 2, 1.0)
    drift = _noise(seed + 3, 1.0)
    mdot = thrust_lbf / 240.0  # lbm/s at an Isp of about 240 s
    ox_flow, fuel_flow = mdot * mixture / (1 + mixture), mdot / (1 + mixture)

    def burning(t: float) -> float:
        return _window(t, t0 + 0.05, t_off, 0.08, 0.12)

    def press_line(t: float) -> float:
        draw = 25.0 * _window(t, t0, t_off, 0.3, 0.6)  # the regulator droops while the engine draws
        return regulated * _rise(t, t_press, 0.35) - draw + 2.0 * wobble()

    def tank(blowdown: float) -> Callable[[float], float]:
        def pressure(t: float) -> float:
            pressed = (regulated - 15.0) * _rise(t, t_press + 0.2, 0.9)
            return pressed - blowdown * _window(t, t0, t_off, 0.4, 1.5) + 1.5 * jitter()

        return pressure

    def chamber(t: float) -> float:
        if t < t0 or t > t_off + 1.5:
            return 0.4 * tick()
        rough = 1 + 0.015 * math.sin(2 * math.pi * 7.3 * t) + 0.01 * drift()
        spike = 0.35 * math.exp(-((t - t0 - 0.06) ** 2) / 0.0008)  # the light-off
        return chamber_psi * (burning(t) * rough + spike * burning(t))

    def thrust(t: float) -> float:
        ring = 0.04 * math.exp(-max(t - t0, 0) / 0.25) * math.sin(2 * math.pi * 18 * max(t - t0, 0))
        return thrust_lbf * burning(t) * (1 + ring + 0.008 * drift()) + 1.5 * tick() + 0.1 * t / 30

    def flow(rate: float, lead: float) -> Callable[[float], float]:
        return lambda t: rate * _window(t, t0 - lead, t_off, 0.12, 0.2) + 0.004 * wobble()

    def nozzle(t: float) -> float:
        heat = 0.0 if t < t0 else min(t, t_off) - t0
        cool = 0.0 if t < t_off else t - t_off
        return 72 + 380 * (1 - math.exp(-heat / 2.5)) * math.exp(-cool / 30.0) + 0.5 * jitter()

    channels = [
        Channel("PT-1", "psi", press_line),
        Channel("PT-2", "psi", tank(40.0)),
        Channel("PT-3", "psi", tank(55.0)),
        Channel("PT-4", "psi", chamber),
        Channel("LC-1", "lbf", thrust),
        Channel("FM-OX", "lbm/s", flow(ox_flow, 0.0), 3),
        Channel("FM-FU", "lbm/s", flow(fuel_flow, 0.1), 3),
        Channel("TC-1", "degF", nozzle),
        Channel("BV-1", "", lambda t: _state(t, t_press, t_off + 2.0)),
        Channel("SV-1", "", lambda t: CLOSED if t_vent <= t < t_off + 2.5 else OPEN),
        Channel("PV-1", "", lambda t: _state(t, t0 - 0.1, t_off)),
        Channel("PV-2", "", lambda t: _state(t, t0, t_off)),
    ]
    events = {t_press: "PRESS", t0: "IGNITION", t_off: "SHUTDOWN", t_off + 2.5: "SAFE"}
    return _csv(200.0, t_off + 8.0, channels, events)


def cold_flow(*, seed: int, tank_psi: float, manifold_psi: float, flow_lbm: float, duration: float) -> bytes:
    """Water through the feed line and the injector, from the tank, pressed, then MOV-01 opened for a while: the cold
    flow P&ID's tags. 100 samples a second."""
    t_open = 5.0
    t_shut = t_open + duration
    noise = _noise(seed, 1.0)

    def flowing(t: float) -> float:
        return _window(t, t_open, t_shut, 0.15, 0.1)

    channels = [
        Channel("PT-TANK", "psi", lambda t: tank_psi - 18.0 * _window(t, t_open, t_shut, 0.8, 2.0) + 0.8 * noise()),
        Channel("PT-MANIFOLD", "psi", lambda t: manifold_psi * flowing(t) + 0.6 * noise()),
        Channel("FM-WATER", "lbm/s", lambda t: flow_lbm * flowing(t) + 0.005 * noise(), 3),
        Channel("MOV-01", "", lambda t: _state(t, t_open, t_shut)),
    ]
    return _csv(100.0, t_shut + 5.0, channels, {t_open: "OPEN MOV-01", t_shut: "CLOSE MOV-01"})


def proof_test(*, seed: int, meop_psi: float) -> bytes:
    """A tank's hydrostatic proof test: held at a quarter, a half, and its MEOP, then 1.5 times it for a minute, and
    let down. A sample a second."""
    noise = _noise(seed, 1.0)
    # When it starts to go to each level, as a fraction of MEOP: 12 s to get there, then held until the next.
    steps = [(0.0, 0.0), (30.0, 0.25), (90.0, 0.5), (150.0, 1.0), (240.0, 1.5), (300.0, 0.0)]

    def pressure(t: float) -> float:
        before, level, since = 0.0, 0.0, 0.0
        for at, to in steps:
            if at <= t:
                before, level, since = level, to, at
        ramp = min(1.0, (t - since) / 12.0)
        return meop_psi * (before + (level - before) * ramp) + 0.5 * noise()

    events = {30: "25% MEOP", 90: "50% MEOP", 150: "MEOP", 240: "PROOF 1.5x", 300: "VENT"}
    return _csv(1.0, 360.0, [Channel("PT-TANK", "psi", pressure)], events)
