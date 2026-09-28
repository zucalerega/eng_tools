"""Yorg's API (/api/yorg): datasets (upload a file, read it, fetch its arrays) and saved views."""

import hashlib
import re
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..api.deps import DB, ActiveUser, Config
from ..errors import CvcError, NotFound, TooLarge
from ..models import User
from . import datasets
from .files import DataFiles
from .models import Dataset
from .schemas import (
    DatasetChangeIn,
    DatasetDetailOut,
    DatasetOut,
    FormulaIn,
    FormulaOut,
    ReadOptionsIn,
    ViewIn,
    ViewOut,
)

router = APIRouter(prefix="/api/yorg", tags=["yorg"])

_VERSION = re.compile(r"^[0-9a-f]{16}$")
_ARRAY = re.compile(r"^(?:time|c\d{1,4}(?:\.t)?)\.f64$")
# An array's URL names one read of the file, so its bytes never change: browsers can keep them.
_FOREVER = {"Cache-Control": "private, max-age=31536000, immutable"}


def get_files(request: Request) -> DataFiles:
    return request.app.state.yorg_files


Files = Annotated[DataFiles, Depends(get_files)]


def _detail(db: Session, dataset: Dataset, user: User) -> DatasetDetailOut:
    return DatasetDetailOut.of_detail(dataset, list(datasets.channels(db, dataset.id)), user)


@router.get("/datasets")
def get_datasets(user: ActiveUser, db: DB, deleted: bool = False) -> list[DatasetOut]:
    """Every dataset, newest first (deleted=true: the deleted ones)."""
    return [DatasetOut.of(dataset, user) for dataset in datasets.datasets(db, deleted=deleted)]


@router.post("/datasets", status_code=201)
async def post_dataset(
    request: Request,
    user: ActiveUser,
    db: DB,
    files: Files,
    settings: Config,
    filename: Annotated[str, Query(min_length=1, max_length=255)],
    name: Annotated[str | None, Query(max_length=200)] = None,
    description: Annotated[str, Query(max_length=5000)] = "",
) -> DatasetDetailOut:
    """Upload a file of test data (a CSV) as the raw request body, and read it.

    A file that can't be read is kept, with status "failed" and an error that says why: read it again another way
    (POST .../read) rather than uploading it again.
    """
    filename = filename.replace("\\", "/").rsplit("/", 1)[-1].strip() or "data.csv"
    limit = settings.max_upload_mb * 1024 * 1024
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise TooLarge(f"Files over {settings.max_upload_mb} MB aren't accepted")
    temp = files.temp_path()
    try:
        digest, size = hashlib.sha256(), 0
        with temp.open("wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise TooLarge(f"Files over {settings.max_upload_mb} MB aren't accepted")
                digest.update(chunk)
                out.write(chunk)
        if size == 0:
            raise CvcError(f"{filename} is empty", code="empty")
        dataset = await run_in_threadpool(
            datasets.add,
            db,
            user,
            files,
            temp,
            filename=filename,
            name=((name or "").strip() or filename.rsplit(".", 1)[0] or filename)[:200],
            description=description,
            size=size,
            sha256=digest.hexdigest(),
        )
        return await run_in_threadpool(_detail, db, dataset, user)
    finally:
        temp.unlink(missing_ok=True)


@router.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: int, user: ActiveUser, db: DB) -> DatasetDetailOut:
    """A dataset with its channels, events, and how its file was read."""
    return _detail(db, datasets.dataset(db, dataset_id), user)


@router.patch("/datasets/{dataset_id}")
def patch_dataset(dataset_id: int, body: DatasetChangeIn, user: ActiveUser, db: DB) -> DatasetOut:
    return DatasetOut.of(datasets.update(db, user, dataset_id, name=body.name, description=body.description), user)


@router.post("/datasets/{dataset_id}/read")
def post_read(dataset_id: int, body: ReadOptionsIn, user: ActiveUser, db: DB, files: Files) -> DatasetDetailOut:
    """Read the file again another way (the time column, its format, where the names are). If that fails, 422."""
    return _detail(db, datasets.read(db, user, files, dataset_id, body.options()), user)


