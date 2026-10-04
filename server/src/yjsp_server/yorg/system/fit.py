"""Fitting a model to a test: the knobs picked (CdAs, line losses, an ullage's heat) turned until the model's outputs
match the channels they're compared with, by SciPy's least squares, each try a run of the model. Runs in the
runner's process.

Each compared channel counts the same, however many samples it has: its errors are divided by how much it moves over
the window (or 5% of its size, if it barely does), and by the root of how many of its samples are compared. Each
knob is searched over its limits on a scale from 0 to 1: a CdA or a time over 1/30 to 30 times where it starts (as
its logarithm, since they matter by ratio), one that starts at 0 (a fittings' K) over its limits.
"""

import copy
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.optimize import least_squares

from .catalog import BY_TYPE, in_words
from .network import ModelError, Series, run

POINTS = 300  # a compared channel's samples, averaged down to at most this many
SPREAD = 30.0  # a knob that starts above 0 is searched from 1/SPREAD to SPREAD times its start, within its limits
ZERO_TOP = 100.0  # and one that starts at 0, up to this (or its limit)
TRIES = 12  # least squares' iterations at most (each is a run for every knob, and one more)
STEP = 0.01  # the finite-difference step for the slopes, on each knob's 0-to-1 scale
FAILED = 2.0  # a try that didn't run: as if every sample were off by twice its channel's swing


class Stop(Exception):
    """Out of time: the fit ends with the best it found."""


@dataclass
class _Knob:
    part: str
    key: str
    start: float
    low: float  # the 0-to-1 scale's ends: the value's logarithm if log, else the value
    high: float
    log: bool

    def value(self, z: float) -> float:
        u = self.low + min(max(z, 0.0), 1.0) * (self.high - self.low)
        return math.exp(u) if self.log else u

    def scaled(self, value: float) -> float:
        u = math.log(value) if self.log else value
        return min(max((u - self.low) / (self.high - self.low), 0.0), 1.0)


def _knob(part: dict[str, Any], key: str) -> _Knob:
    setting = next(one for one in BY_TYPE[part["type"]].settings if one.key == key)
    start = float(part["settings"][key])
    minimum = setting.minimum if setting.minimum is not None else -math.inf
    maximum = setting.maximum if setting.maximum is not None else math.inf
    if start > 0.0:
        low, high = max(start / SPREAD, minimum), min(start * SPREAD, maximum)
        if low > 0.0 and high > low:
            return _Knob(part["id"], key, start, math.log(low), math.log(high), True)
    low, high = max(minimum, 0.0 if start >= 0.0 else start * SPREAD), min(maximum, ZERO_TOP)
    if not high > low:
        raise ModelError(f"{part['name']}'s {in_words(setting.label)} has no room to move within its limits")
    return _Knob(part["id"], key, start, low, high, False)


@dataclass
class _Compared:
    output: str
    times: np.ndarray  # on the dataset's clock
    values: np.ndarray  # SI
    scale: float


def _compared(output: str, series: Series, start: float, end: float) -> _Compared | None:
    """A channel's samples in the window, averaged down to at most POINTS (which also quiets their noise)."""
    times, values = series
    keep = np.isfinite(times) & np.isfinite(values) & (times >= start) & (times <= end)
    times, values = times[keep], values[keep]
    if len(times) == 0:
        return None
    if len(times) > POINTS:
        edges = np.linspace(start, end, POINTS + 1)
        bins = np.clip(np.searchsorted(edges, times, side="right") - 1, 0, POINTS - 1)
        counts = np.bincount(bins, minlength=POINTS)
        filled = counts > 0
        times = (np.bincount(bins, weights=times, minlength=POINTS)[filled]) / counts[filled]
        values = (np.bincount(bins, weights=values, minlength=POINTS)[filled]) / counts[filled]
    swing = float(values.max() - values.min())
    scale = max(swing, 0.05 * float(np.abs(values).max()), 1e-12)
    return _Compared(output, times, values, scale)


