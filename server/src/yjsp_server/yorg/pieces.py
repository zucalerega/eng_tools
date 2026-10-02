"""Pieces of a dataset: its samples between two times (one test of several in a file), as arrays of their own.

Splitting a file into its tests copies each test's samples out of the file's arrays, so each test is a dataset like
any other: plotted, compared, moved, and deleted on its own. A piece's times can start from a new zero (where a valve
opened, say); a dated file's start moves with it, so its times of day stay as they were.
"""

import hashlib
import math
import sys
from array import array
from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ingest import ChannelData
from .models import Channel

MAIN_TIMES = "time.f64"  # the file's times; a slower sensor's are its own (c3.t.f64)


def _read(path: Path, start: int = 0, count: int | None = None) -> array:
    """Little-endian float64s from an array file: count of them from index start (the rest, if count is None)."""
    values = array("d")
    with path.open("rb") as file:
        available = max(0, file.seek(0, 2) // 8 - start)
        file.seek(start * 8)
        values.fromfile(file, available if count is None else min(count, available))
    if sys.byteorder != "little":
        values.byteswap()
    return values


def _write(values: array, path: Path) -> None:
    if sys.byteorder != "little":
        values = array("d", values)
        values.byteswap()
    with path.open("wb") as file:
        values.tofile(file)


@dataclass
class Piece:
    """What a piece holds, once its arrays are written."""

    rows: int
    t_min: float
    t_max: float
    channels: list[ChannelData]
    events: list[dict[str, Any]]
    left_out: list[str]  # channels without a sample in it
    size: int  # bytes of its arrays
    sha256: str  # of its arrays, by name


class Cutter:
    """Cuts pieces out of one read of a dataset (its arrays, in data), reading each array of times once."""

    def __init__(self, data: Path, channels: Sequence[Channel], events: Sequence[dict[str, Any]]):
        self.data = data
        self.channels = channels
        self.events = events
        self._times: dict[str, array] = {}

    def _times_of(self, name: str) -> array:
        if name not in self._times:
            self._times[name] = _read(self.data / name)
        return self._times[name]

    def rows(self, start: float, end: float) -> int:
        """How many of the file's samples are from start to end (both included)."""
        times = self._times_of(MAIN_TIMES)
        return bisect_right(times, end) - bisect_left(times, start)

    def cut(self, out: Path, start: float, end: float, zero: float) -> Piece:
        """Write the samples from start to end into out (an empty folder), with zero's time as 0."""
        spans: dict[str, tuple[int, array]] = {}  # per array of times: where the piece starts in it, and its times
        for name in sorted({MAIN_TIMES, *(channel.time_file for channel in self.channels)}):
            times = self._times_of(name)
            first, last = bisect_left(times, start), bisect_right(times, end)
            piece = times[first:last]
            spans[name] = (first, array("d", (t - zero for t in piece)) if zero else piece)
        main = spans[MAIN_TIMES][1]
        if not main:
            raise ValueError(f"No samples from {start} to {end}")
        _write(main, out / MAIN_TIMES)

        channels: list[ChannelData] = []
        left_out: list[str] = []
        for channel in self.channels:
            first, times = spans[channel.time_file]
            values = _read(self.data / channel.value_file, first, len(times)) if times else array("d")
            total = sum(values)
            finite = values if math.isfinite(total) else array("d", filter(math.isfinite, values))
            if not finite:
                left_out.append(channel.name)
                continue
            if finite is not values:
                total = sum(finite)
            head = next(i for i, value in enumerate(values) if math.isfinite(value))
            tail = next(i for i in range(len(values) - 1, -1, -1) if math.isfinite(values[i]))
            if channel.time_file != MAIN_TIMES and not (out / channel.time_file).exists():
                _write(times, out / channel.time_file)
            _write(values, out / channel.value_file)
            channels.append(
                ChannelData(
                    position=channel.position,
                    name=channel.name,
                    unit=channel.unit,
                    kind=channel.kind,
                    labels=channel.labels,
                    decimals=channel.decimals,
                    count=len(finite),
                    min=min(finite),
                    max=max(finite),
                    mean=total / len(finite),
                    t_min=times[head],
                    t_max=times[tail],
                    time_file=channel.time_file,
                    value_file=channel.value_file,
                )
            )

        size, digest = 0, hashlib.sha256()
        for path in sorted(out.iterdir()):
            digest.update(path.name.encode() + b"\0")
            with path.open("rb") as file:
                while chunk := file.read(1 << 20):
                    digest.update(chunk)
                    size += len(chunk)
        return Piece(
            rows=len(main),
            t_min=main[0],
            t_max=main[-1],
            channels=channels,
            events=[{**event, "t": event["t"] - zero} for event in self.events if start <= event["t"] <= end],
            left_out=left_out,
            size=size,
            sha256=digest.hexdigest(),
        )
