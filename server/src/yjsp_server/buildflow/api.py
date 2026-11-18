"""Buildflow's API (/api/buildflow): programs and their bills of design, their layout (admins'), and their components'
progress, links, and people, and their design reviews (anyone's); and the shop (/api/buildflow/shop): the parts queued to
be machined (anyone's), who's trained on which machine (each their own, and admins anyone's), and the machines
(admins')."""

from typing import Annotated

from fastapi import APIRouter, Query, Response
from sqlalchemy.orm import Session

from ..api.deps import DB, ActiveUser
from ..api.schemas import UserRef
from ..models import User
from . import programs, progress, reviews, shop
from .models import Program
from .schemas import (
    ComponentChangeIn,
    ComponentIn,
    ComponentOut,
    EventOut,
    LevelsIn,
    LinkIn,
    LoadOut,
    MachineChangeIn,
    MachineIn,
    MachineOut,
    MilestoneChangeIn,
    MilestoneIn,
    MilestoneOut,
    PeopleIn,
    ProgramChangeIn,
    ProgramDetailOut,
    ProgramIn,
    ProgramOut,
    ProgressIn,
    ReviewChangeIn,
    ReviewFileIn,
    ReviewIn,
    ReviewOut,
    ReviewPassIn,
    ShopOut,
    ShopPartChangeIn,
    ShopPartIn,
    ShopPartOut,
    SubsystemChangeIn,
    SubsystemIn,
    SubsystemOut,
    TrainedOut,
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
        reviews=[ReviewOut.of(r) for r in reviews.reviews(db, program.id)],
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


# --- design reviews (anyone) ----------------------------------------------------------------------------------------


@router.get("/programs/{program_id}/reviews")
def get_reviews(program_id: int, user: ActiveUser, db: DB, removed: bool = False) -> list[ReviewOut]:
    """A program's design reviews, by their days (removed=true: those removed from it, to bring back)."""
    return [ReviewOut.of(r) for r in reviews.reviews(db, program_id, removed=removed)]


@router.post("/programs/{program_id}/reviews", status_code=201)
def post_review(program_id: int, body: ReviewIn, user: ActiveUser, db: DB) -> ReviewOut:
    """A review at one of the program's review milestones, for several of its components: its day is each one's due
    date there."""
    found = reviews.add_review(
        db,
        user,
        program_id,
        milestone_id=body.milestone_id,
        name=body.name,
        held_on=body.held_on,
        component_ids=body.component_ids,
        notes=body.notes,
    )
    return ReviewOut.of(found)


@router.get("/reviews/{review_id}")
def get_review(review_id: int, user: ActiveUser, db: DB) -> ReviewOut:
    return ReviewOut.of(reviews.review(db, review_id))


@router.patch("/reviews/{review_id}")
def patch_review(review_id: int, body: ReviewChangeIn, user: ActiveUser, db: DB) -> ReviewOut:
    """Change what's sent of a review (its name, day, notes, and the components it covers), and leave the rest."""
    change = {key: getattr(body, key) for key in body.model_fields_set}
    return ReviewOut.of(reviews.change_review(db, user, review_id, change))


@router.post("/reviews/{review_id}/pass")
def post_pass_review(review_id: int, body: ReviewPassIn, user: ActiveUser, db: DB) -> ReviewOut:
    """Pass a review: each component it covers passes its milestone, but those through it already."""
    return ReviewOut.of(reviews.pass_review(db, user, review_id, on=body.done_on))


@router.delete("/reviews/{review_id}")
def delete_review(review_id: int, user: ActiveUser, db: DB) -> ReviewOut:
    """Take a review off its program, keeping it, its notes and files with it."""
    return ReviewOut.of(reviews.remove_review(db, user, review_id, removed=True))


@router.post("/reviews/{review_id}/restore")
def post_restore_review(review_id: int, user: ActiveUser, db: DB) -> ReviewOut:
    return ReviewOut.of(reviews.remove_review(db, user, review_id, removed=False))


@router.post("/reviews/{review_id}/files", status_code=201)
def post_review_file(review_id: int, body: ReviewFileIn, user: ActiveUser, db: DB) -> ReviewOut:
    """A review's file: its slides, its package, its minutes (400 bad_link for one that isn't a link)."""
    return ReviewOut.of(reviews.add_file(db, user, review_id, url=body.url, title=body.title))


@router.delete("/reviews/{review_id}/files/{file_id}")
def delete_review_file(review_id: int, file_id: int, user: ActiveUser, db: DB) -> ReviewOut:
    return ReviewOut.of(reviews.remove_file(db, user, review_id, file_id))


# --- the shop -------------------------------------------------------------------------------------------------------


@router.get("/shop")
def get_shop(user: ActiveUser, db: DB, removed: bool = False) -> ShopOut:
    """The shop: its machines (retired ones too), the parts in its queue (removed=true: those taken off it instead),
    who's trained on what, and how much work each machine has waiting."""
    return ShopOut(
        machines=[MachineOut.of(m) for m in shop.machines(db)],
        parts=[ShopPartOut.of(p) for p in shop.parts(db, removed=removed)],
        trained=[TrainedOut(user=UserRef.of(person), levels=levels) for person, levels in shop.trained(db)],
        load=[
            LoadOut(
                machine_id=each.machine.id,
                parts=each.parts,
                hours=each.hours,
                unestimated=each.unestimated,
                operators=each.operators,
                trainers=each.trainers,
            )
            for each in shop.load(db)
        ],
        can_edit_machines=user.is_admin,
    )


@router.get("/shop/parts")
def get_shop_parts(
    user: ActiveUser,
    db: DB,
    component_id: int | None = None,
    program_id: int | None = None,
    removed: bool = False,
) -> list[ShopPartOut]:
    """The parts in the shop's queue, or only those for a component, or a program; removed=true: those taken off it."""
    found = shop.parts(db, removed=removed, component_id=component_id, program_id=program_id)
    return [ShopPartOut.of(p) for p in found]


@router.post("/shop/parts", status_code=201)
def post_shop_part(body: ShopPartIn, user: ActiveUser, db: DB) -> ShopPartOut:
    """Put a part in the shop's queue (anyone): asked for by you, unless requester_id says whose it is."""
    return ShopPartOut.of(shop.add_part(db, user, {key: getattr(body, key) for key in body.model_fields_set}))


@router.patch("/shop/parts/{part_id}")
def patch_shop_part(part_id: int, body: ShopPartChangeIn, user: ActiveUser, db: DB) -> ShopPartOut:
    """Change what's sent of a part (anyone): its status moves it through the queue."""
    change = {key: getattr(body, key) for key in body.model_fields_set}
    return ShopPartOut.of(shop.change_part(db, user, part_id, change))


@router.delete("/shop/parts/{part_id}")
def delete_shop_part(part_id: int, user: ActiveUser, db: DB) -> ShopPartOut:
    """Take a part off the shop's queue, keeping it, to put back (anyone)."""
    return ShopPartOut.of(shop.remove_part(db, user, part_id, removed=True))


@router.post("/shop/parts/{part_id}/restore")
def post_restore_shop_part(part_id: int, user: ActiveUser, db: DB) -> ShopPartOut:
    """Put a part taken off the shop's queue back in it."""
    return ShopPartOut.of(shop.remove_part(db, user, part_id, removed=False))


@router.put("/shop/skills/{user_id}")
def put_skills(user_id: int, body: LevelsIn, user: ActiveUser, db: DB) -> TrainedOut:
    """How far someone's trained on each machine sent (0 to 3): your own, or anyone's, for admins."""
    person, levels = shop.set_levels(db, user, user_id, body.levels)
    return TrainedOut(user=UserRef.of(person), levels=levels)


@router.post("/shop/machines", status_code=201)
def post_machine(body: MachineIn, user: ActiveUser, db: DB) -> MachineOut:
    """A new machine in the shop (admins)."""
    return MachineOut.of(shop.add_machine(db, user, body.name))


@router.patch("/shop/machines/{machine_id}")
def patch_machine(machine_id: int, body: MachineChangeIn, user: ActiveUser, db: DB) -> MachineOut:
    """Rename a machine, or retire it (it takes no new parts), or bring it back (admins)."""
    return MachineOut.of(shop.change_machine(db, user, machine_id, name=body.name, retired=body.retired))
