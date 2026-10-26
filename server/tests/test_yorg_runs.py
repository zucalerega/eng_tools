"""Yorg's model runs as processes (yorg/system/runs.py): what a run's process sees and may use, and the watchdog that
stops one at its time limit. Each run here runs code of the test's own in place of runner.py's model (Runs.runner), so
it can say what it sees, wait, or ask for more memory than it may have, without FullFlow."""

import math
import os
import signal
import socket
import sys
import time
from pathlib import Path

import pytest

from yjsp_server.yorg.system.runs import CPU_MARGIN, FILE_SIZE, MEMORY, TIME_LIMIT


def start_run(team, who) -> str:
    """Start a run of a model, a tank of water draining through an orifice, over a test's first second. The run's
    id."""
    data = b"Time (s),PT-TANK (psig)\n0,300\n1,300\n"
    response = team.client.post("/api/yorg/datasets", params={"filename": "Tank.csv"}, content=data, headers=who)
    assert response.status_code == 201, response.text
    model = {
        "nodes": [
            {"id": "tank", "type": "tank", "name": "Water tank", "settings": {"fluid": "Water"}, "links": {}},
            {"id": "out", "type": "outlet", "name": "Atmosphere", "settings": {}, "links": {}},
        ],
        "edges": [
            {
                "id": "inj",
                "type": "orifice",
                "name": "Injector",
                "settings": {"cda": 3e-5},
                "links": {},
                "source": "tank",
                "target": "out",
            }
        ],
    }
    body = {"model": model, "dataset_id": response.json()["id"], "start": 0.0, "end": 1.0}
    response = team.client.post("/api/yorg/models/runs", json=body, headers=who)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def status_of(team, who, run_id: str) -> dict:
    response = team.client.get(f"/api/yorg/models/runs/{run_id}", headers=who)
    assert response.status_code == 200, response.text
    return response.json()


# What a run's process sees around it, saved as its result.
LOOK_AROUND = """
import json, os, resource, sys
limits = ("AS", "CPU", "FSIZE", "CORE")
seen = {
    "environ": dict(os.environ),
    "cwd": os.getcwd(),
    "path": sys.path,
    "session": os.getsid(0) == os.getpid(),
    "limits": {name: resource.getrlimit(getattr(resource, f"RLIMIT_{name}")) for name in limits},
}
with open(os.path.join(sys.argv[1], "result.json"), "w") as file:
    json.dump(seen, file)
"""


@pytest.mark.skipif(os.name != "posix", reason="sessions and resource limits are POSIX's")
def test_a_runs_process_has_a_folder_of_its_own_and_none_of_the_servers_settings(team, monkeypatch):
    """A run's process runs in its folder, in a session of its own, with an environment of its own (none of the
    server's settings or secrets), and held to its limits."""
    monkeypatch.setenv("YJSP_SECRET_KEY", "the server's, never a run's")
    chief = team.member("chief@x.test", admin=True)
    runs = team.app.state.yorg_runs
    runs.runner = ["-c", LOOK_AROUND]
    run_id = start_run(team, chief)
    assert runs.wait(run_id, timeout=60) == 0
    status = status_of(team, chief, run_id)
    assert status["state"] == "done", status
    seen, folder = status["result"], (runs.root / run_id).resolve()
    environ = seen["environ"]
    assert [name for name in environ if name.startswith("YJSP_")] == []
    # Its folder is where it runs, its home, and its temporary folder: what it leaves there goes with it.
    assert Path(seen["cwd"]).resolve() == Path(environ["HOME"]).resolve() == folder
    assert Path(environ["TMPDIR"]).resolve() == folder / "tmp"
    assert (environ["MPLBACKEND"], environ["OPENBLAS_NUM_THREADS"]) == ("Agg", "1")
    # Isolated, its Python imports nothing from there; and it leads a session of its own, which stops with it.
    assert all(entry and Path(entry).resolve() != folder for entry in seen["path"])
    assert seen["session"]
    limits = seen["limits"]
    cpu = math.ceil(TIME_LIMIT + CPU_MARGIN)
    assert (limits["CPU"], limits["FSIZE"], limits["CORE"]) == ([cpu, cpu], [FILE_SIZE, FILE_SIZE], [0, 0])
    if sys.platform == "linux":  # macOS doesn't hold a process to its address space
        assert limits["AS"] == [MEMORY, MEMORY]


