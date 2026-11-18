"""Buildflow's design reviews: a review held for several of a program's components at once, at one of its review
milestones (a subsystem's PDR, say, for its eight components), with its day, its files (its slides, its package, the
minutes, wherever they're kept), and the notes taken in it. Anyone signed in (and approved) keeps them, as they do
progress (progress.py), which a review changes through the same rules: its day is each of its components' due date at
its milestone (but those already through it), and passing it passes each of them there. Each component's progress is
still its own, so one can come back from the review with actions to close (in progress, its note saying what). Each
change is noted in the program's activity."""

from collections.abc import Iterable, Sequence
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import ApiError, NotFound
from ..models import User
from . import programs, progress
from .models import Component, Milestone, Program, Review, ReviewComponent, ReviewLink, Status
from .programs import log

MOST_FILES = 50  # on a review
_THROUGH = (Status.DONE, Status.SKIPPED)  # passed, or not needed: a review leaves these as they are


class NotAReview(ApiError):
    """A review held at a milestone that's work, not a review (Manufacturing, say)."""

    code = "not_a_review"


def reviews(db: Session, program_id: int, *, removed: bool = False) -> list[Review]:
    """A program's reviews (removed: those removed from it instead), by their days, those with none yet last."""
    programs.program(db, program_id)
    gone = Review.removed_at.is_not(None) if removed else Review.removed_at.is_(None)
    found = db.scalars(select(Review).where(Review.program_id == program_id, gone))
    return sorted(found, key=lambda r: (r.held_on is None, r.held_on or date.min, r.id))


def review(db: Session, review_id: int) -> Review:
    found = db.get(Review, review_id)
    if found is None:
        raise NotFound(f"There's no review #{review_id}")
    return found


def _open(db: Session, review_id: int) -> tuple[Review, Program]:
    """A review that can be changed, and its program: not removed, and its program not archived."""
    found = review(db, review_id)
    owner = programs.program(db, found.program_id)
    programs.check_open(owner)
    if found.removed_at is not None:
        raise programs.Removed(f"The review {found.name} was removed: bring it back to change it")
    return found, owner


def _review_milestone(db: Session, program: Program, milestone_id: int) -> Milestone:
    stone = db.get(Milestone, milestone_id)
    if stone is None or stone.program_id != program.id:
        raise NotFound(f"{program.name} has no milestone #{milestone_id}")
    if not stone.review:
        raise NotAReview(
            f"{stone.name} is work, not a review: a review is held at one of {program.name}'s review milestones, as "
            "its CDR"
        )
    return stone


def _components(db: Session, program: Program, component_ids: Iterable[int]) -> list[Component]:
    """The components a review is to cover, as they're said: each on its program, and not removed from it."""
    found = []
    for component_id in dict.fromkeys(component_ids):
        component = db.get(Component, component_id)
        if component is None or component.program_id != program.id:
            raise NotFound(f"{program.name} has no component #{component_id}")
        programs.check_live(component)
        found.append(component)
    return found


def _covered(db: Session, found: Review) -> list[Component]:
    """The components a review covers that are on its program now (those removed from it aren't, until they're brought
    back), in the program's order."""
    ids = {cover.component_id for cover in found.covers}
    return [c for c in programs.components(db, found.program_id) if c.id in ids]


def _counted(count: int, what: str) -> str:
    return f"{count} {what}{'' if count == 1 else 's'}"


def _schedule(
    db: Session,
    user: User,
    owner: Program,
    found: Review,
    stone: Milestone,
    components: Sequence[Component],
    was: date | None,
) -> None:
    """Make a review's day each of these components' due date at its milestone, but those through it already (passed,
    or not needed). A review with no day now takes its old day (was) off them, and leaves a due date of their own."""
    for component in components:
        kept = progress.progress_at(db, component, stone)
        if kept is not None and kept.status in _THROUGH:
            continue
        if found.held_on is None and (kept is None or kept.due != was):
            continue
        progress.change_progress(db, user, owner, component, stone, {"due": found.held_on}, found.name)


def _touch(found: Review, user: User) -> None:
    found.updated_at, found.updated_by = utcnow(), user.id


