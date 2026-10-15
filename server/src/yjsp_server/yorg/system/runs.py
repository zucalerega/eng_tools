"""Model runs, fits, and anchored runs: each a process of its own (runner.py) with a folder of inputs and results, so
a long simulation never holds up the site, and one that runs past its limit is stopped. A run's folder goes a while
after it's done.

A run's process is kept from harming the site, which is one small machine (one CPU, 6 GB): it starts in its folder,
with an environment of its own (none of the server's settings or secrets) and in a session of its own (so stopping it
stops whatever it started), and the system holds it to limits on its memory, its CPU time, and its files' sizes, so a
run gone wrong fails by itself. A watchdog stops each run at its time limit, whether or not anyone's asking how it's
going. It still runs as the server's user, so it could read the server's files: the server runs only scripts it wrote
(network.py), and only admins start runs.
"""

import contextlib
import json
import logging
import math
import os
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from array import array
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ...errors import Conflict, NotFound

if os.name == "posix":
    import resource

log = logging.getLogger(__name__)

TIME_LIMIT = 600.0  # seconds a run may take
# And a fit, or an anchored run that may fit too: it stops itself a minute before, with the best it found.
FIT_LIMIT = 1800.0
KEEP = 1800.0  # seconds a finished run's results are kept
RUNNING_AT_ONCE = 2  # the server has one CPU: more would only slow each other
CHECK_EVERY = 5.0  # seconds between the watchdog's looks at the runs
GRACE = 5.0  # seconds a run asked to stop has to end before it's killed
# What a run's process may use. Two runs at once still leave the server and the system 2 GB of the 6.
MEMORY = 2 * 1024**3  # bytes of address space: on Linux, as macOS doesn't hold a process to one
FILE_SIZE = 1024**3  # bytes in any one file it writes
CPU_MARGIN = 60.0  # CPU seconds past its time limit: the watchdog stops it before then, unless the server is gone
RUNNER = ("-m", "yjsp_server.yorg.system.runner")  # what a run's Python runs, given its folder


@dataclass
class Run:
    id: str
    user_id: int
    kind: str  # run, fit, or anchor (a run with anchored knobs)
    folder: Path
    process: subprocess.Popen
    started: float
    duration: float  # simulated seconds
    limit: float  # seconds it may take
    finished: float | None = None


