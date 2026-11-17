"""Buildflow's rules for a program's progress: where each component is at each milestone, the pages about it (its links),
and who's on it in each phase. Anyone signed in (and approved) keeps these up as the team works through a program, as
admins laid it out (programs.py); each change is noted in the program's activity, which says what's been worked on
lately."""

import unicodedata
from collections.abc import Iterable, Sequence
from datetime import date
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import ApiError, NotFound
from ..models import User
from . import programs
from .models import Assignment, Component, Event, Link, Milestone, Phase, Program, Progress, Status
from .programs import PHASES, log
from .schemas import MOST_LINKS, PhaseCounts, Summary

# How a status reads in the activity: a review that's done has passed.
_SAID = {
    Status.NOT_STARTED: "not started",
    Status.IN_PROGRESS: "in progress",
    Status.DONE: "done",
    Status.BLOCKED: "blocked",
    Status.SKIPPED: "skipped",
}


class BadLink(ApiError):
    """A link that's neither a web address nor a page of the site's own."""

    code = "bad_link"


def check_address(url: str, of: str = "a component") -> str:
    """A link a component (or a review: `of`) can have: http or https to a host, or a page of the site's own
    ("/vault/file/12"), with no spaces or control characters in it. Never javascript: or data:, which would run in the
    site when someone opened it, and never //host, which a browser takes as another site."""
    clean = bool(url) and not any(char.isspace() or unicodedata.category(char) == "Cc" for char in url)
    if clean and url.startswith("/") and not url.startswith(("//", "/\\")):
        return url
    if clean and url.partition(":")[0].lower() in ("http", "https") and urlsplit(url).hostname:
        return url
    raise BadLink(
        f"{url[:100]} isn't a link {of} can have: a link is an http or https address, or a page of the site's own, "
        "like /vault/file/12"
    )


# What a link is, as the activity says it.
_LINKED = {
    "cad": "CAD",
    "drawing": "a drawing",
    "requirement": "a requirement",
    "document": "a design document",
    "review": "a review",
    "pid": "a P&ID",
    "data": "test data",
    "procedure": "a procedure",
    "other": "a link",
}
# Who's on a component in each phase, as the activity says it.
_WHO = {Phase.DESIGN: "Designing", Phase.BUILD: "Manufacturing", Phase.TEST: "Testing", Phase.LAUNCH: "Flying"}


def phase_state(milestones: Sequence[Milestone], statuses: dict[int, Status]) -> str:
    """Where a component is in a phase, from its status at each of the phase's milestones: skipped (nothing to do in
    it), done (through every milestone it has to go through), blocked (held up at one), in progress (one started or
    done), or not started. A PhaseCounts field's name."""
    wanted = [s for s in (statuses.get(m.id, Status.NOT_STARTED) for m in milestones) if s != Status.SKIPPED]
    if not wanted:
        return "skipped"
    if all(s == Status.DONE for s in wanted):
        return "done"
    if Status.BLOCKED in wanted:
        return "blocked"
    if any(s in (Status.DONE, Status.IN_PROGRESS) for s in wanted):
        return "in_progress"
    return "not_started"


def summarize(db: Session, program: Program) -> Summary:
    """How far a program's components have come in each phase, and how many are through each phase's last milestone
    (the CDRs passed, the components flown)."""
    stones = programs.milestones(db, program.id)
    live = programs.components(db, program.id)
    by_phase = {phase: [m for m in stones if m.phase == phase] for phase in PHASES}
    last = {phase: (by_phase[phase][-1] if by_phase[phase] else None) for phase in PHASES}
    counts = {phase: PhaseCounts() for phase in PHASES}
    through = dict.fromkeys(PHASES, 0)
    for component in live:
        statuses = {p.milestone_id: p.status for p in component.progress}
        for phase in PHASES:
            state = phase_state(by_phase[phase], statuses)
            setattr(counts[phase], state, getattr(counts[phase], state) + 1)
            end = last[phase]
            if end is not None and statuses.get(end.id) == Status.DONE:
                through[phase] += 1
    return Summary(
        components=len(live),
        phases=counts,
        through=through,
        last_milestone={phase: (m.name if m is not None else None) for phase, m in last.items()},
    )


def _open(db: Session, component_id: int) -> tuple[Component, Program]:
    """A component that can be changed, and its program: not removed, and its program not archived."""
    found = programs.component(db, component_id)
    owner = programs.program(db, found.program_id)
    programs.check_open(owner)
    programs.check_live(found)
    return found, owner


def _milestone_of(db: Session, program: Program, milestone_id: int) -> Milestone:
    found = db.get(Milestone, milestone_id)
    if found is None or found.program_id != program.id:
        raise NotFound(f"{program.name} has no milestone #{milestone_id}")
    return found


def day_in_words(day: date) -> str:
    """A day as the activity says it: "Dec 3, 2026"."""
    return f"{day:%b} {day.day}, {day.year}"


def _touch(component: Component, user: User) -> None:
    component.updated_at, component.updated_by = utcnow(), user.id


def set_progress(db: Session, user: User, component_id: int, milestone_id: int, change: dict[str, Any]) -> Component:
    """Change a component's progress at a milestone: what's in `change` (status, due, done_on, note), and only that.
    Done, it's done today unless it says when; no longer done, it's no longer done on any day, unless it says."""
    for attempt in range(2):
        found, owner = _open(db, component_id)
        stone = _milestone_of(db, owner, milestone_id)
        if not change_progress(db, user, owner, found, stone, change):
            db.rollback()
            return found
        try:
            db.commit()
            db.refresh(found)
            return found
        except IntegrityError:  # someone kept this component's first progress at this milestone meanwhile: theirs first
            db.rollback()
            if attempt:
                raise
    raise AssertionError("unreachable")


