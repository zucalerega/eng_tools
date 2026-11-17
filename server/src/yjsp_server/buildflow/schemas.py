"""The request and response bodies of Buildflow's API, and what the server checks of a vehicle's drawing and a link."""

from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from ..api.schemas import UserRef
from .models import (
    Assignment,
    BomLine,
    BomStatus,
    Component,
    Event,
    Link,
    Machine,
    Milestone,
    Phase,
    Program,
    Progress,
    Review,
    ReviewLink,
    ShopPart,
    ShopStatus,
    Status,
    Subsystem,
)

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
MOST_NEEDS = 100  # components one needs first
# A lead time, in days: from ordering a part (or starting to make it) to having it, up to ten years.
LeadDays = Annotated[int, Field(ge=0, le=3650)]
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
    lead_days: LeadDays | None = None  # its lead time, in days; null: none said
    need_by: date | None = None  # the day it has to be ready by; null: none


class NeedsIn(BaseModel):
    component_ids: list[int] = Field(max_length=MOST_NEEDS)  # what has to be ready before it can be started


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


# Notes taken in a review, in Markdown: a long review's minutes, actions and all.
ReviewNotes = Annotated[str, StringConstraints(strip_whitespace=True, max_length=50_000)]
MOST_COVERED = 1000  # components a review covers: as many as a program has


class ReviewIn(BaseModel):
    milestone_id: int  # one of the program's review milestones: its PDR, say
    name: LongName  # "Feed system PDR"
    held_on: date | None = None  # its day, if it has one yet
    component_ids: list[int] = Field(default_factory=list, max_length=MOST_COVERED)
    notes: ReviewNotes = ""


class ReviewChangeIn(BaseModel):
    """What's sent is changed, and what's left out stays: held_on null leaves it with no day; component_ids is every
    component it's to cover."""

    name: LongName | None = None
    held_on: date | None = None
    notes: ReviewNotes | None = None
    component_ids: list[int] | None = Field(default=None, max_length=MOST_COVERED)


class ReviewPassIn(BaseModel):
    done_on: date | None = None  # the day it passed: its own day, or today, if not said


class ReviewFileIn(BaseModel):
    url: Address
    title: Title = ""


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
    lead_days: int | None  # its lead time: from ordering it (or starting it) to having it
    need_by: date | None  # the day it has to be ready by, for the build
    needs: list[int]  # the components that have to be ready before it can be started
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
            lead_days=component.lead_days,
            need_by=component.need_by,
            needs=[need.needs_id for need in component.needs],
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


class ReviewFileOut(BaseModel):
    id: int
    title: str
    url: str
    added_at: datetime
    added_by: UserRef | None

    @classmethod
    def of(cls, link: ReviewLink) -> "ReviewFileOut":
        return cls(id=link.id, title=link.title, url=link.url, added_at=link.added_at, added_by=_ref(link.adder))


class ReviewOut(BaseModel):
    id: int
    program_id: int
    milestone_id: int
    name: str
    held_on: date | None
    notes: str
    # The components it covers, as they were added: those removed from the program too, which it covers again once
    # they're brought back.
    component_ids: list[int]
    files: list[ReviewFileOut]
    created_at: datetime
    created_by: UserRef | None
    updated_at: datetime
    updated_by: UserRef | None
    removed_at: datetime | None

    @classmethod
    def of(cls, review: Review) -> "ReviewOut":
        return cls(
            id=review.id,
            program_id=review.program_id,
            milestone_id=review.milestone_id,
            name=review.name,
            held_on=review.held_on,
            notes=review.notes,
            component_ids=[cover.component_id for cover in review.covers],
            files=[ReviewFileOut.of(link) for link in review.links],
            created_at=review.created_at,
            created_by=_ref(review.creator),
            updated_at=review.updated_at,
            updated_by=_ref(review.editor),
            removed_at=review.removed_at,
        )