class Runs:
    def __init__(self, root: Path):
        root = Path(root).absolute()  # a run's process starts in its own folder, where a relative path means nothing
        self.root = root / "runs"
        # Matplotlib (which FullFlow's plotting imports) keeps a font cache: kept between runs, it's built once.
        self.matplotlib = root / "matplotlib"
        # Tests give their own of these: what a run's Python runs, the clock, and how often the watchdog looks.
        self.runner = RUNNER
        self.clock = time.monotonic
        self.check_every = CHECK_EVERY
        self._runs: dict[str, Run] = {}
        self._lock = threading.Lock()
        self._closed = threading.Event()
        self._watchdog: threading.Thread | None = None  # started with the first run
        shutil.rmtree(self.root, ignore_errors=True)  # runs don't outlive the server
        self.root.mkdir(parents=True, exist_ok=True)

    def start(
        self, user_id: int, job: dict[str, Any], inputs: dict[str, tuple[array, array]], kind: str = "run"
    ) -> Run:
        """Start a run (or a fit) of job (see runner.py), with inputs: each linked channel's times and values, by
        part.link."""
        limit = FIT_LIMIT if kind in ("fit", "anchor") else TIME_LIMIT
        with self._lock:
            self._sweep()
            for run in list(self._runs.values()):
                if run.user_id == user_id and run.kind == kind and run.finished is None:
                    self._stop(run)  # your new run replaces the one still going (and a fit, a fit)
            if sum(1 for run in self._runs.values() if run.finished is None) >= RUNNING_AT_ONCE:
                raise Conflict("Other runs are using the server: try again in a minute", code="busy")
            run_id = secrets.token_hex(8)
            folder = self.root / run_id
            (folder / "inputs").mkdir(parents=True)
            (folder / "tmp").mkdir()
            for key, (times, values) in inputs.items():
                _write(times, folder / "inputs" / f"{key}.t.f64")
                _write(values, folder / "inputs" / f"{key}.v.f64")
            memory = _memory()
            job = {**job, "kind": kind, "inputs": sorted(inputs), "deadline": limit - 60.0, "memory": memory}
            (folder / "job.json").write_text(json.dumps(job), encoding="utf-8")
            with (folder / "log.txt").open("wb") as output:
                process = subprocess.Popen(
                    # -I: isolated, so Python takes no PYTHON* settings and imports nothing from the run's folder. -u:
                    # what it prints is in log.txt at once, so a run that's stopped or crashes leaves its last words.
                    [sys.executable, "-I", "-u", *self.runner, str(folder)],
                    cwd=folder,
                    env=self._environment(folder),
                    stdin=subprocess.DEVNULL,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,  # its own process group, which _end stops whole
                    preexec_fn=_limiter(limit + CPU_MARGIN, memory) if os.name == "posix" else None,
                )
            run = Run(run_id, user_id, kind, folder, process, self.clock(), job["end"] - job["start"], limit)
            self._runs[run_id] = run
            if self._watchdog is None:
                self._watchdog = threading.Thread(target=self._watch, name="yorg-runs", daemon=True)
                self._watchdog.start()
            return run

    def status(self, run_id: str, user_id: int) -> dict[str, Any]:
        """How a run is going: running (with how far it has got), done (with its results), or failed (and why). A
        fit's progress (its tries, and the best it has found) comes with it, stopped or not, as does an anchored
        run's, which may fit."""
        with self._lock:
            run = self._find(run_id, user_id)
            now = self.clock()
            self._update(run, now)
            elapsed = (run.finished or now) - run.started
            progress = _load(run.folder / "progress.json") or {}
            status = {"elapsed": elapsed, "duration": run.duration}
            if run.kind in ("fit", "anchor"):
                status["progress"] = progress
            if run.finished is None:
                return {**status, "state": "running", "done": progress.get("t", 0.0)}
            result = _load(run.folder / "result.json")
            if result is not None:
                return {**status, "state": "done", "result": result}
            error = _load(run.folder / "error.json") or {"message": _crash(run.folder)}
            return {**status, "state": "failed", "message": error["message"]}

    def check(self) -> None:
        """Stop each run past its time limit, and forget those done a while ago: what the watchdog does every few
        seconds, so a run's limit holds whether or not anyone's asking how it's going."""
        with self._lock:
            self._sweep()

    def wait(self, run_id: str, timeout: float) -> int:
        """Wait for a run's process to end, and give its exit status (for tests: pages ask for status instead)."""
        return self._runs[run_id].process.wait(timeout)

    def cancel(self, run_id: str, user_id: int) -> None:
        with self._lock:
            run = self._find(run_id, user_id)
            if run.finished is None:
                self._stop(run)
                _save(run.folder / "error.json", {"message": "Stopped."})

    def close(self) -> None:
        """Stop the watchdog, and every run (the server is shutting down)."""
        self._closed.set()
        with self._lock:
            watchdog = self._watchdog
        if watchdog is not None:
            watchdog.join()  # within a look at the runs, which it may be taking
        with self._lock:
            for run in self._runs.values():
                if run.finished is None:
                    self._stop(run)

    def _watch(self) -> None:
        """The watchdog: a look at the runs every few seconds, from the first run until the server stops."""
        while not self._closed.wait(self.check_every):
            try:
                self.check()
            except Exception:  # a bad look mustn't stop the next ones
                log.exception("Checking Yorg's model runs failed")

    def _environment(self, folder: Path) -> dict[str, str]:
        """A run's environment: what Python, NumPy, and Matplotlib need, and nothing else of the server's (whose
        settings and secrets, YJSP_*, are in its own)."""
        environment = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": str(folder),  # what a library keeps in a home folder goes with the run
            "TMPDIR": str(folder / "tmp"),
            "MPLCONFIGDIR": str(self.matplotlib),
            "MPLBACKEND": "Agg",
            # NumPy's and SciPy's OpenBLAS start a thread for each CPU, and each thread's stack and buffers take some
            # of the run's MEMORY: on a server with one CPU, one is all a run can use anyway.
            "OPENBLAS_NUM_THREADS": "1",
        }
        # How the server's text is written, and SYSTEMROOT, without which Python doesn't start on Windows.
        for name in ("LANG", "LC_ALL", "LC_CTYPE", "SYSTEMROOT"):
            if name in os.environ:
                environment[name] = os.environ[name]
        return environment

    def _find(self, run_id: str, user_id: int) -> Run:
        run = self._runs.get(run_id)
        if run is None or run.user_id != user_id:
            raise NotFound("There's no such run: it may have finished a while ago")
        return run

    def _update(self, run: Run, now: float) -> None:
        """Note that a run's process has ended, or stop it if it's past its time limit, saying why."""
        if run.finished is not None:
            return
        if run.process.poll() is not None:
            run.finished = now
        elif now - run.started > run.limit:
            self._stop(run)
            _save(
                run.folder / "error.json",
                {
                    "message": f"The {named(run.kind)} took longer than {run.limit / 60:.0f} minutes, so it was "
                    "stopped. Try a shorter time, or a longer time step."
                },
            )

    def _stop(self, run: Run) -> None:
        _end(run.process)
        run.finished = self.clock()

    def _sweep(self) -> None:
        now = self.clock()
        for run_id, run in list(self._runs.items()):
            self._update(run, now)
            if run.finished is not None and now - run.finished > KEEP:
                shutil.rmtree(run.folder, ignore_errors=True)
                del self._runs[run_id]