def fit(job: dict[str, Any], inputs: dict[str, Series], report: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    """Fit job["fit"]["knobs"] ([{part, key}]) so the model's outputs match job["fit"]["compared"] ([{output,
    input}]: an output, and the input holding the channel it's compared with), within job["deadline"] seconds. The
    result: the best try's run, with what the fit found under "fit"."""
    started = time.monotonic()
    deadline = started + float(job["deadline"])
    model = job["model"]
    parts = {**model["nodes"], **model["edges"]}
    knobs = [_knob(parts[one["part"]], one["key"]) for one in job["fit"]["knobs"]]
    compared = [
        found
        for one in job["fit"]["compared"]
        if (found := _compared(one["output"], inputs[one["input"]], job["start"], job["end"])) is not None
    ]
    if not compared:
        raise ModelError("None of the channels the model is compared with has samples in the run's window")
    trial = copy.deepcopy(job)
    trial_parts = {**trial["model"]["nodes"], **trial["model"]["edges"]}
    best: dict[str, Any] = {"cost": math.inf, "z": None, "result": None, "errors": None}
    first: dict[str, Any] = {}
    tries = 0

    def errors_of(result: dict[str, Any]) -> list[np.ndarray]:
        errors = []
        for one in compared:
            modeled = np.array([math.nan if value is None else value for value in result["series"][one.output]])
            at = np.interp(one.times, result["times"], modeled)
            errors.append(at - one.values)
        return errors

    def residuals(z: np.ndarray) -> np.ndarray:
        nonlocal tries
        if time.monotonic() > deadline:
            raise Stop
        for knob, value in zip(knobs, z, strict=True):
            trial_parts[knob.part]["settings"][knob.key] = knob.value(float(value))
        tries += 1
        try:
            result = run(trial, inputs, lambda t: None, max_points=1000)
            errors = errors_of(result)
        except ModelError:
            result, errors = None, None
        pieces = []
        for index, one in enumerate(compared):
            weight = 1.0 / (one.scale * math.sqrt(len(one.values)))
            if errors is None:
                pieces.append(np.full(len(one.values), FAILED * one.scale * weight))
            else:
                pieces.append(np.nan_to_num(errors[index] * weight, nan=FAILED * one.scale * weight))
        vector = np.concatenate(pieces)
        cost = float(vector @ vector)
        if not first:
            first.update(cost=cost, errors=errors)
        if result is not None and cost < best["cost"]:
            best.update(cost=cost, z=np.array(z, dtype=float), result=result, errors=errors)
        report(
            {
                "tries": tries,
                "cost_start": first["cost"],
                "cost": best["cost"],
                "values": [knob.value(float(v)) for knob, v in zip(knobs, best["z"], strict=True)]
                if best["z"] is not None
                else None,
                "elapsed": time.monotonic() - started,
            }
        )
        return vector

    z0 = np.array([knob.scaled(knob.start) for knob in knobs])
    stopped = False
    try:
        least_squares(
            residuals,
            z0,
            bounds=(0.0, 1.0),
            method="trf",
            diff_step=STEP,
            ftol=1e-4,
            xtol=1e-4,
            gtol=1e-8,
            max_nfev=TRIES,
        )
    except Stop:
        stopped = True
    if best["result"] is None:
        raise ModelError(
            "The model didn't run with its knobs where they started, so there's nothing to fit from: run it first"
        )

    def rms(errors: list[np.ndarray] | None, index: int) -> float | None:
        if errors is None:
            return None
        found = errors[index][np.isfinite(errors[index])]
        return float(np.sqrt(np.mean(found**2))) if len(found) else None

    return {
        **best["result"],
        "fit": {
            "knobs": [
                {"part": knob.part, "key": knob.key, "start": knob.start, "value": knob.value(float(z))}
                for knob, z in zip(knobs, best["z"], strict=True)
            ],
            "compared": [
                {"output": one.output, "rms_start": rms(first["errors"], index), "rms": rms(best["errors"], index)}
                for index, one in enumerate(compared)
            ],
            "cost_start": first["cost"],
            "cost": best["cost"],
            "tries": tries,
            "stopped": stopped,
        },
    }
