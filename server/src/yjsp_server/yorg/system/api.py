"""The dev page's API (/api/yorg/dev), for admins: the parts a system model can have, saved models, and runs of a
model against a test's data, fits of its knobs to it, and runs with knobs anchored to it; and, for the page's Script
view, the FullFlow script a run runs, what the script imports, and a run's data, to run a changed script in the
browser."""

import json
import math
from importlib import metadata
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, model_validator

from ...api.deps import DB, ActiveUser
from ...errors import Forbidden
from ...models import User
from .. import datasets
from ..api import Files
from ..models import DatasetStatus
from ..saved import Saved
from . import catalog, channels
from .catalog import in_words
from .runs import Runs
from .script import Unrunnable, script
from .spec import BadModel, Runnable, SystemModelIn, check_shape, runnable

router = APIRouter(prefix="/api/yorg/dev", tags=["yorg-dev"])

MAX_DURATION = 600.0  # simulated seconds in one run
MAX_STEPS = 200_000
MAX_KNOBS = 8  # a fit's: each costs a run per try
# What a script imports as yorg_models, a package (library.py is its __init__.py): its files, by where they go in it.
LIBRARY = {"yorg_models/__init__.py": "library.py", "yorg_models/components.py": "components.py"}
PACKAGES = ("fullflow", "thermoprop")  # and what to install from PyPI to run it, as the server has them


def admin_user(user: ActiveUser) -> User:
    if not user.is_admin:
        raise Forbidden("The dev page is for admins", code="admins_only")
    return user


AdminUser = Annotated[User, Depends(admin_user)]


def get_models(request: Request) -> Saved:
    return request.app.state.yorg_models


def get_runs(request: Request) -> Runs:
    return request.app.state.yorg_runs


SavedModels = Annotated[Saved, Depends(get_models)]
ModelRuns = Annotated[Runs, Depends(get_runs)]


class ModelSaveIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    model: SystemModelIn


class ReadingIn(BaseModel):
    """The units to read channels in when they don't say theirs."""

    pressure: str = Field(default="psi", max_length=16)
    temperature: str = Field(default="F", max_length=16)
    mass_flow: str = Field(default="lbm/s", max_length=16)


class WindowIn(BaseModel):
    """A model, and how it runs: over a window of a test's clock, in time steps of dt."""

    model: SystemModelIn
    start: float  # seconds, on the dataset's clock
    end: float
    dt: float = Field(default=0.01, ge=0.0005, le=1.0)
    # steady: FullFlow's quasi-steady sweep, in which lines, junctions, and regulators settle in each time step and
    # tanks hold the pressure measured (or set)
    solver: Literal["transient", "steady"] = "transient"

    @model_validator(mode="after")
    def _window(self) -> "WindowIn":
        if not self.end > self.start:
            raise ValueError("end must be after start")
        if self.end - self.start > MAX_DURATION:
            raise ValueError(f"a run can cover at most {MAX_DURATION:.0f} s")
        if (self.end - self.start) / self.dt > MAX_STEPS:
            raise ValueError(f"that's more than {MAX_STEPS} time steps: make the time step longer")
        return self


class RunIn(WindowIn):
    dataset_id: int
    reading: ReadingIn = Field(default_factory=ReadingIn)


class KnobIn(BaseModel):
    part: str = Field(max_length=40)
    key: str = Field(max_length=40)


class FitIn(RunIn):
    knobs: list[KnobIn] = Field(min_length=1, max_length=MAX_KNOBS)


class AnchorIn(KnobIn):
    """A knob, moved in each time step so the model reads what a sensor's channel measured."""

    sensor: str = Field(max_length=40)  # the part the channel is linked to
    link: str = Field(max_length=40)  # and the link it's in
    start: float | None = None  # when it's anchored, on the dataset's clock (left out: the run's window)
    end: float | None = None


class AnchorRunIn(RunIn):
    anchors: list[AnchorIn] = Field(min_length=1, max_length=MAX_KNOBS)
    knobs: list[KnobIn] = Field(default_factory=list, max_length=MAX_KNOBS)  # fitted, to the sensors not anchoring
    fallback: bool = True  # fit each knob whose anchor doesn't work


class ScriptIn(WindowIn):
    anchors: list[AnchorIn] = Field(default_factory=list, max_length=MAX_KNOBS)  # an anchored run's script


