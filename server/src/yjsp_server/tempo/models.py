"""Tempo's database tables: saved sequence tests and reusable test environments.

Operator Python never executes on the server; the server only persists exact sequence source,
environment definitions, ownership, and revision metadata.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base, UTCDateTime, utcnow
from ..models import User


class TempoTest(Base):
    """A saved Luna sequence test with its exact Python source and test environment."""

    __tablename__ = "tempo_tests"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    source: Mapped[str] = mapped_column(Text, default="")
    environment: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    version: Mapped[int] = mapped_column(default=1)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    owner: Mapped[User] = relationship(foreign_keys=[owner_id], lazy="selectin")
    updated_by: Mapped[User | None] = relationship(foreign_keys=[updated_by_id], lazy="selectin")


class TempoEnvironment(Base):
    """A reusable test environment (valves and sensor profiles) for Tempo."""

    __tablename__ = "tempo_environments"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    environment: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    version: Mapped[int] = mapped_column(default=1)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    owner: Mapped[User] = relationship(foreign_keys=[owner_id], lazy="selectin")
    updated_by: Mapped[User | None] = relationship(foreign_keys=[updated_by_id], lazy="selectin")