@router.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: int, user: ActiveUser, db: DB) -> DatasetOut:
    """Delete a dataset. Its file and arrays are kept, so it can be restored."""
    return DatasetOut.of(datasets.remove(db, user, dataset_id), user)


@router.post("/datasets/{dataset_id}/restore")
def post_restore(dataset_id: int, user: ActiveUser, db: DB) -> DatasetOut:
    return DatasetOut.of(datasets.restore(db, user, dataset_id), user)


@router.get("/datasets/{dataset_id}/source", response_class=FileResponse)
def get_source(dataset_id: int, user: ActiveUser, db: DB, files: Files) -> FileResponse:
    """The file as it was uploaded."""
    dataset = datasets.dataset(db, dataset_id)
    return FileResponse(files.source(dataset.id), filename=dataset.filename, media_type="application/octet-stream")


@router.get("/datasets/{dataset_id}/data/{version}/{name}", response_class=FileResponse)
def get_array(dataset_id: int, version: str, name: str, user: ActiveUser, db: DB, files: Files) -> FileResponse:
    """One of a read's arrays (a channel's ChannelOut.time or .values): little-endian float64."""
    dataset = datasets.dataset(db, dataset_id)
    if dataset.deleted_at is not None:
        raise NotFound(f"{dataset.name} is deleted")
    if version != dataset.data_version or not _VERSION.match(version):
        raise NotFound(f"{dataset.name} has been read again since: load it again", code="stale")
    path = files.data(dataset.id, version) / name
    if not _ARRAY.match(name) or not path.is_file():
        raise NotFound(f"{dataset.name} has no array {name}")
    return FileResponse(path, media_type="application/octet-stream", headers=_FOREVER)


@router.get("/formulas")
def get_formulas(user: ActiveUser, db: DB) -> list[FormulaOut]:
    """Calculated channels, by name."""
    return [FormulaOut.of(formula, user) for formula in datasets.formulas(db)]


@router.post("/formulas", status_code=201)
def post_formula(body: FormulaIn, user: ActiveUser, db: DB) -> FormulaOut:
    new = datasets.add_formula(
        db, user, name=body.name, expression=body.expression, unit=body.unit.strip(), description=body.description
    )
    return FormulaOut.of(new, user)


@router.put("/formulas/{formula_id}")
def put_formula(formula_id: int, body: FormulaIn, user: ActiveUser, db: DB) -> FormulaOut:
    changed = datasets.update_formula(
        db,
        user,
        formula_id,
        name=body.name,
        expression=body.expression,
        unit=body.unit.strip(),
        description=body.description,
    )
    return FormulaOut.of(changed, user)


@router.delete("/formulas/{formula_id}", status_code=204)
def delete_formula(formula_id: int, user: ActiveUser, db: DB) -> Response:
    datasets.remove_formula(db, user, formula_id)
    return Response(status_code=204)


@router.get("/views")
def get_views(user: ActiveUser, db: DB) -> list[ViewOut]:
    """Saved views, the most recently changed first."""
    return [ViewOut.of(view, user) for view in datasets.views(db)]


@router.post("/views", status_code=201)
def post_view(body: ViewIn, user: ActiveUser, db: DB) -> ViewOut:
    new = datasets.add_view(
        db, user, name=body.name, description=body.description, datasets=body.datasets, config=body.config
    )
    return ViewOut.of(new, user)


@router.get("/views/{view_id}")
def get_view(view_id: int, user: ActiveUser, db: DB) -> ViewOut:
    return ViewOut.of(datasets.view(db, view_id), user)


@router.put("/views/{view_id}")
def put_view(view_id: int, body: ViewIn, user: ActiveUser, db: DB) -> ViewOut:
    changed = datasets.update_view(
        db,
        user,
        view_id,
        name=body.name,
        description=body.description,
        datasets=body.datasets,
        config=body.config,
    )
    return ViewOut.of(changed, user)


@router.delete("/views/{view_id}", status_code=204)
def delete_view(view_id: int, user: ActiveUser, db: DB) -> Response:
    datasets.remove_view(db, user, view_id)
    return Response(status_code=204)
