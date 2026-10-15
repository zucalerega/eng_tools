"""How hard the server is working, for Admin > People's server load chart: a sample a minute of how busy its CPUs
were and how full its memory, kept a week (admins only)."""

from datetime import timedelta
from pathlib import Path

import pytest

from yjsp_server import load
from yjsp_server.db import utcnow
from yjsp_server.models import ServerLoad

GB = 2**30


def proc(tmp_path: Path, *, busy: int, idle: int, steal: int = 0, available: float = 4) -> Path:
    """A /proc whose CPUs have spent these clock ticks since boot, with 6 GB of memory, `available` GB of it free."""
    root = tmp_path / f"proc-{busy}-{idle}-{steal}-{available}"
    root.mkdir()
    # user nice system idle iowait irq softirq steal guest guest_nice
    (root / "stat").write_text(f"cpu  {busy} 0 0 {idle} 0 0 0 {steal} 0 0\ncpu0 {busy} 0 0 {idle} 0 0 0 {steal} 0 0\n")
    meminfo = f"MemTotal: {6 * GB // 1024} kB\nMemFree: 1024 kB\nMemAvailable: {int(available * GB) // 1024} kB\n"
    (root / "meminfo").write_text(meminfo)
    return root


def sampler_reading(app, *roots: Path) -> load.Sampler:
    """A sampler that finds these /procs, one a reading, in turn."""
    sampler = load.Sampler(app.state.sessionmaker)
    found = iter(roots)
    sampler.read = lambda: load.read(next(found))
    return sampler


def test_admins_see_how_busy_the_cpu_was_and_how_full_the_memory_minute_by_minute(app, client, team, tmp_path):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    sampler = sampler_reading(
        app,
        proc(tmp_path, busy=1000, idle=9000),
        proc(tmp_path, busy=1600, idle=9400, available=4),  # 600 of 1,000 ticks busy; 2 of 6 GB in use
        proc(tmp_path, busy=2500, idle=9450, steal=50, available=1.5),  # 900 of 1,000, and 50 stolen; 4.5 GB
    )
    now = utcnow()
    for minutes in (3, 2, 1):  # the first reading has nothing to compare with
        sampler.take(now - timedelta(minutes=minutes))

    seen = client.get("/api/load", headers=chief).json()
    assert seen["cpus"] >= 1 and seen["minutes"] == 1
    assert [(p["cpu"], p["steal"], round(p["memory"], 1)) for p in seen["points"]] == [
        (60.0, 0.0, 33.3),
        (90.0, 5.0, 75.0),
    ]
    assert (seen["memory_used"], seen["memory_total"]) == (int(4.5 * GB), 6 * GB)

    # It's the server's business: members don't see it.
    refused = client.get("/api/load", headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
    assert client.get("/api/load", params={"hours": 169}, headers=chief).status_code == 422


def test_more_than_a_day_shows_the_busiest_minute_of_each_ten(app, client, team, tmp_path):
    chief = team.member("chief@x.test", admin=True)
    sampler = sampler_reading(
        app,
        proc(tmp_path, busy=0, idle=1000),
        proc(tmp_path, busy=200, idle=1800),  # 20%
        proc(tmp_path, busy=900, idle=2100),  # 70%
        proc(tmp_path, busy=1000, idle=3000),  # 10%, ten minutes on
    )
    now = utcnow()
    stretch = timedelta(minutes=10)
    start = now - (now - load.EPOCH) % stretch - 3 * stretch  # a 10-minute stretch, half an hour ago
    for at in (start, start + timedelta(minutes=1), start + timedelta(minutes=2), start + stretch):
        sampler.take(at)

    week = client.get("/api/load", params={"hours": 168}, headers=chief).json()
    assert week["minutes"] == 10
    assert [(p["at"], p["cpu"]) for p in week["points"]] == [
        (start.isoformat().replace("+00:00", "Z"), 70.0),
        ((start + stretch).isoformat().replace("+00:00", "Z"), 10.0),
    ]


def test_samples_older_than_a_week_go(app, client, team, tmp_path):
    chief = team.member("chief@x.test", admin=True)
    sampler = sampler_reading(app, *(proc(tmp_path, busy=n, idle=1000 * n) for n in range(1, 4)))
    now = utcnow()
    sampler.take(now - timedelta(days=9))
    sampler.take(now - timedelta(days=8))  # kept until a sample a week later
    assert len(client.get("/api/load", params={"hours": 168}, headers=chief).json()["points"]) == 0  # too old to show
    sampler.take(now)
    with app.state.sessionmaker() as db:
        assert [row.at for row in db.query(ServerLoad)] == [now]


def test_without_proc_the_cpu_comes_from_the_load_average(monkeypatch, tmp_path):
    monkeypatch.setattr(load, "cpus", lambda: 4)
    reading = load.read(tmp_path / "no-proc-here")
    assert (reading.cpu_total, reading.memory_total) == (None, None)
    assert load.between(load.Reading(), load.Reading(load=1.0)) == load.Sample(25.0, None, None, None)
    assert load.between(load.Reading(), load.Reading(load=9.0)).cpu == 100.0


@pytest.mark.parametrize("broken", ["", "cpu  12 x\n", "nonsense"])
def test_a_proc_it_cant_read_is_no_reading_rather_than_an_error(tmp_path, broken):
    root = tmp_path / "proc"
    root.mkdir()
    (root / "stat").write_text(broken)
    (root / "meminfo").write_text("MemTotal: 10 kB\nOdd:\nMemAvailable: 4 kB\n")
    reading = load.read(root)
    assert (reading.cpu_total, reading.memory_total, reading.memory_available) == (None, 10240, 4096)
