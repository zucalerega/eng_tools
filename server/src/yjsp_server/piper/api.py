"""Piper's API (/api/piper): diagrams, saving their drawings, their revisions and releases, and color schemes."""

from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy.orm import Session

from ..api.deps import DB, ActiveUser
from ..models import User
from . import diagrams, releases, schemes
from .models import Diagram, Scheme
from .schemas import (
    DecisionIn,
    DiagramChangeIn,
    DiagramDetailOut,
    DiagramIn,
    DiagramOut,
    DrawingSaveIn,
    ReleaseIn,
    ReleaseOut,
    RevisionDetailOut,
    RevisionNoteIn,
    RevisionOut,
    RevisionRestoreIn,
    SchemeChangeIn,
    SchemeIn,
    SchemeOut,
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
    """A diagram's revisions, the latest first, without their drawings, each with its release's letter if it's been
    released."""
    found = diagrams.revisions(db, diagram_id)
    marks = releases.marks(db, diagram_id)
    return [RevisionOut.of(revision, marks.get(revision.number, (None, False))) for revision in found]


@router.get("/diagrams/{diagram_id}/revisions/{number}")
def get_revision(diagram_id: int, number: int, user: ActiveUser, db: DB) -> RevisionDetailOut:
    """A revision with its drawing."""
    revision = diagrams.revision(db, diagram_id, number)
    mark = releases.marks(db, diagram_id).get(number, (None, False))
    return RevisionDetailOut.of_detail(revision, diagrams.unpack(revision.drawing), mark)


@router.patch("/diagrams/{diagram_id}/revisions/{number}")
def patch_revision(diagram_id: int, number: int, body: RevisionNoteIn, user: ActiveUser, db: DB) -> RevisionOut:
    """Name a revision, which keeps it as it is ("": no name). One that's released, or waiting to be, keeps its name:
    409 `revision_released`, `release_pending`."""
    named = diagrams.name_revision(db, diagram_id, number, body.note)
    return RevisionOut.of(named, releases.marks(db, diagram_id).get(number, (None, False)))


@router.post("/diagrams/{diagram_id}/revisions/{number}/restore")
def post_restore_revision(
    diagram_id: int, number: int, body: RevisionRestoreIn, user: ActiveUser, db: DB
) -> DiagramDetailOut:
    """Make a revision the drawing again, as a new revision, if the diagram is still at `version` (else 409 `changed`,
    as for a save)."""
    restored = diagrams.restore_revision(db, user, diagram_id, number, body.version)
    return _detail(db, restored, user)


@router.get("/diagrams/{diagram_id}/releases")
def get_releases(diagram_id: int, user: ActiveUser, db: DB) -> list[ReleaseOut]:
    """A diagram's releases, the latest asked for first: released, waiting for their approvers, and those that weren't
    (rejected, withdrawn)."""
    return [ReleaseOut.of(release, user) for release in releases.releases(db, diagram_id)]


@router.post("/diagrams/{diagram_id}/releases", status_code=201)
def post_release(diagram_id: int, body: ReleaseIn, user: ActiveUser, db: DB) -> ReleaseOut:
    """Put a revision forward as the diagram's next release, to the approvers named: at least one besides you (422
    `needs_approver`). One at a time (409 `release_pending`), each after the last released (409
    `older_than_released`)."""
    made = releases.request(db, user, diagram_id, body.revision, body.approvers, body.note)
    return ReleaseOut.of(made, user)


@router.post("/diagrams/{diagram_id}/releases/{release_id}/approve")
def post_approve(diagram_id: int, release_id: int, body: DecisionIn, user: ActiveUser, db: DB) -> ReleaseOut:
    """Approve a release you're named for (else 403 `not_an_approver`): it's released, with the next letter, once all
    its approvers have. 409 `already_decided` if it's over, or you've had your say."""
    return ReleaseOut.of(releases.decide(db, user, diagram_id, release_id, approve=True, comment=body.comment), user)


@router.post("/diagrams/{diagram_id}/releases/{release_id}/reject")
def post_reject(diagram_id: int, release_id: int, body: DecisionIn, user: ActiveUser, db: DB) -> ReleaseOut:
    """Reject a release you're named for, saying why: it ends there."""
    return ReleaseOut.of(releases.decide(db, user, diagram_id, release_id, approve=False, comment=body.comment), user)


@router.post("/diagrams/{diagram_id}/releases/{release_id}/withdraw")
def post_withdraw(diagram_id: int, release_id: int, user: ActiveUser, db: DB) -> ReleaseOut:
    """Withdraw a release that's waiting: whoever asked for it, or an admin (else 403 `not_yours`)."""
    return ReleaseOut.of(releases.withdraw(db, user, diagram_id, release_id), user)


def _scheme(found: Scheme, user: User) -> SchemeOut:
    return SchemeOut.of(found, can_delete=schemes.can_delete(user, found))


@router.get("/schemes")
def get_schemes(user: ActiveUser, db: DB) -> list[SchemeOut]:
    """The team's color schemes: its default first, then the rest by name."""
    return [_scheme(found, user) for found in schemes.schemes(db)]


@router.post("/schemes", status_code=201)
def post_scheme(body: SchemeIn, user: ActiveUser, db: DB) -> SchemeOut:
    """A new color scheme: its fluids, and the colors of valves' states."""
    fluids = [fluid.model_dump() for fluid in body.fluids]
    return _scheme(schemes.add(db, user, name=body.name, fluids=fluids, states=body.states.model_dump()), user)


@router.patch("/schemes/{scheme_id}")
def patch_scheme(scheme_id: int, body: SchemeChangeIn, user: ActiveUser, db: DB) -> SchemeOut:
    """Rename a scheme, or change its fluids or states: what's left out stays as it is."""
    changed = schemes.change(
        db,
        user,
        scheme_id,
        name=body.name,
        fluids=None if body.fluids is None else [fluid.model_dump() for fluid in body.fluids],
        states=None if body.states is None else body.states.model_dump(),
    )
    return _scheme(changed, user)


@router.delete("/schemes/{scheme_id}", status_code=204)
def delete_scheme(scheme_id: int, user: ActiveUser, db: DB) -> None:
    """Delete a scheme (whoever made it, or an admin; not the default, 409 `scheme_default`). Diagrams keep the colors
    they took from it."""
    schemes.remove(db, user, scheme_id)


@router.post("/schemes/{scheme_id}/default")
def post_default_scheme(scheme_id: int, user: ActiveUser, db: DB) -> SchemeOut:
    """Make a scheme the team's default, which new diagrams start with (admins: else 403 `admin_only`)."""
    return _scheme(schemes.make_default(db, user, scheme_id), user)
