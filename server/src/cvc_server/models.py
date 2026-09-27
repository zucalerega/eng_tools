"""Database tables. Timestamps are timezone-aware UTC (db.UTCDateTime)."""

import enum
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, BigInteger, ForeignKey, Index, String, Text, UniqueConstraint, text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, UTCDateTime, utcnow


class Role(enum.StrEnum):
    VIEWER = "viewer"  # browse, download, see history
    EDITOR = "editor"  # + check out, check in, add, delete, restore
    LEAD = "lead"  # + undo other people's check-outs, manage permissions

    @property
    def rank(self) -> int:
        return {Role.VIEWER: 1, Role.EDITOR: 2, Role.LEAD: 3}[self]


class UserStatus(enum.StrEnum):
    INVITED = "invited"  # added by an admin; active from their first sign-in
    PENDING = "pending"  # signed in without an invite; waiting for an admin
    ACTIVE = "active"
    DISABLED = "disabled"


def _enum(cls: type[enum.Enum]) -> SAEnum:
    # Plain strings in the database (no native enum type), so adding a value needs no migration.
    return SAEnum(cls, native_enum=False, length=16, values_callable=lambda e: [m.value for m in e])


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    google_sub: Mapped[str | None] = mapped_column(String(255), unique=True)
    status: Mapped[UserStatus] = mapped_column(_enum(UserStatus), default=UserStatus.PENDING)
    is_admin: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    @property
    def display_name(self) -> str:
        return self.name or self.email


class Token(Base):
    """A browser session or a CLI/add-in credential. Only the secret's SHA-256 is stored."""

    __tablename__ = "tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # auth.SESSION or auth.CLIENT
    name: Mapped[str] = mapped_column(String(200), default="")
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class ClientAuthCode(Base):
    """One-time code from the CLI/add-in browser sign-in, redeemed with a PKCE verifier."""

    __tablename__ = "client_auth_codes"

    id: Mapped[int] = mapped_column(primary_key=True)
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    challenge: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class VaultState(Base):
    """A single row (id 1). seq numbers committed vault changes; see vault.begin_write."""

    __tablename__ = "vault_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, default=0)
    access_seq: Mapped[int] = mapped_column(BigInteger, default=0)  # seq of the last permission change


class Folder(Base):
    __tablename__ = "folders"
    __table_args__ = (
        # One live folder per name in a folder; deleted folders keep their names and places, to come back to.
        Index(
            "uq_folders_live_name",
            "parent_id",
            "name_key",
            unique=True,
            sqlite_where=text("deleted_at IS NULL"),
            postgresql_where=text("deleted_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("folders.id"))  # None for the root
    name: Mapped[str] = mapped_column(String(255))
    name_key: Mapped[str] = mapped_column(String(255))  # paths.key(name)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    change_seq: Mapped[int] = mapped_column(BigInteger, default=0)
    # In the trash, with the folders and files in it: everything deleted in one go shares deleted_at.
    deleted_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    deleted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class File(Base):
    __tablename__ = "files"
    __table_args__ = (
        # One live file per name in a folder; deleted files keep their names.
        Index(
            "uq_files_live_name",
            "folder_id",
            "name_key",
            unique=True,
            sqlite_where=text("deleted_at IS NULL"),
            postgresql_where=text("deleted_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int] = mapped_column(ForeignKey("folders.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    name_key: Mapped[str] = mapped_column(String(255))
    latest_version: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    # The lock: who has the file checked out, since when, and on which computer.
    checked_out_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    checked_out_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    checked_out_host: Mapped[str | None] = mapped_column(String(255))
    deleted_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    deleted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    change_seq: Mapped[int] = mapped_column(BigInteger, default=0, index=True)


class Checkin(Base):
    """One check-in: a comment and the versions it created, possibly across many files."""

    __tablename__ = "checkins"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    host: Mapped[str] = mapped_column(String(255))
    comment: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Blob(Base):
    """File contents, stored once under their SHA-256 (storage.BlobStore)."""

    __tablename__ = "blobs"

    sha256: Mapped[str] = mapped_column(String(64), primary_key=True)
    size: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Version(Base):
    __tablename__ = "versions"
    __table_args__ = (UniqueConstraint("file_id", "number"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("files.id"))
    number: Mapped[int]
    checkin_id: Mapped[int] = mapped_column(ForeignKey("checkins.id"), index=True)
    blob_sha256: Mapped[str] = mapped_column(ForeignKey("blobs.sha256"))
    size: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))


class VersionRef(Base):
    """A version's reference to another file (an assembly using a part), pinned to the version it used."""

    __tablename__ = "version_refs"

    version_id: Mapped[int] = mapped_column(ForeignKey("versions.id"), primary_key=True)
    child_file_id: Mapped[int] = mapped_column(ForeignKey("files.id"), primary_key=True, index=True)
    child_version: Mapped[int]


class Grant(Base):
    """A role on a folder and everything under it, for one user or (user_id None) everyone."""

    __tablename__ = "grants"
    __table_args__ = (UniqueConstraint("folder_id", "user_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int] = mapped_column(ForeignKey("folders.id"))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    role: Mapped[Role] = mapped_column(_enum(Role))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class Event(Base):
    """Audit log and activity feed. detail keeps paths and names as they were at the time."""

    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(32))
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("folders.id"), index=True)
    file_id: Mapped[int | None] = mapped_column(ForeignKey("files.id"), index=True)
    version_id: Mapped[int | None] = mapped_column(ForeignKey("versions.id"))
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
