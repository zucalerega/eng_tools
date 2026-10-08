"""A model run's (or fit's, or anchored run's) process: python -m yjsp_server.yorg.system.runner <folder>.

The folder holds job.json (the checked model, the window, the time step, the solver; for a fit, what to fit; for an
anchored run, its anchors and what to fit if they don't work) and inputs/ (each linked channel's times and values, as
little-endian float64s). The process writes progress.json as it goes, then result.json or error.json.
"""

import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any

import numpy as np

from .fit import fit, tune
from .network import ModelError, run


def _save(path: Path, value: dict) -> None:
    """Write so that a reader never sees half a file."""
    fd, name = tempfile.mkstemp(dir=path.parent, suffix=".part")
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        json.dump(value, file)
    os.replace(name, path)


class _Progress:
    """Says how far a run has got, at most twice a second."""

    def __init__(self, path: Path):
        self.path, self.last, self.shown = path, 0.0, 0.0

    def __call__(self, t: float) -> None:
        now = time.monotonic()
        if t > self.shown and now - self.last > 0.5:
            self.shown, self.last = t, now
            _save(self.path, {"t": t})


def main(folder: Path) -> None:
    job = json.loads((folder / "job.json").read_text(encoding="utf-8"))
    inputs = {
        key: (
            np.fromfile(folder / "inputs" / f"{key}.t.f64", dtype="<f8"),
            np.fromfile(folder / "inputs" / f"{key}.v.f64", dtype="<f8"),
        )
        for key in job["inputs"]
    }
    progress = folder / "progress.json"

    def report(state: dict[str, Any]) -> None:
        _save(progress, state)

    try:
        if job.get("kind") == "fit":
            result = fit(job, inputs, report)
        elif job.get("kind") == "anchor":
            result = tune(job, inputs, _Progress(progress), report)
        else:
            result = run(job, inputs, _Progress(progress))
    except ModelError as error:
        _save(folder / "error.json", {"message": str(error)})
        return
    except Exception as error:  # a bug here or in a library: say what, and keep the details in the log
        traceback.print_exc()
        _save(folder / "error.json", {"message": f"The run failed: {type(error).__name__}: {error}"})
        return
    _save(folder / "result.json", result)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
