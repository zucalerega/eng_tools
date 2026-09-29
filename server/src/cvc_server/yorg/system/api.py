"""The dev page's API (/api/yorg/dev), for admins: the parts a system model can have, saved models, and runs of a
model against a test's data."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, model_validator

from ...api.deps import DB, ActiveUser
from ...errors import Forbidden
from ...models import User
from .. import datasets
from ..api import Files
from ..models import DatasetStatus
from . import catalog, channels
from .runs import Runs
from .spec import BadModel, SystemModelIn, check_shape, runnable
from .store import Models

router = APIRouter(prefix="/api/yorg/dev", tags=["yorg-dev"])

MAX_DURATION = 600.0  # simulated seconds in one run
MAX_STEPS = 200_000


def admin_user(user: ActiveUser) -> User:
    if not user.is_admin:
        raise Forbidden("The dev page is for admins", code="admins_only")
    return user


AdminUser = Annotated[User, Depends(admin_user)]


def get_models(request: Request) -> Models:
    return request.app.state.yorg_models


def get_runs(request: Request) -> Runs:
    return request.app.state.yorg_runs


SavedModels = Annotated[Models, Depends(get_models)]
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
    return models.add(user, body.name.strip(), body.model.model_dump())


@router.get("/models/{model_id}")
def get_model(model_id: str, user: AdminUser, models: SavedModels) -> dict[str, Any]:
    return models.get(model_id)


@router.put("/models/{model_id}")
def put_model(model_id: str, body: ModelSaveIn, user: AdminUser, models: SavedModels) -> dict[str, Any]:
    check_shape(body.model)
    return models.change(user, model_id, body.name.strip(), body.model.model_dump())


@router.delete("/models/{model_id}", status_code=204)
def delete_model(model_id: str, user: AdminUser, models: SavedModels) -> Response:
    models.remove(model_id)
    return Response(status_code=204)


@router.post("/runs", status_code=201)
def post_run(body: RunIn, user: AdminUser, db: DB, files: Files, runs: ModelRuns) -> dict[str, Any]:
    """Start running a model over a window of a dataset: the channels it follows come from that dataset (by name, so
    the model runs against any test that has them). Ask GET /runs/{id} how it's going."""
    checked = runnable(body.model)
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
            if not name or link.role == "sensor":
                continue  # sensors are compared with the model in the browser, which has their data
            channel = by_name.get(name)
            if channel is None:
                raise channels.NoSuchChannel(
                    f"{part['name']}'s {link.label.lower()} is {name}, which {dataset.name} doesn't have"
                )
            times, values = channels.load(folder, channel, body.start, body.end)
            inputs[f"{part['id']}.{link.key}"] = (times, channels.to_si(link.quantity, channel.unit, values, reading))
    job = {
        "model": {"nodes": checked.nodes, "edges": checked.edges},
        "liquid_of": checked.liquid_of,
        "start": body.start,
        "end": body.end,
        "dt": body.dt,
    }
    return {"id": runs.start(user.id, job, inputs).id}


@router.get("/runs/{run_id}")
def get_run(run_id: str, user: AdminUser, runs: ModelRuns) -> dict[str, Any]:
    return runs.status(run_id, user.id)


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: str, user: AdminUser, runs: ModelRuns) -> Response:
    runs.cancel(run_id, user.id)
    return Response(status_code=204)
