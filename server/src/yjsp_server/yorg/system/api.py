"""The dev page's API (/api/yorg/dev), for admins: the parts a system model can have, saved models, and runs of a
model against a test's data, and fits of its knobs to it."""

from typing import Annotated, Any

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
from .spec import BadModel, Runnable, SystemModelIn, check_shape, runnable

router = APIRouter(prefix="/api/yorg/dev", tags=["yorg-dev"])

MAX_DURATION = 600.0  # simulated seconds in one run
MAX_STEPS = 200_000
MAX_KNOBS = 8  # a fit's: each costs a run per try


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


class RunIn(BaseModel):
    model: SystemModelIn
    dataset_id: int
    start: float  # seconds, on the dataset's clock
    end: float
    dt: float = Field(default=0.01, ge=0.0005, le=1.0)
    reading: ReadingIn = Field(default_factory=ReadingIn)

    @model_validator(mode="after")
    def _window(self) -> "RunIn":
        if not self.end > self.start:
            raise ValueError("end must be after start")
        if self.end - self.start > MAX_DURATION:
            raise ValueError(f"a run can cover at most {MAX_DURATION:.0f} s")
        if (self.end - self.start) / self.dt > MAX_STEPS:
            raise ValueError(f"that's more than {MAX_STEPS} time steps: make the time step longer")
        return self


class KnobIn(BaseModel):
    part: str = Field(max_length=40)
    key: str = Field(max_length=40)


class FitIn(RunIn):
    knobs: list[KnobIn] = Field(min_length=1, max_length=MAX_KNOBS)


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
    job = {
        "model": {"nodes": checked.nodes, "edges": checked.edges},
        "liquid_of": checked.liquid_of,
        "gas_of": checked.gas_of,
        "start": body.start,
        "end": body.end,
        "dt": body.dt,
    }
    return job, inputs


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
        part = parts.get(knob.part)
        if part is None:
            raise BadModel(f"There's no part {knob.part} to fit")
        setting = next((one for one in catalog.BY_TYPE[part["type"]].settings if one.key == knob.key), None)
        if setting is None or not setting.tunable:
            raise BadModel(f"{part['name']} has no knob {knob.key} to fit")
        if not catalog.applies(setting.only_when, part["settings"]):
            raise BadModel(f"{part['name']}'s {in_words(setting.label)} doesn't matter as it's set up")
        if (knob.part, knob.key) in knobs:
            raise BadModel(f"{part['name']}'s {in_words(setting.label)} is picked twice")
        knobs.append((knob.part, knob.key))
    compared = [
        {"output": f"{part['id']}.{catalog.output_of(link)}", "input": f"{part['id']}.{link.key}"}
        for part in parts.values()
        for link in catalog.BY_TYPE[part["type"]].links
        if part["links"].get(link.key) and catalog.compared(link, part["settings"])
    ]
    if not compared:
        raise BadModel("Link a sensor to fit the model to: a pressure transducer, a flow meter, a tank's pressure")
    job, inputs = _job(body, db, files, checked, compared=True)
    job["fit"] = {"knobs": [{"part": part, "key": key} for part, key in knobs], "compared": compared}
    return {"id": runs.start(user.id, job, inputs, kind="fit").id}


@router.get("/runs/{run_id}")
def get_run(run_id: str, user: AdminUser, runs: ModelRuns) -> dict[str, Any]:
    """How a run or a fit is going, and its result when it's done."""
    return runs.status(run_id, user.id)


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: str, user: AdminUser, runs: ModelRuns) -> Response:
    """Stop a run or a fit (a stopped fit's status still has the best it found)."""
    runs.cancel(run_id, user.id)
    return Response(status_code=204)
