"""Buildflow's rules for a program's layout: making programs and changing them, their milestones, subsystems, and
components, and where each component is on the vehicle's drawing.

Admins lay programs out: each program's bill of design is set up once, as the team plans the vehicle, and changes as
the plan does. Anyone signed in keeps its progress (progress.py). Nothing here deletes what's been said of a component:
a component removed is kept, with its progress, links, and people, until an admin brings it back; a milestone or a
subsystem goes only once nothing's been kept on it; and a program is archived, never deleted.
"""

from collections.abc import Sequence
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import ApiError, Conflict, Forbidden, NotFound
from ..models import User, UserStatus
from . import templates
from .models import Component, Event, Link, Milestone, Phase, Program, Progress, Review, Status, Subsystem
from .schemas import Profile

PHASES = tuple(Phase)
MOST_MILESTONES = 40  # in a program
MOST_SUBSYSTEMS = 40
MOST_COMPONENTS = 1000


class Archived(Conflict):
    """A program that's archived is kept as it was: an admin brings it back to change it."""

    code = "archived"


class Removed(Conflict):
    """A component removed from its program is kept as it was: an admin brings it back to change it."""

    code = "removed"


class NotAMember(ApiError):
    """Someone named on a component who isn't an active member of the site."""

    code = "not_a_member"


class MilestoneInUse(Conflict):
    """A milestone with progress kept on it, or links, stays: rename it instead."""

    code = "milestone_in_use"


def require_admin(user: User, what: str) -> None:
    if not user.is_admin:
        raise Forbidden(f"Only admins can {what}: ask one", code="admin_only")


def log(db: Session, program: Program, user: User | None, what: str, component: Component | None = None) -> None:
    """Note what someone did to a program, for its activity."""
    db.add(
        Event(
            program_id=program.id,
            component_id=component.id if component is not None else None,
            user_id=user.id if user is not None else None,
            what=what[:500],
        )
    )


def _touch(program: Program, user: User) -> None:
    program.updated_at, program.updated_by = utcnow(), user.id


def _commit(db: Session, taken: str) -> None:
    """Commit, saying what's taken if a name a program, a milestone, or a subsystem must have alone was taken
    meanwhile."""
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise Conflict(taken, code="name_taken") from None


# --- programs -------------------------------------------------------------------------------------------------------


def programs(db: Session, *, archived: bool = False) -> list[Program]:
    """The programs, in the order admins put them in (archived: those that are archived instead)."""
    archive = Program.archived_at.is_not(None) if archived else Program.archived_at.is_(None)
    return list(db.scalars(select(Program).where(archive).order_by(Program.position, Program.name_key)))


def program(db: Session, program_id: int) -> Program:
    found = db.get(Program, program_id)
    if found is None:
        raise NotFound(f"There's no program #{program_id}")
    return found


def check_open(program: Program) -> None:
    if program.archived_at is not None:
        raise Archived(f"{program.name} is archived: an admin can bring it back to change it")


def _check_name_free(db: Session, name: str, but: Program | None = None) -> None:
    taken = db.scalar(select(Program).where(Program.name_key == name.lower(), Program.id != (but.id if but else -1)))
    if taken is not None:
        archived = " (archived)" if taken.archived_at is not None else ""
        raise Conflict(f"There's a program called {taken.name}{archived} already", code="name_taken")


