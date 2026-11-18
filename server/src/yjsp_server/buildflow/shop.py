"""Buildflow's shop, from the team's machining tracker: the machines in the team's shop, the places people are trained
to make parts in, how far each person's trained on each machine and at each place, and the parts queued to be machined.

Anyone signed in keeps the queue. They add a part (asked for by them, unless they say whose it is), change it, move it
through the queue (queued, in progress, blocked, done), and take it off it, which keeps it, to bring back. A part can be
for a component on a program's bill of design, or for a program as a whole: the component's panel shows it, and the
program's activity what's become of it. Each person says how far they're trained on each machine, and at each place
(a department's machine shop, a makerspace: each has training of its own), and admins can change anyone's; those who
run a machine on their own (level 2) or train others on it (3) are who can make its parts. Admins keep the lists of
machines and places: a machine that's retired takes no new parts, and keeps those made on it; a place that's retired
isn't offered, and keeps who was trained there.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import Conflict, NotFound
from ..models import User, UserStatus
from . import programs
from .models import Machine, Place, PlaceSkill, Program, ShopPart, ShopStatus, Skill
from .programs import Removed, log, require_admin
from .progress import check_address

LEVELS = (0, 1, 2, 3)  # not trained, supervised only, runs it on their own, trains others
RUNS_IT = 2  # the level at which someone can make a machine's parts
TRAINS = 3

# The queue's order: what's under way first, then what's held up, then what's waiting, then what's done.
_ORDER = {ShopStatus.IN_PROGRESS: 0, ShopStatus.BLOCKED: 1, ShopStatus.QUEUED: 2, ShopStatus.DONE: 3}
# How a status reads in a program's activity.
_SAID = {
    ShopStatus.QUEUED: "queued",
    ShopStatus.IN_PROGRESS: "in progress",
    ShopStatus.BLOCKED: "blocked",
    ShopStatus.DONE: "done",
}


class MachineRetired(Conflict):
    """A retired machine takes no new parts: an admin brings it back, or the part goes on another machine."""

    code = "machine_retired"


def _commit(db: Session, taken: str) -> None:
    """Commit, saying what's taken if a name a machine must have alone was taken meanwhile."""
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise Conflict(taken, code="name_taken") from None


# --- machines and places (admins) ----------------------------------------------------------------------------------

# What each list calls what it keeps, in what it says.
_WHAT = {Machine: "machine", Place: "place"}


def _listed[Kept: (Machine, Place)](db: Session, kind: type[Kept], retired: bool | None) -> list[Kept]:
    found = select(kind)
    if retired is not None:
        found = found.where(kind.retired_at.is_not(None) if retired else kind.retired_at.is_(None))
    return list(db.scalars(found.order_by(kind.position, kind.id)))


def _one[Kept: (Machine, Place)](db: Session, kind: type[Kept], kept_id: int) -> Kept:
    found = db.get(kind, kept_id)
    if found is None:
        raise NotFound(f"There's no {_WHAT[kind]} #{kept_id}")
    return found


def _check_free(db: Session, kind: type[Machine] | type[Place], name: str, but: Machine | Place | None = None) -> None:
    taken = db.scalar(select(kind).where(kind.name_key == name.lower(), kind.id != (but.id if but else -1)))
    if taken is not None:
        retired = " (retired)" if taken.retired_at is not None else ""
        raise Conflict(f"There's a {_WHAT[kind]} called {taken.name}{retired} already", code="name_taken")


def _add[Kept: (Machine, Place)](db: Session, admin: User, kind: type[Kept], name: str) -> Kept:
    """A new machine or place, at the end of its list."""
    require_admin(admin, f"add {_WHAT[kind]}s")
    _check_free(db, kind, name)
    last = max((each.position for each in _listed(db, kind, None)), default=-1)
    found = kind(name=name, name_key=name.lower(), position=last + 1)
    db.add(found)
    _commit(db, f"There's a {_WHAT[kind]} called {name} already")
    return found


