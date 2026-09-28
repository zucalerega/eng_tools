"""Yorg's rules: reading a dataset's file into channels, and who may change datasets and views.

Everyone signed in (and approved) sees every dataset and view, and can add them. Only the person who added one,
or an admin, can change or delete it. Deleting keeps everything, so a dataset can come back.
"""

import json
import logging
import secrets
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import Conflict, CvcError, Forbidden, NotFound, TooLarge
from ..models import User
from .files import DataFiles
from .ingest import ReadError, ReadOptions, read_csv
from .models import Channel, Dataset, DatasetStatus, View

log = logging.getLogger(__name__)
MAX_VIEW_BYTES = 512 * 1024


class Unreadable(CvcError):
    status = 422
    code = "unreadable"


def can_change(user: User, created_by: int | None) -> bool:
    return user.is_admin or user.id == created_by


def _check_can_change(user: User, created_by: int | None, what: str) -> None:
    if not can_change(user, created_by):
        raise Forbidden(f"Only whoever added this {what}, or an admin, can change it", code="not_yours")


# --- datasets -----------------------------------------------------------------------------------------------------


def datasets(db: Session, *, deleted: bool = False) -> Sequence[Dataset]:
    """Newest first. deleted=True: the deleted ones instead."""
    gone = Dataset.deleted_at.is_not(None) if deleted else Dataset.deleted_at.is_(None)
    return db.scalars(select(Dataset).where(gone).order_by(Dataset.created_at.desc(), Dataset.id.desc())).all()


def dataset(db: Session, dataset_id: int) -> Dataset:
    found = db.get(Dataset, dataset_id, populate_existing=True)
    if found is None:
        raise NotFound(f"There's no dataset {dataset_id}")
    return found


def channels(db: Session, dataset_id: int) -> Sequence[Channel]:
    return db.scalars(select(Channel).where(Channel.dataset_id == dataset_id).order_by(Channel.position)).all()


def add(
    db: Session,
    user: User,
    files: DataFiles,
    upload: Path,
    *,
    filename: str,
    name: str,
    description: str,
    size: int,
    sha256: str,
) -> Dataset:
    """A dataset from an uploaded file, read as the file itself suggests (read again to change that)."""
    new = Dataset(
        name=name,
        description=description,
        filename=filename,
        size=size,
        sha256=sha256,
        status=DatasetStatus.READING,
        creator=user,
    )
    db.add(new)
    db.flush()
    files.keep_source(new.id, upload)
    db.commit()
    return _read(db, files, new.id, ReadOptions())


def read(db: Session, user: User, files: DataFiles, dataset_id: int, options: ReadOptions) -> Dataset:
    """Read a dataset's file again, another way. If that doesn't work, the last read stays."""
    found = dataset(db, dataset_id)
    _check_can_change(user, found.created_by, "dataset")
    if found.deleted_at is not None:
        raise Conflict(f"{found.name} is deleted: restore it first")
    return _read(db, files, dataset_id, options)


def _read(db: Session, files: DataFiles, dataset_id: int, options: ReadOptions) -> Dataset:
    db.commit()  # hold nothing in the database while the file is read: a big one takes a while
    work = files.work_folder()
    try:
        result = read_csv(files.source(dataset_id), work, options)
    except ReadError as error:
        files.drop(work)
        return _failed(db, dataset_id, str(error), options)
    except Exception:
        files.drop(work)
        log.exception("Reading dataset %s failed", dataset_id)
        return _failed(db, dataset_id, "Something went wrong reading this file; the server's log says what.", options)

    version = secrets.token_hex(8)
    files.keep_data(dataset_id, work, version)
    found = dataset(db, dataset_id)
    replaced = found.data_version
    db.execute(delete(Channel).where(Channel.dataset_id == dataset_id))
    db.add_all(Channel(dataset_id=dataset_id, **asdict(channel)) for channel in result.channels)
    found.status = DatasetStatus.READY
    found.error = None
    found.data_version = version
    found.rows = result.rows
    found.channel_count = len(result.channels)
    found.time_kind = result.time_kind
    found.start_epoch = result.start_epoch
    found.t_min, found.t_max = result.t_min, result.t_max
    found.sample_rate = result.sample_rate
    found.read_options = options.as_dict()
    found.read_info = result.info
    found.warnings = result.warnings
    found.events = result.events
    found.updated_at = utcnow()
    db.commit()
    if replaced:
        files.drop(files.data(dataset_id, replaced))
    return found


