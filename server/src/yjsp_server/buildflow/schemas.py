"""The request and response bodies of Buildflow's API, and what the server checks of a vehicle's drawing and a link."""

from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from ..api.schemas import UserRef
from .models import Assignment, Component, Event, Link, Milestone, Phase, Program, Progress, Status, Subsystem

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
LongName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
# A milestone's short name, as the list's columns show it: "CDR", "Manufacturing".
MilestoneName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
Words = Annotated[str, StringConstraints(strip_whitespace=True, max_length=10_000)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
# Where on the vehicle's drawing, in its units: finite, and never far off it.
Coordinate = Annotated[float, Field(allow_inf_nan=False, ge=-100_000, le=100_000)]
Size = Annotated[float, Field(allow_inf_nan=False, gt=0, le=100_000)]

MOST_SECTIONS = 40
MOST_PEOPLE = 50  # on a component, in a phase
MOST_LINKS = 100  # on a component
MOST_URL = 2000

# What a link is to, so the web app shows it with what it is: a model or a drawing in Vault, a requirement, a design
# document, a review's slides or minutes, a P&ID in Piper, test data in Yorg, a procedure, or anything else.
LINK_KINDS = ("cad", "drawing", "requirement", "document", "review", "pid", "data", "procedure", "other")
LinkKind = Literal["cad", "drawing", "requirement", "document", "review", "pid", "data", "procedure", "other"]


# A link's address, as it's sent: what it may be is a rule (progress.check_address), which says so in words.
Address = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MOST_URL)]


# --- the vehicle's drawing ------------------------------------------------------------------------------------------


class Section(BaseModel):
    """A stretch of the vehicle, from its aft end to its nose, as the web app draws it (web/src/buildflow/vehicle.ts):
    an engine's nozzles, a body tube, a tank (its domes drawn in it), a coupler (a joint, its flanges drawn), a
    transition (tapering from the section before it to its own diameter), or the nose cone. Lengths and diameters are
    in the drawing's own units, the same for all of them."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["engine", "body", "tank", "coupler", "transition", "nose"]
    length: Size
    diameter: Size
    label: Title = ""  # what it is: "LOX tank"
    count: int = Field(default=1, ge=1, le=9)  # an engine's nozzles, side by side
    fins: bool = False  # fins at its aft end
    legs: bool = False  # landing legs from its aft end, as a hopper's


class Profile(BaseModel):
    """The vehicle as a program's page draws it: its sections from the aft end to the nose, and whether it stands on a
    test stand's frame (a static fire) rather than flying."""

    model_config = ConfigDict(extra="forbid")

    sections: list[Section] = Field(default_factory=list, max_length=MOST_SECTIONS)
    stand: bool = False


# --- requests -------------------------------------------------------------------------------------------------------


class ProgramIn(BaseModel):
    name: Name
    description: Words = ""
    # What it starts with (templates.py): a rocket's, a hopper's, or a test stand's drawing, subsystems, and components,
    # or none of them. Every program starts with the same milestones, to change.
    template: Literal["rocket", "hopper", "stand", "blank"] = "blank"


class ProgramChangeIn(BaseModel):
    name: Name | None = None
    description: Words | None = None
    profile: Profile | None = None
    position: int | None = Field(default=None, ge=0, le=10_000)


class MilestoneIn(BaseModel):
    phase: Phase
    name: MilestoneName
    title: Title = ""
    review: bool = False
    position: int | None = Field(default=None, ge=0, le=1000)  # its place in its phase; none: last


class MilestoneChangeIn(BaseModel):
    phase: Phase | None = None
    name: MilestoneName | None = None
    title: Title | None = None
    review: bool | None = None
    position: int | None = Field(default=None, ge=0, le=1000)


class SubsystemIn(BaseModel):
    name: Name
    position: int | None = Field(default=None, ge=0, le=1000)


class SubsystemChangeIn(BaseModel):
    name: Name | None = None
    position: int | None = Field(default=None, ge=0, le=1000)


class ComponentIn(BaseModel):
    subsystem_id: int
    name: LongName
    description: Words = ""
    bought: bool = False
    x: Coordinate | None = None
    y: Coordinate | None = None


class ComponentChangeIn(BaseModel):
    """What's sent is changed, and what's left out stays: x and y null take it off the drawing, lead_id null leaves it
    with no lead."""

    name: LongName | None = None
    subsystem_id: int | None = None
    description: Words | None = None
    bought: bool | None = None
    x: Coordinate | None = None
    y: Coordinate | None = None
    position: int | None = Field(default=None, ge=0, le=10_000)
    lead_id: int | None = None


class ProgressIn(BaseModel):
    """A component's progress at a milestone: what's sent is changed (due and done_on null clear them)."""

    status: Status | None = None
    due: date | None = None
    done_on: date | None = None
    note: Words | None = None


class LinkIn(BaseModel):
    phase: Phase
    kind: LinkKind = "other"
    url: Address
    title: Title = ""
    milestone_id: int | None = None  # a review's slides, say, on that review


class PeopleIn(BaseModel):
    phase: Phase
    user_ids: list[int] = Field(max_length=MOST_PEOPLE)


# --- responses ------------------------------------------------------------------------------------------------------


def _ref(user: Any) -> UserRef | None:
    return UserRef.of(user) if user is not None else None


