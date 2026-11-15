"""Yorg's saved views, and the folders they're kept in.

Everyone signed in sees every view and can save them; only whoever saved one, or an admin, changes it: renames it,
moves it to another folder, changes its plots, or deletes it (for good: views aren't restored). Several are moved or
deleted together, all or none.

Views have a tree of folders of their own (a campaign's, a test day's), kept by the datasets' folders' rules
(datasets.py): anyone makes a folder; whoever made it, or an admin, renames it, moves it (never inside itself), or
deletes it once it's empty. Two folders in one can't have names that differ only in case. Before folders were their
own, a view's folder was a path ("Hotfires/HF-3"); a request may still name one so, and the folders on it are made
where they aren't there yet (folder_at), so older clients work as they did.
"""

import json
from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import ApiError, Conflict, NotFound, TooLarge
from ..models import User
from .datasets import check_can_change
from .models import View, ViewFolder

MAX_VIEW_BYTES = 512 * 1024
MAX_NAME = 200  # a folder's


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
    db: Session,
    user: User,
    *,
    name: str,
    description: str,
    datasets: list[int],
    config: dict[str, Any],
    folder_id: int | None = None,
) -> View:
    """A new view, in a folder (None: at the top)."""
    _check_size(config)
    target = folder(db, folder_id) if folder_id is not None else None
    new = View(
        name=name,
        folder=target,
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
    folder_id: int | None = None,
    move: bool = False,
) -> View:
    """A view changed, and (move) put in a folder (folder_id None: at the top). Without move it stays where it is, as
    a client from before views had folders, which names none, leaves it."""
    found = view(db, view_id)
    check_can_change(user, found.created_by, "view")
    _check_size(config)
    if move and folder_id != found.folder_id:
        found.folder = folder(db, folder_id) if folder_id is not None else None
    found.name = name
    found.description = description
    found.datasets = datasets
    found.config = config
    found.updated_at = utcnow()
    found.editor = user
    db.commit()
    return found


def move_views(db: Session, user: User, view_ids: Sequence[int], folder_id: int | None) -> list[View]:
    """Put views in a folder (None: at the top): all of them, or none if one isn't there or isn't yours to move. Their
    plots don't change; each that moves is changed, by you."""
    target = folder(db, folder_id) if folder_id is not None else None
    moving = [view(db, view_id) for view_id in dict.fromkeys(view_ids)]
    for found in moving:
        check_can_change(user, found.created_by, "view")
    now = utcnow()
    for found in moving:
        if found.folder_id != folder_id:
            found.folder, found.updated_at, found.editor = target, now, user
    db.commit()
    return moving


def remove_view(db: Session, user: User, view_id: int) -> None:
    remove_views(db, user, [view_id])


def remove_views(db: Session, user: User, view_ids: Sequence[int]) -> None:
    """Delete views, for good (the data they plot stays): all of them, or none if one isn't there or isn't yours."""
    removing = [view(db, view_id) for view_id in dict.fromkeys(view_ids)]
    for found in removing:
        check_can_change(user, found.created_by, "view")
    for found in removing:
        db.delete(found)
    db.commit()


# --- folders ------------------------------------------------------------------------------------------------------


def folders(db: Session) -> Sequence[ViewFolder]:
    """Every folder, by name."""
    return db.scalars(select(ViewFolder).order_by(ViewFolder.name_key, ViewFolder.id)).all()


def folder(db: Session, folder_id: int) -> ViewFolder:
    found = db.get(ViewFolder, folder_id, populate_existing=True)
    if found is None:
        raise NotFound(f"There's no folder {folder_id}: it may have been deleted")
    return found


def _named(db: Session, name: str, parent_id: int | None) -> ViewFolder | None:
    """The folder in another (or at the top) with this name, whatever its case."""
    return db.scalar(
        select(ViewFolder).where(
            ViewFolder.parent_id.is_(None) if parent_id is None else ViewFolder.parent_id == parent_id,
            ViewFolder.name_key == name.lower(),
        )
    )


def _check_name(db: Session, name: str, parent_id: int | None, folder_id: int | None = None) -> None:
    taken = _named(db, name, parent_id)
    if taken is not None and taken.id != folder_id:
        raise Conflict(f"There's already a folder called {taken.name} there", code="name_taken")


def add_folder(db: Session, user: User, *, name: str, parent_id: int | None) -> ViewFolder:
    if parent_id is not None:
        folder(db, parent_id)
    _check_name(db, name, parent_id)
    new = ViewFolder(name=name, name_key=name.lower(), parent_id=parent_id, creator=user)
    db.add(new)
    db.commit()
    return new


def change_folder(
    db: Session, user: User, folder_id: int, *, name: str | None = None, parent_id: int | None = None, move: bool
) -> ViewFolder:
    """Rename a folder, or (move) put it in another folder, or at the top (parent_id None)."""
    found = folder(db, folder_id)
    check_can_change(user, found.created_by, "folder")
    parent = parent_id if move else found.parent_id
    above = parent
    while above is not None:  # up from where it's going: it mustn't be on the way
        if above == found.id:
            raise Conflict(f"{found.name} can't go inside itself", code="cycle")
        above = folder(db, above).parent_id
    new_name = name if name is not None else found.name
    _check_name(db, new_name, parent, found.id)
    found.name, found.name_key, found.parent_id = new_name, new_name.lower(), parent
    db.commit()
    return found


def remove_folder(db: Session, user: User, folder_id: int) -> None:
    """Delete an empty folder: no folders in it, and no views (which aren't kept once deleted, so none wait in it)."""
    found = folder(db, folder_id)
    check_can_change(user, found.created_by, "folder")
    inside = db.scalar(select(ViewFolder.id).where(ViewFolder.parent_id == found.id).limit(1)) is not None
    inside = inside or db.scalar(select(View.id).where(View.folder_id == found.id).limit(1)) is not None
    if inside:
        raise Conflict(f"{found.name} isn't empty: move what's in it out first", code="not_empty")
    db.delete(found)
    db.commit()


def folder_at(db: Session, user: User, path: str) -> int | None:
    """The folder at a path ("Hotfires/HF-3", tidied: FolderPath), made where it isn't there yet (as yours); None for
    "", the top. Its parts are matched whatever their case, as folders' names are."""
    parent: int | None = None
    for name in [part for part in path.split("/") if part]:
        if len(name) > MAX_NAME:
            raise ApiError(f"A folder's name can be up to {MAX_NAME} characters: {name[:40]}… is longer")
        found = _named(db, name, parent)
        if found is None:
            found = ViewFolder(name=name, name_key=name.lower(), parent_id=parent, creator=user)
            db.add(found)
            db.flush()
        parent = found.id
    return parent