def add_program(db: Session, admin: User, name: str, description: str, template: str) -> Program:
    """A new program, with the milestones every program starts with, and a starting layout's drawing, subsystems, and
    components (templates.py), or none (blank)."""
    require_admin(admin, "make programs")
    _check_name_free(db, name)
    layout = templates.LAYOUTS[template]
    last = db.scalar(select(func.max(Program.position))) or 0
    made = Program(
        name=name,
        name_key=name.lower(),
        description=description,
        profile=Profile.model_validate(layout.profile).model_dump(),
        position=last + 1,
        created_by=admin.id,
        updated_by=admin.id,
    )
    db.add(made)
    db.flush()
    positions = dict.fromkeys(PHASES, 0)
    for phase, short, title, review in templates.MILESTONES:
        db.add(
            Milestone(
                program_id=made.id,
                phase=phase,
                name=short,
                name_key=short.lower(),
                title=title,
                review=review,
                position=positions[phase],
            )
        )
        positions[phase] += 1
    subsystems: dict[str, Subsystem] = {}
    for position, subsystem_name in enumerate(layout.subsystems):
        subsystems[subsystem_name] = Subsystem(
            program_id=made.id, name=subsystem_name, name_key=subsystem_name.lower(), position=position
        )
        db.add(subsystems[subsystem_name])
    db.flush()
    counts: dict[str, int] = {}
    for part in layout.parts:
        position = counts.get(part.subsystem, 0)
        counts[part.subsystem] = position + 1
        db.add(
            Component(
                program_id=made.id,
                subsystem_id=subsystems[part.subsystem].id,
                name=part.name,
                bought=part.bought,
                x=part.x,
                y=part.y,
                position=position,
                created_by=admin.id,
                updated_by=admin.id,
            )
        )
    log(db, made, admin, f"Made the program{'' if template == 'blank' else f', from the {template} layout'}")
    _commit(db, f"There's a program called {name} already")
    return made


def change_program(
    db: Session,
    admin: User,
    program_id: int,
    *,
    name: str | None = None,
    description: str | None = None,
    profile: Profile | None = None,
    position: int | None = None,
) -> Program:
    """Rename a program, describe it, draw its vehicle again, or move it in the list: what's None stays as it is."""
    require_admin(admin, "change a program's layout")
    found = program(db, program_id)
    check_open(found)
    said: list[str] = []
    if name is not None and name != found.name:
        _check_name_free(db, name, found)
        said.append(f"Renamed the program from {found.name} to {name}")
        found.name, found.name_key = name, name.lower()
    if description is not None and description != found.description:
        found.description = description
        said.append("Changed the program's description")
    if profile is not None:
        drawn = profile.model_dump()
        if drawn != found.profile:
            found.profile = drawn
            said.append("Changed the vehicle's drawing")
    if position is not None:
        _place(programs(db), found, position)
    for what in said:
        log(db, found, admin, what)
    _touch(found, admin)
    _commit(db, f"There's a program called {name} already")
    return found


def archive(db: Session, admin: User, program_id: int, *, archived: bool) -> Program:
    """Archive a program (done with: flown, or retired), or bring one back."""
    require_admin(admin, "archive programs")
    found = program(db, program_id)
    if (found.archived_at is not None) != archived:
        found.archived_at = utcnow() if archived else None
        log(db, found, admin, "Archived the program" if archived else "Brought the program back")
        _touch(found, admin)
        db.commit()
    return found


# --- milestones -----------------------------------------------------------------------------------------------------


def milestones(db: Session, program_id: int) -> list[Milestone]:
    """A program's milestones, in order: by phase, then their places in it."""
    found = db.scalars(select(Milestone).where(Milestone.program_id == program_id))
    return sorted(found, key=lambda m: (PHASES.index(m.phase), m.position, m.id))


def milestone(db: Session, milestone_id: int) -> Milestone:
    found = db.get(Milestone, milestone_id)
    if found is None:
        raise NotFound(f"There's no milestone #{milestone_id}")
    return found


