"""Request and response bodies of Yorg's API."""

from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, Field, StringConstraints

from ..api.schemas import UserRef
from ..models import User
from .datasets import can_change
from .ingest import Delimiter, ReadOptions, TimeFormat
from .models import Channel, Dataset, View

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


def _ref(user: User | None) -> UserRef | None:
    return UserRef.of(user) if user else None


class ChannelOut(BaseModel):
    name: str
    unit: str
    kind: str  # "number", or "state": text, numbered in the order of labels
    labels: list[str]
    decimals: int | None  # the most digits after the point in the file
    count: int  # samples with a value
    min: float | None
    max: float | None
    mean: float | None
    t_min: float | None
    t_max: float | None
    column: int  # in the file, from 1
    # Its samples' times and values: arrays of little-endian float64 at .../data/{data_version}/{file}.
    time: str
    values: str

    @classmethod
    def of(cls, channel: Channel) -> "ChannelOut":
        return cls(
            name=channel.name,
            unit=channel.unit,
            kind=channel.kind,
            labels=channel.labels,
            decimals=channel.decimals,
            count=channel.count,
            min=channel.min,
            max=channel.max,
            mean=channel.mean,
            t_min=channel.t_min,
            t_max=channel.t_max,
            column=channel.position + 1,
            time=channel.time_file,
            values=channel.value_file,
        )


class EventOut(BaseModel):
    t: float
    label: str
    channel: str


class DatasetOut(BaseModel):
    id: int
    name: str
    description: str
    filename: str
    size: int
    status: str  # "reading", "ready", or "failed" (error says why)
    error: str | None
    rows: int
    channel_count: int
    # Times are seconds: "relative", as in the file; "absolute", from start_epoch (Unix seconds); "clock", times of
    # day, from start_epoch seconds after midnight.
    time_kind: str | None
    start_epoch: float | None
    t_min: float | None
    t_max: float | None
    sample_rate: float | None
    created_at: datetime
    created_by: UserRef | None
    updated_at: datetime
    deleted_at: datetime | None
    deleted_by: UserRef | None
    can_change: bool  # yours (or you're an admin): you can rename, read again, and delete it

    @classmethod
    def fields(cls, dataset: Dataset, user: User) -> dict[str, Any]:
        return {
            "id": dataset.id,
            "name": dataset.name,
            "description": dataset.description,
            "filename": dataset.filename,
            "size": dataset.size,
            "status": dataset.status,
            "error": dataset.error,
            "rows": dataset.rows,
            "channel_count": dataset.channel_count,
            "time_kind": dataset.time_kind,
            "start_epoch": dataset.start_epoch,
            "t_min": dataset.t_min,
            "t_max": dataset.t_max,
            "sample_rate": dataset.sample_rate,
            "created_at": dataset.created_at,
            "created_by": _ref(dataset.creator),
            "updated_at": dataset.updated_at,
            "deleted_at": dataset.deleted_at,
            "deleted_by": _ref(dataset.deleter),
            "can_change": can_change(user, dataset.created_by),
        }

    @classmethod
    def of(cls, dataset: Dataset, user: User) -> "DatasetOut":
        return cls(**cls.fields(dataset, user))


class DatasetDetailOut(DatasetOut):
    data_version: str | None
    channels: list[ChannelOut]
    events: list[EventOut]  # from text columns that were mostly empty, like a sequence's steps
    warnings: list[str]  # what was left out or changed while reading the file
    read_options: dict[str, Any]  # how it was asked to be read
    read_info: dict[str, Any]  # how it was read: delimiter, header_row, time_column, time_format, ...

    @classmethod
    def of_detail(cls, dataset: Dataset, channels: list[Channel], user: User) -> "DatasetDetailOut":
        return cls(
            **DatasetOut.fields(dataset, user),
            data_version=dataset.data_version,
            channels=[ChannelOut.of(channel) for channel in channels],
            events=[EventOut(**event) for event in dataset.events],
            warnings=dataset.warnings,
            read_options=dataset.read_options,
            read_info=dataset.read_info,
        )


class DatasetChangeIn(BaseModel):
    name: Name | None = None
    description: str | None = Field(None, max_length=5000)


class ReadOptionsIn(BaseModel):
    """How to read a dataset's file; what's left out is worked out from the file."""

    time_column: str | None = Field(None, max_length=255)
    time_format: TimeFormat = "auto"
    sample_rate: float | None = Field(None, gt=0, le=1e9)  # for time_format "rows"
    header_row: int | None = Field(None, ge=0, le=1_000_000)  # from 1; 0: no names
    delimiter: Delimiter | None = None

    def options(self) -> ReadOptions:
        return ReadOptions(**self.model_dump())


class ViewIn(BaseModel):
    name: Name
    description: str = Field("", max_length=5000)
    datasets: list[int] = Field(default_factory=list, max_length=100)
    config: dict[str, Any]  # the web app's layout of the plots


class ViewOut(BaseModel):
    id: int
    name: str
    description: str
    datasets: list[int]
    config: dict[str, Any]
    created_at: datetime
    created_by: UserRef | None
    updated_at: datetime
    updated_by: UserRef | None
    can_change: bool

    @classmethod
    def of(cls, view: View, user: User) -> "ViewOut":
        return cls(
            id=view.id,
            name=view.name,
            description=view.description,
            datasets=view.datasets,
            config=view.config,
            created_at=view.created_at,
            created_by=_ref(view.creator),
            updated_at=view.updated_at,
            updated_by=_ref(view.editor),
            can_change=can_change(user, view.created_by),
        )
