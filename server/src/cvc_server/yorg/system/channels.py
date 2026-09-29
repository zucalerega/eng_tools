"""A run's inputs: the channels its model follows (pressures, temperatures, valve commands), cut to the run's window
and put in SI units, as network.py expects them.

A channel's unit comes from its file (PT-1 (psig)); one without a unit is read in the units the model is shown in.
Plain psi and bar are gauge or absolute as the model's pressures are.
"""

import re
import sys
from array import array
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from pathlib import Path

from ...errors import CvcError
from .catalog import ATMOSPHERE, PSI

_PRESSURE = {
    "pa": 1.0,
    "kpa": 1e3,
    "mpa": 1e6,
    "bar": 1e5,
    "mbar": 100.0,
    "psi": PSI,
    "ksi": 1000 * PSI,
    "atm": ATMOSPHERE,
    "torr": 133.322,
    "mmhg": 133.322,
    "inhg": 3386.39,
}
_MASS_FLOW = {
    "kg/s": 1.0,
    "g/s": 1e-3,
    "kg/min": 1 / 60,
    "lb/s": 0.45359237,
    "lbm/s": 0.45359237,
    "lbs/s": 0.45359237,
    "lb/min": 0.45359237 / 60,
    "lbm/min": 0.45359237 / 60,
}


class NoSuchChannel(CvcError):
    status = 422
    code = "no_channel"


@dataclass(frozen=True)
class Reading:
    """How to read channels without a unit: the units the model is shown in."""

    pressure: str = "psi"
    temperature: str = "F"
    mass_flow: str = "lbm/s"
    gauge: bool = True
    ambient: float = ATMOSPHERE


def _key(unit: str) -> str:
    return re.sub(r"[\s°º]|deg", "", unit.lower())


def to_si(quantity: str, unit: str, values: array, reading: Reading) -> array:
    """values, in unit, as SI (Pa absolute, K, kg/s); commands stay as they are."""
    key = _key(unit)
    if quantity == "pressure":
        gauge = reading.gauge
        if key.endswith(("g", "a")) and key[:-1] in _PRESSURE:
            gauge, key = key.endswith("g"), key[:-1]  # psig, psia, barg, bara, kpag...
        if key not in _PRESSURE:
            key, gauge = _key(reading.pressure), reading.gauge
        scale, offset = _PRESSURE.get(key, PSI), reading.ambient if gauge else 0.0
        return array("d", (value * scale + offset for value in values))
    if quantity == "temperature":
        key = key if key in ("k", "c", "f", "r") else _key(reading.temperature)
        convert = {
            "k": lambda value: value,
            "c": lambda value: value + 273.15,
            "f": lambda value: (value - 32.0) * 5 / 9 + 273.15,
            "r": lambda value: value * 5 / 9,
        }.get(key, lambda value: value)
        return array("d", (convert(value) for value in values))
    if quantity == "mass_flow":
        scale = _MASS_FLOW.get(key, _MASS_FLOW.get(_key(reading.mass_flow), 1.0))
        return array("d", (value * scale for value in values))
    return values


def _floats(path: Path) -> array:
    values = array("d")
    with path.open("rb") as file:
        values.frombytes(file.read())
    if sys.byteorder != "little":
        values.byteswap()
    return values


def window(times: array, values: array, start: float, end: float) -> tuple[array, array]:
    """The samples from the last one before start to the first one after end, so the window's edges have values."""
    first = max(bisect_left(times, start) - 1, 0)
    last = min(bisect_right(times, end) + 1, len(times))
    return times[first:last], values[first:last]


def load(folder: Path, channel, start: float, end: float) -> tuple[array, array]:
    """A channel's samples in [start, end] (and one each side), from a read's folder of arrays."""
    return window(_floats(folder / channel.time_file), _floats(folder / channel.value_file), start, end)