def add_milestone(
    db: Session,
    admin: User,
    program_id: int,
    *,
    phase: Phase,
    name: str,
    title: str,
    review: bool,
    position: int | None,
) -> Milestone:
    require_admin(admin, "change a program's milestones")
    found = program(db, program_id)
    check_open(found)
    every = milestones(db, program_id)
    if len(every) >= MOST_MILESTONES:
        raise ApiError(f"A program has up to {MOST_MILESTONES} milestones")
    _check_milestone_free(every, name)
    made = Milestone(program_id=found.id, phase=phase, name=name, name_key=name.lower(), title=title, review=review)
    db.add(made)
    db.flush()
    in_phase = [m for m in every if m.phase == phase]
    _place(in_phase + [made], made, len(in_phase) if position is None else position)
    log(db, found, admin, f"Added the milestone {name} to {phase.value}")
    _touch(found, admin)
    _commit(db, f"There's a milestone called {name} already")
    return made


def _check_milestone_free(every: Sequence[Milestone], name: str, but: Milestone | None = None) -> None:
    taken = next((m for m in every if m.name_key == name.lower() and m is not but), None)
    if taken is not None:
        raise Conflict(f"There's a milestone called {taken.name} already, in {taken.phase.value}", code="name_taken")


def change_milestone(
    db: Session,
    admin: User,
    milestone_id: int,
    *,
    phase: Phase | None = None,
    name: str | None = None,
    title: str | None = None,
    review: bool | None = None,
    position: int | None = None,
) -> Milestone:
    """Rename a milestone, say what it stands for, or move it: to another place in its phase, or to another phase.
    Progress kept on it stays on it, as do links on it, which go with it to its phase."""
    require_admin(admin, "change a program's milestones")
    found = milestone(db, milestone_id)
    owner = program(db, found.program_id)
    check_open(owner)
    every = milestones(db, owner.id)
    said = []
    if name is not None and name != found.name:
        _check_milestone_free(every, name, found)
        said.append(f"Renamed the milestone {found.name} to {name}")
        found.name, found.name_key = name, name.lower()
    if title is not None:
        found.title = title
    if review is not None:
        found.review = review
    if phase is not None and phase != found.phase:
        _place([m for m in every if m.phase == found.phase], found, None)  # out of the phase it was in
        said.append(f"Moved the milestone {found.name} to {phase.value}")
        found.phase = phase
        for link in db.scalars(select(Link).where(Link.milestone_id == found.id)):
            link.phase = phase
        siblings = [m for m in every if m.phase == phase and m is not found]
        _place(siblings + [found], found, len(siblings) if position is None else position)
    elif position is not None:
        _place([m for m in every if m.phase == found.phase], found, position)
    for what in said:
        log(db, owner, admin, what)
    _touch(owner, admin)
    _commit(db, f"There's a milestone called {name} already")
    return found


def remove_milestone(db: Session, admin: User, milestone_id: int) -> None:
    """Delete a milestone nothing's been kept on: no component's progress (past not started, with no dates or note),
    and no links. One with any stays, so nothing said of a component is lost: rename it instead."""
    require_admin(admin, "change a program's milestones")
    found = milestone(db, milestone_id)
    owner = program(db, found.program_id)
    check_open(owner)
    kept = list(db.scalars(select(Progress).where(Progress.milestone_id == found.id)))
    used = [p for p in kept if p.status != Status.NOT_STARTED or p.due or p.done_on or p.note]
    links = db.scalar(select(func.count()).where(Link.milestone_id == found.id)) or 0
    held = db.scalar(select(func.count()).where(Review.milestone_id == found.id)) or 0  # removed ones are kept too
    if used or links or held:
        said = [f"progress on {len(used)} component{'s' if len(used) != 1 else ''}"] if used else []
        said += [f"{links} link{'s' if links != 1 else ''}"] if links else []
        said += [f"{held} review{'s' if held != 1 else ''}"] if held else []
        listed = said[0] if len(said) == 1 else f"{', '.join(said[:-1])} and {said[-1]}"
        raise MilestoneInUse(f"{found.name} has {listed} kept on it: rename it, or move it, instead")
    for blank in kept:
        db.delete(blank)
    _place([m for m in milestones(db, owner.id) if m.phase == found.phase], found, None)
    db.delete(found)
    log(db, owner, admin, f"Deleted the milestone {found.name} from {found.phase.value}")
    _touch(owner, admin)
    db.commit()