def named(kind: str) -> str:
    """What a run of a kind is called when it says what happened to it."""
    return {"fit": "fit", "anchor": "anchored run"}.get(kind, "run")


def _end(process: subprocess.Popen) -> None:
    """Stop a run's process, and whatever it started: asked to (SIGTERM), then killed if it hasn't ended within GRACE
    seconds."""
    if process.poll() is not None:
        return  # it ended by itself
    if os.name != "posix":  # Windows has neither SIGTERM nor process groups
        process.kill()
        process.wait()
        return
    # The run leads a process group of its own (start_new_session), whose id is its pid: the run's, while its process
    # hasn't been reaped.
    with contextlib.suppress(ProcessLookupError):  # it has just ended
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(GRACE)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def _memory() -> int | None:
    """The bytes of address space a run may use, where the system holds a process to that: on Linux."""
    return _within(resource.RLIMIT_AS, MEMORY) if sys.platform == "linux" else None


def _limiter(seconds: float, memory: int | None) -> Callable[[], None]:
    """What sets a run's limits, in its process before it starts Python: past one, the run fails by itself (a
    MemoryError, a file too large, killed for its CPU time) instead of taking the site down with it."""
    limits = [
        (resource.RLIMIT_CPU, _within(resource.RLIMIT_CPU, math.ceil(seconds))),
        (resource.RLIMIT_FSIZE, _within(resource.RLIMIT_FSIZE, FILE_SIZE)),
        (resource.RLIMIT_CORE, 0),  # no core dumps: a crashed run's memory would fill the disk
    ]
    if memory is not None:
        limits.append((resource.RLIMIT_AS, memory))

    def limit() -> None:
        for which, value in limits:
            resource.setrlimit(which, (value, value))

    return limit


def _within(which: int, value: int) -> int:
    """value, or the server's own hard limit where that's lower: a process may lower its limits, never raise them."""
    hard = resource.getrlimit(which)[1]
    return value if hard == resource.RLIM_INFINITY else min(value, hard)


def _write(values: array, path: Path) -> None:
    if sys.byteorder != "little":
        values = array("d", values)
        values.byteswap()
    with path.open("wb") as file:
        values.tofile(file)


def _save(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def _load(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None  # not there yet, or being written


def _crash(folder: Path) -> str:
    """Why a run stopped without saying: the end of what it printed. Only the end is read, as a run's log may be as big
    as any file it may write (FILE_SIZE)."""
    try:
        with (folder / "log.txt").open("rb") as file:
            file.seek(max(file.seek(0, os.SEEK_END) - 65536, 0))
            lines = file.read().decode("utf-8", errors="replace").strip().splitlines()
    except OSError:
        lines = []
    return "The run stopped unexpectedly" + (f": {lines[-1]}" if lines else ".")
