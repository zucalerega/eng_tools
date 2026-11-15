"""Buildflow's API (/api/buildflow): programs and their bills of design, their layout (admins'), and their components'
progress, links, and people (anyone's)."""

from typing import Annotated

from fastapi import APIRouter, Query, Response
from sqlalchemy.orm import Session

from ..api.deps import DB, ActiveUser
from ..models import User
from . import programs, progress
from .models import Program
from .schemas import (
    ComponentChangeIn,
    ComponentIn,
    ComponentOut,
    EventOut,
    LinkIn,
    MilestoneChangeIn,
    MilestoneIn,
    MilestoneOut,
    PeopleIn,
    ProgramChangeIn,
    ProgramDetailOut,
    ProgramIn,
    ProgramOut,
    ProgressIn,
    SubsystemChangeIn,
    SubsystemIn,
    SubsystemOut,
)

router = APIRouter(prefix="/api/buildflow", tags=["buildflow"])


def _out(db: Session, program: Program, user: User) -> ProgramOut:
    return ProgramOut.of(program, progress.summarize(db, program), can_edit=user.is_admin)


def _detail(db: Session, program: Program, user: User) -> ProgramDetailOut:
    out = _out(db, program, user)
    removed = programs.components(db, program.id, removed=True) if user.is_admin else []
    return ProgramDetailOut(
        **out.model_dump(),
        milestones=[MilestoneOut.of(m) for m in programs.milestones(db, program.id)],
        subsystems=[SubsystemOut.of(s) for s in programs.subsystems(db, program.id)],
        components=[ComponentOut.of(c) for c in programs.components(db, program.id)],
        removed=[ComponentOut.of(c) for c in removed],
    )


# --- programs -------------------------------------------------------------------------------------------------------


@router.get("/programs")
def get_programs(user: ActiveUser, db: DB, archived: bool = False) -> list[ProgramOut]:
    """The programs, in the order admins put them in, each with how far its components have come in each phase
    (archived=true: the archived ones)."""
    return [_out(db, found, user) for found in programs.programs(db, archived=archived)]


@router.post("/programs", status_code=201)
def post_program(body: ProgramIn, user: ActiveUser, db: DB) -> ProgramDetailOut:
    """A new program, with the milestones every program starts with, and a starting layout (rocket, hopper, stand) or
    none (blank) (admins)."""
    made = programs.add_program(db, user, body.name, body.description, body.template)
    return _detail(db, made, user)


@router.get("/programs/{program_id}")
def get_program(program_id: int, user: ActiveUser, db: DB) -> ProgramDetailOut:
    """A program's whole bill of design: its milestones, subsystems, and components, each with its progress, links, and
    people."""
    return _detail(db, programs.program(db, program_id), user)


@router.patch("/programs/{program_id}")
def patch_program(program_id: int, body: ProgramChangeIn, user: ActiveUser, db: DB) -> ProgramOut:
    """Rename a program, describe it, draw its vehicle again (profile), or move it in the list (admins): what's left
    out stays as it is."""
    changed = programs.change_program(
        db,
        user,
        program_id,
        name=body.name,
        description=body.description,
        profile=body.profile,
        position=body.position,
    )
    return _out(db, changed, user)


@router.post("/programs/{program_id}/archive")
def post_archive(program_id: int, user: ActiveUser, db: DB) -> ProgramOut:
    """Archive a program: kept as it is, off the list (admins)."""
    return _out(db, programs.archive(db, user, program_id, archived=True), user)


@router.post("/programs/{program_id}/restore")
def post_restore(program_id: int, user: ActiveUser, db: DB) -> ProgramOut:
    """Bring an archived program back (admins)."""
    return _out(db, programs.archive(db, user, program_id, archived=False), user)


@router.get("/programs/{program_id}/activity")
def get_activity(
    program_id: int, user: ActiveUser, db: DB, limit: Annotated[int, Query(ge=1, le=500)] = 50
) -> list[EventOut]:
    """What's been done to a program, the latest first."""
    return [EventOut.of(event, name) for event, name in progress.activity(db, program_id, limit)]


# --- the layout: milestones, subsystems, components (admins) --------------------------------------------------------


@router.post("/programs/{program_id}/milestones", status_code=201)
def post_milestone(program_id: int, body: MilestoneIn, user: ActiveUser, db: DB) -> MilestoneOut:
    """A new milestone in a phase, at a place in it (none: last)."""
    made = programs.add_milestone(
        db,
        user,
        program_id,
        phase=body.phase,
        name=body.name,
        title=body.title,
        review=body.review,
        position=body.position,
    )
    return MilestoneOut.of(made)


@router.patch("/milestones/{milestone_id}")
def patch_milestone(milestone_id: int, body: MilestoneChangeIn, user: ActiveUser, db: DB) -> MilestoneOut:
    """Rename a milestone, say what it stands for, or move it, in its phase or to another."""
    changed = programs.change_milestone(
        db,
        user,
        milestone_id,
        phase=body.phase,
        name=body.name,
        title=body.title,
        review=body.review,
        position=body.position,
    )
    return MilestoneOut.of(changed)


