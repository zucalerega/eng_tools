"""Request and response bodies of the JSON API."""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from .. import vault
from ..models import Role, Token, User

Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
# A file id, or a vault path such as "Structures/Fins/Fin.SLDPRT".
FileRefs = Annotated[list[int | str], Field(min_length=1, max_length=5000)]


class UserRef(BaseModel):
    id: int
    name: str
    email: str

    @classmethod
    def of(cls, user: User) -> "UserRef":
        return cls(id=user.id, name=user.display_name, email=user.email)


class UserOut(BaseModel):
    id: int
    name: str
    email: str
    status: str
    is_admin: bool
    created_at: datetime
    last_login_at: datetime | None

    @classmethod
    def of(cls, user: User) -> "UserOut":
        return cls(
            id=user.id,
            name=user.display_name,
            email=user.email,
            status=user.status.value,
            is_admin=user.is_admin,
            created_at=user.created_at,
            last_login_at=user.last_login_at,
        )


class LockOut(BaseModel):
    user: UserRef
    host: str
    since: datetime


class UseOut(BaseModel):
    file_id: int
    version: int  # the version it was checked in with; the file may have newer ones since


class FileOut(BaseModel):
    id: int
    path: str
    name: str
    folder_id: int
    version: int  # latest
    size: int
    sha256: str
    modified_at: datetime
    modified_by: UserRef
    checked_out: LockOut | None
    deleted_at: datetime | None
    deleted_by: UserRef | None = None
    # What the latest version uses (an assembly's parts, a drawing's model), by id: the files you can
    # see, including any deleted since. Clients look them up in their copy of the sync feed.
    uses: list[UseOut]

    @classmethod
    def of(cls, view: vault.FileView) -> "FileOut":
        file, latest = view.file, view.latest
        lock = None
        if view.locked_by is not None and file.checked_out_at is not None:
            lock = LockOut(user=UserRef.of(view.locked_by), host=file.checked_out_host or "", since=file.checked_out_at)
        return cls(
            id=file.id,
            path=view.path,
            name=file.name,
            folder_id=file.folder_id,
            version=latest.number,
            size=latest.size,
            sha256=latest.blob_sha256,
            modified_at=latest.created_at,
            modified_by=UserRef.of(view.modified_by),
            checked_out=lock,
            deleted_at=file.deleted_at,
            deleted_by=UserRef.of(view.deleted_by) if view.deleted_by else None,
            uses=[UseOut(file_id=file_id, version=number) for file_id, number in view.uses],
        )


class FilesOut(BaseModel):
    files: list[FileOut]

    @classmethod
    def of(cls, views: list[vault.FileView]) -> "FilesOut":
        return cls(files=[FileOut.of(v) for v in views])


class FolderOut(BaseModel):
    id: int
    path: str
    name: str
    role: str | None  # your role here: admin, lead, editor, viewer, or null (you can only pass through)
    deleted_at: datetime | None = None  # in a trash listing: when it was deleted, and by whom
    deleted_by: UserRef | None = None

    @classmethod
    def of(cls, view: vault.FolderView) -> "FolderOut":
        return cls(
            id=view.id,
            path=view.path,
            name=view.name,
            role=view.role,
            deleted_at=view.deleted_at,
            deleted_by=UserRef.of(view.deleted_by) if view.deleted_by else None,
        )


class ListingOut(BaseModel):
    folder: FolderOut
    folders: list[FolderOut]
    files: list[FileOut]

    @classmethod
    def of(cls, listing: vault.Listing) -> "ListingOut":
        return cls(
            folder=FolderOut.of(listing.folder),
            folders=[FolderOut.of(f) for f in listing.folders],
            files=[FileOut.of(f) for f in listing.files],
        )


class RefOut(BaseModel):
    file_id: int
    path: str
    version: int
    deleted: bool


class VersionOut(BaseModel):
    number: int
    size: int
    sha256: str
    created_at: datetime
    author: UserRef
    comment: str
    host: str
    checkin_id: int
    references: list[RefOut]


class UsedByOut(BaseModel):
    file: FileOut
    uses_version: int


class FileDetailOut(BaseModel):
    file: FileOut
    versions: list[VersionOut]
    used_by: list[UsedByOut]

    @classmethod
    def of(cls, detail: vault.FileDetail) -> "FileDetailOut":
        return cls(
            file=FileOut.of(detail.file),
            versions=[
                VersionOut(
                    number=v.version.number,
                    size=v.version.size,
                    sha256=v.version.blob_sha256,
                    created_at=v.version.created_at,
                    author=UserRef.of(v.author),
                    comment=v.checkin.comment,
                    host=v.checkin.host,
                    checkin_id=v.checkin.id,
                    references=[
                        RefOut(file_id=r.file_id, path=r.path, version=r.version, deleted=r.deleted)
                        for r in v.references
                    ],
                )
                for v in detail.versions
            ],
            used_by=[UsedByOut(file=FileOut.of(u.file), uses_version=u.uses_version) for u in detail.used_by],
        )


class FolderIn(BaseModel):
    path: str


class FilesIn(BaseModel):
    files: FileRefs


class CheckoutIn(FilesIn):
    host: str  # this computer's name; the lock belongs to it
    force: bool = False  # take over files checked out elsewhere (someone else's: leads only)