@router.get("/catalog")
def get_catalog(user: AdminUser) -> dict[str, Any]:
    """The parts a model can have: their settings (SI units), links, and outputs; and the liquids and gases."""
    return catalog.as_json()


@router.get("/models")
def get_saved_models(user: AdminUser, models: SavedModels) -> list[dict[str, Any]]:
    return models.all()


@router.post("/models", status_code=201)
def post_model(body: ModelSaveIn, user: AdminUser, models: SavedModels) -> dict[str, Any]:
    check_shape(body.model)
    return models.add(user, name=body.name.strip(), model=body.model.model_dump())


@router.get("/models/{model_id}")
def get_model(model_id: str, user: AdminUser, models: SavedModels) -> dict[str, Any]:
    saved = models.get(model_id)
    # As a model is saved now: a part since renamed (a press line, now a gas valve) under its new name.
    return {**saved, "model": SystemModelIn.model_validate(saved["model"]).model_dump()}


@router.put("/models/{model_id}")
def put_model(model_id: str, body: ModelSaveIn, user: AdminUser, models: SavedModels) -> dict[str, Any]:
    check_shape(body.model)
    return models.change(user, model_id, name=body.name.strip(), model=body.model.model_dump())


@router.delete("/models/{model_id}", status_code=204)
def delete_model(model_id: str, user: AdminUser, models: SavedModels) -> Response:
    models.remove(model_id)
    return Response(status_code=204)


def _window_job(body: WindowIn, checked: Runnable) -> dict[str, Any]:
    """A run's job, but for its data: the checked model, its window and time step, and its solver."""
    return {
        "model": {"nodes": checked.nodes, "edges": checked.edges},
        "liquid_of": checked.liquid_of,
        "gas_of": checked.gas_of,
        "start": body.start,
        "end": body.end,
        "dt": body.dt,
        "solver": body.solver,
    }


def _job(body: RunIn, db, files, checked: Runnable, compared: bool) -> tuple[dict[str, Any], dict[str, Any]]:
    """What a run of a checked model needs: the model, its window, and the channels it uses from the dataset (by
    name, so a model runs against any test that has them), cut to the window and in SI units. The channels it's
    only compared with come too for a fit: a run's are compared in the browser, which has their data."""
    dataset = datasets.dataset(db, body.dataset_id)
    if dataset.deleted_at is not None or dataset.status != DatasetStatus.READY or dataset.data_version is None:
        raise BadModel(f"{dataset.name} isn't ready to run against: open it in Yorg first")
    by_name = {channel.name: channel for channel in datasets.channels(db, dataset.id)}
    display = body.model.display
    reading = channels.Reading(**body.reading.model_dump(), gauge=display.gauge, ambient=display.ambient)
    folder = files.data(dataset.id, dataset.data_version)
    inputs = {}
    for part in [*checked.nodes.values(), *checked.edges.values()]:
        for link in catalog.BY_TYPE[part["type"]].links:
            name = part["links"].get(link.key, "")
            if not name or not catalog.applies(link.only_when, part["settings"]):
                continue
            if catalog.link_role(link, part["settings"]) == "sensor" and not compared:
                continue
            channel = by_name.get(name)
            if channel is None:
                raise channels.NoSuchChannel(
                    f"{part['name']}'s {in_words(link.label)} is {name}, which {dataset.name} doesn't have"
                )
            times, values = channels.load(folder, channel, body.start, body.end)
            inputs[f"{part['id']}.{link.key}"] = (times, channels.to_si(link.quantity, channel.unit, values, reading))
    return _window_job(body, checked), inputs


def _compared(parts: dict[str, dict[str, Any]]) -> list[dict[str, str]]:
    """The sensors a fit compares the model with: each linked channel's output, and the input holding it."""
    return [
        {"output": f"{part['id']}.{catalog.output_of(link)}", "input": f"{part['id']}.{link.key}"}
        for part in parts.values()
        for link in catalog.BY_TYPE[part["type"]].links
        if part["links"].get(link.key) and catalog.compared(link, part["settings"])
    ]