@pytest.mark.skipif(os.name != "posix", reason="SIGTERM is POSIX's")
def test_a_run_past_its_time_limit_is_stopped_with_no_one_asking(team):
    """A watchdog looks at the runs every few seconds and stops one past its time limit whether or not anyone's asking
    how it's going (its page closed, say): asked to stop, it says why."""
    chief = team.member("chief@x.test", admin=True)
    runs = team.app.state.yorg_runs
    runs.runner = ["-c", "import time; time.sleep(3600)"]  # a run that would take an hour
    runs.check_every = 0.01
    run_id = start_run(team, chief)
    runs.clock = lambda: time.monotonic() + TIME_LIMIT + 1  # and then its 10 minutes are up
    assert runs.wait(run_id, timeout=60) == -signal.SIGTERM
    status = status_of(team, chief, run_id)
    assert (status["state"], status["message"]) == (
        "failed",
        "The run took longer than 10 minutes, so it was stopped. Try a shorter time, or a longer time step.",
    )


@pytest.mark.skipif(os.name != "posix", reason="SIGTERM and SIGKILL are POSIX's")
def test_a_run_that_wont_stop_is_killed(team, monkeypatch):
    """A run that won't stop when it's asked to (it ignores SIGTERM) is killed GRACE seconds later."""
    monkeypatch.setattr("yjsp_server.yorg.system.runs.GRACE", 0.1)
    chief = team.member("chief@x.test", admin=True)
    runs = team.app.state.yorg_runs
    with socket.create_server(("127.0.0.1", 0)) as ready:
        ready.settimeout(60)
        runs.runner = [
            "-c",
            "import signal, socket, time\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            f"socket.create_connection(('127.0.0.1', {ready.getsockname()[1]}))\n"
            "time.sleep(3600)\n",
        ]
        run_id = start_run(team, chief)
        ready.accept()[0].close()  # it has said it's ignoring SIGTERM
    runs.clock = lambda: time.monotonic() + TIME_LIMIT + 1
    runs.check()
    assert runs.wait(run_id, timeout=0) == -signal.SIGKILL


def test_a_run_that_crashes_says_the_last_thing_it_printed(team):
    """A run that stops without saying why (it crashed) says the last line it printed, from the end of a log that may
    be as big as a run may write."""
    chief = team.member("chief@x.test", admin=True)
    runs = team.app.state.yorg_runs
    runs.runner = ["-c", "import sys\nfor i in range(100_000): print('working on step', i)\nsys.exit('lost in space')"]
    run_id = start_run(team, chief)
    assert runs.wait(run_id, timeout=60) == 1
    assert status_of(team, chief, run_id)["message"] == "The run stopped unexpectedly: lost in space"


# runner.py as it is, but for its model's run, which asks for 8 GB: memory a run may not have, on any machine.
NEEDS_8_GB = """
import sys
from pathlib import Path
import numpy as np
from yjsp_server.yorg.system import runner
runner.run = lambda job, inputs, progress: {"bytes": np.empty(2**30).nbytes}
runner.main(Path(sys.argv[1]))
"""


@pytest.mark.skipif(sys.platform != "linux", reason="Linux holds a run to its memory (RLIMIT_AS); macOS doesn't")
def test_a_run_out_of_memory_says_so(team):
    """A run that needs more memory than it may have fails, saying so, while the server carries on. The system refuses
    the 8 GB at once, so none of it is ever used, whatever the machine has."""
    chief = team.member("chief@x.test", admin=True)
    runs = team.app.state.yorg_runs
    runs.runner = ["-c", NEEDS_8_GB]
    run_id = start_run(team, chief)
    assert runs.wait(run_id, timeout=120) == 0
    status = status_of(team, chief, run_id)
    assert (status["state"], status["message"]) == (
        "failed",
        "The run ran out of memory: it may use 2 GB. Try a shorter time, or a longer time step.",
    )