# --- subsystems -----------------------------------------------------------------------------------------------------


def subsystems(db: Session, program_id: int) -> list[Subsystem]:
    found = db.scalars(select(Subsystem).where(Subsystem.program_id == program_id))
    return sorted(found, key=lambda s: (s.position, s.id))


def subsystem(db: Session, subsystem_id: int) -> Subsystem:
    found = db.get(Subsystem, subsystem_id)
    if found is None:
        raise NotFound(f"There's no subsystem #{subsystem_id}")
    return found


def _check_subsystem_free(every: Sequence[Subsystem], name: str, but: Subsystem | None = None) -> None:
    taken = next((s for s in every if s.name_key == name.lower() and s is not but), None)
    if taken is not None:
        raise Conflict(f"There's a subsystem called {taken.name} already", code="name_taken")


def add_subsystem(db: Session, admin: User, program_id: int, *, name: str, position: int | None) -> Subsystem:
    require_admin(admin, "change a program's subsystems")
    found = program(db, program_id)
    check_open(found)
    every = subsystems(db, program_id)
    if len(every) >= MOST_SUBSYSTEMS:
        raise ApiError(f"A program has up to {MOST_SUBSYSTEMS} subsystems")
    _check_subsystem_free(every, name)
    made = Subsystem(program_id=found.id, name=name, name_key=name.lower())
    db.add(made)
    db.flush()
    _place(every + [made], made, len(every) if position is None else position)
    log(db, found, admin, f"Added the subsystem {name}")
    _touch(found, admin)
    _commit(db, f"There's a subsystem called {name} already")
    return made


def change_subsystem(
    db: Session, admin: User, subsystem_id: int, *, name: str | None = None, position: int | None = None
) -> Subsystem:
    require_admin(admin, "change a program's subsystems")
    found = subsystem(db, subsystem_id)
    owner = program(db, found.program_id)
    check_open(owner)
    every = subsystems(db, owner.id)
    if name is not None and name != found.name:
        _check_subsystem_free(every, name, found)
        log(db, owner, admin, f"Renamed the subsystem {found.name} to {name}")
        found.name, found.name_key = name, name.lower()
    if position is not None:
        _place(every, found, position)
    _touch(owner, admin)
    _commit(db, f"There's a subsystem called {name} already")
    return found


def remove_subsystem(db: Session, admin: User, subsystem_id: int) -> None:
    """Delete a subsystem with no components in it: none on the program, and none removed from it either, which keep
    their subsystem to come back to."""
    require_admin(admin, "change a program's subsystems")
    found = subsystem(db, subsystem_id)
    owner = program(db, found.program_id)
    check_open(owner)
    inside = list(db.scalars(select(Component).where(Component.subsystem_id == found.id)))
    if inside:
        live = sum(1 for c in inside if c.removed_at is None)
        what = (
            f"{live} component{'s' if live != 1 else ''} in it: move them to another subsystem first"
            if live
            else f"{len(inside)} removed component{'s' if len(inside) != 1 else ''} to come back to it: bring them "
            "back and move them first"
        )
        raise Conflict(f"{found.name} has {what}", code="not_empty")
    _place(subsystems(db, owner.id), found, None)
    db.delete(found)
    log(db, owner, admin, f"Deleted the subsystem {found.name}")
    _touch(owner, admin)
    db.commit()


# --- components -----------------------------------------------------------------------------------------------------


def components(db: Session, program_id: int, *, removed: bool = False) -> list[Component]:
    """A program's components (removed: those removed from it instead), in order: by subsystem, then their places in
    it."""
    gone = Component.removed_at.is_not(None) if removed else Component.removed_at.is_(None)
    found = db.scalars(select(Component).where(Component.program_id == program_id, gone))
    order = {s.id: s.position for s in subsystems(db, program_id)}
    return sorted(found, key=lambda c: (order.get(c.subsystem_id, 0), c.position, c.id))


