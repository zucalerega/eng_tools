"""Pydantic request and response schemas for Tempo's API."""

import math
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from ..models import User
from .models import TempoEnvironment, TempoTest

MAX_SOURCE = 512 * 1024  # 512 KiB of Python source


def _validate_json_numbers(value: Any, depth: int = 0) -> None:
    if depth > 20:
        raise ValueError("Environment JSON is nested too deeply")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Environment values must be finite numbers")
    if isinstance(value, dict):
        for item in value.values():
            _validate_json_numbers(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _validate_json_numbers(item, depth + 1)


def _validate_environment(value: dict[str, Any]) -> dict[str, Any]:
    valves = value.get("valves")
    sensors = value.get("sensors")
    if not isinstance(valves, list) or not isinstance(sensors, list):
        raise ValueError("Environment must include 'valves' and 'sensors' lists")
    if len(valves) > 200 or len(sensors) > 200:
        raise ValueError("Environment has too many valves or sensors")
    _validate_json_numbers(value)
    return {"valves": valves, "sensors": sensors}


def _user_name(user: User | None) -> str:
    return user.display_name if user else ""


class TestIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    source: str = Field(default="", max_length=MAX_SOURCE)
    environment: dict[str, Any] = Field(default_factory=lambda: {"valves": [], "sensors": []})
    expected_version: int | None = Field(default=None, ge=1)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("A test needs a name")
        return cleaned

    @field_validator("environment")
    @classmethod
    def _environment(cls, value: dict[str, Any]) -> dict[str, Any]:
        return _validate_environment(value)


class TestOut(BaseModel):
    id: int
    name: str
    version: int
    owner_id: int
    owner_name: str
    updated_by_id: int | None
    updated_by_name: str
    created_at: datetime
    updated_at: datetime
    can_change: bool
    valve_count: int
    sensor_count: int
    line_count: int

    @classmethod
    def of(cls, test: TempoTest, *, can_change: bool) -> "TestOut":
        env = test.environment if isinstance(test.environment, dict) else {}
        valves = env.get("valves") if isinstance(env.get("valves"), list) else []
        sensors = env.get("sensors") if isinstance(env.get("sensors"), list) else []
        line_count = test.source.count("\n") + 1 if test.source else 0
        return cls(
            id=test.id,
            name=test.name,
            version=test.version,
            owner_id=test.owner_id,
            owner_name=_user_name(test.owner),
            updated_by_id=test.updated_by_id,
            updated_by_name=_user_name(test.updated_by),
            created_at=test.created_at,
            updated_at=test.updated_at,
            can_change=can_change,
            valve_count=len(valves),
            sensor_count=len(sensors),
            line_count=line_count,
        )


class TestDetailOut(TestOut):
    source: str
    environment: dict[str, Any]

    @classmethod
    def of_detail(cls, test: TempoTest, *, can_change: bool) -> "TestDetailOut":
        base = TestOut.of(test, can_change=can_change)
        return cls(**base.model_dump(), source=test.source, environment=test.environment)


class EnvironmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    environment: dict[str, Any] = Field(default_factory=lambda: {"valves": [], "sensors": []})
    expected_version: int | None = Field(default=None, ge=1)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("An environment needs a name")
        return cleaned

    @field_validator("environment")
    @classmethod
    def _environment(cls, value: dict[str, Any]) -> dict[str, Any]:
        return _validate_environment(value)


class EnvironmentOut(BaseModel):
    id: int
    name: str
    description: str
    environment: dict[str, Any]
    version: int
    owner_id: int
    owner_name: str
    updated_by_id: int | None
    updated_by_name: str
    created_at: datetime
    updated_at: datetime
    can_change: bool

    @classmethod
    def of(cls, item: TempoEnvironment, *, can_change: bool) -> "EnvironmentOut":
        return cls(
            id=item.id,
            name=item.name,
            description=item.description,
            environment=item.environment,
            version=item.version,
            owner_id=item.owner_id,
            owner_name=_user_name(item.owner),
            updated_by_id=item.updated_by_id,
            updated_by_name=_user_name(item.updated_by),
            created_at=item.created_at,
            updated_at=item.updated_at,
            can_change=can_change,
        )
