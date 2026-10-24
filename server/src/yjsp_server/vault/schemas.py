"""Request and response bodies of Vault's API."""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, FiniteFloat

from ..api.schemas import UserRef
from . import numbers, vault
from .caliper import Color
from .models import Applies, Numbering, PartKind, PartNumber, Role

Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
# A file id, or a vault path such as "Structures/Fins/Fin.SLDPRT".
FileRefs = Annotated[list[int | str], Field(min_length=1, max_length=5000)]


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
    created_at: datetime  # when it was added (version 1), and by whom
    created_by: UserRef | None
    modified_at: datetime  # the latest version's: when and by whom it was last changed
    modified_by: UserRef
    checked_out: LockOut | None
    deleted_at: datetime | None
    deleted_by: UserRef | None = None
    # What the latest version uses (an assembly's parts, a drawing's model), by id: the files you can
    # see, including any deleted since. Clients look them up in their copy of the sync feed.
    uses: list[UseOut]
    title: str  # what people call it: its name without its type, until someone names it (POST /api/files/metadata)
    vendor: bool  # a vendor's part (a McMaster screw, say), which keeps the vendor's name rather than a part number
    # The names it had before its renames, oldest first: SolidWorks files saved before then still look for it by them.
    former_names: list[str]

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
            created_at=file.created_at,
            created_by=UserRef.of(view.created_by) if view.created_by else None,
            modified_at=latest.created_at,
            modified_by=UserRef.of(view.modified_by),
            checked_out=lock,
            deleted_at=file.deleted_at,
            deleted_by=UserRef.of(view.deleted_by) if view.deleted_by else None,
            uses=[UseOut(file_id=file_id, version=number) for file_id, number in view.uses],
            title=file.title,
            vendor=file.vendor,
            former_names=view.former_names,
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


class DescriptionIn(BaseModel):
    file: int | str  # an id, or a vault path
    title: str | None = None  # what it's called; null leaves it as it is
    vendor: bool | None = None  # whether it's a vendor's part; null leaves it as it is


class MetadataIn(BaseModel):
    files: list[DescriptionIn] = Field(min_length=1, max_length=5000)


class MovedOut(BaseModel):
    folders: list[FolderOut]
    files: list[FileOut]

    @classmethod
    def of(cls, moved: vault.Moved) -> "MovedOut":
        return cls(folders=[FolderOut.of(f) for f in moved.folders], files=[FileOut.of(f) for f in moved.files])


class NumberingOut(BaseModel):
    mode: (
        Numbering  # off: not handed out (but to admins); offer: new parts and assemblies take them; require: they must
    )
    next_number: int  # the next to hand out


class NumberingIn(BaseModel):
    mode: Numbering | None = None
    next_number: int | None = Field(default=None, ge=1, le=numbers.LARGEST)  # only ever later


class PartKindOut(BaseModel):
    code: str  # 001: a part number's last three digits
    label: str  # what it's for: Part, Sheet metal part, Assembly
    applies: Applies  # what can have one: parts (and STEP and STL files), assemblies, or any
    retired: bool  # no new numbers of it are handed out

    @classmethod
    def of(cls, kind: PartKind) -> "PartKindOut":
        return cls(code=kind.code, label=kind.label, applies=kind.applies, retired=kind.retired)


class PartKindIn(BaseModel):
    code: str
    label: str
    applies: Applies


class PartKindChangeIn(BaseModel):
    label: str | None = None
    applies: Applies | None = None  # only while no file has a number of it
    retired: bool | None = None


class PartNumberOut(BaseModel):
    number: str  # 00000123-001
    kind: str
    title: str  # what the file that takes it is to be called; "" for none
    issued_at: datetime
    file_id: int | None  # the file that has it, once one does

    @classmethod
    def of(cls, issued: PartNumber) -> "PartNumberOut":
        return cls(
            number=numbers.text(issued.number, issued.kind),
            kind=issued.kind,
            title=issued.title,
            issued_at=issued.issued_at,
            file_id=issued.file_id,
        )


class PartNumbersOut(BaseModel):
    numbers: list[PartNumberOut]

    @classmethod
    def of(cls, issued: list[PartNumber]) -> "PartNumbersOut":
        return cls(numbers=[PartNumberOut.of(n) for n in issued])


class ReserveIn(BaseModel):
    kind: str  # a kind's code: 001
    title: str = ""  # what to call the file that takes it
    count: int = Field(default=1, ge=1)


class ReleaseIn(BaseModel):
    numbers: list[str] = Field(min_length=1, max_length=10_000)  # 00000123-001, ...


