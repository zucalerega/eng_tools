"""Yorg's tables: datasets (uploaded files and the channels read from them) and saved plot views."""

import enum
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, BigInteger, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base, UTCDateTime, utcnow
from ..models import User


class DatasetStatus(enum.StrEnum):
    READING = "reading"  # its file is being read for the first time
    READY = "ready"
    FAILED = "failed"  # the file couldn't be read: error says why, and it can be read again another way


class Dataset(Base):
    """An uploaded file of test data, and what was read from it: one time base, and a channel per column."""

    __tablename__ = "yorg_datasets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    filename: Mapped[str] = mapped_column(String(255))
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16))  # DatasetStatus
    error: Mapped[str | None] = mapped_column(Text)
    # The folder of arrays from the latest read (DataFiles.data). Each read makes a new one, so an array's URL
    # always means the same bytes, and browsers can keep them.
    data_version: Mapped[str | None] = mapped_column(String(32))
    rows: Mapped[int] = mapped_column(BigInteger, default=0)
    channel_count: Mapped[int] = mapped_column(default=0)
    # Times are seconds. "relative": as the file had them. "absolute" (dates, or Unix time) and "clock" (times of
    # day): seconds from start_epoch, the first row's time (Unix seconds; for "clock", seconds after midnight).
    time_kind: Mapped[str | None] = mapped_column(String(16))
    start_epoch: Mapped[float | None]
    t_min: Mapped[float | None]
    t_max: Mapped[float | None]
    sample_rate: Mapped[float | None]  # rows per second, typically
    # How to read the file (ingest.ReadOptions), and how it was read: delimiter, rows, the time column and format.
    read_options: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    read_info: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    warnings: Mapped[list[str]] = mapped_column(JSON, default=list)
    # Text columns that were mostly empty, like a sequence's steps: [{"t", "label", "channel"}], shown as markers.
    events: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    deleted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    creator: Mapped[User | None] = relationship(foreign_keys=[created_by], lazy="selectin")
    deleter: Mapped[User | None] = relationship(foreign_keys=[deleted_by], lazy="selectin")


class Channel(Base):
    """One column of a dataset: a sensor's samples, in two arrays (times and values) in the dataset's data."""

    __tablename__ = "yorg_channels"
    __table_args__ = (UniqueConstraint("dataset_id", "name", name="uq_yorg_channels_dataset_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("yorg_datasets.id"), index=True)
    position: Mapped[int]  # its column in the file, from 0
    name: Mapped[str] = mapped_column(String(255))
    unit: Mapped[str] = mapped_column(String(64), default="")
    kind: Mapped[str] = mapped_column(String(16))  # "number", or "state": text, numbered in labels' order
    labels: Mapped[list[str]] = mapped_column(JSON, default=list)
    decimals: Mapped[int | None]  # the most digits after the point in the file, to show values as written
    count: Mapped[int] = mapped_column(BigInteger)
    min: Mapped[float | None]
    max: Mapped[float | None]
    mean: Mapped[float | None]
    t_min: Mapped[float | None]
    t_max: Mapped[float | None]
    time_file: Mapped[str] = mapped_column(String(64))
    value_file: Mapped[str] = mapped_column(String(64))


class View(Base):
    """A saved plot: its panels, channels, scales, time window, and markers, as the web app lays them out."""

    __tablename__ = "yorg_views"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    datasets: Mapped[list[int]] = mapped_column(JSON, default=list)  # the datasets it plots, by id
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    creator: Mapped[User | None] = relationship(foreign_keys=[created_by], lazy="selectin")
    editor: Mapped[User | None] = relationship(foreign_keys=[updated_by], lazy="selectin")
