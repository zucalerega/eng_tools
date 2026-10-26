"""The shape of a drawing, as far as the server checks it, and the request and response bodies of Piper's API."""

from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from pydantic_core import ErrorDetails

from ..api.schemas import FolderPath, UserRef
from ..errors import ApiError
from ..models import User
from .models import Approval, Diagram, DiagramFolder, Image, Release, Revision, Scheme

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
# A folder's name: no slashes, as a diagram's folder could be named by its path ("Vespula/GSE").
FolderName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200, pattern=r"^[^/\\]+$")
]
MAX_CHOSEN = 1000  # diagrams moved, deleted, or restored together
MAX_PARTS = 5000  # in a drawing, on all its pages
MAX_LINES = 10_000
MAX_PAGES = 100


class InvalidDrawing(ApiError):
    status = 422
    code = "invalid_drawing"


# --- a drawing ----------------------------------------------------------------------------------------------------
# What a part and a line are (a ball valve, its ports, its properties) is the web app's (web/src/piper/drawing.ts). The
# server checks only what it needs, the ids and what the list shows, and keeps the rest as it was sent. A drawing of
# format 1 is one page, its parts and lines; of format 2, it has pages, each with its own.

Id = Annotated[str, Field(strict=True, min_length=1, max_length=64)]
Tag = Annotated[str, Field(strict=True, max_length=100)]
Coordinate = Annotated[float, Field(strict=True, allow_inf_nan=False)]


class _Checked(BaseModel):
    # Other fields are the web app's, and welcome. A model only checks the drawing: the drawing kept is the one sent,
    # with them in it, so they needn't be copied into the model too.
    model_config = ConfigDict(extra="ignore")


class PartShape(_Checked):
    id: Id
    kind: Annotated[str, Field(strict=True, min_length=1, max_length=64)]
    x: Coordinate
    y: Coordinate
    tag: Tag = ""


class LineShape(_Checked):
    id: Id
    from_: dict[str, Any] = Field(alias="from")  # its ends: a part's port, another line, or a point
    to: dict[str, Any]
    tag: Tag = ""
    fluid: Annotated[str, Field(strict=True, max_length=64)] = ""


class PageShape(_Checked):
    parts: list[PartShape] = Field(max_length=MAX_PARTS)
    lines: list[LineShape] = Field(max_length=MAX_LINES)


class NamedPageShape(PageShape):
    id: Id
    name: Annotated[str, Field(strict=True, max_length=100)] = ""


class FormatShape(_Checked):
    format: int = Field(strict=True, ge=1)


class PagesShape(FormatShape):
    pages: list[NamedPageShape] = Field(min_length=1, max_length=MAX_PAGES)


def drawing_format(drawing: dict[str, Any]) -> int:
    """A drawing's format: 1, from before pages, or 2."""
    found = drawing.get("format")
    return found if type(found) is int else 1


def drawing_pages(drawing: dict[str, Any]) -> list[dict[str, Any]]:
    """A checked drawing's pages: a drawing of format 1 is one."""
    if drawing_format(drawing) >= 2:
        return [page for page in drawing.get("pages") or [] if isinstance(page, dict)]
    return [drawing]


def check_drawing(drawing: dict[str, Any]) -> None:
    """A drawing has the shape the server needs, or InvalidDrawing says what's wrong with it."""
    try:
        if FormatShape.model_validate(drawing).format >= 2:
            pages: list[PageShape] = list(PagesShape.model_validate(drawing).pages)
        else:
            pages = [PageShape.model_validate(drawing)]
    except ValidationError as error:
        raise InvalidDrawing(_in_words(error.errors()[0])) from None
    parts = [part for page in pages for part in page.parts]
    lines = [line for page in pages for line in page.lines]
    if len(parts) > MAX_PARTS:
        raise InvalidDrawing(f"The drawing has more than {MAX_PARTS} parts on its pages")
    if len(lines) > MAX_LINES:
        raise InvalidDrawing(f"The drawing has more than {MAX_LINES} lines on its pages")
    # Unique in the whole drawing, not only on a page: a jump from one page to a part on another names it by its id.
    seen: set[str] = set()
    for item in [*parts, *lines]:
        if item.id in seen:
            raise InvalidDrawing(f"Two parts or lines share the id {item.id}")
        seen.add(item.id)
    pages_seen: set[str] = set()
    for page in pages:
        if isinstance(page, NamedPageShape):
            if page.id in pages_seen:
                raise InvalidDrawing(f"Two pages share the id {page.id}")
            pages_seen.add(page.id)