def _failed(db: Session, dataset_id: int, message: str, options: ReadOptions) -> Dataset:
    found = dataset(db, dataset_id)
    if found.status == DatasetStatus.READY:  # its last read still stands; say why this one didn't work
        raise Unreadable(message)
    found.status = DatasetStatus.FAILED
    found.error = message
    found.read_options = options.as_dict()
    found.updated_at = utcnow()
    db.commit()
    return found


def update(db: Session, user: User, dataset_id: int, *, name: str | None, description: str | None) -> Dataset:
    found = dataset(db, dataset_id)
    _check_can_change(user, found.created_by, "dataset")
    if name is not None:
        found.name = name
    if description is not None:
        found.description = description
    found.updated_at = utcnow()
    db.commit()
    return found


def remove(db: Session, user: User, dataset_id: int) -> Dataset:
    """Delete a dataset: it's hidden, with its file and arrays kept, until someone restores it."""
    found = dataset(db, dataset_id)
    _check_can_change(user, found.created_by, "dataset")
    if found.deleted_at is None:
        found.deleted_at = utcnow()
        found.deleter = user
        db.commit()
    return found


def restore(db: Session, user: User, dataset_id: int) -> Dataset:
    found = dataset(db, dataset_id)
    _check_can_change(user, found.created_by, "dataset")
    found.deleted_at = None
    found.deleter = None
    db.commit()
    return found


def recover(db: Session) -> None:
    """At startup: datasets the server was reading when it stopped can be read again."""
    for found in db.scalars(select(Dataset).where(Dataset.status == DatasetStatus.READING)):
        found.status = DatasetStatus.FAILED
        found.error = "The server stopped while it was reading this file. Read it again."
    db.commit()


# --- views --------------------------------------------------------------------------------------------------------


def views(db: Session) -> Sequence[View]:
    """The most recently changed first."""
    return db.scalars(select(View).order_by(View.updated_at.desc(), View.id.desc())).all()


def view(db: Session, view_id: int) -> View:
    found = db.get(View, view_id, populate_existing=True)
    if found is None:
        raise NotFound(f"There's no view {view_id}")
    return found


def _check_size(config: dict[str, Any]) -> None:
    if len(json.dumps(config)) > MAX_VIEW_BYTES:
        raise TooLarge(f"A view can be up to {MAX_VIEW_BYTES // 1024} KB")


def add_view(
    db: Session, user: User, *, name: str, description: str, datasets: list[int], config: dict[str, Any]
) -> View:
    _check_size(config)
    new = View(
        name=name,
        description=description,
        datasets=datasets,
        config=config,
        creator=user,
        editor=user,
    )
    db.add(new)
    db.commit()
    return new


def update_view(
    db: Session,
    user: User,
    view_id: int,
    *,
    name: str,
    description: str,
    datasets: list[int],
    config: dict[str, Any],
) -> View:
    found = view(db, view_id)
    _check_can_change(user, found.created_by, "view")
    _check_size(config)
    found.name = name
    found.description = description
    found.datasets = datasets
    found.config = config
    found.updated_at = utcnow()
    found.editor = user
    db.commit()
    return found


def remove_view(db: Session, user: User, view_id: int) -> None:
    found = view(db, view_id)
    _check_can_change(user, found.created_by, "view")
    db.delete(found)
    db.commit()
