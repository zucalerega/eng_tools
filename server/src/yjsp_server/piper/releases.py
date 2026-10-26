"""Piper's releases: a diagram's revision put forward as its next release, to approvers named for it, for a design
review or before a test, so there's a P&ID of record that doesn't change.

Anyone signed in asks for a revision to be released, naming its approvers: at least one of them someone else. Each
approves it or rejects it (saying why). Once all of them approve it, it's released, with the diagram's next letter (A,
B, ... Z, AA): a revision that's released, or waiting to be, never changes again (diagrams.save starts the next one,
and its name stays as it is), and editing goes on in the revisions after it. A rejection ends the request, and so does
whoever asked withdrawing it. A diagram has one release waiting at a time, and each releases a revision after the last.
"""

from collections.abc import Sequence

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import ApiError, Conflict, Forbidden, NotFound
from ..models import User, UserStatus
from . import diagrams
from .models import Approval, Diagram, Release

MOST_APPROVERS = 20


class NeedsApprover(ApiError):
    status = 422
    code = "needs_approver"


def _lock(db: Session, diagram_id: int) -> None:
    """Changes to a diagram's releases one at a time: the UPDATE (which changes nothing) is the transaction's first
    statement, so it takes SQLite's write lock (Postgres' lock on the row), and what's read after it is the latest."""
    db.execute(
        update(Diagram)
        .where(Diagram.id == diagram_id)
        .values(version=Diagram.version)
        .execution_options(synchronize_session=False)
    )


def letter(count: int) -> str:
    """The letter of a diagram's count'th release: 1 is A, 26 Z, 27 AA, as spreadsheets letter their columns."""
    letters = ""
    while count > 0:
        count, rest = divmod(count - 1, 26)
        letters = chr(ord("A") + rest) + letters
    return letters


def releases(db: Session, diagram_id: int) -> Sequence[Release]:
    """A diagram's releases, the latest asked for first: released, waiting, and those that weren't."""
    diagrams.diagram(db, diagram_id)
    return db.scalars(
        select(Release).where(Release.diagram_id == diagram_id).order_by(Release.requested_at.desc(), Release.id.desc())
    ).all()


def marks(db: Session, diagram_id: int) -> dict[int, tuple[str | None, bool]]:
    """Each revision with a release: its letter if it's released, and whether a release of it is waiting."""
    found: dict[int, tuple[str | None, bool]] = {}
    for release in db.scalars(
        select(Release).where(Release.diagram_id == diagram_id, Release.state.in_(("pending", "released")))
    ):
        letter_now, waiting = found.get(release.revision, (None, False))
        found[release.revision] = (release.letter or letter_now, waiting or release.state == "pending")
    return found


def _release(db: Session, diagram_id: int, release_id: int) -> Release:
    found = db.get(Release, release_id, populate_existing=True)
    if found is None or found.diagram_id != diagram_id:
        raise NotFound(f"Diagram {diagram_id} has no release {release_id}")
    return found


def _waiting_on(release: Release) -> str:
    names = [a.approver.display_name for a in release.approvals if a.decision == "pending"]
    return " and ".join([", ".join(names[:-1]), names[-1]] if len(names) > 1 else names) or "no one"


def request(db: Session, user: User, diagram_id: int, number: int, approvers: list[int], note: str = "") -> Release:
    """Put a revision forward as the diagram's next release, to the approvers named (by their accounts' ids)."""
    _lock(db, diagram_id)
    found = diagrams.diagram(db, diagram_id)
    diagrams.check_not_deleted(found)
    diagrams.revision(db, diagram_id, number)
    waiting = db.scalar(select(Release).where(Release.diagram_id == diagram_id, Release.state == "pending"))
    if waiting is not None:
        raise Conflict(
            f"Revision {waiting.revision} of {found.name} is waiting on {_waiting_on(waiting)} to approve it: "
            "it's approved, rejected, or withdrawn before another release is asked for",
            code="release_pending",
        )
    if found.released_revision is not None and number <= found.released_revision:
        raise Conflict(
            f"Revision {number} isn't after Rev {found.released}, revision {found.released_revision}: release a newer "
            "one",
            code="older_than_released",
        )
    named = list(dict.fromkeys(approvers))
    if not named or all(approver == user.id for approver in named):
        raise NeedsApprover("Name at least one approver besides yourself")
    if len(named) > MOST_APPROVERS:
        raise NeedsApprover(f"A release can have up to {MOST_APPROVERS} approvers")
    people = {person.id: person for person in db.scalars(select(User).where(User.id.in_(named)))}
    for approver in named:
        person = people.get(approver)
        if person is None or person.status != UserStatus.ACTIVE:
            raise NeedsApprover(f"Account {approver} isn't an active member: pick approvers from the team")
    release = Release(diagram_id=diagram_id, revision=number, note=note, requester=user, requested_at=utcnow())
    release.approvals = [Approval(approver=people[approver]) for approver in named]
    db.add(release)
    db.commit()
    return release


def _check_pending(release: Release) -> None:
    if release.state != "pending":
        said = {"released": f"released, as Rev {release.letter}", "rejected": "rejected", "withdrawn": "withdrawn"}
        raise Conflict(f"This release was {said.get(release.state, release.state)} already", code="already_decided")


def decide(db: Session, user: User, diagram_id: int, release_id: int, *, approve: bool, comment: str = "") -> Release:
    """An approver's say on a release that's waiting: approved (released once everyone has approved it), or rejected,
    which ends it."""
    _lock(db, diagram_id)
    release = _release(db, diagram_id, release_id)
    _check_pending(release)
    mine = next((a for a in release.approvals if a.approver_id == user.id), None)
    if mine is None:
        raise Forbidden("Only the approvers named for this release can approve or reject it", code="not_an_approver")
    if mine.decision != "pending":
        raise Conflict(f"You've {mine.decision} this release already", code="already_decided")
    now = utcnow()
    mine.decision = "approved" if approve else "rejected"
    mine.comment = comment
    mine.decided_at = now
    if not approve:
        release.state = "rejected"
        release.decided_at = now
    elif all(a.decision == "approved" for a in release.approvals):
        found = diagrams.diagram(db, diagram_id)
        count = db.scalar(
            select(func.count())
            .select_from(Release)
            .where(Release.diagram_id == diagram_id, Release.letter.is_not(None))
        )
        release.state = "released"
        release.letter = letter((count or 0) + 1)
        release.decided_at = now
        found.released, found.released_revision = release.letter, release.revision
    db.commit()
    return release


def withdraw(db: Session, user: User, diagram_id: int, release_id: int) -> Release:
    """Take back a release that's waiting: whoever asked for it, or an admin."""
    _lock(db, diagram_id)
    release = _release(db, diagram_id, release_id)
    _check_pending(release)
    if release.requested_by != user.id and not user.is_admin:
        raise Forbidden("Only whoever asked for this release, or an admin, can withdraw it", code="not_yours")
    release.state = "withdrawn"
    release.decided_at = utcnow()
    db.commit()
    return release