def component(db: Session, component_id: int) -> Component:
    found = db.get(Component, component_id)
    if found is None:
        raise NotFound(f"There's no component #{component_id}")
    return found


def check_live(found: Component) -> None:
    if found.removed_at is not None:
        raise Removed(f"{found.name} was removed from its program: an admin can bring it back to change it")


def _subsystem_of(db: Session, program_id: int, subsystem_id: int) -> Subsystem:
    found = db.get(Subsystem, subsystem_id)
    if found is None or found.program_id != program_id:
        raise NotFound(f"The program has no subsystem #{subsystem_id}")
    return found


def _check_component_free(db: Session, program_id: int, name: str, but: Component | None = None) -> None:
    taken = db.scalar(
        select(Component).where(
            Component.program_id == program_id,
            Component.removed_at.is_(None),
            func.lower(Component.name) == name.lower(),
            Component.id != (but.id if but else -1),
        )
    )
    if taken is not None:
        raise Conflict(f"There's a component called {taken.name} already", code="name_taken")


def add_component(
    db: Session,
    admin: User,
    program_id: int,
    *,
    subsystem_id: int,
    name: str,
    description: str,
    bought: bool,
    x: float | None,
    y: float | None,
) -> Component:
    require_admin(admin, "add components")
    found = program(db, program_id)
    check_open(found)
    into = _subsystem_of(db, found.id, subsystem_id)
    every = components(db, found.id)
    if len(every) >= MOST_COMPONENTS:
        raise ApiError(f"A program has up to {MOST_COMPONENTS} components")
    _check_component_free(db, found.id, name)
    siblings = [c for c in every if c.subsystem_id == into.id]
    made = Component(
        program_id=found.id,
        subsystem_id=into.id,
        name=name,
        description=description,
        bought=bought,
        x=x if y is not None else None,
        y=y if x is not None else None,
        position=len(siblings),
        created_by=admin.id,
        updated_by=admin.id,
    )
    db.add(made)
    db.flush()
    log(db, found, admin, f"Added {name} to {into.name}", made)
    _touch(found, admin)
    db.commit()
    return made


# What a component's change may say: its layout (admins'), and what anyone may change.
LAYOUT = ("name", "subsystem_id", "bought", "x", "y", "position")


