"""Piper's rules: making diagrams, saving their drawings, their history, and who may delete them.

Everyone signed in (and approved) sees every diagram, makes them, and changes them: a P&ID is the team's, and its
history keeps every drawing, so nothing anyone does to one is lost. One person edits a diagram at a time: whoever's
editing it holds it, and no one else's save goes over theirs until they're done. Only whoever made one, or an admin,
deletes it, which keeps everything, so it can come back.
"""

import json
import zlib
from collections.abc import Iterable, Sequence
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..api.schemas import UserRef
from ..db import utcnow
from ..errors import Conflict, Forbidden, NotFound, TooLarge
from ..models import User
from . import folders
from .models import Diagram, Release, Revision
from .schemas import EditingOut, InvalidDrawing, check_drawing, drawing_format, drawing_pages

EMPTY_DRAWING: dict[str, Any] = {"format": 1, "parts": [], "lines": [], "fluids": [], "style": {}}
MAX_DRAWING_BYTES = 2 * 1024 * 1024  # of JSON: a big P&ID's is a few hundred KB
# Objects and lists in each other: far deeper than a drawing goes, and well within what the server can send back
# (pydantic's limit is about 100).
MAX_DEPTH = 50
# How long a revision takes its author's saves: an afternoon's editing is a few revisions, not thousands.
AMEND_WITHIN = timedelta(minutes=30)
# How long a diagram stays held by whoever's editing it without a word from their editor, which says they're still at
# it every minute while it's open: a laptop shut or a tab that crashed lets it go, so no diagram is held for good.
LOCK_LAPSES = timedelta(minutes=10)


class Changed(Conflict):
    """Someone saved the diagram after the version a save was changed from."""

    code = "changed"


class DrawingNewer(Conflict):
    """A save in an older format than the diagram's drawing is in: from a tab still running an older Piper, which would
    leave out what it doesn't know of (all but a page of it, or its simulation's settings)."""

    code = "drawing_newer"


class Locked(Conflict):
    """Someone else is editing the diagram: until they're done, only they change its drawing."""

    code = "locked"


# What each format of drawing added, which a tab from before it would leave out: said when its save is refused.
ADDED = {2: "pages", 3: "simulation settings"}


def can_delete(user: User, diagram: Diagram) -> bool:
    return user.is_admin or user.id == diagram.created_by


def _check_can_delete(user: User, found: Diagram) -> None:
    if not can_delete(user, found):
        raise Forbidden(f"Only whoever made {found.name}, or an admin, can delete or restore it", code="not_yours")


def check_not_deleted(found: Diagram) -> None:
    if found.deleted_at is not None:
        raise Conflict(f"{found.name} is deleted: restore it first", code="deleted")


# --- drawings -----------------------------------------------------------------------------------------------------