_ITEMS = {"parts": "Part", "lines": "Line"}
_FIELDS = {
    "from": "start (from)",
    "to": "end (to)",
    "parts": "list of parts",
    "lines": "list of lines",
    "pages": "list of pages",
}
_SAID = {
    "missing": "{whose} has no {name}",
    "string_too_short": "{whose} has no {name}",
    "string_type": "{its} isn't text",
    "string_too_long": "{its} is longer than {max_length} characters",
    "int_type": "{its} isn't a whole number",
    "float_type": "{its} isn't a number",
    "finite_number": "{its} isn't a finite number",
    "greater_than_equal": "{its} has to be at least {ge}",
    "list_type": "{whose}'s {field} aren't a list",
    "too_long": "{whose} has more than {max_length} {field}",
    "too_short": "{whose} has no {field}",
    "dict_type": "{its} isn't an object",
    "model_type": "{its} isn't an object",
}


def _in_words(error: ErrorDetails) -> str:
    """What pydantic found wrong, in words: "Part 3 has no kind", "Page 2's line 4's end (to) isn't an object"."""
    loc = error["loc"]
    page = ""
    if len(loc) >= 2 and loc[0] == "pages" and isinstance(loc[1], int):  # on a page, or the page itself
        page, loc = f"Page {loc[1] + 1}", loc[2:]
    if len(loc) >= 2 and loc[0] in _ITEMS and isinstance(loc[1], int):  # a part or a line, or one of its fields
        item = f"{_ITEMS[str(loc[0])]} {loc[1] + 1}"
        whose, field = f"{page}'s {item.lower()}" if page else item, str(loc[2]) if len(loc) > 2 else ""
    else:
        whose, field = page or "The drawing", str(loc[0]) if loc else ""
    name = _FIELDS.get(field, field)
    its = f"{whose}'s {name}" if field else whose
    said = _SAID.get(error["type"], "{its}: {msg}")
    return said.format(whose=whose, its=its, name=name, field=field, msg=error["msg"], **error.get("ctx", {}))


# --- bodies -------------------------------------------------------------------------------------------------------


def _ref(user: User | None) -> UserRef | None:
    return UserRef.of(user) if user else None


class DiagramIn(BaseModel):
    """A new diagram: in a folder by its id (folder_id), or by its path (folder: "Vespula/GSE", its folders made where
    they aren't there yet, as before folders were their own); at the top if neither."""

    name: Name
    folder: FolderPath = ""
    folder_id: int | None = None
    description: str = Field("", max_length=5000)
    drawing: dict[str, Any] | None = None  # None: an empty one


class DiagramChangeIn(BaseModel):
    """A new name, folder (by its id, null for the top, or by its path), or description. Leave out what doesn't
    change."""

    name: Name | None = None
    folder: FolderPath | None = None
    folder_id: int | None = None
    description: str | None = Field(None, max_length=5000)


class DiagramsIn(BaseModel):
    """Diagrams, by their ids, to delete or restore together."""

    diagrams: list[int] = Field(min_length=1, max_length=MAX_CHOSEN)


class MoveIn(DiagramsIn):
    folder_id: int | None = None  # None: the top


class FolderIn(BaseModel):
    name: FolderName
    parent_id: int | None = None  # None: at the top


class FolderChangeIn(BaseModel):
    """A new name, or a new place (parent_id; null: the top). Leave out what doesn't change."""

    name: FolderName | None = None
    parent_id: int | None = None


class FolderOut(BaseModel):
    id: int
    parent_id: int | None  # the folder it's in; None: the top
    name: str
    path: str  # its folders' names, from the top down to it: "Vespula/GSE"
    created_at: datetime
    created_by: UserRef | None

    @classmethod
    def of(cls, folder: DiagramFolder) -> "FolderOut":
        return cls(
            id=folder.id,
            parent_id=folder.parent_id,
            name=folder.name,
            path=folder.path,
            created_at=folder.created_at,
            created_by=_ref(folder.creator),
        )


class DrawingSaveIn(BaseModel):
    drawing: dict[str, Any]
    version: int = Field(ge=1)  # the diagram's version the drawing was changed from
    fresh: bool = False  # start a new revision, even if the latest is yours and would take this save


class LockIn(BaseModel):
    force: bool = False  # an admin taking over from whoever's editing it


class RevisionNoteIn(BaseModel):
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]  # its name; "": none


