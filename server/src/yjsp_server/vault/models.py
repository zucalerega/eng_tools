"""Vault's tables: its folders, files, versions, check-ins, permissions, and activity log. Timestamps are
timezone-aware UTC (db.UTCDateTime). They're named without a prefix, from before the site had Yorg too."""

import enum
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, BigInteger, ForeignKey, Index, Integer, String, Text, UniqueConstraint, false, text
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base, UTCDateTime, enum_column, utcnow


class Role(enum.StrEnum):
    VIEWER = "viewer"  # browse, download, see history
    EDITOR = "editor"  # + check out, check in, add, delete, restore
    LEAD = "lead"  # + undo other people's check-outs, manage permissions

    @property
    def rank(self) -> int:
        return {Role.VIEWER: 1, Role.EDITOR: 2, Role.LEAD: 3}[self]


class Numbering(enum.StrEnum):
    """Whether new files take part numbers (docs/vault.md, "Part numbers"): an admin's switch."""

    OFF = "off"  # not handed out but to admins: until the vault's files are numbered
    OFFER = "offer"  # handed out to editors, and new parts and assemblies take them; files without one still go in
    REQUIRE = "require"  # new parts, assemblies, STEP and STL files need numbers, unless they're vendors' parts


class Applies(enum.StrEnum):
    """What a kind of part number is for (numbers.fits)."""

    PART = "part"
    ASSEMBLY = "assembly"
    ANY = "any"


class VaultState(Base):
    """A single row (id 1). seq numbers committed vault changes; see vault.begin_write."""

    __tablename__ = "vault_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, default=0)
    access_seq: Mapped[int] = mapped_column(BigInteger, default=0)  # seq of the last permission change
    # Part numbers: the next to hand out (vault.reserve_numbers), and whether new files take them.
    next_number: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    numbering: Mapped[Numbering] = mapped_column(
        enum_column(Numbering), default=Numbering.OFF, server_default=Numbering.OFF.value
    )
    # Paused by an admin (vault.pause): changes wait, but theirs from the computer they paused it on.
    paused_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    paused_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", name="fk_vault_state_paused_by_users"))
    paused_host: Mapped[str | None] = mapped_column(String(255))
    paused_reason: Mapped[str] = mapped_column(String(500), default="", server_default="")


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
    # What people call it: its name without its type, until someone names it (vault.describe). Part numbers make file
    # names numbers, so this is what's shown beside them.
    title: Mapped[str] = mapped_column(String(200), default="", server_default="")
    # A vendor's part (a McMaster screw, say), which keeps the vendor's name rather than taking a part number.
    vendor: Mapped[bool] = mapped_column(default=False, server_default=false())


class FormerName(Base):
    """Where a file was, by its path then, before a rename or a move. SolidWorks files keep the paths their parts had
    when they were saved, so a file is found by the names it had too (vault._Finder, and clients' FindUsedFiles)."""

    __tablename__ = "former_names"

    id: Mapped[int] = mapped_column(primary_key=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("files.id"), index=True)
    path: Mapped[str] = mapped_column(String(1024))  # a folder's moves can take paths past paths.MAX_PATH
    name_key: Mapped[str] = mapped_column(String(255), index=True)  # paths.key of the path's last name
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    changed_by: Mapped[int] = mapped_column(ForeignKey("users.id"))


class PartKind(Base):
    """A kind of thing a part number is for, its last 3 digits (numbers.py): 001 Part, 501 Assembly. Admins keep the
    list. A kind is retired, never deleted: the numbers handed out with it keep it."""

    __tablename__ = "part_kinds"

    code: Mapped[str] = mapped_column(String(3), primary_key=True)
    label: Mapped[str] = mapped_column(String(100))
    applies: Mapped[Applies] = mapped_column(enum_column(Applies))
    retired: Mapped[bool] = mapped_column(default=False, server_default=false())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))  # None: one the vault started with