def _pack(drawing: dict[str, Any]) -> tuple[bytes, int]:
    """A drawing as it's kept: its JSON, compressed, and the JSON's size. Checked first, so what's kept can always be
    sent back as it came."""
    check_drawing(drawing)
    if not _nested_within(drawing, MAX_DEPTH):
        raise InvalidDrawing(f"The drawing has objects and lists in each other more than {MAX_DEPTH} deep")
    try:
        text = json.dumps(drawing, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    except UnicodeEncodeError:  # half of a character that takes two (a lone surrogate)
        raise InvalidDrawing("The drawing has text that isn't valid Unicode") from None
    except ValueError:  # NaN or infinity, which JSON doesn't have
        raise InvalidDrawing("The drawing has a number that isn't finite") from None
    if len(text) > MAX_DRAWING_BYTES:
        raise TooLarge(f"A drawing can be up to {MAX_DRAWING_BYTES >> 20} MB")
    return zlib.compress(text), len(text)


def _nested_within(value: dict[str, Any], most: int) -> bool:
    """Whether a value's objects and lists are in each other at most `most` deep (the value itself is 1)."""
    # By exact type, which is what JSON reads into, and the fastest test: this goes through every value of a drawing.
    containers = (dict, list)
    level: list[Any] = [value]
    for _ in range(most):
        level = [
            child
            for item in level
            for child in (item.values() if type(item) is dict else item)
            if type(child) in containers
        ]
        if not level:
            return True
    return False


def unpack(data: bytes) -> dict[str, Any]:
    """A drawing as it was saved, from a revision's drawing."""
    return json.loads(zlib.decompress(data))


def summarize(drawing: dict[str, Any]) -> dict[str, Any]:
    """What the list shows and searches: how many parts and lines on all its pages, their tags, and the lines' fluids,
    each once; and its format, which a save can't go back from."""
    pages = drawing_pages(drawing)
    parts = [part for page in pages for part in page.get("parts") or [] if isinstance(part, dict)]
    lines = [line for page in pages for line in page.get("lines") or [] if isinstance(line, dict)]
    return {
        "parts": len(parts),
        "lines": len(lines),
        "pages": len(pages),
        "format": drawing_format(drawing),
        "tags": _once(item.get("tag") for item in [*parts, *lines]),
        "fluids": _once(line.get("fluid") for line in lines),
    }


def _once(values: Iterable[Any]) -> list[str]:
    """The texts that aren't empty, each once, in order."""
    return list(dict.fromkeys(value.strip() for value in values if isinstance(value, str) and value.strip()))


# --- diagrams -----------------------------------------------------------------------------------------------------


def diagrams(db: Session, *, deleted: bool = False, q: str = "") -> list[Diagram]:
    """The most recently changed first. deleted=True: the deleted ones instead. q: only those with every word of it in
    their name, folder, description, or tags, whatever its case."""
    gone = Diagram.deleted_at.is_not(None) if deleted else Diagram.deleted_at.is_(None)
    found = db.scalars(select(Diagram).where(gone).order_by(Diagram.updated_at.desc(), Diagram.id.desc())).all()
    words = q.casefold().split()
    return [each for each in found if all(word in _searched(each) for word in words)]


def _searched(found: Diagram) -> str:
    return "\n".join([found.name, found.folder_path, found.description, *found.summary.get("tags", [])]).casefold()


def diagram(db: Session, diagram_id: int) -> Diagram:
    found = db.get(Diagram, diagram_id, populate_existing=True)
    if found is None:
        raise NotFound(f"There's no diagram {diagram_id}")
    return found


def latest_drawing(db: Session, found: Diagram) -> dict[str, Any]:
    """A diagram's drawing: its latest revision's."""
    return unpack(_latest(db, found.id).drawing)


def add(
    db: Session,
    user: User,
    *,
    name: str,
    folder_id: int | None = None,
    description: str = "",
    drawing: dict[str, Any] | None = None,
) -> Diagram:
    """A new diagram, at version 1, in a folder (None: at the top), with its drawing (an empty one if there's none) as
    revision 1."""
    drawing = EMPTY_DRAWING if drawing is None else drawing
    data, size = _pack(drawing)
    if folder_id is not None:
        folders.folder(db, folder_id)
    now = utcnow()
    new = Diagram(
        name=name,
        folder_id=folder_id,
        description=description,
        version=1,
        revision=1,
        summary=summarize(drawing),
        creator=user,
        editor=user,
        created_at=now,
        updated_at=now,
    )
    db.add(new)
    db.flush()
    db.add(Revision(diagram_id=new.id, number=1, drawing=data, size=size, author=user, created_at=now, saved_at=now))
    db.commit()
    return new


def change(
    db: Session,
    user: User,
    diagram_id: int,
    *,
    name: str | None = None,
    folder_id: int | None = None,
    move: bool = False,
    description: str | None = None,
) -> Diagram:
    """Rename, describe, or (move) put a diagram in a folder (folder_id None: at the top); None: as it is. Its drawing,
    and so its version, don't change."""
    found = diagram(db, diagram_id)
    check_not_deleted(found)
    target = folders.folder(db, folder_id) if move and folder_id is not None else None
    wanted: dict[str, Any] = {"name": name, "description": description}
    changing = {key: value for key, value in wanted.items() if value is not None and value != getattr(found, key)}
    if move and folder_id != found.folder_id:
        changing["folder"] = target  # the folder itself, so what's loaded of it is too
    if changing:  # only a change moves it up the list
        for key, value in changing.items():
            setattr(found, key, value)
        found.updated_at = utcnow()
        found.editor = user
        db.commit()
    return found


def save(
    db: Session, user: User, diagram_id: int, drawing: dict[str, Any], version: int, *, fresh: bool = False
) -> Diagram:
    """Save a diagram's drawing, changed from `version`: taken only if the diagram is still at it, as the next version.

    The latest revision takes the save if it's the same person's, begun less than AMEND_WITHIN before, not named, not
    restored, not released or waiting to be (releases.py), and the save isn't `fresh`; otherwise the save begins the
    next revision. So one person's work never writes over another's in the history, and a named, restored, or released
    revision stays as it is. If someone else is editing it, the save is refused (`locked`); a save by whoever is says
    they're still at it.
    """
    data, size = _pack(drawing)
    _next_version(db, user, diagram_id, version)
    found = diagram(db, diagram_id)
    if drawing_format(drawing) < found.summary.get("format", 1):
        name = found.name
        db.rollback()  # it stays at its version
        added = ADDED.get(drawing_format(drawing) + 1, "more than this tab's Piper knows of")
        raise DrawingNewer(
            f"{name} has {added}, which this tab's Piper is too old to keep: reload the page, then make your change again"
        )
    now = utcnow()
    _check_editing(db, user, found, now, "your change isn't saved: save yours as a new diagram, or load theirs")
    if found.locked_by == user.id:  # you're still at it (and, if it had lapsed, hold it again)
        _hold_for(found, user, now)
    latest = _latest(db, diagram_id)
    if (
        not fresh
        and latest.author_id == user.id
        and not latest.note
        and latest.restored_from is None
        and now - latest.created_at < AMEND_WITHIN
        and _release_of(db, diagram_id, latest.number) is None
    ):
        latest.drawing, latest.size, latest.saved_at = data, size, now
    else:
        found.revision = latest.number + 1
        db.add(
            Revision(
                diagram_id=found.id,
                number=found.revision,
                drawing=data,
                size=size,
                author=user,
                created_at=now,
                saved_at=now,
            )
        )
    found.summary = summarize(drawing)
    found.updated_at = now
    found.editor = user
    db.commit()
    return found


def _next_version(db: Session, user: User, diagram_id: int, version: int) -> None:
    """Move a diagram on from `version` to the next, if it's still at it, or say why it isn't (and change nothing).

    The UPDATE is the transaction's first statement, so it takes SQLite's write lock (Postgres' lock on the row), and
    what's read after it is the latest: saves of a diagram go one at a time, and only one from each version is taken.
    """
    moved = db.execute(
        update(Diagram)
        .where(Diagram.id == diagram_id, Diagram.version == version, Diagram.deleted_at.is_(None))
        .values(version=Diagram.version + 1)
        .execution_options(synchronize_session=False)
    ).rowcount
    if moved:
        return
    try:
        found = diagram(db, diagram_id)
        check_not_deleted(found)
        latest = _latest(db, diagram_id)  # the save since: whose it was, and when
        if latest.restored_from is None:
            done = f"saved {found.name}"
        else:
            done = f"restored {found.name} to revision {latest.restored_from}"
        if latest.author_id == user.id:
            said = f"You {done} in another window after you opened it here"
        else:
            said = f"{latest.author.display_name if latest.author else 'Someone'} {done} after you opened it"
        raise Changed(
            said,
            version=found.version,
            updated_by=UserRef.of(latest.author).model_dump() if latest.author else None,
            updated_at=latest.saved_at.isoformat(),
        )
    finally:
        db.rollback()  # let the next writer in


def _release_of(db: Session, diagram_id: int, number: int) -> Release | None:
    """A revision's release, if it's released or waiting to be: either way, it's kept as it is."""
    return db.scalar(
        select(Release)
        .where(Release.diagram_id == diagram_id, Release.revision == number, Release.state.in_(("pending", "released")))
        .order_by(Release.id.desc())
        .limit(1)
    )


def _latest(db: Session, diagram_id: int) -> Revision:
    return db.scalars(
        select(Revision).where(Revision.diagram_id == diagram_id).order_by(Revision.number.desc()).limit(1)
    ).one()


def move_all(db: Session, user: User, diagram_ids: Sequence[int], folder_id: int | None) -> list[Diagram]:
    """Put diagrams in a folder (None: at the top), as anyone can: all of them, or none if one isn't there or is
    deleted. Their drawings don't change; each that moves is changed, by you."""
    target = folders.folder(db, folder_id) if folder_id is not None else None
    moving = [diagram(db, diagram_id) for diagram_id in dict.fromkeys(diagram_ids)]
    for found in moving:
        check_not_deleted(found)
    now = utcnow()
    for found in moving:
        if found.folder_id != folder_id:
            found.folder, found.updated_at, found.editor = target, now, user
    db.commit()
    return moving


def remove(db: Session, user: User, diagram_id: int) -> Diagram:
    """Delete a diagram: it's hidden, with its history kept, until whoever made it, or an admin, restores it."""
    return remove_all(db, user, [diagram_id])[0]


def remove_all(db: Session, user: User, diagram_ids: Sequence[int]) -> list[Diagram]:
    """Delete diagrams, as remove does: all of them, or none if any isn't yours to delete."""
    removing = [diagram(db, diagram_id) for diagram_id in dict.fromkeys(diagram_ids)]
    for found in removing:
        _check_can_delete(user, found)
    now = utcnow()
    for found in removing:
        if found.deleted_at is None:
            found.deleted_at = now
            found.deleter = user
    db.commit()
    return removing


def restore(db: Session, user: User, diagram_id: int) -> Diagram:
    return restore_all(db, user, [diagram_id])[0]


def restore_all(db: Session, user: User, diagram_ids: Sequence[int]) -> list[Diagram]:
    """Bring deleted diagrams back, each in its folder: all of them, or none if any isn't yours to restore."""
    restoring = [diagram(db, diagram_id) for diagram_id in dict.fromkeys(diagram_ids)]
    for found in restoring:
        _check_can_delete(user, found)
    for found in restoring:
        found.deleted_at = None
        found.deleter = None
    db.commit()
    return restoring


# --- revisions ----------------------------------------------------------------------------------------------------


def revisions(db: Session, diagram_id: int) -> Sequence[Revision]:
    """A diagram's history, the latest first (their drawings are loaded only if they're asked for)."""
    diagram(db, diagram_id)
    return db.scalars(select(Revision).where(Revision.diagram_id == diagram_id).order_by(Revision.number.desc())).all()


def revision(db: Session, diagram_id: int, number: int) -> Revision:
    found = diagram(db, diagram_id)
    kept = db.scalar(select(Revision).where(Revision.diagram_id == diagram_id, Revision.number == number))
    if kept is None:
        raise NotFound(f"{found.name} has no revision {number}")
    return kept


def name_revision(db: Session, diagram_id: int, number: int, note: str) -> Revision:
    """Name a revision ("Rev B, for HF-3"), which keeps it as it is: the next save begins another. "" takes the name
    off."""
    # Wait for a save of the diagram that's under way, and hold the next one until this is done, so a save doesn't
    # change a revision once it's named. Postgres needs this; SQLite has one writer at a time anyway.
    db.execute(select(Diagram.id).where(Diagram.id == diagram_id).with_for_update())
    check_not_deleted(diagram(db, diagram_id))
    named = revision(db, diagram_id, number)
    release = _release_of(db, diagram_id, number)
    if release is not None and release.state == "released":
        raise Conflict(
            f"Revision {number} is Rev {release.letter}, released: it stays as it was", code="revision_released"
        )
    if release is not None:
        raise Conflict(
            f"Revision {number} is waiting to be released: it stays as it is unless the release is withdrawn",
            code="release_pending",
        )
    named.note = note
    db.commit()
    return named


def restore_revision(db: Session, user: User, diagram_id: int, number: int, version: int) -> Diagram:
    """Make a revision the drawing again: the next version, taken only if the diagram is still at `version` (as a save
    is), and a new revision that says where it came from. The drawings after it stay in the history."""
    _next_version(db, user, diagram_id, version)
    try:
        source = revision(db, diagram_id, number)
    except NotFound:
        db.rollback()  # the diagram stays at its version
        raise
    found = diagram(db, diagram_id)
    now = utcnow()
    _check_editing(db, user, found, now, "restore a revision once they're done")
    latest = _latest(db, diagram_id)
    found.revision = latest.number + 1
    db.add(
        Revision(
            diagram_id=found.id,
            number=found.revision,
            drawing=source.drawing,
            size=source.size,
            restored_from=source.number,
            author=user,
            created_at=now,
            saved_at=now,
        )
    )
    found.summary = summarize(unpack(source.drawing))
    found.updated_at = now
    found.editor = user
    db.commit()
    return found


# --- editing ------------------------------------------------------------------------------------------------------


def editing(found: Diagram, now: datetime | None = None) -> User | None:
    """Who's editing a diagram, if anyone still is: not once it's deleted, or once their editor hasn't said they're at
    it in LOCK_LAPSES."""
    if found.locked_by is None or found.lock_seen_at is None or found.deleted_at is not None:
        return None
    if (now or utcnow()) - found.lock_seen_at >= LOCK_LAPSES:
        return None
    return found.locker


def take_lock(db: Session, user: User, diagram_id: int, *, force: bool = False) -> Diagram:
    """Start editing a diagram, or say you're still at it: only you change its drawing until you're done (release_lock),
    or until LOCK_LAPSES without a word. If someone else is editing it, 409 `locked`; an admin can take it over (force),
    and whoever had it is told when they next save."""
    if force and not user.is_admin:
        raise Forbidden("Only an admin can take over editing from someone else", code="admin_only")
    found = _held(db, diagram_id)
    now = utcnow()
    try:
        check_not_deleted(found)
    except Conflict:
        db.rollback()  # let the next writer in
        raise
    if not force:
        _check_editing(db, user, found, now, "you can look at it, and edit it once they're done")
    _hold_for(found, user, now)
    db.commit()
    return found


def release_lock(db: Session, user: User, diagram_id: int) -> Diagram:
    """Done editing a diagram: anyone can edit it now. If it isn't yours (someone took it over), it stays as it is."""
    found = _held(db, diagram_id)
    if found.locked_by == user.id:
        found.locker = found.locked_at = found.lock_seen_at = None
    db.commit()
    return found


def _held(db: Session, diagram_id: int) -> Diagram:
    """A diagram as it is now, held until the transaction ends. The UPDATE is the transaction's first statement, so it
    takes SQLite's write lock (Postgres' lock on the row), and what's read after it is the latest: who's editing it
    changes one at a time."""
    db.execute(
        update(Diagram)
        .where(Diagram.id == diagram_id)
        .values(locked_by=Diagram.locked_by)
        .execution_options(synchronize_session=False)
    )
    try:
        return diagram(db, diagram_id)
    except NotFound:
        db.rollback()
        raise


def _check_editing(db: Session, user: User, found: Diagram, now: datetime, then: str) -> None:
    """Refuse, and change nothing, if someone else is editing the diagram: who is, then what to do."""
    holder = editing(found, now)
    if holder is None or holder.id == user.id:
        return
    said = f"{holder.display_name} is editing {found.name}: {then}"
    who = EditingOut(by=UserRef.of(holder), since=found.locked_at or now).model_dump(mode="json")  # as it's sent
    db.rollback()  # it stays as it was
    raise Locked(said, editing=who)


def _hold_for(found: Diagram, user: User, now: datetime) -> None:
    """Hold a diagram for you (whoever else was editing it checked first): since now, unless you're editing it
    already."""
    holder = editing(found, now)
    if holder is None or holder.id != user.id:
        found.locker, found.locked_at = user, now  # the person, so what's loaded of them is too
    found.lock_seen_at = now
