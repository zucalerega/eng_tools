"""Buildflow's tables: programs, each with its vehicle's drawing, its milestones (the steps every component goes through,
in four phases), its subsystems and their components; each component's progress through each milestone, its links (CAD,
drawings, requirements, documents, test data), and its people; what's been done, for the activity; and its design
reviews, each held for several components at once (reviews.py); and its bill of materials (bom.py). And the shop's: its
machines, who's trained on each, and the parts queued to be machined (shop.py)."""

import enum
from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Date, Float, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base, UTCDateTime, enum_column, utcnow
from ..models import User


class Phase(enum.StrEnum):
    """The four phases a component goes through, in order: the tabs on a program's page."""

    DESIGN = "design"
    BUILD = "build"
    TEST = "test"
    LAUNCH = "launch"


class Status(enum.StrEnum):
    """Where a component is at a milestone. A milestone with no progress kept for a component is not started."""

    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    DONE = "done"  # passed, for a review
    BLOCKED = "blocked"  # held up: the note says by what
    SKIPPED = "skipped"  # not needed for this component (a bought part's design reviews)


class Program(Base):
    """A vehicle or a test stand the team designs, builds, tests, and flies: its bill of design. Admins lay it out
    (programs.py); anyone keeps its progress (progress.py)."""

    __tablename__ = "buildflow_programs"
    # Archived ones too: an archived program is brought back, not made again.
    __table_args__ = (UniqueConstraint("name_key", name="uq_buildflow_programs_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    name_key: Mapped[str] = mapped_column(String(100))  # lowercased: two programs can't differ only in case
    description: Mapped[str] = mapped_column(Text, default="")
    # The vehicle as it's drawn on the program's page: {"sections": [...], "stand": false} (schemas.Profile), aft to nose.
    profile: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    position: Mapped[int] = mapped_column(default=0)  # its place in the list
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    # Archived: done with (flown, or retired), kept as it was, and off the list until an admin brings it back.
    archived_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    creator: Mapped[User | None] = relationship(foreign_keys=[created_by], lazy="selectin")
    editor: Mapped[User | None] = relationship(foreign_keys=[updated_by], lazy="selectin")


class Milestone(Base):
    """A step every component of a program goes through, in one of the four phases: a review (DCR, CoDR, PDR, CDR,
    TRR, QRR, FRR) or a piece of work (Manufacturing, Testing). Each program has its own, which admins name, add, and
    order."""

    __tablename__ = "buildflow_milestones"
    __table_args__ = (UniqueConstraint("program_id", "name_key", name="uq_buildflow_milestones_program_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    program_id: Mapped[int] = mapped_column(ForeignKey("buildflow_programs.id"), index=True)
    phase: Mapped[Phase] = mapped_column(enum_column(Phase))
    name: Mapped[str] = mapped_column(String(40))  # short, as the list shows it: "CDR"
    name_key: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(200), default="")  # what it stands for: "Critical Design Review"
    review: Mapped[bool] = mapped_column(default=False)  # a review, held on a day, rather than work done over weeks
    position: Mapped[int] = mapped_column(default=0)  # its order in its phase


class Subsystem(Base):
    """A part of the vehicle its components are grouped in: Propulsion, Fluids, Structures, Avionics, Recovery."""

    __tablename__ = "buildflow_subsystems"
    __table_args__ = (UniqueConstraint("program_id", "name_key", name="uq_buildflow_subsystems_program_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    program_id: Mapped[int] = mapped_column(ForeignKey("buildflow_programs.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    name_key: Mapped[str] = mapped_column(String(100))
    position: Mapped[int] = mapped_column(default=0)


class Component(Base):
    """A component of the vehicle (the main oxidizer valve, the fins, the flight computer), in a subsystem, and where it
    is on the vehicle's drawing (x from the aft end, y up from the centerline, in the drawing's units; None: not placed).
    Removed by an admin, it's kept, with everything said of it, until they bring it back."""

    __tablename__ = "buildflow_components"

    id: Mapped[int] = mapped_column(primary_key=True)
    program_id: Mapped[int] = mapped_column(ForeignKey("buildflow_programs.id"), index=True)
    subsystem_id: Mapped[int] = mapped_column(ForeignKey("buildflow_subsystems.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    bought: Mapped[bool] = mapped_column(default=False)  # off the shelf (COTS): bought, not designed and made
    x: Mapped[float | None] = mapped_column(Float)
    y: Mapped[float | None] = mapped_column(Float)
    position: Mapped[int] = mapped_column(default=0)  # its order in its subsystem
    lead_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))  # who's responsible for it
    # Its build plan: how long it takes to get, from ordering it (bought) or starting it (made) to having it; and when
    # it has to be ready by, for the build. None: not said yet.
    lead_days: Mapped[int | None]
    need_by: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)  # anything about it, its progress too
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    removed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    removed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    lead: Mapped[User | None] = relationship(foreign_keys=[lead_id], lazy="selectin")
    editor: Mapped[User | None] = relationship(foreign_keys=[updated_by], lazy="selectin")
    progress: Mapped[list["Progress"]] = relationship(lazy="selectin", order_by="Progress.id")
    links: Mapped[list["Link"]] = relationship(lazy="selectin", order_by="Link.id")
    people: Mapped[list["Assignment"]] = relationship(lazy="selectin", order_by="Assignment.id")
    needs: Mapped[list["Need"]] = relationship(lazy="selectin", order_by="Need.id", foreign_keys="Need.component_id")


class Need(Base):
    """A component that has to be ready before another can be started: the thrust structure needs the thrust chamber,
    say. Each program's needs never go round in a circle (progress.set_needs)."""

    __tablename__ = "buildflow_needs"
    __table_args__ = (UniqueConstraint("component_id", "needs_id", name="uq_buildflow_needs_component_needs"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    component_id: Mapped[int] = mapped_column(ForeignKey("buildflow_components.id"), index=True)
    needs_id: Mapped[int] = mapped_column(ForeignKey("buildflow_components.id"), index=True)


class Progress(Base):
    """A component at a milestone: its status, when it's due, when it was done, and a note (a review's actions, what's
    holding it up). Kept from its first change: one that's never been changed is not started."""

    __tablename__ = "buildflow_progress"
    __table_args__ = (
        UniqueConstraint("component_id", "milestone_id", name="uq_buildflow_progress_component_milestone"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    component_id: Mapped[int] = mapped_column(ForeignKey("buildflow_components.id"), index=True)
    milestone_id: Mapped[int] = mapped_column(ForeignKey("buildflow_milestones.id"), index=True)
    status: Mapped[Status] = mapped_column(enum_column(Status), default=Status.NOT_STARTED)
    due: Mapped[date | None] = mapped_column(Date)  # when it's planned for: a review's day, or work's deadline
    done_on: Mapped[date | None] = mapped_column(Date)  # when it was done (passed)
    note: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    editor: Mapped[User | None] = relationship(foreign_keys=[updated_by], lazy="selectin")


class Link(Base):
    """A page about a component, in one of its phases: its CAD in Vault, a drawing, a requirement, a design document, a
    review's slides (on that milestone), a Piper P&ID, a Yorg test. An http or https address, or a page of the site's
    own ("/vault/file/12"), which the web app shows by what it is."""

    __tablename__ = "buildflow_links"

    id: Mapped[int] = mapped_column(primary_key=True)
    component_id: Mapped[int] = mapped_column(ForeignKey("buildflow_components.id"), index=True)
    phase: Mapped[Phase] = mapped_column(enum_column(Phase))
    milestone_id: Mapped[int | None] = mapped_column(ForeignKey("buildflow_milestones.id"))
    kind: Mapped[str] = mapped_column(String(16))  # schemas.LINK_KINDS: cad, drawing, requirement, document, ...
    title: Mapped[str] = mapped_column(String(200), default="")
    url: Mapped[str] = mapped_column(String(2000))
    added_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    added_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    adder: Mapped[User | None] = relationship(foreign_keys=[added_by], lazy="selectin")


class Assignment(Base):
    """Someone working on a component in a phase: designing it, making it (the build phase's people are who's
    manufacturing it), testing it, or flying it."""

    __tablename__ = "buildflow_people"
    __table_args__ = (
        UniqueConstraint("component_id", "phase", "user_id", name="uq_buildflow_people_component_phase_user"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    component_id: Mapped[int] = mapped_column(ForeignKey("buildflow_components.id"), index=True)
    phase: Mapped[Phase] = mapped_column(enum_column(Phase))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))

    user: Mapped[User] = relationship(lazy="selectin")


class Event(Base):
    """Something someone did to a program: a status set, a link added, a component added. The program's activity, and
    what's been worked on lately."""

    __tablename__ = "buildflow_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    program_id: Mapped[int] = mapped_column(ForeignKey("buildflow_programs.id"), index=True)
    component_id: Mapped[int | None] = mapped_column(ForeignKey("buildflow_components.id"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    what: Mapped[str] = mapped_column(String(500))  # "CDR: done", in words, as the activity shows it

    user: Mapped[User | None] = relationship(lazy="selectin")


class Review(Base):
    """A design review held for several of a program's components at once, at one of its review milestones: a
    subsystem's PDR, say, covering its eight components (reviews.py). Its day is each one's due date at the milestone,
    and passing it passes each one there; its files (slides, the package, the minutes, wherever they're kept) are links,
    and its notes are taken in it. Removed, it's kept, to bring back."""

    __tablename__ = "buildflow_reviews"

    id: Mapped[int] = mapped_column(primary_key=True)
    program_id: Mapped[int] = mapped_column(ForeignKey("buildflow_programs.id"), index=True)
    milestone_id: Mapped[int] = mapped_column(ForeignKey("buildflow_milestones.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))  # "Feed system PDR"
    held_on: Mapped[date | None] = mapped_column(Date)  # its day: when it's planned for, or was held
    notes: Mapped[str] = mapped_column(Text, default="")  # taken in it, in Markdown
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    removed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    removed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    creator: Mapped[User | None] = relationship(foreign_keys=[created_by], lazy="selectin")
    editor: Mapped[User | None] = relationship(foreign_keys=[updated_by], lazy="selectin")
    covers: Mapped[list["ReviewComponent"]] = relationship(lazy="selectin", order_by="ReviewComponent.id")
    links: Mapped[list["ReviewLink"]] = relationship(lazy="selectin", order_by="ReviewLink.id")


class ReviewComponent(Base):
    """A component a review covers. Kept while the component's removed from its program, so it's in the review again
    when it's brought back."""

    __tablename__ = "buildflow_review_components"
    __table_args__ = (
        UniqueConstraint("review_id", "component_id", name="uq_buildflow_review_components_review_component"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    review_id: Mapped[int] = mapped_column(ForeignKey("buildflow_reviews.id"), index=True)
    component_id: Mapped[int] = mapped_column(ForeignKey("buildflow_components.id"), index=True)


class ReviewLink(Base):
    """A review's file: its slides, its package, its minutes, its recording, wherever they're kept (SharePoint, say):
    an http or https address, or a page of the site's own, as a component's links are."""

    __tablename__ = "buildflow_review_links"

    id: Mapped[int] = mapped_column(primary_key=True)
    review_id: Mapped[int] = mapped_column(ForeignKey("buildflow_reviews.id"), index=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    url: Mapped[str] = mapped_column(String(2000))
    added_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    added_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    adder: Mapped[User | None] = relationship(foreign_keys=[added_by], lazy="selectin")


class BomStatus(enum.StrEnum):
    """Where a part on a program's BOM is."""

    TO_ORDER = "to_order"
    ORDERED = "ordered"
    RECEIVED = "received"  # in hand


class BomLine(Base):
    """A line of a program's bill of materials (bom.py): a part to buy, how many, from whom, at what cost each, how long
    it takes to come, and where it is; and the component it's for (none: not matched to one). Read in from the team's
    own BOM spreadsheet, and read in again as that changes, matched by part number."""

    __tablename__ = "buildflow_bom_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    program_id: Mapped[int] = mapped_column(ForeignKey("buildflow_programs.id"), index=True)
    component_id: Mapped[int | None] = mapped_column(ForeignKey("buildflow_components.id"), index=True)
    position: Mapped[int] = mapped_column(default=0)  # its place in the BOM, as the spreadsheet has it
    part_number: Mapped[str] = mapped_column(String(100), default="")
    description: Mapped[str] = mapped_column(String(500), default="")
    quantity: Mapped[float | None] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(20), default="")  # "ft", "ea"
    vendor: Mapped[str] = mapped_column(String(200), default="")
    unit_cost: Mapped[int | None]  # in cents, each
    lead_days: Mapped[int | None]  # from ordering it to having it
    url: Mapped[str] = mapped_column(String(2000), default="")  # where it's bought: a link, as a component's are
    status: Mapped[BomStatus] = mapped_column(enum_column(BomStatus), default=BomStatus.TO_ORDER)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    editor: Mapped[User | None] = relationship(foreign_keys=[updated_by], lazy="selectin")


# --- the shop -------------------------------------------------------------------------------------------------------


class ShopStatus(enum.StrEnum):
    """Where a part in the shop's queue is."""

    QUEUED = "queued"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"  # held up: its note says by what
    DONE = "done"


class Machine(Base):
    """A machine in the team's shop (the lathe, the mill, the waterjet, the CNC) that parts are made on and people are
    trained on. Admins add and rename them; one that's retired takes no new parts, and keeps what was made on it."""

    __tablename__ = "buildflow_machines"
    __table_args__ = (UniqueConstraint("name_key", name="uq_buildflow_machines_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(40))
    name_key: Mapped[str] = mapped_column(String(40))  # lowercased: two machines can't differ only in case
    position: Mapped[int] = mapped_column(default=0)  # its place in the list
    retired_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class Skill(Base):
    """How far someone's trained on a machine: 1, only supervised; 2, runs it on their own; 3, trains others (none kept:
    not trained). Each person says their own; admins can change anyone's."""

    __tablename__ = "buildflow_skills"
    __table_args__ = (UniqueConstraint("user_id", "machine_id", name="uq_buildflow_skills_user_machine"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    machine_id: Mapped[int] = mapped_column(ForeignKey("buildflow_machines.id"), index=True)
    level: Mapped[int] = mapped_column(default=0)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))  # who said so: them, or an admin

    user: Mapped[User] = relationship(foreign_keys=[user_id], lazy="selectin")


class ShopPart(Base):
    """A part to be machined in the team's shop: on which machine, from what, how many, and about how long they'll
    take; who asked for it (its responsible engineer) and who's making it; its drawing and CAD; when it's needed; and
    where it is in the queue. It can be for a component on a program's bill of design, or for a program as a whole, so
    the bill shows it. Removed from the queue, it's kept, to bring back."""

    __tablename__ = "buildflow_shop_parts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    program_id: Mapped[int | None] = mapped_column(ForeignKey("buildflow_programs.id"), index=True)
    component_id: Mapped[int | None] = mapped_column(ForeignKey("buildflow_components.id"), index=True)
    machine_id: Mapped[int] = mapped_column(ForeignKey("buildflow_machines.id"), index=True)
    material: Mapped[str] = mapped_column(String(100), default="")
    quantity: Mapped[int] = mapped_column(default=1)
    hours: Mapped[float | None] = mapped_column(Float)  # estimated, for all of them
    drawing: Mapped[str] = mapped_column(String(2000), default="")  # a link, as a component's are (check_address)
    cad: Mapped[str] = mapped_column(String(2000), default="")
    status: Mapped[ShopStatus] = mapped_column(enum_column(ShopStatus), default=ShopStatus.QUEUED)
    requester_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))  # its responsible engineer
    machinist_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    need_by: Mapped[date | None] = mapped_column(Date)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    done_at: Mapped[datetime | None] = mapped_column(UTCDateTime)  # when it was last said to be done
    removed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    removed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    machine: Mapped[Machine] = relationship(lazy="selectin")
    program: Mapped[Program | None] = relationship(lazy="selectin")
    component: Mapped[Component | None] = relationship(lazy="selectin")
    requester: Mapped[User | None] = relationship(foreign_keys=[requester_id], lazy="selectin")
    machinist: Mapped[User | None] = relationship(foreign_keys=[machinist_id], lazy="selectin")
    editor: Mapped[User | None] = relationship(foreign_keys=[updated_by], lazy="selectin")
