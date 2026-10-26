"""Piper's tables: diagrams, their revisions, each with a drawing as the web app sent it, and their releases, each a
revision put to the approvers named for it."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base, UTCDateTime, utcnow
from ..models import User


class Diagram(Base):
    """A drawing of a fluid system, with its name, folder, and description. Its drawings are its revisions."""

    __tablename__ = "piper_diagrams"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    # Its folder, a path of its own ("Vespula/GSE"; "" at the top), as Yorg's views have.
    folder: Mapped[str] = mapped_column(String(300), default="", server_default="")
    description: Mapped[str] = mapped_column(Text, default="")
    # 1, and one more with every save of its drawing: a save names the version it was changed from, and is taken only
    # if the diagram is still at it (diagrams.save).
    version: Mapped[int] = mapped_column(default=1)
    revision: Mapped[int] = mapped_column(default=1)  # its latest revision's number
    # Its latest release, if it has one: the letter ("B"), and the revision that is (releases.py).
    released: Mapped[str | None] = mapped_column(String(8))
    released_revision: Mapped[int | None]
    # What the list shows and searches, noted from the drawing as it's saved: {"parts": n, "lines": n, "tags": [...],
    # "fluids": [...]} (diagrams.summarize).
    summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    deleted_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    deleted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    creator: Mapped[User | None] = relationship(foreign_keys=[created_by], lazy="selectin")
    editor: Mapped[User | None] = relationship(foreign_keys=[updated_by], lazy="selectin")
    deleter: Mapped[User | None] = relationship(foreign_keys=[deleted_by], lazy="selectin")


class Revision(Base):
    """One of a diagram's drawings, numbered from 1. The latest takes its author's saves for a while; the others never
    change (diagrams.save)."""

    __tablename__ = "piper_revisions"
    __table_args__ = (UniqueConstraint("diagram_id", "number", name="uq_piper_revisions_diagram_number"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    diagram_id: Mapped[int] = mapped_column(ForeignKey("piper_diagrams.id"), index=True)
    number: Mapped[int]
    # The drawing's JSON (UTF-8), zlib-compressed: a P&ID's compresses about tenfold. Loaded only when it's asked for,
    # so listing a diagram's history doesn't unpack all of it.
    drawing: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    size: Mapped[int]  # the JSON's bytes
    note: Mapped[str] = mapped_column(String(200), default="", server_default="")  # its name ("Rev B, for HF-3")
    restored_from: Mapped[int | None]  # the revision it was restored from, by number
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)  # when it began
    saved_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)  # its last save
    author_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    author: Mapped[User | None] = relationship(foreign_keys=[author_id], lazy="selectin")


class Release(Base):
    """A revision put forward as the diagram's next release, to the approvers named for it: released, with the next
    letter, once all of them approve it; or not, if one rejects it or whoever asked withdraws it. A revision that's
    released (or waiting to be) never changes again (releases.py)."""

    __tablename__ = "piper_releases"
    # A letter is given once to each diagram; releases that weren't released have none.
    __table_args__ = (UniqueConstraint("diagram_id", "letter", name="uq_piper_releases_diagram_letter"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    diagram_id: Mapped[int] = mapped_column(ForeignKey("piper_diagrams.id"), index=True)
    revision: Mapped[int]  # the revision's number
    letter: Mapped[str | None] = mapped_column(String(8))  # "A", "B", ... "AA", once it's released
    note: Mapped[str] = mapped_column(Text, default="")  # what it's for: "For HF-3's test readiness review"
    state: Mapped[str] = mapped_column(String(20), default="pending")  # pending, released, rejected, withdrawn
    requested_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    requested_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime)  # when it was released, rejected, or withdrawn

    requester: Mapped[User | None] = relationship(foreign_keys=[requested_by], lazy="selectin")
    approvals: Mapped[list["Approval"]] = relationship(lazy="selectin", order_by="Approval.id")


class Approval(Base):
    """One approver's say on a release: waiting, approved, or rejected (with why)."""

    __tablename__ = "piper_approvals"
    __table_args__ = (UniqueConstraint("release_id", "approver_id", name="uq_piper_approvals_release_approver"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    release_id: Mapped[int] = mapped_column(ForeignKey("piper_releases.id"), index=True)
    approver_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    decision: Mapped[str] = mapped_column(String(20), default="pending")  # pending, approved, rejected
    comment: Mapped[str] = mapped_column(Text, default="")
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    approver: Mapped[User] = relationship(foreign_keys=[approver_id], lazy="selectin")


class Scheme(Base):
    """A color scheme, defined in Piper by the team: the fluids lines carry (each one's name, label, color, and whether
    it's a gas) and the colors of valves' states. A diagram takes one's colors (the web app applies them to it); the
    team's default ("YJSP standard") is what new diagrams start with (schemes.py)."""

    __tablename__ = "piper_schemes"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    # [{"id": "lox", "name": "Liquid oxygen", "label": "LOX", "color": "#2f6fd6", "gas": false}, ...]
    fluids: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    # {"no": "#2e9e4f", "nc": "#d64541", "fip": "#5b7a99", "other": "#e0a500"}
    states: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)
    is_default: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    creator: Mapped[User | None] = relationship(foreign_keys=[created_by], lazy="selectin")
    editor: Mapped[User | None] = relationship(foreign_keys=[updated_by], lazy="selectin")