class RevertIn(BaseModel):
    version: int = Field(ge=1)  # the version to make the latest again
    comment: str = Field(default="", max_length=5000)
    host: str = "web"
    force: bool = False  # even if someone else has it checked out (leads only): releases their check-out


class DeleteIn(BaseModel):
    files: list[int | str] = Field(default=[], max_length=5000)  # ids or vault paths
    folders: list[str] = Field(default=[], max_length=500)  # vault paths; they go with everything in them
    force: bool = False  # delete even if other files still use these


class DeletedOut(BaseModel):
    folders: list[FolderOut]
    files: list[FileOut]  # the files named, not those that went with their folders

    @classmethod
    def of(cls, deleted: vault.Deleted) -> "DeletedOut":
        return cls(folders=[FolderOut.of(f) for f in deleted.folders], files=[FileOut.of(f) for f in deleted.files])


class MoveIn(BaseModel):
    files: list[int | str] = Field(default=[], max_length=5000)  # ids or vault paths
    folders: list[str] = Field(default=[], max_length=500)  # vault paths
    to: str  # the folder they go into, made if it isn't there; "" is the top of the vault


class RenameIn(BaseModel):
    file: int | str | None = None  # a file (id or vault path), or
    folder: str | None = None  # a folder (vault path)
    name: str


class MovedOut(BaseModel):
    folders: list[FolderOut]
    files: list[FileOut]

    @classmethod
    def of(cls, moved: vault.Moved) -> "MovedOut":
        return cls(folders=[FolderOut.of(f) for f in moved.folders], files=[FileOut.of(f) for f in moved.files])


class ReferenceIn(BaseModel):
    path: str
    version: int | None = Field(default=None, ge=1)  # default: latest, or the one in this check-in


class CheckinItemIn(BaseModel):
    path: str
    sha256: Sha256
    size: int = Field(ge=0)
    references: list[ReferenceIn] = []


class CheckinIn(BaseModel):
    comment: str = Field(default="", max_length=5000)
    host: str
    keep_checked_out: bool = False
    items: list[CheckinItemIn] = Field(min_length=1, max_length=5000)


class CheckinFileOut(BaseModel):
    status: Literal["created", "updated", "unchanged"]
    file: FileOut


class CheckinOut(BaseModel):
    checkin_id: int | None  # null when nothing changed
    files: list[CheckinFileOut]

    @classmethod
    def of(cls, result: vault.CheckinResult) -> "CheckinOut":
        return cls(
            checkin_id=result.checkin_id,
            files=[CheckinFileOut(status=status, file=FileOut.of(view)) for status, view in result.files],
        )


class SyncOut(BaseModel):
    seq: int  # pass as `since` next time
    full: bool  # true: this is everything you can see; drop anything not listed
    folders: list[FolderOut]
    files: list[FileOut]  # when not full, includes files deleted since (deleted_at set)

    @classmethod
    def of(cls, result: vault.SyncResult) -> "SyncOut":
        return cls(
            seq=result.seq,
            full=result.full,
            folders=[FolderOut.of(f) for f in result.folders],
            files=[FileOut.of(f) for f in result.files],
        )


class EventOut(BaseModel):
    id: int
    at: datetime
    action: str
    user: UserRef | None
    folder_id: int | None
    file_id: int | None
    detail: dict[str, Any]
    # Events that made a version (add, checkin): its check-in, which groups the files checked in together.
    checkin_id: int | None = None
    comment: str | None = None

    @classmethod
    def of(cls, view: vault.EventView) -> "EventOut":
        e = view.event
        return cls(
            id=e.id,
            at=e.at,
            action=e.action,
            user=UserRef.of(view.user) if view.user else None,
            folder_id=e.folder_id,
            file_id=e.file_id,
            detail=e.detail,
            checkin_id=view.checkin.id if view.checkin else None,
            comment=view.checkin.comment if view.checkin else None,
        )


class GrantOut(BaseModel):
    folder: str  # path of the folder the grant is on (this one or an ancestor)
    user: UserRef | None  # null: everyone
    role: Role


class GrantsOut(BaseModel):
    folder: FolderOut
    grants: list[GrantOut]

    @classmethod
    def of(cls, folder: vault.FolderView, grants: list[vault.GrantView]) -> "GrantsOut":
        return cls(
            folder=FolderOut.of(folder),
            grants=[
                GrantOut(folder=g.folder, user=UserRef.of(g.user) if g.user else None, role=g.role) for g in grants
            ],
        )


class GrantIn(BaseModel):
    path: str = ""
    user_id: int | None = None  # null: everyone
    role: Role | None  # null: remove the grant


class InviteIn(BaseModel):
    email: str
    name: str = ""


class UserPatch(BaseModel):
    status: Literal["active", "disabled"] | None = None
    is_admin: bool | None = None
    name: str | None = None


class TokenOut(BaseModel):
    id: int
    kind: str
    name: str
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None

    @classmethod
    def of(cls, token: Token) -> "TokenOut":
        return cls(
            id=token.id,
            kind=token.kind,
            name=token.name,
            created_at=token.created_at,
            last_used_at=token.last_used_at,
            expires_at=token.expires_at,
        )


class TokenIssuedOut(BaseModel):
    token: str
    user: UserOut


class DevTokenIn(BaseModel):
    email: str
    name: str = ""


class ClientTokenIn(BaseModel):
    code: str
    verifier: str = Field(min_length=43, max_length=128)