class RevisionRestoreIn(BaseModel):
    version: int = Field(ge=1)  # the diagram's version, as a save names it


class ReleaseIn(BaseModel):
    revision: int = Field(ge=1)  # the revision to release, by number
    approvers: list[int] = Field(max_length=100)  # their accounts' ids: at least one besides whoever asks
    note: str = Field("", max_length=2000)  # what it's for: "For HF-3's test readiness review"


class DecisionIn(BaseModel):
    comment: str = Field("", max_length=2000)  # why, for a rejection


class EditingOut(BaseModel):
    """Who's editing a diagram: only they change its drawing until they're done (diagrams.take_lock)."""

    by: UserRef
    since: datetime


class DiagramOut(BaseModel):
    id: int
    name: str
    folder: str  # its folder's path ("Vespula/GSE"), "" at the top
    folder_id: int | None = None  # its folder; None: the top
    description: str
    version: int  # what a save of its drawing names as the version it was changed from
    revision: int  # its latest revision's number
    parts: int  # how many its drawing has, on all its pages
    lines: int
    pages: int = 1  # how many pages its drawing has
    fluids: list[str]  # its lines' fluids, each once
    created_at: datetime
    created_by: UserRef | None
    updated_at: datetime
    updated_by: UserRef | None
    deleted_at: datetime | None
    deleted_by: UserRef | None
    can_delete: bool  # you made it (or you're an admin): you can delete it, and restore it
    released: str | None = None  # its latest release's letter ("B"), if it's been released
    released_revision: int | None = None  # and the revision that is
    editing: EditingOut | None = None  # who's editing it, if anyone

    @classmethod
    def fields(cls, diagram: Diagram, can_delete: bool, editing: User | None = None) -> dict[str, Any]:
        return {
            "id": diagram.id,
            "name": diagram.name,
            "folder": diagram.folder_path,
            "folder_id": diagram.folder_id,
            "description": diagram.description,
            "version": diagram.version,
            "revision": diagram.revision,
            "parts": diagram.summary.get("parts", 0),
            "lines": diagram.summary.get("lines", 0),
            "pages": diagram.summary.get("pages", 1),
            "fluids": diagram.summary.get("fluids", []),
            "created_at": diagram.created_at,
            "created_by": _ref(diagram.creator),
            "updated_at": diagram.updated_at,
            "updated_by": _ref(diagram.editor),
            "deleted_at": diagram.deleted_at,
            "deleted_by": _ref(diagram.deleter),
            "can_delete": can_delete,
            "released": diagram.released,
            "released_revision": diagram.released_revision,
            "editing": (
                EditingOut(by=UserRef.of(editing), since=diagram.locked_at or diagram.updated_at) if editing else None
            ),
        }

    @classmethod
    def of(cls, diagram: Diagram, *, can_delete: bool, editing: User | None = None) -> "DiagramOut":
        return cls(**cls.fields(diagram, can_delete, editing))


class DiagramDetailOut(DiagramOut):
    drawing: dict[str, Any]  # its latest revision's, as the web app saved it

    @classmethod
    def of_detail(
        cls, diagram: Diagram, drawing: dict[str, Any], *, can_delete: bool, editing: User | None = None
    ) -> "DiagramDetailOut":
        return cls(**DiagramOut.fields(diagram, can_delete, editing), drawing=drawing)


class RevisionOut(BaseModel):
    number: int
    note: str  # its name, if it has one: a named revision stays as it is
    size: int  # its drawing's JSON, in bytes
    created_at: datetime  # when it began
    saved_at: datetime  # its last save
    author: UserRef | None
    restored_from: int | None  # the revision it's a copy of, if it was restored from one
    released: str | None = None  # its letter, if it's been released ("B"): it stays as it is
    release_pending: bool = False  # a release of it is waiting for its approvers: it stays as it is too

    @classmethod
    def fields(cls, revision: Revision, mark: tuple[str | None, bool] = (None, False)) -> dict[str, Any]:
        return {
            "number": revision.number,
            "note": revision.note,
            "size": revision.size,
            "created_at": revision.created_at,
            "saved_at": revision.saved_at,
            "author": _ref(revision.author),
            "restored_from": revision.restored_from,
            "released": mark[0],
            "release_pending": mark[1],
        }

    @classmethod
    def of(cls, revision: Revision, mark: tuple[str | None, bool] = (None, False)) -> "RevisionOut":
        """mark: its release's letter, and whether one's waiting (releases.marks)."""
        return cls(**cls.fields(revision, mark))


