"""Piper's tables: diagrams, and their revisions, each with a drawing as the web app sent it."""

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