def _knob(parts: dict[str, dict[str, Any]], part_id: str, key: str, verb: str) -> tuple[dict[str, Any], str]:
    """A part's tunable setting that matters as the part is set up, and how it reads (Injector's CdA)."""
    part = parts.get(part_id)
    if part is None:
        raise BadModel(f"There's no part {part_id} to {verb}")
    setting = next((one for one in catalog.BY_TYPE[part["type"]].settings if one.key == key), None)
    if setting is None or not setting.tunable:
        raise BadModel(f"{part['name']} has no knob {key} to {verb}")
    named = f"{part['name']}'s {in_words(setting.label)}"
    if not catalog.applies(setting.only_when, part["settings"]):
        raise BadModel(f"{named} doesn't matter as it's set up")
    return part, named


def _anchors(body: ScriptIn | AnchorRunIn, parts: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """The anchors asked for, checked: each a knob that matters, anchored over a span of the run's window to a sensor
    of its own that the model is compared with (not one it follows)."""
    steady = body.solver == "steady"
    anchors: list[dict[str, Any]] = []
    for anchor in body.anchors:
        part, named = _knob(parts, anchor.part, anchor.key, "anchor")
        if any((one["part"], one["key"]) == (anchor.part, anchor.key) for one in anchors):
            raise BadModel(f"{named} is picked twice")
        if steady and part["type"] == "tank":
            raise BadModel(f"{named} doesn't matter in a steady run, where tanks hold their pressure")
        sensor = parts.get(anchor.sensor)
        link = (
            next((one for one in catalog.BY_TYPE[sensor["type"]].links if one.key == anchor.link), None)
            if sensor
            else None
        )
        if sensor is None or link is None or not catalog.applies(link.only_when, sensor["settings"]):
            raise BadModel(f"There's no {anchor.sensor} {anchor.link} to anchor {named} to")
        measured = f"{sensor['name']}'s {in_words(link.label)}"
        if not sensor["links"].get(link.key):
            raise BadModel(f"Link {measured} to a channel to anchor {named} to it")
        if steady and sensor["type"] == "tank":
            raise BadModel(
                f"In a steady run {sensor['name']} holds what was measured, so {measured} can't anchor {named}"
            )
        if not catalog.compared(link, sensor["settings"]):
            raise BadModel(f"The model follows {measured}, so it can't anchor {named}: pick a sensor")
        if any((one["sensor"], one["link"]) == (anchor.sensor, anchor.link) for one in anchors):
            raise BadModel(f"{measured} anchors two knobs: give each knob a sensor of its own")
        start = body.start if anchor.start is None else anchor.start
        end = body.end if anchor.end is None else anchor.end
        if start < body.start or end > body.end:
            raise BadModel(f"{named} is anchored outside the run's window")
        if end - start < body.dt:
            raise BadModel(f"{named} is anchored for less than a time step")
        anchors.append(
            {
                "part": anchor.part,
                "key": anchor.key,
                "sensor": anchor.sensor,
                "link": anchor.link,
                "start": start,
                "end": end,
            }
        )
    return anchors


@router.post("/runs", status_code=201)
def post_run(body: RunIn, user: AdminUser, db: DB, files: Files, runs: ModelRuns) -> dict[str, Any]:
    """Start running a model over a window of a dataset. Ask GET /runs/{id} how it's going."""
    job, inputs = _job(body, db, files, runnable(body.model), compared=False)
    return {"id": runs.start(user.id, job, inputs).id}


@router.post("/fits", status_code=201)
def post_fit(body: FitIn, user: AdminUser, db: DB, files: Files, runs: ModelRuns) -> dict[str, Any]:
    """Start fitting a model's knobs (settings marked tunable) to what its compared channels measured over a window
    of a dataset: the model runs again and again, its knobs turned until it matches best. Ask GET /runs/{id} how
    it's going; its result is the best run, with what the fit found."""
    checked = runnable(body.model)
    parts = {**checked.nodes, **checked.edges}
    knobs: list[tuple[str, str]] = []
    for knob in body.knobs:
        _, named = _knob(parts, knob.part, knob.key, "fit")
        if (knob.part, knob.key) in knobs:
            raise BadModel(f"{named} is picked twice")
        knobs.append((knob.part, knob.key))
    compared = _compared(parts)
    if not compared:
        raise BadModel("Link a sensor to fit the model to: a pressure transducer, a flow meter, a tank's pressure")
    job, inputs = _job(body, db, files, checked, compared=True)
    job["fit"] = {"knobs": [{"part": part, "key": key} for part, key in knobs], "compared": compared}
    return {"id": runs.start(user.id, job, inputs, kind="fit").id}


@router.post("/anchors", status_code=201)
def post_anchor(body: AnchorRunIn, user: AdminUser, db: DB, files: Files, runs: ModelRuns) -> dict[str, Any]:
    """Start a run with knobs anchored to a test (FullFlow's Sensors): in each time step of an anchor's span, FullFlow
    moves its knob, with the rest of the model, until the model reads at its sensor what the sensor's channel
    measured. Then a fit (fit.tune) of the knobs picked to fit, and, with fallback, of each knob whose anchor didn't
    work, to the sensors not anchoring, the working anchors anchored in each of its runs. Ask GET /runs/{id} how it's
    going; its result has each anchored knob's history ("anchored", by part.key) and the value it settled at
    ("anchors"), and what a fit found ("fit")."""
    checked = runnable(body.model)
    parts = {**checked.nodes, **checked.edges}
    steady = body.solver == "steady"
    anchors = _anchors(body, parts)
    fitted: list[dict[str, str]] = []
    for knob in body.knobs:
        part, named = _knob(parts, knob.part, knob.key, "fit")
        if any((one["part"], one["key"]) == (knob.part, knob.key) for one in anchors):
            raise BadModel(f"{named} is anchored and fitted: pick one")
        if any((one["part"], one["key"]) == (knob.part, knob.key) for one in fitted):
            raise BadModel(f"{named} is picked twice")
        if steady and part["type"] == "tank":
            raise BadModel(f"{named} doesn't matter in a steady run, where tanks hold their pressure")
        fitted.append({"part": knob.part, "key": knob.key})
    compared = _compared(parts)
    anchoring = {f"{one['sensor']}.{one['link']}" for one in anchors}
    if fitted and all(one["input"] in anchoring for one in compared):
        raise BadModel(
            "Every sensor anchors a knob, so there's none left to fit the others to: anchor fewer, or link another "
            "sensor"
        )
    job, inputs = _job(body, db, files, checked, compared=True)
    job.update(anchors=anchors, knobs=fitted, fallback=body.fallback, compared=compared)
    return {"id": runs.start(user.id, job, inputs, kind="anchor").id}


@router.post("/script")
def post_script(body: ScriptIn, user: AdminUser) -> dict[str, str]:
    """The FullFlow script a run of the model runs over the window (with anchors, an anchored run's: before any fit of
    what they don't settle). The server runs it as it is; the Models page shows it, and runs it changed in the
    browser, with GET /library and POST /inputs."""
    checked = runnable(body.model)
    job = {**_window_job(body, checked), "anchors": _anchors(body, {**checked.nodes, **checked.edges})}
    try:
        return {"script": script(job)}
    except Unrunnable as error:
        raise BadModel(str(error)) from error


@router.get("/library")
def get_library(user: AdminUser) -> dict[str, Any]:
    """What a model's script imports besides FullFlow: yorg_models, a package of two files (by path), and the
    packages to install from PyPI to run it as the server does (FullFlow and ThermoProp, at the server's versions)."""
    folder = Path(__file__).parent
    return {
        "files": {name: (folder / source).read_text(encoding="utf-8") for name, source in LIBRARY.items()},
        "packages": [f"{package}=={metadata.version(package)}" for package in PACKAGES],
    }


@router.post("/inputs")
def post_inputs(body: RunIn, user: AdminUser, db: DB, files: Files) -> Response:
    """A run's data, as a script gets it: each channel the model is linked to (by part.link), its samples in the
    run's window (and one each side) on the dataset's clock, in SI units. A sample that's missing is null."""
    _, inputs = _job(body, db, files, runnable(body.model), compared=True)

    def floats(values) -> list[float | None]:
        return [value if math.isfinite(value) else None for value in values]

    found = {key: {"times": floats(times), "values": floats(values)} for key, (times, values) in inputs.items()}
    # Written here rather than by FastAPI, which goes through every number on its way: channels have a lot of them.
    return Response(json.dumps({"inputs": found}, allow_nan=False), media_type="application/json")


@router.get("/runs/{run_id}")
def get_run(run_id: str, user: AdminUser, runs: ModelRuns) -> dict[str, Any]:
    """How a run or a fit is going, and its result when it's done."""
    return runs.status(run_id, user.id)


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: str, user: AdminUser, runs: ModelRuns) -> Response:
    """Stop a run or a fit (a stopped fit's status still has the best it found)."""
    runs.cancel(run_id, user.id)
    return Response(status_code=204)
