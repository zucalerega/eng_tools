"""Buildflow's bills of materials: each program's parts to buy, each for one of its components (or none yet), with how
many, from whom, at what cost each, how long it takes to come, and where it is: to order, ordered, received. They're
read in from the team's own BOM spreadsheets (an Excel or CSV file, read in the web app, billOfMaterials.ts) and read in
again as those change: a part already on the BOM (its component and part number, or its description where it has
none) is kept, with what the site says of it that the spreadsheet doesn't (its note, and where it is, unless the
spreadsheet says), and a part no longer in it goes. Anyone signed in keeps the BOM, as they do progress; each import,
and each part's change of where it is, is noted in the program's activity."""

from collections import defaultdict
from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import ApiError, NotFound
from ..models import User
from . import programs, progress
from .models import BomLine, BomStatus, Component, Program
from .programs import log

MOST_LINES = 5000  # on a program's BOM
# What a line's import says of it, and so changes; what the site keeps of its own (its note, its status when the
# spreadsheet says none) stays.
IMPORTED = ("component_id", "part_number", "description", "quantity", "unit", "vendor", "unit_cost", "lead_days", "url")
_SAID = {BomStatus.TO_ORDER: "to order", BomStatus.ORDERED: "ordered", BomStatus.RECEIVED: "received"}


def lines(db: Session, program_id: int, *, component_id: int | None = None) -> list[BomLine]:
    """A program's BOM, in its order (component_id: only that component's lines)."""
    programs.program(db, program_id)
    query = select(BomLine).where(BomLine.program_id == program_id)
    if component_id is not None:
        query = query.where(BomLine.component_id == component_id)
    return list(db.scalars(query.order_by(BomLine.position, BomLine.id)))


def _open(db: Session, program_id: int) -> Program:
    owner = programs.program(db, program_id)
    programs.check_open(owner)
    return owner


def _component_of(db: Session, owner: Program, component_id: int | None) -> Component | None:
    """The component a line's for: one of its program's, not removed (409 removed); None, none yet."""
    if component_id is None:
        return None
    found = db.get(Component, component_id)
    if found is None or found.program_id != owner.id:
        raise NotFound(f"{owner.name} has no component #{component_id}")
    programs.check_live(found)
    return found


def _key(component_id: int | None, part_number: str, description: str) -> tuple[int | None, str]:
    """What a line's known by, from one import to the next: its component, and its part number (its description, where
    it has none), whatever their case and spacing."""
    tidy = " ".join((part_number or description).split()).lower()
    return component_id, ("#" if part_number.strip() else "~") + tidy


def _checked(values: dict[str, Any]) -> dict[str, Any]:
    if values.get("url"):
        values["url"] = progress.check_address(values["url"], "a BOM line")
    return values


def _name(line: BomLine) -> str:
    return line.part_number or line.description[:80]


def import_bom(
    db: Session,
    user: User,
    program_id: int,
    incoming: Sequence[dict[str, Any]],
    *,
    component_id: int | None,
    file: str,
) -> tuple[list[BomLine], dict[str, int]]:
    """Read a BOM in: the program's whole BOM (component_id None), or one component's, becomes these lines, in this
    order. Each that's on it already (by its key) is changed to what the import says, keeping its note, and its status
    unless the import says one; those not on it are added; those on it no longer go. What it did: how many lines were
    added, changed, and taken off."""
    owner = _open(db, program_id)
    only = _component_of(db, owner, component_id)
    if len(incoming) > MOST_LINES:
        raise ApiError(f"A BOM has up to {MOST_LINES} lines: split it by component, and read each in on its own")
    wanted = []
    for values in incoming:
        values = _checked(dict(values))
        if only is not None:
            values["component_id"] = only.id  # one component's BOM is all its own
        _component_of(db, owner, values.get("component_id"))
        wanted.append(values)
    scope = lines(db, owner.id, component_id=only.id) if only is not None else lines(db, owner.id)
    kept: dict[tuple[int | None, str], list[BomLine]] = defaultdict(list)
    for line in scope:
        kept[_key(line.component_id, line.part_number, line.description)].append(line)
    counts = {"added": 0, "changed": 0, "removed": 0}
    now = utcnow()
    for position, values in enumerate(wanted):
        key = _key(values.get("component_id"), values.get("part_number", ""), values.get("description", ""))
        line = kept[key].pop(0) if kept[key] else None
        if line is None:
            line = BomLine(program_id=owner.id, created_by=user.id, note="")
            db.add(line)
            counts["added"] += 1
        elif any(getattr(line, field) != values.get(field, getattr(line, field)) for field in IMPORTED) or (
            values.get("status") is not None and values["status"] != line.status
        ):
            counts["changed"] += 1
        for field in IMPORTED:
            if field in values:
                setattr(line, field, values[field])
        if values.get("status") is not None:
            line.status = values["status"]
        line.position, line.updated_at, line.updated_by = position, now, user.id
    for gone in [line for left in kept.values() for line in left]:
        db.delete(gone)
        counts["removed"] += 1
    whose = f"{only.name}'s BOM" if only is not None else "the BOM"
    log(
        db,
        owner,
        user,
        f"Read in {whose} from {file or 'a spreadsheet'}: {len(wanted)} lines, {counts['added']} new, "
        f"{counts['changed']} changed, {counts['removed']} taken off",
        only,
    )
    db.commit()
    return lines(db, owner.id, component_id=component_id), counts


def add_line(db: Session, user: User, program_id: int, values: dict[str, Any]) -> BomLine:
    """A line added by hand, at the end of the BOM."""
    owner = _open(db, program_id)
    values = _checked(dict(values))
    component = _component_of(db, owner, values.get("component_id"))
    every = lines(db, owner.id)
    if len(every) >= MOST_LINES:
        raise ApiError(f"A BOM has up to {MOST_LINES} lines: take off some it no longer needs first")
    line = BomLine(program_id=owner.id, created_by=user.id, updated_by=user.id, position=len(every), note="")
    for field, value in values.items():
        setattr(line, field, value)
    db.add(line)
    log(db, owner, user, f"Added to the BOM: {_name(line)}", component)
    db.commit()
    db.refresh(line)
    return line


def change_line(db: Session, user: User, line_id: int, change: dict[str, Any]) -> BomLine:
    """Change what's in `change` of a line, and only that: where it is (to order, ordered, received) is noted in the
    activity."""
    line = db.get(BomLine, line_id)
    if line is None:
        raise NotFound(f"There's no BOM line #{line_id}: someone may have read the BOM in again")
    owner = _open(db, line.program_id)
    change = _checked(dict(change))
    if "component_id" in change:
        _component_of(db, owner, change["component_id"])
    said = []
    if change.get("status") is not None and change["status"] != line.status:
        said.append(f"BOM: {_name(line)}: {_SAID[change['status']]}")
    for field, value in change.items():
        if field == "status" and value is None:
            continue
        setattr(line, field, value)
    line.updated_at, line.updated_by = utcnow(), user.id
    component = db.get(Component, line.component_id) if line.component_id is not None else None
    for what in said:
        log(db, owner, user, what, component)
    db.commit()
    db.refresh(line)
    return line


def remove_line(db: Session, user: User, line_id: int) -> None:
    line = db.get(BomLine, line_id)
    if line is None:
        raise NotFound(f"There's no BOM line #{line_id}: someone may have taken it off already")
    owner = _open(db, line.program_id)
    component = db.get(Component, line.component_id) if line.component_id is not None else None
    db.delete(line)
    log(db, owner, user, f"Took off the BOM: {_name(line)}", component)
    db.commit()