def _change[Kept: (Machine, Place)](
    db: Session, admin: User, kind: type[Kept], kept_id: int, *, name: str | None, retired: bool | None
) -> Kept:
    """Rename a machine or a place, or retire it, or bring it back."""
    require_admin(admin, f"change {_WHAT[kind]}s")
    found = _one(db, kind, kept_id)
    if name is not None and name != found.name:
        _check_free(db, kind, name, found)
        found.name, found.name_key = name, name.lower()
    if retired is not None and (found.retired_at is not None) != retired:
        found.retired_at = utcnow() if retired else None
    _commit(db, f"There's a {_WHAT[kind]} called {name} already")
    return found


def machines(db: Session, *, retired: bool | None = None) -> list[Machine]:
    """The shop's machines, in their order: all of them, or (retired) only those retired, or only those not."""
    return _listed(db, Machine, retired)


def machine(db: Session, machine_id: int) -> Machine:
    return _one(db, Machine, machine_id)


def add_machine(db: Session, admin: User, name: str) -> Machine:
    """A new machine in the shop, at the end of the list."""
    return _add(db, admin, Machine, name)


def change_machine(db: Session, admin: User, machine_id: int, *, name: str | None, retired: bool | None) -> Machine:
    """Rename a machine, or retire it (it takes no new parts, and keeps those made on it), or bring it back."""
    return _change(db, admin, Machine, machine_id, name=name, retired=retired)


def places(db: Session, *, retired: bool | None = None) -> list[Place]:
    """The places people are trained in, in their order: all of them, or (retired) only those retired, or only those
    not."""
    return _listed(db, Place, retired)


def place(db: Session, place_id: int) -> Place:
    return _one(db, Place, place_id)


def add_place(db: Session, admin: User, name: str) -> Place:
    """A new place people are trained in (a department's machine shop, a makerspace), at the end of the list."""
    return _add(db, admin, Place, name)


def change_place(db: Session, admin: User, place_id: int, *, name: str | None, retired: bool | None) -> Place:
    """Rename a place, or retire it (it isn't offered, and keeps who was trained there), or bring it back."""
    return _change(db, admin, Place, place_id, name=name, retired=retired)


# --- who's trained on what, and where ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Trained:
    """How far someone's trained: their level on each machine, and at each place, they're trained on or at (1 to 3)."""

    user: User
    machines: dict[int, int]  # by machine id
    places: dict[int, int]  # by place id


def trained(db: Session) -> list[Trained]:
    """Who's trained on the shop's machines, or at the places people are trained in, by name. Only active members:
    someone who's left the team runs nothing."""
    found: dict[int, Trained] = {}
    active = User.status == UserStatus.ACTIVE
    on = db.execute(select(Skill, User).join(User, User.id == Skill.user_id).where(Skill.level > 0, active))
    for skill, user in on:
        found.setdefault(user.id, Trained(user, {}, {})).machines[skill.machine_id] = skill.level
    at = db.execute(
        select(PlaceSkill, User).join(User, User.id == PlaceSkill.user_id).where(PlaceSkill.level > 0, active)
    )
    for place_skill, user in at:
        found.setdefault(user.id, Trained(user, {}, {})).places[place_skill.place_id] = place_skill.level
    return sorted(found.values(), key=lambda each: (each.user.display_name.lower(), each.user.id))


def training_of(db: Session, person: User) -> Trained:
    """How far someone's trained, on each machine and at each place."""
    on = db.scalars(select(Skill).where(Skill.user_id == person.id, Skill.level > 0))
    at = db.scalars(select(PlaceSkill).where(PlaceSkill.user_id == person.id, PlaceSkill.level > 0))
    return Trained(
        person, {skill.machine_id: skill.level for skill in on}, {skill.place_id: skill.level for skill in at}
    )