@router.delete("/milestones/{milestone_id}", status_code=204)
def delete_milestone(milestone_id: int, user: ActiveUser, db: DB) -> Response:
    """Delete a milestone nothing's been kept on (409 `milestone_in_use` if anything has)."""
    programs.remove_milestone(db, user, milestone_id)
    return Response(status_code=204)


@router.post("/programs/{program_id}/subsystems", status_code=201)
def post_subsystem(program_id: int, body: SubsystemIn, user: ActiveUser, db: DB) -> SubsystemOut:
    return SubsystemOut.of(programs.add_subsystem(db, user, program_id, name=body.name, position=body.position))


@router.patch("/subsystems/{subsystem_id}")
def patch_subsystem(subsystem_id: int, body: SubsystemChangeIn, user: ActiveUser, db: DB) -> SubsystemOut:
    changed = programs.change_subsystem(db, user, subsystem_id, name=body.name, position=body.position)
    return SubsystemOut.of(changed)


@router.delete("/subsystems/{subsystem_id}", status_code=204)
def delete_subsystem(subsystem_id: int, user: ActiveUser, db: DB) -> Response:
    """Delete a subsystem with no components in it (409 `not_empty`)."""
    programs.remove_subsystem(db, user, subsystem_id)
    return Response(status_code=204)


@router.post("/programs/{program_id}/components", status_code=201)
def post_component(program_id: int, body: ComponentIn, user: ActiveUser, db: DB) -> ComponentOut:
    """A new component, at the end of its subsystem, and on the drawing at x, y (both, or neither)."""
    made = programs.add_component(
        db,
        user,
        program_id,
        subsystem_id=body.subsystem_id,
        name=body.name,
        description=body.description,
        bought=body.bought,
        x=body.x,
        y=body.y,
    )
    return ComponentOut.of(made)


@router.get("/components/{component_id}")
def get_component(component_id: int, user: ActiveUser, db: DB) -> ComponentOut:
    return ComponentOut.of(programs.component(db, component_id))


@router.patch("/components/{component_id}")
def patch_component(component_id: int, body: ComponentChangeIn, user: ActiveUser, db: DB) -> ComponentOut:
    """Change what's sent of a component: its name, subsystem, whether it's bought, its place on the drawing (x, y; null
    takes it off), and its place in its subsystem are admins' to change; its description and lead (lead_id; null: no
    one), anyone's."""
    change = {key: getattr(body, key) for key in body.model_fields_set}
    return ComponentOut.of(programs.change_component(db, user, component_id, change))


@router.delete("/components/{component_id}")
def delete_component(component_id: int, user: ActiveUser, db: DB) -> ComponentOut:
    """Take a component off its program, keeping everything said of it, to bring back (admins)."""
    return ComponentOut.of(programs.remove_component(db, user, component_id, removed=True))


@router.post("/components/{component_id}/restore")
def post_restore_component(component_id: int, user: ActiveUser, db: DB) -> ComponentOut:
    """Bring a removed component back, at the end of its subsystem (admins)."""
    return ComponentOut.of(programs.remove_component(db, user, component_id, removed=False))


# --- progress, links, and people (anyone) ---------------------------------------------------------------------------


@router.put("/components/{component_id}/progress/{milestone_id}")
def put_progress(component_id: int, milestone_id: int, body: ProgressIn, user: ActiveUser, db: DB) -> ComponentOut:
    """Change a component's progress at a milestone: what's sent (status, due, done_on, note) changes, and what's left
    out stays. Done without done_on, it's done today."""
    change = {key: getattr(body, key) for key in body.model_fields_set}
    return ComponentOut.of(progress.set_progress(db, user, component_id, milestone_id, change))


@router.post("/components/{component_id}/links", status_code=201)
def post_link(component_id: int, body: LinkIn, user: ActiveUser, db: DB) -> ComponentOut:
    """A page about a component, in a phase (or on a milestone, in its phase)."""
    found = progress.add_link(
        db,
        user,
        component_id,
        phase=body.phase,
        kind=body.kind,
        url=body.url,
        title=body.title,
        milestone_id=body.milestone_id,
    )
    return ComponentOut.of(found)


@router.delete("/links/{link_id}")
def delete_link(link_id: int, user: ActiveUser, db: DB) -> ComponentOut:
    """Remove a link: its component, without it."""
    return ComponentOut.of(progress.remove_link(db, user, link_id))


@router.put("/components/{component_id}/people")
def put_people(component_id: int, body: PeopleIn, user: ActiveUser, db: DB) -> ComponentOut:
    """Who's on a component in a phase (user_ids, in order): the build phase's are who's making it."""
    return ComponentOut.of(progress.set_people(db, user, component_id, body.phase, body.user_ids))
