"""A checked system model run over a test's window: its FullFlow script (script.py) run, with the test's channels in
and each part's outputs back.

Runs in the runner's process only: the script imports FullFlow, ThermoProp, NumPy, and SciPy. The script is written
from the model alone, every value in it a literal, so the server runs only code it wrote.
"""

import sys
from collections.abc import Callable
from typing import Any

from . import library
from .library import MAX_POINTS, ModelError, Series
from .script import Unrunnable, script

__all__ = ["MAX_POINTS", "ModelError", "Series", "execute", "run"]

# A script imports Yorg's own (library.py and components.py) as yorg_models: the package they are in the browser.
sys.modules.setdefault("yorg_models", library)


def run(
    job: dict[str, Any],
    inputs: dict[str, Series],
    progress: Callable[[float], None],
    max_points: int = MAX_POINTS,
) -> dict[str, Any]:
    """Simulate job's model from job["start"] to job["end"], with time steps of job["dt"] (steady, if job["solver"]
    says so), anchoring job["anchors"]; inputs are the linked channels' samples (SI units, on the dataset's clock) by
    part.link."""
    try:
        text = script(job, max_points)
    except Unrunnable as error:
        raise ModelError(str(error)) from error
    return execute(text, inputs, progress)


def execute(text: str, inputs: dict[str, Series], progress: Callable[[float], None] | None = None) -> dict[str, Any]:
    """Run a model's script (one script.py wrote: never one from a request) with a test's channels as its data, and
    give its result."""
    namespace: dict[str, Any] = {"__name__": "__main__", "data": inputs}
    library.progress = progress
    try:
        exec(compile(text, "model.py", "exec"), namespace)
    finally:
        library.progress = None
    return namespace["result"]
