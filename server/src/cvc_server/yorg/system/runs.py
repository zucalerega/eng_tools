"""Model runs: each a process of its own (runner.py) with a folder of inputs and results, so a long simulation never
holds up the site, and one that runs past its limit is stopped. A run's folder goes a while after it's done.
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ...errors import Conflict, NotFound

TIME_LIMIT = 600.0  # seconds a run may take
KEEP = 1800.0  # seconds a finished run's results are kept
RUNNING_AT_ONCE = 2  # the server has one CPU: more would only slow each other


@dataclass
class Run:
    id: str
    user_id: int
    folder: Path
    process: subprocess.Popen
    started: float
    duration: float  # simulated seconds
    finished: float | None = None


class Runs:
    def __init__(self, root: Path):
        self.root = Path(root) / "runs"
        # Matplotlib (which FullFlow's plotting imports) keeps a font cache: kept between runs, it's built once.
        self.matplotlib = Path(root) / "matplotlib"
        self._runs: dict[str, Run] = {}
        self._lock = threading.Lock()
        shutil.rmtree(self.root, ignore_errors=True)  # runs don't outlive the server
        self.root.mkdir(parents=True, exist_ok=True)

    def start(self, user_id: int, job: dict[str, Any], inputs: dict[str, tuple[array, array]]) -> Run:
        """Start a run of job (see runner.py), with inputs: each linked channel's times and values, by part.link."""
        with self._lock:
            self._sweep()
            for run in list(self._runs.values()):
                if run.user_id == user_id and run.finished is None:
                    self._stop(run)  # your new run replaces the one still going
            if sum(1 for run in self._runs.values() if run.finished is None) >= RUNNING_AT_ONCE:
                raise Conflict("Other runs are using the server: try again in a minute", code="busy")
            run_id = secrets.token_hex(8)
            folder = self.root / run_id
            (folder / "inputs").mkdir(parents=True)
            for key, (times, values) in inputs.items():
                _write(times, folder / "inputs" / f"{key}.t.f64")
                _write(values, folder / "inputs" / f"{key}.v.f64")
            (folder / "job.json").write_text(json.dumps({**job, "inputs": sorted(inputs)}), encoding="utf-8")
            environment = {**os.environ, "MPLCONFIGDIR": str(self.matplotlib), "MPLBACKEND": "Agg"}
            with (folder / "log.txt").open("wb") as log:
                process = subprocess.Popen(
                    [sys.executable, "-m", "cvc_server.yorg.system.runner", str(folder)],
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    env=environment,
                )
            run = Run(run_id, user_id, folder, process, time.monotonic(), job["end"] - job["start"])
            self._runs[run_id] = run
            return run

    def status(self, run_id: str, user_id: int) -> dict[str, Any]:
        """How a run is going: running (with how far it has got), done (with its results), or failed (and why)."""
        with self._lock:
            run = self._find(run_id, user_id)
            now = time.monotonic()
            if run.finished is None and run.process.poll() is not None:
                run.finished = now
            if run.finished is None and now - run.started > TIME_LIMIT:
                self._stop(run)
                _save(
                    run.folder / "error.json",
                    {
                        "message": f"The run took longer than {TIME_LIMIT / 60:.0f} minutes, so it was stopped. Try a shorter time, or a longer time step."
                    },
                )
            elapsed = (run.finished or now) - run.started
            if run.finished is None:
                progress = _load(run.folder / "progress.json") or {}
                return {
                    "state": "running",
                    "elapsed": elapsed,
                    "done": progress.get("t", 0.0),
                    "duration": run.duration,
                }
            result = _load(run.folder / "result.json")
            if result is not None:
                return {"state": "done", "elapsed": elapsed, "duration": run.duration, "result": result}
            error = _load(run.folder / "error.json") or {"message": _crash(run.folder)}
            return {"state": "failed", "elapsed": elapsed, "duration": run.duration, "message": error["message"]}

    def wait(self, run_id: str, timeout: float) -> None:
        """Wait for a run's process to end (for tests: pages ask for status instead)."""
        self._runs[run_id].process.wait(timeout)

    def cancel(self, run_id: str, user_id: int) -> None:
        with self._lock:
            run = self._find(run_id, user_id)
            if run.finished is None:
                self._stop(run)
                _save(run.folder / "error.json", {"message": "Stopped."})

    def close(self) -> None:
        """Stop every run (the server is shutting down)."""
        with self._lock:
            for run in self._runs.values():
                if run.finished is None:
                    self._stop(run)

    def _find(self, run_id: str, user_id: int) -> Run:
        run = self._runs.get(run_id)
        if run is None or run.user_id != user_id:
            raise NotFound("There's no such run: it may have finished a while ago")
        return run

    def _stop(self, run: Run) -> None:
        run.process.kill()
        run.process.wait()
        run.finished = time.monotonic()

    def _sweep(self) -> None:
        now = time.monotonic()
        for run_id, run in list(self._runs.items()):
            if run.finished is None and now - run.started > TIME_LIMIT:
                self._stop(run)
            if run.finished is not None and now - run.finished > KEEP:
                shutil.rmtree(run.folder, ignore_errors=True)
                del self._runs[run_id]


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
    """Why a run stopped without saying: the end of what it printed."""
    try:
        lines = (folder / "log.txt").read_text(encoding="utf-8", errors="replace").strip().splitlines()
    except OSError:
        lines = []
    return "The run stopped unexpectedly" + (f": {lines[-1]}" if lines else ".")