class ProgramDetailOut(ProgramOut):
    """A program's whole bill of design: its milestones and subsystems in order, and its components, each with its
    progress, links, and people; its reviews, by their days; and, for admins, the components removed from it, to bring
    back."""

    milestones: list[MilestoneOut]
    subsystems: list[SubsystemOut]
    components: list[ComponentOut]
    removed: list[ComponentOut]
    reviews: list[ReviewOut]


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


# --- bills of materials (bom.py) ------------------------------------------------------------------------------------

PartNumber = Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]
PartWords = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Unit = Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)]
Vendor = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
LineUrl = Annotated[str, StringConstraints(strip_whitespace=True, max_length=MOST_URL)]  # empty, or a link
Amount = Annotated[float, Field(allow_inf_nan=False, ge=0, le=1_000_000)]
Cents = Annotated[int, Field(ge=0, le=1_000_000_000)]
LineNote = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
MOST_BOM_LINES = 5000


class BomLineIn(BaseModel):
    """A part on a program's BOM: a part number or a description, at least."""

    component_id: int | None = None
    part_number: PartNumber = ""
    description: PartWords = ""
    quantity: Amount | None = None
    unit: Unit = ""
    vendor: Vendor = ""
    unit_cost: Cents | None = None  # in cents, each
    lead_days: LeadDays | None = None
    url: LineUrl = ""
    status: BomStatus | None = None  # none said: to order, for a new line; as it was, for one read in again

    @model_validator(mode="after")
    def _named(self) -> "BomLineIn":
        if not self.part_number and not self.description:
            raise ValueError("a BOM line needs a part number or a description")
        return self


class BomImportIn(BaseModel):
    lines: list[BomLineIn] = Field(max_length=MOST_BOM_LINES)
    component_id: int | None = None  # one component's BOM; none: the program's whole BOM
    file: Title = ""  # the spreadsheet it's from, for the activity


class BomLineChangeIn(BaseModel):
    """What's sent is changed, and what's left out stays (component_id null: for no component)."""

    component_id: int | None = None
    part_number: PartNumber | None = None
    description: PartWords | None = None
    quantity: Amount | None = None
    unit: Unit | None = None
    vendor: Vendor | None = None
    unit_cost: Cents | None = None
    lead_days: LeadDays | None = None
    url: LineUrl | None = None
    status: BomStatus | None = None
    note: LineNote | None = None


class BomLineOut(BaseModel):
    id: int
    program_id: int
    component_id: int | None
    position: int
    part_number: str
    description: str
    quantity: float | None
    unit: str
    vendor: str
    unit_cost: int | None
    lead_days: int | None
    url: str
    status: BomStatus
    note: str
    updated_at: datetime
    updated_by: UserRef | None

    @classmethod
    def of(cls, line: BomLine) -> "BomLineOut":
        return cls(
            id=line.id,
            program_id=line.program_id,
            component_id=line.component_id,
            position=line.position,
            part_number=line.part_number,
            description=line.description,
            quantity=line.quantity,
            unit=line.unit,
            vendor=line.vendor,
            unit_cost=line.unit_cost,
            lead_days=line.lead_days,
            url=line.url,
            status=line.status,
            note=line.note,
            updated_at=line.updated_at,
            updated_by=_ref(line.editor),
        )


class BomImportOut(BaseModel):
    lines: list[BomLineOut]  # the BOM read in: the program's, or the component's
    added: int
    changed: int
    removed: int


# --- the shop (shop.py) ---------------------------------------------------------------------------------------------

