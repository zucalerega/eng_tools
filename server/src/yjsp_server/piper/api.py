"""Piper's API (/api/piper): diagrams, saving their drawings, and their revisions."""

from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy.orm import Session

from ..api.deps import DB, ActiveUser
from ..models import User
from . import diagrams
from .models import Diagram
from .schemas import (
    DiagramChangeIn,
    DiagramDetailOut,
    DiagramIn,
    DiagramOut,
    DrawingSaveIn,
    RevisionDetailOut,
    RevisionNoteIn,
    RevisionOut,
    RevisionRestoreIn,
)

router = APIRouter(prefix="/api/piper", tags=["piper"])


def _out(diagram: Diagram, user: User) -> DiagramOut:
    return DiagramOut.of(diagram, can_delete=diagrams.can_delete(user, diagram))


def _detail(db: Session, diagram: Diagram, user: User) -> DiagramDetailOut:
    drawing = diagrams.latest_drawing(db, diagram)
    return DiagramDetailOut.of_detail(diagram, drawing, can_delete=diagrams.can_delete(user, diagram))


@router.get("/diagrams")
def get_diagrams(
    user: ActiveUser, db: DB, q: Annotated[str, Query(max_length=1000)] = "", deleted: bool = False
) -> list[DiagramOut]:
    """The diagrams, the most recently changed first, without their drawings (deleted=true: the deleted ones). q: only
    those whose name, folder, description, or tags have every word of it."""
    return [_out(diagram, user) for diagram in diagrams.diagrams(db, deleted=deleted, q=q)]


@router.post("/diagrams", status_code=201)
def post_diagram(body: DiagramIn, user: ActiveUser, db: DB) -> DiagramDetailOut:
    """A new diagram, with its drawing (an empty one if there's none)."""
    new = diagrams.add(db, user, name=body.name, folder=body.folder, description=body.description, drawing=body.drawing)
    return _detail(db, new, user)


@router.get("/diagrams/{diagram_id}")
def get_diagram(diagram_id: int, user: ActiveUser, db: DB) -> DiagramDetailOut:
    """A diagram with its drawing (a deleted one too: deleted_at says so)."""
    return _detail(db, diagrams.diagram(db, diagram_id), user)


@router.patch("/diagrams/{diagram_id}")
def patch_diagram(diagram_id: int, body: DiagramChangeIn, user: ActiveUser, db: DB) -> DiagramOut:
    """Rename, move, or describe a diagram: what's left out stays as it is."""
    changed = diagrams.change(db, user, diagram_id, name=body.name, folder=body.folder, description=body.description)
    return _out(changed, user)


@router.delete("/diagrams/{diagram_id}")
def delete_diagram(diagram_id: int, user: ActiveUser, db: DB) -> DiagramOut:
    """Delete a diagram (whoever made it, or an admin). Its history is kept, so it can be restored."""
    return _out(diagrams.remove(db, user, diagram_id), user)


@router.post("/diagrams/{diagram_id}/restore")
def post_restore(diagram_id: int, user: ActiveUser, db: DB) -> DiagramOut:
    """Restore a deleted diagram (whoever made it, or an admin)."""
    return _out(diagrams.restore(db, user, diagram_id), user)


@router.put("/diagrams/{diagram_id}/drawing")
def put_drawing(diagram_id: int, body: DrawingSaveIn, user: ActiveUser, db: DB) -> DiagramOut:
    """Save a diagram's drawing, changed from `version`. If someone saved it since, 409 `changed`, with the version it's
    at, who saved it, and when. fresh: begin a new revision even if the latest is yours."""
    saved = diagrams.save(db, user, diagram_id, body.drawing, body.version, fresh=body.fresh)
    return _out(saved, user)


@router.get("/diagrams/{diagram_id}/revisions")
def get_revisions(diagram_id: int, user: ActiveUser, db: DB) -> list[RevisionOut]:
    """A diagram's revisions, the latest first, without their drawings."""
    return [RevisionOut.of(revision) for revision in diagrams.revisions(db, diagram_id)]


@router.get("/diagrams/{diagram_id}/revisions/{number}")
def get_revision(diagram_id: int, number: int, user: ActiveUser, db: DB) -> RevisionDetailOut:
    """A revision with its drawing."""
    revision = diagrams.revision(db, diagram_id, number)
    return RevisionDetailOut.of_detail(revision, diagrams.unpack(revision.drawing))


@router.patch("/diagrams/{diagram_id}/revisions/{number}")
def patch_revision(diagram_id: int, number: int, body: RevisionNoteIn, user: ActiveUser, db: DB) -> RevisionOut:
    """Name a revision, which keeps it as it is ("": no name)."""
    return RevisionOut.of(diagrams.name_revision(db, diagram_id, number, body.note))


@router.post("/diagrams/{diagram_id}/revisions/{number}/restore")
def post_restore_revision(
    diagram_id: int, number: int, body: RevisionRestoreIn, user: ActiveUser, db: DB
) -> DiagramDetailOut:
    """Make a revision the drawing again, as a new revision, if the diagram is still at `version` (else 409 `changed`,
    as for a save)."""
    restored = diagrams.restore_revision(db, user, diagram_id, number, body.version)
    return _detail(db, restored, user)
