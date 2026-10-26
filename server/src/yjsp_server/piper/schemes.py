"""Piper's color schemes, defined by the team: each a set of fluids (name, label, color, gas or not) and the colors of
valves' states. Anyone signed in makes one; whoever made it, or an admin, changes or deletes it, since a change reaches
every diagram that takes its colors again (the team's first, which Piper made, is the admins'). An admin picks the
team's default, which new diagrams start with and which can't be deleted while it's the default. A diagram takes a
scheme's colors into its drawing (the web app does, web/src/piper/fluids.ts), noting which scheme and when, so its
colors are its own until it takes the scheme's again.
"""

from collections.abc import Sequence
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import Conflict, Forbidden, NotFound
from ..models import User
from .models import Scheme


def schemes(db: Session) -> Sequence[Scheme]:
    """The team's default first, then the rest by name."""
    found = db.scalars(select(Scheme)).all()
    return sorted(found, key=lambda scheme: (not scheme.is_default, scheme.name.casefold(), scheme.id))


def scheme(db: Session, scheme_id: int) -> Scheme:
    found = db.get(Scheme, scheme_id, populate_existing=True)
    if found is None:
        raise NotFound(f"There's no color scheme {scheme_id}")
    return found


def can_change(user: User, found: Scheme) -> bool:
    """Whether someone may change or delete a scheme: whoever made it, or an admin."""
    return user.is_admin or user.id == found.created_by


def add(db: Session, user: User, *, name: str, fluids: list[dict[str, Any]], states: dict[str, str]) -> Scheme:
    now = utcnow()
    new = Scheme(name=name, fluids=fluids, states=states, creator=user, editor=user, created_at=now, updated_at=now)
    db.add(new)
    db.commit()
    return new


def change(
    db: Session,
    user: User,
    scheme_id: int,
    *,
    name: str | None = None,
    fluids: list[dict[str, Any]] | None = None,
    states: dict[str, str] | None = None,
) -> Scheme:
    """Rename a scheme, or change its fluids or states (None: as they are): whoever made it, or an admin. Diagrams that
    use it see it's changed."""
    found = scheme(db, scheme_id)
    if not can_change(user, found):
        raise Forbidden(f"Only whoever made {found.name}, or an admin, can change it", code="not_yours")
    wanted = {"name": name, "fluids": fluids, "states": states}
    changing = {key: value for key, value in wanted.items() if value is not None and value != getattr(found, key)}
    if changing:  # only a change is one a diagram that took its colors is told of
        for key, value in changing.items():
            setattr(found, key, value)
        found.updated_at = utcnow()
        found.editor = user
        db.commit()
    return found


def remove(db: Session, user: User, scheme_id: int) -> None:
    """Delete a scheme (whoever made it, or an admin): diagrams that took its colors keep them."""
    found = scheme(db, scheme_id)
    if not can_change(user, found):
        raise Forbidden(f"Only whoever made {found.name}, or an admin, can delete it", code="not_yours")
    if found.is_default:
        raise Conflict(f"{found.name} is the team's default: make another the default first", code="scheme_default")
    db.delete(found)
    db.commit()


def make_default(db: Session, user: User, scheme_id: int) -> Scheme:
    """The team's default scheme, what new diagrams start with: an admin's to pick."""
    if not user.is_admin:
        raise Forbidden("Only an admin can pick the team's default color scheme", code="admin_only")
    found = scheme(db, scheme_id)
    db.execute(update(Scheme).where(Scheme.id != scheme_id).values(is_default=False))
    found.is_default = True
    db.commit()
    return found
