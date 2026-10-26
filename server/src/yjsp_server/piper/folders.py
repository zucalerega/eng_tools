"""Piper's folders: where diagrams are kept (the vehicle's, a test stand's), each in another folder or at the top, as
Yorg's datasets are.

A diagram is the team's, and anyone moves one, so anyone makes, renames, and moves a folder too, and deletes one once
it's empty: nothing is lost by it (the deleted diagrams that were in it go to the folder it was in, to be restored
there). Two folders in one can't have names that differ only in case, and a folder can't go inside itself. Before
folders were their own, a diagram's folder was a path ("Vespula/GSE"); a request may still name one so, and the
folders on it are made where they aren't there yet (folder_at).
"""

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..errors import ApiError, Conflict, NotFound
from ..models import User
from .models import Diagram, DiagramFolder

MAX_NAME = 200


def folders(db: Session) -> Sequence[DiagramFolder]:
    """Every folder, by name."""
    return db.scalars(select(DiagramFolder).order_by(DiagramFolder.name_key, DiagramFolder.id)).all()


def folder(db: Session, folder_id: int) -> DiagramFolder:
    found = db.get(DiagramFolder, folder_id, populate_existing=True)
    if found is None:
        raise NotFound(f"There's no folder {folder_id}: it may have been deleted")
    return found


def _named(db: Session, name: str, parent_id: int | None) -> DiagramFolder | None:
    """The folder in another (or at the top) with this name, whatever its case."""
    return db.scalar(
        select(DiagramFolder).where(
            DiagramFolder.parent_id.is_(None) if parent_id is None else DiagramFolder.parent_id == parent_id,
            DiagramFolder.name_key == name.lower(),
        )
    )


def _check_name(db: Session, name: str, parent_id: int | None, folder_id: int | None = None) -> None:
    taken = _named(db, name, parent_id)
    if taken is not None and taken.id != folder_id:
        raise Conflict(f"There's already a folder called {taken.name} there", code="name_taken")


def add_folder(db: Session, user: User, *, name: str, parent_id: int | None) -> DiagramFolder:
    if parent_id is not None:
        folder(db, parent_id)
    _check_name(db, name, parent_id)
    new = DiagramFolder(name=name, name_key=name.lower(), parent_id=parent_id, creator=user)
    db.add(new)
    db.commit()
    return new


def change_folder(
    db: Session, user: User, folder_id: int, *, name: str | None = None, parent_id: int | None = None, move: bool
) -> DiagramFolder:
    """Rename a folder, or (move) put it in another folder, or at the top (parent_id None)."""
    found = folder(db, folder_id)
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
    """Delete an empty folder: no folders in it, and no diagrams but deleted ones, which go to the folder it was in."""
    found = folder(db, folder_id)
    inside = db.scalar(select(DiagramFolder.id).where(DiagramFolder.parent_id == found.id).limit(1)) is not None
    inside = (
        inside
        or db.scalar(select(Diagram.id).where(Diagram.folder_id == found.id, Diagram.deleted_at.is_(None)).limit(1))
        is not None
    )
    if inside:
        raise Conflict(f"{found.name} isn't empty: move what's in it out first", code="not_empty")
    for gone in db.scalars(select(Diagram).where(Diagram.folder_id == found.id)):
        gone.folder = found.parent
    db.delete(found)
    db.commit()


def folder_at(db: Session, user: User, path: str) -> int | None:
    """The folder at a path ("Vespula/GSE", tidied: FolderPath), made where it isn't there yet; None for "", the top.
    Its parts are matched whatever their case, as folders' names are."""
    parent: int | None = None
    for name in [part for part in path.split("/") if part]:
        if len(name) > MAX_NAME:
            raise ApiError(f"A folder's name can be up to {MAX_NAME} characters: {name[:40]}… is longer")
        found = _named(db, name, parent)
        if found is None:
            found = DiagramFolder(name=name, name_key=name.lower(), parent_id=parent, creator=user)
            db.add(found)
            db.flush()
        parent = found.id
    return parent