def set_levels(
    db: Session, user: User, person_id: int, levels: Mapping[int, int], at_places: Mapping[int, int] | None = None
) -> Trained:
    """Say how far someone's trained on each machine sent, and at each place (0, not trained, to 3): your own, or
    anyone's for admins. The machines and places left out stay as they were. Their training, as it is now."""
    if person_id != user.id:
        require_admin(user, "change how far someone else is trained")
    person = programs.member(db, person_id)
    at_places = at_places or {}
    for known in levels:
        machine(db, known)
    for known in at_places:
        place(db, known)
    for attempt in range(2):
        for machine_id, level in levels.items():
            kept = db.scalar(select(Skill).where(Skill.user_id == person.id, Skill.machine_id == machine_id))
            if kept is None:
                kept = Skill(user_id=person.id, machine_id=machine_id)
                db.add(kept)
            kept.level, kept.updated_at, kept.updated_by = level, utcnow(), user.id
        for place_id, level in at_places.items():
            there = db.scalar(
                select(PlaceSkill).where(PlaceSkill.user_id == person.id, PlaceSkill.place_id == place_id)
            )
            if there is None:
                there = PlaceSkill(user_id=person.id, place_id=place_id)
                db.add(there)
            there.level, there.updated_at, there.updated_by = level, utcnow(), user.id
        try:
            db.commit()
            break
        except IntegrityError:  # someone else said a level of theirs first: say this one over it
            db.rollback()
            if attempt:
                raise
    return training_of(db, person)


# --- the queue (anyone) ---------------------------------------------------------------------------------------------


def parts(
    db: Session, *, removed: bool = False, component_id: int | None = None, program_id: int | None = None
) -> list[ShopPart]:
    """The parts in the shop's queue (removed: those taken off it instead), or only those for a component or a program:
    what's under way first, then what's held up, then what's waiting, then what's done; in each, the one needed soonest
    first, then the oldest."""
    gone = ShopPart.removed_at.is_not(None) if removed else ShopPart.removed_at.is_(None)
    found = select(ShopPart).where(gone)
    if component_id is not None:
        found = found.where(ShopPart.component_id == component_id)
    if program_id is not None:
        found = found.where(ShopPart.program_id == program_id)
    return sorted(db.scalars(found), key=lambda p: (_ORDER[p.status], p.need_by or date.max, p.created_at, p.id))


def part(db: Session, part_id: int) -> ShopPart:
    found = db.get(ShopPart, part_id)
    if found is None:
        raise NotFound(f"There's no part #{part_id} in the shop")
    return found


def _for(db: Session, part: ShopPart, *, component_id: int | None, program_id: int | None) -> None:
    """Say what a part is for: a component (and so its program), a program as a whole, or neither. Only one that can
    be changed: not removed from its program, and in a program that isn't archived."""
    if component_id is not None:
        component = programs.component(db, component_id)
        programs.check_open(programs.program(db, component.program_id))
        programs.check_live(component)
        part.component_id, part.program_id = component.id, component.program_id
    elif program_id is not None:
        programs.check_open(programs.program(db, program_id))
        part.component_id, part.program_id = None, program_id
    else:
        part.component_id = part.program_id = None


def _apply(db: Session, part: ShopPart, change: Mapping[str, Any]) -> ShopStatus | None:
    """Change what's in `change` of a part, and only that, as the rules have it. Its new status, if that changed."""
    if "machine_id" in change and change["machine_id"] != part.machine_id:
        on = machine(db, change["machine_id"])
        if on.retired_at is not None:
            raise MachineRetired(f"The {on.name} is retired: put the part on another machine, or ask an admin")
        part.machine_id = on.id
    # What it's for is said by the two together: either sent, the other's taken as none if it's left out.
    if "component_id" in change or "program_id" in change:
        component_id, program_id = change.get("component_id"), change.get("program_id")
        same = (
            component_id == part.component_id
            if component_id is not None
            else part.component_id is None and program_id == part.program_id
        )
        if not same:
            _for(db, part, component_id=component_id, program_id=program_id)
    for person in ("requester_id", "machinist_id"):
        if person in change:
            setattr(part, person, programs.member(db, change[person]).id if change[person] is not None else None)
    for address in ("drawing", "cad"):
        if address in change:
            setattr(part, address, check_address(change[address]) if change[address] else "")
    for plain in ("name", "material", "quantity", "hours", "need_by", "note"):
        if plain in change:
            setattr(part, plain, change[plain])
    if "status" in change and change["status"] != part.status:
        part.status = change["status"]
        part.done_at = utcnow() if part.status == ShopStatus.DONE else None
        return part.status
    return None