class ReferenceIn(BaseModel):
    path: str = ""  # the file it uses, by vault path; or
    file_id: int | None = None  # by id, which a rename in the same check-in doesn't change
    version: int | None = Field(default=None, ge=1)  # default: latest, or the one in this check-in


class CheckinItemIn(BaseModel):
    path: str
    sha256: Sha256
    size: int = Field(ge=0)
    references: list[ReferenceIn] = []
    title: str | None = None  # what it's called; a new file's is otherwise its part number's, or its name's
    vendor: bool | None = None  # a vendor's part; a new file's is otherwise as its name says (a McMaster number)
    base_version: int | None = Field(default=None, ge=1)  # the version its changes start from: out_of_date if older


class RenamingIn(BaseModel):
    file: int  # a file checked out to you on this computer, by id
    name: str  # its new name, in its folder: list it among the items by its new path


class CheckinIn(BaseModel):
    comment: str = Field(default="", max_length=5000)
    host: str
    keep_checked_out: bool = False
    items: list[CheckinItemIn] = Field(min_length=1, max_length=5000)
    # Files renamed in this check-in; every file whose latest version uses one goes in too, saved with its new name.
    renames: list[RenamingIn] = Field(default=[], max_length=5000)
    dry_run: bool = False  # find every problem, and change nothing


class CheckinFileOut(BaseModel):
    status: Literal["created", "updated", "unchanged", "renamed"]
    file: FileOut


class ProblemOut(BaseModel):
    error: str  # the error's code, as a refusal has it
    message: str
    details: dict[str, Any]  # as a refusal's


class PlannedOut(BaseModel):
    status: Literal["created", "updated", "unchanged", "renamed"]
    path: str


class CheckinOut(BaseModel):
    checkin_id: int | None  # null when nothing changed, and for a dry run
    files: list[CheckinFileOut]  # none for a dry run, which says instead
    planned: list[PlannedOut] = []  # what would happen to each file, if it found no
    problems: list[ProblemOut] = []  # problems: every one it found

    @classmethod
    def of(cls, result: vault.CheckinResult) -> "CheckinOut":
        return cls(
            checkin_id=result.checkin_id,
            files=[CheckinFileOut(status=status, file=FileOut.of(view)) for status, view in result.files],
            planned=[PlannedOut(status=status, path=path) for status, path in result.planned],
            problems=[ProblemOut(error=p.code, message=p.message, details=p.details) for p in result.problems],
        )


class PauseOut(BaseModel):
    by: UserRef  # the admin who paused the vault: their changes, from host, go on
    since: datetime
    host: str
    reason: str

    @classmethod
    def of(cls, pause: vault.Pause) -> "PauseOut":
        return cls(by=UserRef.of(pause.by), since=pause.since, host=pause.host, reason=pause.reason)


class PauseIn(BaseModel):
    host: str  # this computer: the admin's changes from it go on
    reason: str = ""  # what for, shown to everyone