def add_review(
    db: Session,
    user: User,
    program_id: int,
    *,
    milestone_id: int,
    name: str,
    held_on: date | None,
    component_ids: Sequence[int],
    notes: str,
) -> Review:
    """A review at one of a program's review milestones, for these of its components: its day, if it has one yet, is
    each one's due date there."""
    owner = programs.program(db, program_id)
    programs.check_open(owner)
    stone = _review_milestone(db, owner, milestone_id)
    components = _components(db, owner, component_ids)
    found = Review(
        program_id=owner.id,
        milestone_id=stone.id,
        name=name,
        held_on=held_on,
        notes=notes,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(found)
    db.flush()
    for component in components:
        db.add(ReviewComponent(review_id=found.id, component_id=component.id))
    if held_on is not None:
        _schedule(db, user, owner, found, stone, components, None)
    on = f", on {progress.day_in_words(held_on)}" if held_on else ""
    log(db, owner, user, f"{name}: a {stone.name} for {_counted(len(components), 'component')}{on}")
    db.commit()
    db.refresh(found)
    return found


def change_review(db: Session, user: User, review_id: int, change: dict[str, Any]) -> Review:
    """Change what's in `change` (and only that): a review's name, its day (None: none yet), its notes, and the
    components it covers (all of them, as they're to be: those added get its day; those taken off keep what they have,
    their due dates too)."""
    found, owner = _open(db, review_id)
    stone = programs.milestone(db, found.milestone_id)
    said: list[str] = []
    if change.get("name") is not None and change["name"] != found.name:
        said.append(f"Renamed the review {found.name} to {change['name']}")
        found.name = change["name"]
    added: list[Component] = []
    if change.get("component_ids") is not None:
        wanted = _components(db, owner, change["component_ids"])
        have = {cover.component_id for cover in found.covers}
        added = [c for c in wanted if c.id not in have]
        keep = {c.id for c in wanted}
        dropped = [c for c in _covered(db, found) if c.id not in keep]  # one removed from the program stays in it
        for component in added:
            db.add(ReviewComponent(review_id=found.id, component_id=component.id))
        for cover in [cover for cover in found.covers if cover.component_id in {c.id for c in dropped}]:
            db.delete(cover)
        if added:
            said.append(f"{found.name}: added {', '.join(c.name for c in added)}")
        if dropped:
            said.append(f"{found.name}: took off {', '.join(c.name for c in dropped)}")
        db.flush()
        db.refresh(found)
    if "held_on" in change and change["held_on"] != found.held_on:
        was, found.held_on = found.held_on, change["held_on"]
        _schedule(db, user, owner, found, stone, _covered(db, found), was)
        said.append(
            f"{found.name}: on {progress.day_in_words(found.held_on)}" if found.held_on else f"{found.name}: no day"
        )
    elif added and found.held_on is not None:
        _schedule(db, user, owner, found, stone, added, None)
    if change.get("notes") is not None and change["notes"] != found.notes:
        found.notes = change["notes"]
        said.append(f"{found.name}: notes changed" if found.notes else f"{found.name}: notes cleared")
    if not said:
        db.rollback()
        return found
    for what in said:
        log(db, owner, user, what)
    _touch(found, user)
    db.commit()
    db.refresh(found)
    return found


def pass_review(db: Session, user: User, review_id: int, *, on: date | None) -> Review:
    """Pass a review: each component it covers passes its milestone (done, on the day said, else the review's, else
    today), but those through it already (passed, or not needed), which stay as they are."""
    for attempt in range(2):
        found, owner = _open(db, review_id)
        stone = programs.milestone(db, found.milestone_id)
        day = on or found.held_on or utcnow().date()
        passed = 0
        for component in _covered(db, found):
            kept = progress.progress_at(db, component, stone)
            if kept is not None and kept.status in _THROUGH:
                continue
            if progress.change_progress(
                db, user, owner, component, stone, {"status": Status.DONE, "done_on": day}, found.name
            ):
                passed += 1
        if not passed:
            db.rollback()
            return found
        log(db, owner, user, f"{found.name}: passed, {_counted(passed, 'component')}")
        _touch(found, user)
        try:
            db.commit()
            db.refresh(found)
            return found
        except IntegrityError:  # someone kept a component's first progress at the milestone meanwhile: theirs first
            db.rollback()
            if attempt:
                raise
    raise AssertionError("unreachable")


def remove_review(db: Session, user: User, review_id: int, *, removed: bool) -> Review:
    """Take a review off its program, keeping it (its notes and files with it), or bring it back. Its components'
    progress stays as it is either way."""
    found = review(db, review_id)
    owner = programs.program(db, found.program_id)
    programs.check_open(owner)
    if (found.removed_at is not None) == removed:
        return found
    if removed:
        found.removed_at, found.removed_by = utcnow(), user.id
        log(db, owner, user, f"Removed the review {found.name}")
    else:
        found.removed_at, found.removed_by = None, None
        log(db, owner, user, f"Brought the review {found.name} back")
    _touch(found, user)
    db.commit()
    db.refresh(found)
    return found


def add_file(db: Session, user: User, review_id: int, *, url: str, title: str) -> Review:
    """A review's file: its slides, its package, its minutes, wherever they're kept (an http or https address, or a
    page of the site's own)."""
    url = progress.check_address(url, "a review")
    found, owner = _open(db, review_id)
    if len(found.links) >= MOST_FILES:
        raise ApiError(f"A review has up to {MOST_FILES} files: remove some it no longer needs first")
    db.add(ReviewLink(review_id=found.id, title=title, url=url, added_by=user.id))
    log(db, owner, user, f"{found.name}: added {title or url}")
    _touch(found, user)
    db.commit()
    db.refresh(found)
    return found


def remove_file(db: Session, user: User, review_id: int, file_id: int) -> Review:
    found, owner = _open(db, review_id)
    link = db.get(ReviewLink, file_id)
    if link is None or link.review_id != found.id:
        raise NotFound(f"{found.name} has no file #{file_id}: someone may have removed it already")
    db.delete(link)
    log(db, owner, user, f"{found.name}: removed {link.title or link.url}")
    _touch(found, user)
    db.commit()
    db.refresh(found)
    return found