MachineName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
Material = Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]
# A part's drawing or CAD: empty, or a link as a component's are (progress.check_address).
PartAddress = Annotated[str, StringConstraints(strip_whitespace=True, max_length=MOST_URL)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
Quantity = Annotated[int, Field(ge=1, le=100_000)]
Hours = Annotated[float, Field(allow_inf_nan=False, ge=0, le=100_000)]
Level = Annotated[int, Field(ge=0, le=3)]
MOST_MACHINES = 100


class MachineIn(BaseModel):
    name: MachineName


class MachineChangeIn(BaseModel):
    name: MachineName | None = None
    retired: bool | None = None  # true: it takes no new parts; false: brought back


class MachineOut(BaseModel):
    id: int
    name: str
    position: int
    retired: bool

    @classmethod
    def of(cls, machine: Machine) -> "MachineOut":
        return cls(id=machine.id, name=machine.name, position=machine.position, retired=machine.retired_at is not None)


class LevelsIn(BaseModel):
    """Someone's level on each machine sent, by its id: 0 not trained, 1 supervised only, 2 runs it on their own, 3
    trains others. Machines left out stay as they were."""

    levels: dict[int, Level] = Field(max_length=MOST_MACHINES)


class TrainedOut(BaseModel):
    user: UserRef
    levels: dict[int, int]  # by machine id: 1 to 3 (none: not trained)


class ShopPartIn(BaseModel):
    """A part for the shop's queue. requester_id left out: whoever adds it asked for it. component_id says what it's
    for (and so its program); program_id, without one, a program as a whole."""

    name: LongName
    machine_id: int
    component_id: int | None = None
    program_id: int | None = None
    material: Material = ""
    quantity: Quantity = 1
    hours: Hours | None = None  # estimated, for all of them
    drawing: PartAddress = ""
    cad: PartAddress = ""
    status: ShopStatus = ShopStatus.QUEUED
    requester_id: int | None = None
    machinist_id: int | None = None
    need_by: date | None = None
    note: Note = ""


class ShopPartChangeIn(BaseModel):
    """What's sent of a part changes, and what's left out stays; component_id and program_id go together (either sent,
    the other left out is none)."""

    name: LongName | None = None
    machine_id: int | None = None
    component_id: int | None = None
    program_id: int | None = None
    material: Material | None = None
    quantity: Quantity | None = None
    hours: Hours | None = None
    drawing: PartAddress | None = None
    cad: PartAddress | None = None
    status: ShopStatus | None = None
    requester_id: int | None = None
    machinist_id: int | None = None
    need_by: date | None = None
    note: Note | None = None


class Named(BaseModel):
    id: int
    name: str


class ShopPartOut(BaseModel):
    id: int
    name: str
    program: Named | None  # what it's for: a program, and maybe one of its components
    component: Named | None
    machine_id: int
    machine: str  # its name
    material: str
    quantity: int
    hours: float | None
    drawing: str
    cad: str
    status: ShopStatus
    requester: UserRef | None
    machinist: UserRef | None
    need_by: date | None
    note: str
    created_at: datetime
    updated_at: datetime
    updated_by: UserRef | None
    done_at: datetime | None
    removed_at: datetime | None

    @classmethod
    def of(cls, part: ShopPart) -> "ShopPartOut":
        return cls(
            id=part.id,
            name=part.name,
            program=Named(id=part.program.id, name=part.program.name) if part.program is not None else None,
            component=Named(id=part.component.id, name=part.component.name) if part.component is not None else None,
            machine_id=part.machine_id,
            machine=part.machine.name,
            material=part.material,
            quantity=part.quantity,
            hours=part.hours,
            drawing=part.drawing,
            cad=part.cad,
            status=part.status,
            requester=_ref(part.requester),
            machinist=_ref(part.machinist),
            need_by=part.need_by,
            note=part.note,
            created_at=part.created_at,
            updated_at=part.updated_at,
            updated_by=_ref(part.editor),
            done_at=part.done_at,
            removed_at=part.removed_at,
        )


class LoadOut(BaseModel):
    """A machine's open work (not done), and who can do it."""

    machine_id: int
    parts: int
    hours: float  # their estimates, added up
    unestimated: int  # of those, the ones with no estimate
    operators: int  # who run it on their own, or train others on it
    trainers: int


class ShopOut(BaseModel):
    """The shop: its machines (retired ones too), the parts in its queue, who's trained on what, and each machine's
    load."""

    machines: list[MachineOut]
    parts: list[ShopPartOut]
    trained: list[TrainedOut]
    load: list[LoadOut]
    can_edit_machines: bool  # admins