def progress_at(db: Session, component: Component, stone: Milestone) -> Progress | None:
    """A component's progress at a milestone, if any's been kept: none is not started."""
    return db.scalar(select(Progress).where(Progress.component_id == component.id, Progress.milestone_id == stone.id))


def change_progress(
    db: Session, user: User, owner: Program, found: Component, stone: Milestone, change: dict[str, Any], why: str = ""
) -> bool:
    """Make a change to a component's progress at a milestone, as set_progress does, without committing it (a review
    changes several components' at once): whether it changed anything. The activity says why, if it's said ("Feed
    system PDR")."""
    kept = progress_at(db, found, stone) or Progress(
        component_id=found.id, milestone_id=stone.id, status=Status.NOT_STARTED, note=""
    )
    said = _apply(kept, stone, change)
    if not said:
        return False
    if kept.id is None:
        db.add(kept)
    kept.updated_at, kept.updated_by = utcnow(), user.id
    log(db, owner, user, f"{stone.name}: {'; '.join(said)}" + (f" ({why})" if why else ""), found)
    _touch(found, user)
    return True


def _apply(kept: Progress, stone: Milestone, change: dict[str, Any]) -> list[str]:
    """Make the change to a component's progress at a milestone: what it changed, in words, for the activity."""
    said = []
    status = change.get("status")
    restated = status is not None and status != kept.status
    if restated:
        kept.status = status
        said.append("passed" if stone.review and status == Status.DONE else _SAID[status])
        if "done_on" not in change:
            kept.done_on = (kept.done_on or utcnow().date()) if status == Status.DONE else None
    if "due" in change and change["due"] != kept.due:
        kept.due = change["due"]
        said.append(f"due {day_in_words(kept.due)}" if kept.due else "no due date")
    if "done_on" in change and change["done_on"] != kept.done_on:
        kept.done_on = change["done_on"]
        if not restated:  # said with the status, when that changed too
            said.append(f"done on {day_in_words(kept.done_on)}" if kept.done_on else "no day it was done")
    note = change.get("note")
    if note is not None and note != kept.note:
        kept.note = note
        said.append("note changed" if note else "note cleared")
    return said


def add_link(
    db: Session,
    user: User,
    component_id: int,
    *,
    phase: Phase,
    kind: str,
    url: str,
    title: str,
    milestone_id: int | None,
) -> Component:
    """A page about a component, in a phase: on a milestone (a review's slides, say), it's in that milestone's phase."""
    url = check_address(url)
    found, owner = _open(db, component_id)
    if len(found.links) >= MOST_LINKS:
        raise ApiError(f"A component has up to {MOST_LINKS} links: remove some it no longer needs first")
    if milestone_id is not None:
        phase = _milestone_of(db, owner, milestone_id).phase
    db.add(
        Link(
            component_id=found.id,
            phase=phase,
            milestone_id=milestone_id,
            kind=kind,
            title=title,
            url=url,
            added_by=user.id,
        )
    )
    log(db, owner, user, f"Added {_LINKED.get(kind, 'a link')}: {title or url}", found)
    _touch(found, user)
    db.commit()
    db.refresh(found)
    return found


def remove_link(db: Session, user: User, link_id: int) -> Component:
    link = db.get(Link, link_id)
    if link is None:
        raise NotFound(f"There's no link #{link_id}: someone may have removed it already")
    found, owner = _open(db, link.component_id)
    db.delete(link)
    log(db, owner, user, f"Removed {_LINKED.get(link.kind, 'a link')}: {link.title or link.url}", found)
    _touch(found, user)
    db.commit()
    db.refresh(found)
    return found


def set_people(db: Session, user: User, component_id: int, phase: Phase, user_ids: Iterable[int]) -> Component:
    """Who's on a component in a phase: these people, in this order, and no one else."""
    found, owner = _open(db, component_id)
    wanted = [programs.member(db, person) for person in dict.fromkeys(user_ids)]
    now = [a for a in found.people if a.phase == phase]
    if [a.user_id for a in now] == [person.id for person in wanted]:
        return found
    for assignment in now:
        db.delete(assignment)
    db.flush()
    for person in wanted:
        db.add(Assignment(component_id=found.id, phase=phase, user_id=person.id))
    names = ", ".join(person.display_name for person in wanted) or "no one"
    log(db, owner, user, f"{_WHO[phase]}: {names}", found)
    _touch(found, user)
    db.commit()
    db.refresh(found)
    return found


def activity(db: Session, program_id: int, limit: int) -> list[tuple[Event, str | None]]:
    """What's been done to a program, the latest first, each with its component's name as it is now."""
    programs.program(db, program_id)
    events = list(
        db.scalars(
            select(Event).where(Event.program_id == program_id).order_by(Event.at.desc(), Event.id.desc()).limit(limit)
        )
    )
    ids = {e.component_id for e in events if e.component_id is not None}
    names = {c.id: c.name for c in db.scalars(select(Component).where(Component.id.in_(ids)))} if ids else {}
    return [(event, names.get(event.component_id) if event.component_id else None) for event in events]
