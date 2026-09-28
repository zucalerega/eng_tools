"""Yorg's rules: reading a dataset's file into channels, and who may change datasets and views.

Everyone signed in (and approved) sees every dataset, view, and calculated channel, and can add them. Only the person
who added one, or an admin, can change or delete it. Deleting a dataset keeps everything, so it can come back.
"""

import json
import logging
import secrets
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import Conflict, CvcError, Forbidden, NotFound, TooLarge
from ..models import User
from .files import DataFiles
from .ingest import ReadError, ReadOptions, read_csv
from .models import Channel, DataFolder, Dataset, DatasetStatus, Formula, View
from .pieces import Cutter

log = logging.getLogger(__name__)
MAX_VIEW_BYTES = 512 * 1024


class Unreadable(CvcError):
    status = 422
    code = "unreadable"


class EmptyPiece(CvcError):
    status = 422
    code = "empty_piece"


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
    folder_id: int | None = None,
) -> Dataset:
    """A dataset from an uploaded file, read as the file itself suggests (read again to change that)."""
    if folder_id is not None:
        folder(db, folder_id)
    new = Dataset(
        folder_id=folder_id,
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
    if split_from := found.read_info.get("split_from"):
        raise Conflict(
            f"{found.name} was split from {split_from['name']}, and has no file of its own:"
            f" read {split_from['name']} again, and split it again",
            code="split",
        )
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


@dataclass
class PieceSpec:
    """A span of a dataset to make a dataset of: its name, its first and last times, and the time to count from."""

    name: str
    start: float
    end: float
    zero: float | None  # None: times as they are


def split(
    db: Session, user: User, files: DataFiles, dataset_id: int, pieces: Sequence[PieceSpec], *, folder_id: int | None
) -> list[Dataset]:
    """Datasets from spans of one (the tests in a file of several): all of them, or none if a span has no samples.

    Each copies its span's samples, with times counted from its zero, and says where it came from (its read_info's
    split_from). The dataset they come from doesn't change. They're whoever split them's, like an upload.
    """
    found = dataset(db, dataset_id)
    if found.deleted_at is not None:
        raise Conflict(f"{found.name} is deleted: restore it first")
    if found.status != DatasetStatus.READY or not found.data_version:
        raise Conflict(f"{found.name} hasn't been read, so there's nothing to split", code="not_read")
    if folder_id is not None:
        folder(db, folder_id)
    cutter = Cutter(files.data(found.id, found.data_version), channels(db, found.id), found.events)
    for piece in pieces:
        if cutter.rows(piece.start, piece.end) == 0:
            raise EmptyPiece(
                f"{piece.name} would be empty: {found.name} has no samples from {piece.start:g} to {piece.end:g} s"
            )
    db.commit()  # hold nothing in the database while the arrays are copied: a long test takes a while
    works: list[Path] = []
    try:
        cuts = []
        for piece in pieces:
            works.append(files.work_folder())
            cuts.append(cutter.cut(works[-1], piece.start, piece.end, piece.zero or 0.0))
    except BaseException:
        for work in works:
            files.drop(work)
        raise
    made: list[Dataset] = []
    placed: list[Path] = []  # their folders, once their arrays are in them
    try:
        for piece, cut, work in zip(pieces, cuts, works, strict=True):
            zero = piece.zero or 0.0
            version = secrets.token_hex(8)
            new = Dataset(
                folder_id=folder_id,
                name=piece.name,
                description="",
                filename=found.filename,
                size=cut.size,
                sha256=cut.sha256,
                status=DatasetStatus.READY,
                creator=user,
                data_version=version,
                rows=cut.rows,
                channel_count=len(cut.channels),
                time_kind=found.time_kind,
                start_epoch=None if found.start_epoch is None else found.start_epoch + zero,
                t_min=cut.t_min,
                t_max=cut.t_max,
                sample_rate=found.sample_rate,
                read_options={},
                read_info={
                    **found.read_info,
                    "split_from": {
                        "dataset": found.id,
                        "name": found.name,
                        "start": piece.start,
                        "end": piece.end,
                        "zero": piece.zero,
                    },
                },
                warnings=[f"Left out {name}: it has no samples in this span." for name in cut.left_out],
                events=cut.events,
            )
            db.add(new)
            db.flush()
            made.append(new)
            placed.append(files.folder(new.id))
            files.keep_data(new.id, work, version)
            db.add_all(Channel(dataset_id=new.id, **asdict(channel)) for channel in cut.channels)
        db.commit()
    except BaseException:
        db.rollback()
        for path in placed + works:  # a work folder that was moved into place is gone already
            files.drop(path)
        raise
    return made


def recover(db: Session) -> None:
    """At startup: datasets the server was reading when it stopped can be read again."""
    for found in db.scalars(select(Dataset).where(Dataset.status == DatasetStatus.READING)):
        found.status = DatasetStatus.FAILED
        found.error = "The server stopped while it was reading this file. Read it again."
    db.commit()


# --- folders ------------------------------------------------------------------------------------------------------


def folders(db: Session) -> Sequence[DataFolder]:
    return db.scalars(select(DataFolder).order_by(DataFolder.name_key, DataFolder.id)).all()


def folder(db: Session, folder_id: int) -> DataFolder:
    found = db.get(DataFolder, folder_id, populate_existing=True)
    if found is None:
        raise NotFound(f"There's no folder {folder_id}")
    return found


def _check_folder_name(db: Session, name: str, parent_id: int | None, folder_id: int | None = None) -> None:
    taken = db.scalar(
        select(DataFolder).where(
            DataFolder.parent_id.is_(None) if parent_id is None else DataFolder.parent_id == parent_id,
            DataFolder.name_key == name.lower(),
            DataFolder.id != (folder_id or 0),
        )
    )
    if taken is not None:
        raise Conflict(f"There's already a folder called {taken.name} there", code="name_taken")


def add_folder(db: Session, user: User, *, name: str, parent_id: int | None) -> DataFolder:
    if parent_id is not None:
        folder(db, parent_id)
    _check_folder_name(db, name, parent_id)
    new = DataFolder(name=name, name_key=name.lower(), parent_id=parent_id, creator=user)
    db.add(new)
    db.commit()
    return new


def change_folder(
    db: Session, user: User, folder_id: int, *, name: str | None = None, parent_id: int | None, move: bool
) -> DataFolder:
    """Rename a folder, or (move) put it in another folder, or at the top (parent_id None)."""
    found = folder(db, folder_id)
    _check_can_change(user, found.created_by, "folder")
    parent = parent_id if move else found.parent_id
    if move and parent is not None:
        above: int | None = parent
        while above is not None:  # up from the new place: this folder mustn't be there
            if above == found.id:
                raise Conflict(f"{found.name} can't go inside itself", code="cycle")
            above = folder(db, above).parent_id
    new_name = name if name is not None else found.name
    _check_folder_name(db, new_name, parent, found.id)
    found.name, found.name_key, found.parent_id = new_name, new_name.lower(), parent
    db.commit()
    return found


def remove_folder(db: Session, user: User, folder_id: int) -> None:
    """Delete an empty folder. Deleted datasets that were in it go to its folder, to be restored there."""
    found = folder(db, folder_id)
    _check_can_change(user, found.created_by, "folder")
    inside = db.scalar(select(DataFolder.id).where(DataFolder.parent_id == found.id).limit(1)) is not None
    inside = (
        inside
        or db.scalar(select(Dataset.id).where(Dataset.folder_id == found.id, Dataset.deleted_at.is_(None)).limit(1))
        is not None
    )
    if inside:
        raise Conflict(f"{found.name} isn't empty: move what's in it out first", code="not_empty")
    for gone in db.scalars(select(Dataset).where(Dataset.folder_id == found.id)):
        gone.folder_id = found.parent_id
    db.delete(found)
    db.commit()


def move(db: Session, user: User, dataset_ids: list[int], folder_id: int | None) -> Sequence[Dataset]:
    """Put datasets in a folder (or at the top): all of them, or none if any isn't yours to move."""
    if folder_id is not None:
        folder(db, folder_id)
    moving = [dataset(db, dataset_id) for dataset_id in dataset_ids]
    for found in moving:
        _check_can_change(user, found.created_by, "dataset")
    for found in moving:
        found.folder_id = folder_id
    db.commit()
    return moving


# --- calculated channels ------------------------------------------------------------------------------------------


def formulas(db: Session) -> Sequence[Formula]:
    """By name."""
    return db.scalars(select(Formula).order_by(Formula.name_key)).all()


def formula(db: Session, formula_id: int) -> Formula:
    found = db.get(Formula, formula_id, populate_existing=True)
    if found is None:
        raise NotFound(f"There's no calculated channel {formula_id}")
    return found


def _check_name_free(db: Session, name: str, formula_id: int | None = None) -> None:
    taken = db.scalar(select(Formula).where(Formula.name_key == name.lower(), Formula.id != (formula_id or 0)))
    if taken is not None:
        raise Conflict(f"There's already a calculated channel called {taken.name}", code="name_taken")


def add_formula(db: Session, user: User, *, name: str, expression: str, unit: str, description: str) -> Formula:
    _check_name_free(db, name)
    new = Formula(
        name=name,
        name_key=name.lower(),
        expression=expression,
        unit=unit,
        description=description,
        creator=user,
        editor=user,
    )
    db.add(new)
    db.commit()
    return new


def update_formula(
    db: Session, user: User, formula_id: int, *, name: str, expression: str, unit: str, description: str
) -> Formula:
    found = formula(db, formula_id)
    _check_can_change(user, found.created_by, "calculated channel")
    _check_name_free(db, name, formula_id)
    found.name = name
    found.name_key = name.lower()
    found.expression = expression
    found.unit = unit
    found.description = description
    found.updated_at = utcnow()
    found.editor = user
    db.commit()
    return found


def remove_formula(db: Session, user: User, formula_id: int) -> None:
    found = formula(db, formula_id)
    _check_can_change(user, found.created_by, "calculated channel")
    db.delete(found)
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