class SyncOut(BaseModel):
    seq: int  # pass as `since` next time
    full: bool  # true: this is everything you can see; drop anything not listed
    folders: list[FolderOut]
    files: list[FileOut]  # when not full, includes files deleted since (deleted_at set)
    paused: PauseOut | None = None  # an admin has the vault paused: changes wait until it's back

    @classmethod
    def of(cls, result: vault.SyncResult) -> "SyncOut":
        return cls(
            seq=result.seq,
            full=result.full,
            folders=[FolderOut.of(f) for f in result.folders],
            files=[FileOut.of(f) for f in result.files],
            paused=PauseOut.of(result.paused) if result.paused else None,
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


class CaliperModelOut(BaseModel):
    version: int
    configuration: str
    kind: Literal["part", "assembly"]  # a part's model is a mesh; an assembly's, its components
    units: str  # the document's length unit, for measurements: mm, cm, m, in, or ft
    created_at: datetime
    created_by: UserRef

    @classmethod
    def of(cls, view: vault.ModelView) -> "CaliperModelOut":
        model = view.model
        return cls(
            version=view.version,
            configuration=model.configuration,
            kind=view.kind,
            units=model.units,
            created_at=model.created_at,
            created_by=UserRef.of(view.created_by),
        )


class CaliperModelsOut(BaseModel):
    models: list[CaliperModelOut]  # newest version first; in a version, the first made first


class CaliperMakeIn(BaseModel):
    version: int = Field(ge=1)


class CaliperComponentIn(BaseModel):
    name: str = Field(max_length=255)  # SolidWorks' name for it in the assembly: "Bracket-2"
    file_id: int | None = None  # its part's or sub-assembly's file; none for a virtual one, kept in the assembly
    version: int | None = Field(default=None, ge=1)  # of its file: the one the assembly was made with
    configuration: str = Field(default="", max_length=255)
    # Where it is: the rows of a 3 x 4 matrix to the top assembly's coordinates, rotation then translation (mm).
    transform: Annotated[list[FiniteFloat], Field(min_length=12, max_length=12)]
    hidden: bool = False  # hidden in SolidWorks
    color: Color | None = None  # its own, over its part's
    opacity: float = Field(default=1, ge=0, le=1)
    mesh: Sha256 | None = None  # its shape, when the assembly keeps it (a virtual part's)
    # Kept inside the assembly (a virtual part, as routed tubes are): without a mesh, no shape of it was found there (its
    # solid empty, or the sub-assembly that keeps it not in the vault).
    virtual: bool = False
    children: list["CaliperComponentIn"] = []  # a sub-assembly's components


class CaliperModelIn(BaseModel):
    version: int = Field(ge=1)
    configuration: str = Field(min_length=1, max_length=255)
    units: vault.Units
    mesh: Sha256 | None = None  # a part's: upload it first (PUT /api/blobs/{sha256})
    components: list[CaliperComponentIn] | None = None  # an assembly's


class CaliperComponentOut(CaliperComponentIn):
    model: bool  # whether its file has a model of its own, at its version and in its configuration
    # Its file's, by its name: a sub-assembly without children here has none of its parts in the vault. None: it has
    # no file (a virtual part), or one that isn't a SolidWorks part or assembly.
    kind: Literal["part", "assembly"] | None = None
    # A STEP or IGES file's (placed with SolidWorks' 3D Interconnect), which the web app reads as it is.
    format: Literal["step", "iges"] | None = None
    children: list["CaliperComponentOut"] = []


class CaliperAssemblyOut(BaseModel):
    model: CaliperModelOut
    components: list[CaliperComponentOut]  # the ones in files you can see
    left_out: int  # components in files you can't see, left out with everything in them

    @classmethod
    def of(cls, assembly: vault.AssemblyModel) -> "CaliperAssemblyOut":
        return cls(
            model=CaliperModelOut.of(assembly.view),
            components=[CaliperComponentOut.model_validate(c) for c in assembly.components],
            left_out=assembly.left_out,
        )


class CaliperWantIn(BaseModel):
    file_id: int
    version: int
    configuration: str = Field(max_length=255)


class CaliperMissingIn(BaseModel):
    models: list[CaliperWantIn] = Field(max_length=20_000)


class CaliperMissingOut(BaseModel):
    missing: list[CaliperWantIn]  # those that have no model yet, of files you can see


class DrawingPdfOut(BaseModel):
    size: int
    created_at: datetime
    created_by: UserRef

    @classmethod
    def of(cls, view: vault.PdfView) -> "DrawingPdfOut":
        return cls(size=view.size, created_at=view.pdf.created_at, created_by=UserRef.of(view.created_by))


class SheetOut(BaseModel):
    name: str  # SolidWorks' name for it ("Sheet1"), or "" where the file doesn't say
    picture: bool  # whether SolidWorks saved a picture of it in the file (GET .../drawing/sheet)


class DrawingOut(BaseModel):
    version: int
    pdf: DrawingPdfOut | None  # the PDF Vault for SolidWorks made of it (GET .../drawing/pdf), if it made one
    sheets: list[SheetOut]  # in order
    unreadable: str | None  # why its sheets couldn't be read, if they couldn't

    @classmethod
    def of(cls, view: vault.DrawingView) -> "DrawingOut":
        return cls(
            version=view.version,
            pdf=DrawingPdfOut.of(view.pdf) if view.pdf else None,
            sheets=[SheetOut(name=sheet.name, picture=sheet.picture is not None) for sheet in view.sheets],
            unreadable=view.unreadable,
        )


class DrawingPdfIn(BaseModel):
    version: int = Field(ge=1)
    pdf: Sha256  # upload it first (PUT /api/blobs/{sha256})


class DrawingWantIn(BaseModel):
    file_id: int
    version: int


class DrawingsMissingIn(BaseModel):
    drawings: list[DrawingWantIn] = Field(max_length=20_000)


class DrawingsMissingOut(BaseModel):
    missing: list[DrawingWantIn]  # those that have no PDF yet, of files you can see