class PartNumber(Base):
    """A part number handed out (vault.reserve_numbers), and the file that has it once one does: one number per file.
    Numbers are handed out once each, in order, and never again, even given back unused. Ground Structures' files
    named by numbers from before (legacy) are here too: those numbers were never handed out, and several share one."""

    __tablename__ = "part_numbers"
    __table_args__ = (
        Index("uq_part_numbers_file_id", "file_id", unique=True),
        # Each number is handed out once; legacy ones share.
        Index(
            "uq_part_numbers_number",
            "number",
            unique=True,
            sqlite_where=text("legacy = 0"),
            postgresql_where=text("NOT legacy"),
        ),
        Index("ix_part_numbers_number_kind", "number", "kind"),
        Index("ix_part_numbers_issued_by", "issued_by"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(3))  # a PartKind's code; a legacy number's may be none
    title: Mapped[str] = mapped_column(String(200), default="")  # what to call the file that takes it; "": its name
    file_id: Mapped[int | None] = mapped_column(ForeignKey("files.id"))
    legacy: Mapped[bool] = mapped_column(default=False, server_default=false())
    issued_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    issued_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))  # None: a legacy number
    released_at: Mapped[datetime | None] = mapped_column(UTCDateTime)  # given back unused: it's never used


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


class CaliperModel(Base):
    """A version's 3D model in one of its configurations, for Caliper, the web app's 3D viewer: a part's shape (a mesh,
    in the blob store), or an assembly's components (which files, in which configurations, where). Vault for SolidWorks
    makes them; or the server reads one from the 3D view SolidWorks saved in the file (vault/solidworks.py; docs/vault.md,
    "Caliper"). A model is made from its version and describes it: making it again changes no version."""

    __tablename__ = "caliper_models"
    __table_args__ = (UniqueConstraint("version_id", "configuration", name="uq_caliper_models_version_configuration"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    version_id: Mapped[int] = mapped_column(ForeignKey("versions.id"))
    configuration: Mapped[str] = mapped_column(String(255))  # SolidWorks' name for it: "Default"
    units: Mapped[str] = mapped_column(String(8))  # the document's length unit, for measurements: mm, in, ...
    mesh_sha256: Mapped[str | None] = mapped_column(ForeignKey("blobs.sha256"))  # a part's (vault/caliper.py)
    components: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON)  # an assembly's
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    # What made it: the server's reader, by its version (solidworks.READER), which reads it again once there's a newer
    # one; or 0, Vault for SolidWorks. None: made before the server noted which (vault.py tells by what it carries).
    reader: Mapped[int | None] = mapped_column(Integer)
    # Where its shape came from, for Caliper to say (vault.Source): "solidworks", what SolidWorks drew, as Vault for
    # SolidWorks made it; "saved_view", the 3D view SolidWorks saved in the file; "solid", the server's triangles of the
    # solid SolidWorks saved in it; "file", an assembly's places as its file keeps them. None: made before the server
    # noted it.
    source: Mapped[str | None] = mapped_column(String(16))


class DrawingPdf(Base):
    """A drawing version's sheets as a PDF (in the blob store), for Caliper to show in the web app: Vault for SolidWorks
    saves one from SolidWorks when it checks a drawing in (docs/vault.md, "Caliper"). It's made from its version and
    describes it: making it again changes no version."""

    __tablename__ = "drawing_pdfs"
    __table_args__ = (UniqueConstraint("version_id", name="uq_drawing_pdfs_version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    version_id: Mapped[int] = mapped_column(ForeignKey("versions.id"))
    pdf_sha256: Mapped[str] = mapped_column(ForeignKey("blobs.sha256"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))


class Grant(Base):
    """A role on a folder and everything under it, for one user or (user_id None) everyone."""

    __tablename__ = "grants"
    __table_args__ = (UniqueConstraint("folder_id", "user_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int] = mapped_column(ForeignKey("folders.id"))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    role: Mapped[Role] = mapped_column(enum_column(Role))
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