class RevisionDetailOut(RevisionOut):
    drawing: dict[str, Any]

    @classmethod
    def of_detail(
        cls, revision: Revision, drawing: dict[str, Any], mark: tuple[str | None, bool] = (None, False)
    ) -> "RevisionDetailOut":
        return cls(**RevisionOut.fields(revision, mark), drawing=drawing)


class ApprovalOut(BaseModel):
    approver: UserRef
    decision: str  # pending, approved, rejected
    comment: str
    decided_at: datetime | None

    @classmethod
    def of(cls, approval: Approval) -> "ApprovalOut":
        return cls(
            approver=UserRef.of(approval.approver),
            decision=approval.decision,
            comment=approval.comment,
            decided_at=approval.decided_at,
        )


class ReleaseOut(BaseModel):
    id: int
    revision: int  # the revision it releases, by number
    letter: str | None  # "A", "B"..., once it's released
    note: str
    state: str  # pending (waiting for its approvers), released, rejected, withdrawn
    requested_at: datetime
    requested_by: UserRef | None
    decided_at: datetime | None  # when it was released, rejected, or withdrawn
    approvals: list[ApprovalOut]  # each approver's say, in the order they were named
    can_withdraw: bool  # it's waiting, and you asked for it (or you're an admin)

    @classmethod
    def of(cls, release: Release, user: User) -> "ReleaseOut":
        return cls(
            id=release.id,
            revision=release.revision,
            letter=release.letter,
            note=release.note,
            state=release.state,
            requested_at=release.requested_at,
            requested_by=_ref(release.requester),
            decided_at=release.decided_at,
            approvals=[ApprovalOut.of(approval) for approval in release.approvals],
            can_withdraw=release.state == "pending" and (release.requested_by == user.id or user.is_admin),
        )


# --- color schemes ------------------------------------------------------------------------------------------------

Color = Annotated[str, StringConstraints(pattern=r"^#[0-9a-fA-F]{6}$")]


class SchemeFluid(BaseModel):
    id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9_-]{0,39}$")]  # "lox", as lines name it
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]  # "Liquid oxygen"
    label: Annotated[str, StringConstraints(strip_whitespace=True, max_length=12)]  # "LOX", written on lines
    color: Color
    gas: bool = False  # a tank of it is full of it, not filled to a level


class SchemeStates(BaseModel):
    no: Color  # normally open valves
    nc: Color  # normally closed
    fip: Color  # fail in place (double-acting)
    other: Color  # a test's state that's neither


Fluids = Annotated[list[SchemeFluid], Field(max_length=100)]


class SchemeIn(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    fluids: Fluids
    states: SchemeStates


class SchemeChangeIn(BaseModel):
    """A new name, fluids, or states: leave out what doesn't change."""

    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] | None = None
    fluids: Fluids | None = None
    states: SchemeStates | None = None


class SchemeOut(BaseModel):
    id: int
    name: str
    fluids: list[SchemeFluid]
    states: SchemeStates
    is_default: bool  # the team's: what new diagrams start with
    created_by: UserRef | None
    updated_at: datetime  # a diagram that took its colors before this can take them again
    updated_by: UserRef | None
    can_delete: bool  # you made it (or you're an admin), and it isn't the default
    can_edit: bool  # you made it, or you're an admin

    @classmethod
    def of(cls, scheme: Scheme, *, can_change: bool) -> "SchemeOut":
        return cls(
            id=scheme.id,
            name=scheme.name,
            fluids=[SchemeFluid(**fluid) for fluid in scheme.fluids],
            states=SchemeStates(**scheme.states),
            is_default=scheme.is_default,
            created_by=_ref(scheme.creator),
            updated_at=scheme.updated_at,
            updated_by=_ref(scheme.editor),
            can_delete=can_change and not scheme.is_default,
            can_edit=can_change,
        )


class ImageOut(BaseModel):
    """A picture: what a drawing's picture part names it by (its SHA-256), and what it is."""

    sha256: str
    content_type: str
    width: int  # in pixels
    height: int
    size: int  # in bytes
    uploaded_at: datetime
    uploaded_by: UserRef | None

    @classmethod
    def of(cls, image: Image) -> "ImageOut":
        return cls(
            sha256=image.sha256,
            content_type=image.content_type,
            width=image.width,
            height=image.height,
            size=image.size,
            uploaded_at=image.uploaded_at,
            uploaded_by=_ref(image.uploader),
        )
