"""The shape of a drawing, as far as the server checks it, and the request and response bodies of Piper's API."""

from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from pydantic_core import ErrorDetails

from ..api.schemas import FolderPath, UserRef
from ..errors import ApiError
from ..models import User
from .models import Approval, Diagram, Release, Revision

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
MAX_PARTS = 5000
MAX_LINES = 10_000


class InvalidDrawing(ApiError):
    status = 422
    code = "invalid_drawing"


# --- a drawing ----------------------------------------------------------------------------------------------------
# What a part and a line are (a ball valve, its ports, its properties) is the web app's (web/src/piper/drawing.ts). The
# server checks only what it needs, the ids and what the list shows, and keeps the rest as it was sent.

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


class DrawingShape(_Checked):
    format: int = Field(strict=True, ge=1)
    parts: list[PartShape] = Field(max_length=MAX_PARTS)
    lines: list[LineShape] = Field(max_length=MAX_LINES)


def check_drawing(drawing: dict[str, Any]) -> None:
    """A drawing has the shape the server needs, or InvalidDrawing says what's wrong with it."""
    try:
        shape = DrawingShape.model_validate(drawing)
    except ValidationError as error:
        raise InvalidDrawing(_in_words(error.errors()[0])) from None
    seen: set[str] = set()
    for item in [*shape.parts, *shape.lines]:
        if item.id in seen:
            raise InvalidDrawing(f"Two parts or lines share the id {item.id}")
        seen.add(item.id)


_ITEMS = {"parts": "Part", "lines": "Line"}
_FIELDS = {"from": "start (from)", "to": "end (to)", "parts": "list of parts", "lines": "list of lines"}
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
    "dict_type": "{its} isn't an object",
    "model_type": "{its} isn't an object",
}


def _in_words(error: ErrorDetails) -> str:
    """What pydantic found wrong, in words: "Part 3 has no kind", "Line 2's end (to) isn't an object"."""
    loc = error["loc"]
    if len(loc) >= 2 and loc[0] in _ITEMS and isinstance(loc[1], int):  # a part or a line, or one of its fields
        whose, field = f"{_ITEMS[str(loc[0])]} {loc[1] + 1}", str(loc[2]) if len(loc) > 2 else ""
    else:
        whose, field = "The drawing", str(loc[0]) if loc else ""
    name = _FIELDS.get(field, field)
    its = f"{whose}'s {name}" if field else whose
    said = _SAID.get(error["type"], "{its}: {msg}")
    return said.format(whose=whose, its=its, name=name, field=field, msg=error["msg"], **error.get("ctx", {}))


# --- bodies -------------------------------------------------------------------------------------------------------


def _ref(user: User | None) -> UserRef | None:
    return UserRef.of(user) if user else None


class DiagramIn(BaseModel):
    name: Name
    folder: FolderPath = ""
    description: str = Field("", max_length=5000)
    drawing: dict[str, Any] | None = None  # None: an empty one


class DiagramChangeIn(BaseModel):
    """A new name, folder, or description. Leave out what doesn't change."""

    name: Name | None = None
    folder: FolderPath | None = None
    description: str | None = Field(None, max_length=5000)


class DrawingSaveIn(BaseModel):
    drawing: dict[str, Any]
    version: int = Field(ge=1)  # the diagram's version the drawing was changed from
    fresh: bool = False  # start a new revision, even if the latest is yours and would take this save


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


class DiagramOut(BaseModel):
    id: int
    name: str
    folder: str  # "" at the top
    description: str
    version: int  # what a save of its drawing names as the version it was changed from
    revision: int  # its latest revision's number
    parts: int  # how many its drawing has
    lines: int
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

    @classmethod
    def fields(cls, diagram: Diagram, can_delete: bool) -> dict[str, Any]:
        return {
            "id": diagram.id,
            "name": diagram.name,
            "folder": diagram.folder,
            "description": diagram.description,
            "version": diagram.version,
            "revision": diagram.revision,
            "parts": diagram.summary.get("parts", 0),
            "lines": diagram.summary.get("lines", 0),
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
        }

    @classmethod
    def of(cls, diagram: Diagram, *, can_delete: bool) -> "DiagramOut":
        return cls(**cls.fields(diagram, can_delete))


class DiagramDetailOut(DiagramOut):
    drawing: dict[str, Any]  # its latest revision's, as the web app saved it

    @classmethod
    def of_detail(cls, diagram: Diagram, drawing: dict[str, Any], *, can_delete: bool) -> "DiagramDetailOut":
        return cls(**DiagramOut.fields(diagram, can_delete), drawing=drawing)


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
