"""How hard the server is working: its CPU and memory, a sample a minute, kept a week, for Admin > People's server
load chart (admins only). The live server is one small VM (docs/deploying.md), so a heavy Yorg run or a crowd of
check-ins shows here first, as it nears 100%.

On Linux it reads /proc: the share of the CPUs' time since the last sample that was busy, and the share the
hypervisor took for other machines (steal), and the memory in use, all but what's available. Elsewhere (a Mac, in
development) it estimates the CPU from the load average and leaves memory out.
"""

import logging
import os
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from .db import utcnow
from .models import ServerLoad

log = logging.getLogger(__name__)

SAMPLE_EVERY = 60.0  # seconds
KEEP = timedelta(days=7)
PROC = Path("/proc")
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


@dataclass(frozen=True)
class Reading:
    """What the system says at a moment: running totals for the CPU, so a sample is the change between two."""

    cpu_total: int | None = None  # every CPU's time since boot, in clock ticks
    cpu_idle: int | None = None  # of it idle, or waiting for the disk
    cpu_steal: int | None = None  # of it taken by the hypervisor
    load: float | None = None  # the 1-minute load average, where there's no /proc/stat
    memory_total: int | None = None  # bytes
    memory_available: int | None = None


def read(proc: Path = PROC) -> Reading:
    """The CPU's and memory's numbers now, from /proc where there is one."""
    memory = _meminfo(proc)
    try:
        # cpu  user nice system idle iowait irq softirq steal guest guest_nice: guest time is in user and nice already.
        fields = [int(n) for n in (proc / "stat").read_text().splitlines()[0].split()[1:]]
        cpu = {"cpu_total": sum(fields[:8]), "cpu_idle": fields[3] + fields[4], "cpu_steal": sum(fields[7:8])}
    except (OSError, ValueError, IndexError):
        try:
            cpu = {"load": os.getloadavg()[0]}
        except (OSError, AttributeError):  # no load average either
            cpu = {}
    return Reading(**cpu, memory_total=memory.get("MemTotal"), memory_available=memory.get("MemAvailable"))


def _meminfo(proc: Path) -> dict[str, int]:
    """/proc/meminfo's numbers, in bytes; none without it."""
    try:
        lines = (proc / "meminfo").read_text().splitlines()
    except OSError:
        return {}
    found = {}
    for line in lines:
        key, _, value = line.partition(":")
        amount = value.split()
        if amount and amount[0].isdigit():
            found[key] = int(amount[0]) * (1024 if amount[1:] == ["kB"] else 1)
    return found


def cpus() -> int:
    """The CPUs this server may use."""
    return os.process_cpu_count() or 1


@dataclass(frozen=True)
class Sample:
    cpu: float | None  # % of all CPUs busy
    steal: float | None  # % of all CPUs taken by the hypervisor
    memory_used: int | None  # bytes
    memory_total: int | None


def between(before: Reading, after: Reading) -> Sample:
    """What the server did from one reading to the next."""
    cpu = steal = None
    elapsed = _change(before.cpu_total, after.cpu_total)
    idle = _change(before.cpu_idle, after.cpu_idle)
    if elapsed is not None and elapsed > 0 and idle is not None:
        stolen = max(0, _change(before.cpu_steal, after.cpu_steal) or 0)
        cpu = 100 * max(0, elapsed - idle - stolen) / elapsed
        steal = 100 * stolen / elapsed
    elif after.load is not None:
        cpu = min(100.0, 100 * after.load / cpus())
    used = None
    if after.memory_total is not None and after.memory_available is not None:
        used = after.memory_total - after.memory_available
    return Sample(cpu=cpu, steal=steal, memory_used=used, memory_total=after.memory_total)


class Sampler:
    """Takes a sample a minute, in a thread of its own, from the server's start to its stop."""

    def __init__(self, sessions: sessionmaker[Session], every: float = SAMPLE_EVERY):
        self.sessions = sessions
        self.every = every
        self.read = read  # what the system says now: tests give their own
        self._last: Reading | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._last = self.read()
        self._thread = threading.Thread(target=self._run, name="server-load", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.wait(self.every):
            try:
                self.take()
            except Exception:  # a bad minute mustn't stop the next ones
                log.exception("Sampling the server's load failed")

    def take(self, at: datetime | None = None) -> None:
        """Record what the server did since the last reading, and forget samples older than a week."""
        reading = self.read()
        before, self._last = self._last, reading
        if before is None:
            return  # nothing to compare with yet
        sample = between(before, reading)
        at = at or utcnow()
        with self.sessions() as db:
            db.add(
                ServerLoad(
                    at=at,
                    cpu=sample.cpu,
                    steal=sample.steal,
                    memory_used=sample.memory_used,
                    memory_total=sample.memory_total,
                )
            )
            db.execute(delete(ServerLoad).where(ServerLoad.at < at - KEEP))
            db.commit()


def _change(before: int | None, after: int | None) -> int | None:
    return None if before is None or after is None else after - before


@dataclass
class Point:
    at: datetime  # the start of its stretch
    cpu: float | None  # the busiest minute's %
    steal: float | None
    memory: float | None  # the fullest minute's % of memory


@dataclass
class Load:
    cpus: int
    minutes: int  # how long each point's stretch is
    points: list[Point]  # oldest first, a stretch with no samples left out
    memory_used: int | None  # the latest sample's, in bytes
    memory_total: int | None


def recent(db: Session, hours: int) -> Load:
    """The last hours of samples, a point a minute for a day or less, and a point each 10 minutes for more, each
    with the busiest of its minutes, so a short spike still shows."""
    minutes = 1 if hours <= 24 else 10
    since = utcnow() - timedelta(hours=hours)
    stretch = timedelta(minutes=minutes)
    points: dict[datetime, Point] = {}
    latest: ServerLoad | None = None
    for row in db.scalars(select(ServerLoad).where(ServerLoad.at >= since).order_by(ServerLoad.at)):
        start = row.at - (row.at - EPOCH) % stretch
        memory = 100 * row.memory_used / row.memory_total if row.memory_used and row.memory_total else None
        point = points.setdefault(start, Point(start, None, None, None))
        point.cpu = _most(point.cpu, row.cpu)
        point.steal = _most(point.steal, row.steal)
        point.memory = _most(point.memory, memory)
        latest = row
    return Load(
        cpus=cpus(),
        minutes=minutes,
        points=list(points.values()),
        memory_used=latest.memory_used if latest else None,
        memory_total=latest.memory_total if latest else None,
    )


def _most(a: float | None, b: float | None) -> float | None:
    return b if a is None else a if b is None else max(a, b)