def _program_of(db: Session, part: ShopPart) -> Program | None:
    return db.get(Program, part.program_id) if part.program_id is not None else None


def _log(db: Session, part: ShopPart, user: User, what: str) -> None:
    """Note what's become of a part in its program's activity, if it's for one."""
    owner = _program_of(db, part)
    if owner is not None:
        component = programs.component(db, part.component_id) if part.component_id is not None else None
        log(db, owner, user, what, component)


def add_part(db: Session, user: User, fields: Mapping[str, Any]) -> ShopPart:
    """Put a part in the shop's queue: asked for by whoever adds it, unless they say whose it is (requester_id)."""
    found = ShopPart(
        name=fields["name"],
        machine_id=-1,  # none yet: _apply puts it on the machine sent, as the rules have it
        requester_id=user.id,
        created_by=user.id,
        updated_by=user.id,
        status=ShopStatus.QUEUED,
    )
    _apply(db, found, fields)
    db.add(found)
    db.flush()
    on = machine(db, found.machine_id)
    _log(db, found, user, f"Queued {found.name} in the shop, on the {on.name}")
    db.commit()
    db.refresh(found)
    return found


def change_part(db: Session, user: User, part_id: int, change: Mapping[str, Any]) -> ShopPart:
    """Change what's sent of a part in the queue, and only that: its status moves it through the queue."""
    found = part(db, part_id)
    if found.removed_at is not None:
        raise Removed(f"{found.name} was taken off the shop's queue: bring it back to change it")
    moved = _apply(db, found, change)
    found.updated_at, found.updated_by = utcnow(), user.id
    if moved is not None:
        _log(db, found, user, f"{found.name}, in the shop: {_SAID[moved]}")
    db.commit()
    db.refresh(found)
    return found


def remove_part(db: Session, user: User, part_id: int, *, removed: bool) -> ShopPart:
    """Take a part off the shop's queue, keeping it, or put it back where it was."""
    found = part(db, part_id)
    if (found.removed_at is not None) == removed:
        return found
    found.removed_at, found.removed_by = (utcnow(), user.id) if removed else (None, None)
    found.updated_at, found.updated_by = utcnow(), user.id
    _log(
        db, found, user, f"Took {found.name} off the shop's queue" if removed else f"Put {found.name} back in the shop"
    )
    db.commit()
    db.refresh(found)
    return found


# --- how busy each machine is ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Load:
    """A machine's open work, and who can do it."""

    machine: Machine
    parts: int  # in the queue, and not done
    hours: float  # their estimates, added up
    unestimated: int  # of those, the ones with no estimate
    operators: int  # who run it on their own, or train others on it
    trainers: int  # who train others on it


def load(db: Session) -> list[Load]:
    """How much work each machine (that isn't retired) has waiting, and how many people can do it."""
    waiting = [p for p in parts(db) if p.status != ShopStatus.DONE]
    people = trained(db)
    found = []
    for each in machines(db, retired=False):
        mine = [p for p in waiting if p.machine_id == each.id]
        levels = [person.machines.get(each.id, 0) for person in people]
        found.append(
            Load(
                machine=each,
                parts=len(mine),
                hours=round(sum(p.hours or 0 for p in mine), 2),
                unestimated=sum(1 for p in mine if p.hours is None),
                operators=sum(1 for level in levels if level >= RUNS_IT),
                trainers=sum(1 for level in levels if level >= TRAINS),
            )
        )
    return found