class MilestoneOut(BaseModel):
    id: int
    phase: Phase
    name: str
    title: str
    review: bool
    position: int

    @classmethod
    def of(cls, milestone: Milestone) -> "MilestoneOut":
        return cls(
            id=milestone.id,
            phase=milestone.phase,
            name=milestone.name,
            title=milestone.title,
            review=milestone.review,
            position=milestone.position,
        )


class SubsystemOut(BaseModel):
    id: int
    name: str
    position: int

    @classmethod
    def of(cls, subsystem: Subsystem) -> "SubsystemOut":
        return cls(id=subsystem.id, name=subsystem.name, position=subsystem.position)


class ProgressOut(BaseModel):
    milestone_id: int
    status: Status
    due: date | None
    done_on: date | None
    note: str
    updated_at: datetime
    updated_by: UserRef | None

    @classmethod
    def of(cls, progress: Progress) -> "ProgressOut":
        return cls(
            milestone_id=progress.milestone_id,
            status=progress.status,
            due=progress.due,
            done_on=progress.done_on,
            note=progress.note,
            updated_at=progress.updated_at,
            updated_by=_ref(progress.editor),
        )


class LinkOut(BaseModel):
    id: int
    phase: Phase
    milestone_id: int | None
    kind: str
    title: str
    url: str
    added_at: datetime
    added_by: UserRef | None

    @classmethod
    def of(cls, link: Link) -> "LinkOut":
        return cls(
            id=link.id,
            phase=link.phase,
            milestone_id=link.milestone_id,
            kind=link.kind,
            title=link.title,
            url=link.url,
            added_at=link.added_at,
            added_by=_ref(link.adder),
        )


class AssignmentOut(BaseModel):
    phase: Phase
    user: UserRef

    @classmethod
    def of(cls, assignment: Assignment) -> "AssignmentOut":
        return cls(phase=assignment.phase, user=UserRef.of(assignment.user))


class ComponentOut(BaseModel):
    id: int
    program_id: int
    subsystem_id: int
    name: str
    description: str
    bought: bool
    x: float | None
    y: float | None
    position: int
    lead: UserRef | None
    updated_at: datetime
    updated_by: UserRef | None
    removed_at: datetime | None
    progress: list[ProgressOut]
    links: list[LinkOut]
    people: list[AssignmentOut]

    @classmethod
    def of(cls, component: Component) -> "ComponentOut":
        return cls(
            id=component.id,
            program_id=component.program_id,
            subsystem_id=component.subsystem_id,
            name=component.name,
            description=component.description,
            bought=component.bought,
            x=component.x,
            y=component.y,
            position=component.position,
            lead=_ref(component.lead),
            updated_at=component.updated_at,
            updated_by=_ref(component.editor),
            removed_at=component.removed_at,
            progress=[ProgressOut.of(p) for p in component.progress],
            links=[LinkOut.of(link) for link in component.links],
            people=[AssignmentOut.of(a) for a in component.people],
        )


class PhaseCounts(BaseModel):
    """How many of a program's components are where in a phase (progress.phase_state): done, under way, held up, not
    started, or with nothing to do in it."""

    done: int = 0
    in_progress: int = 0
    blocked: int = 0
    not_started: int = 0
    skipped: int = 0


class ProgramOut(BaseModel):
    id: int
    name: str
    description: str
    profile: Profile
    position: int
    created_at: datetime
    created_by: UserRef | None
    updated_at: datetime
    updated_by: UserRef | None
    archived_at: datetime | None
    component_count: int  # not removed
    phases: dict[Phase, PhaseCounts]
    # The last milestone of each phase, and how many components are through it: "18 component-level CDRs".
    through: dict[Phase, int]
    last_milestone: dict[Phase, str | None]
    can_edit: bool  # lay it out: admins

    @classmethod
    def of(cls, program: Program, summary: "Summary", *, can_edit: bool) -> "ProgramOut":
        return cls(
            id=program.id,
            name=program.name,
            description=program.description,
            profile=Profile.model_validate(program.profile or {}),
            position=program.position,
            created_at=program.created_at,
            created_by=_ref(program.creator),
            updated_at=program.updated_at,
            updated_by=_ref(program.editor),
            archived_at=program.archived_at,
            component_count=summary.components,
            phases=summary.phases,
            through=summary.through,
            last_milestone=summary.last_milestone,
            can_edit=can_edit,
        )


class Summary(BaseModel):
    """What a program's card says of it (progress.summarize)."""

    components: int
    phases: dict[Phase, PhaseCounts]
    through: dict[Phase, int]
    last_milestone: dict[Phase, str | None]


class ProgramDetailOut(ProgramOut):
    """A program's whole bill of design: its milestones and subsystems in order, and its components, each with its
    progress, links, and people; and, for admins, the components removed from it, to bring back."""

    milestones: list[MilestoneOut]
    subsystems: list[SubsystemOut]
    components: list[ComponentOut]
    removed: list[ComponentOut]


class EventOut(BaseModel):
    id: int
    component_id: int | None
    component: str | None  # its name, as it is now
    user: UserRef | None
    at: datetime
    what: str

    @classmethod
    def of(cls, event: Event, component: str | None) -> "EventOut":
        return cls(
            id=event.id,
            component_id=event.component_id,
            component=component,
            user=_ref(event.user),
            at=event.at,
            what=event.what,
        )