def change_component(db: Session, user: User, component_id: int, change: dict[str, Any]) -> Component:
    """Change what's in `change` (and only that): a component's name, subsystem, whether it's bought, where it's drawn,
    and its place in its subsystem are its layout, which admins change; its description, its lead, and its build plan
    (its lead time, and when it has to be ready by), anyone. x and y None take it off the drawing; lead_id None leaves
    it with no lead; lead_days and need_by None, with no lead time or day."""
    found = component(db, component_id)
    owner = program(db, found.program_id)
    check_open(owner)
    check_live(found)
    if any(key in change for key in LAYOUT):
        require_admin(user, "change a program's layout: its components' names, subsystems, and places")
    said: list[str] = []
    if "name" in change and change["name"] != found.name:
        _check_component_free(db, owner.id, change["name"], found)
        said.append(f"Renamed {found.name} to {change['name']}")
        found.name = change["name"]
    moved_to: Subsystem | None = None
    if change.get("subsystem_id") is not None and change["subsystem_id"] != found.subsystem_id:
        moved_to = _subsystem_of(db, owner.id, change["subsystem_id"])
    if "bought" in change and change["bought"] is not None and change["bought"] != found.bought:
        found.bought = change["bought"]
        said.append("Marked it bought (off the shelf)" if found.bought else "Marked it made, not bought")
    if "x" in change or "y" in change:
        x, y = change.get("x", found.x), change.get("y", found.y)
        found.x, found.y = (x, y) if x is not None and y is not None else (None, None)
    if "description" in change and change["description"] is not None and change["description"] != found.description:
        found.description = change["description"]
        said.append("Changed its description")
    if "lead_id" in change:
        lead = member(db, change["lead_id"]) if change["lead_id"] is not None else None
        if (lead.id if lead else None) != found.lead_id:
            found.lead_id = lead.id if lead else None
            said.append(f"Lead: {lead.display_name}" if lead else "No lead")
    if "lead_days" in change and change["lead_days"] != found.lead_days:
        found.lead_days = change["lead_days"]
        said.append(f"Lead time: {lead_time(found.lead_days)}" if found.lead_days is not None else "No lead time")
    if "need_by" in change and change["need_by"] != found.need_by:
        found.need_by = change["need_by"]
        day = found.need_by
        said.append(f"Ready by {day:%b} {day.day}, {day.year}" if day else "No day it's to be ready by")
    every = components(db, owner.id)
    if moved_to is not None:
        old = [c for c in every if c.subsystem_id == found.subsystem_id]
        _place(old, found, None)
        found.subsystem_id = moved_to.id
        siblings = [c for c in every if c.subsystem_id == moved_to.id and c is not found]
        position = change.get("position")
        _place(siblings + [found], found, len(siblings) if position is None else position)
        said.append(f"Moved it to {moved_to.name}")
    elif change.get("position") is not None:
        _place([c for c in every if c.subsystem_id == found.subsystem_id], found, change["position"])
    for what in said:
        log(db, owner, user, what, found)
    found.updated_at, found.updated_by = utcnow(), user.id
    db.commit()
    db.refresh(found)  # its lead, as it is now: sessions keep what they loaded past a commit
    return found


def lead_time(days: int) -> str:
    """A lead time in words: in weeks when it's whole weeks ("8 weeks"), else in days ("10 days")."""
    if days and days % 7 == 0:
        return f"{days // 7} week{'s' if days != 7 else ''}"
    return f"{days} day{'s' if days != 1 else ''}"


def member(db: Session, user_id: int) -> User:
    """Someone who can be named on a component (its lead, or one of its people): an active member of the team."""
    found = db.get(User, user_id)
    if found is None or found.status != UserStatus.ACTIVE:
        raise NotAMember(f"There's no active member #{user_id}: only people who've joined the site can be named")
    return found


def remove_component(db: Session, admin: User, component_id: int, *, removed: bool) -> Component:
    """Take a component off its program, keeping everything said of it, or bring it back, at the end of its
    subsystem."""
    require_admin(admin, "remove components")
    found = component(db, component_id)
    owner = program(db, found.program_id)
    check_open(owner)
    if (found.removed_at is not None) == removed:
        return found
    if removed:
        _place([c for c in components(db, owner.id) if c.subsystem_id == found.subsystem_id], found, None)
        found.removed_at, found.removed_by = utcnow(), admin.id
        log(db, owner, admin, f"Removed {found.name}", found)
    else:
        _check_component_free(db, owner.id, found.name, found)
        siblings = [c for c in components(db, owner.id) if c.subsystem_id == found.subsystem_id]
        found.removed_at, found.removed_by, found.position = None, None, len(siblings)
        log(db, owner, admin, f"Brought {found.name} back", found)
    found.updated_at, found.updated_by = utcnow(), admin.id
    _touch(owner, admin)
    db.commit()
    return found


# --- order ----------------------------------------------------------------------------------------------------------


def _place[Placed: (Program, Milestone, Subsystem, Component)](
    items: Sequence[Placed], item: Placed, position: int | None
) -> None:
    """Put `item` at `position` among `items` (in their order now), numbering them all from 0; None takes it out of
    them, numbering the rest."""
    ordered = sorted((i for i in items if i is not item), key=lambda i: (i.position, i.id or 0))
    if position is not None:
        ordered.insert(max(0, min(position, len(ordered))), item)
    for number, each in enumerate(ordered):
        each.position = number
