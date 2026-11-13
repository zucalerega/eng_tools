"""Persistence and authorization rules for Tempo's saved tests and environments."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import Conflict, Forbidden, NotFound
from ..models import User
from .models import TempoEnvironment, TempoTest


def can_change(user: User, owner_id: int) -> bool:
    """Only the owner or an admin can update or delete a saved test or environment."""
    return user.is_admin or user.id == owner_id


def check_can_change(user: User, owner_id: int, what: str) -> None:
    if not can_change(user, owner_id):
        raise Forbidden(f"Only the owner or an admin can change this {what}")


def list_tests(db: Session, *, q: str = "") -> list[TempoTest]:
    rows = list(db.scalars(select(TempoTest).order_by(TempoTest.updated_at.desc(), TempoTest.id.desc())))
    terms = [term.lower() for term in q.split() if term]
    if not terms:
        return rows
    return [
        test
        for test in rows
        if all(
            term in test.name.lower() or term in (test.owner.display_name.lower() if test.owner else "")
            for term in terms
        )
    ]


def get_test(db: Session, test_id: int) -> TempoTest:
    test = db.get(TempoTest, test_id)
    if test is None:
        raise NotFound("No such saved test")
    return test


def create_test(
    db: Session,
    user: User,
    *,
    name: str,
    source: str,
    environment: dict[str, Any],
) -> TempoTest:
    now = utcnow()
    test = TempoTest(
        name=name,
        source=source,
        environment=environment,
        version=1,
        owner_id=user.id,
        updated_by_id=user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(test)
    db.commit()
    db.refresh(test)
    return test


def update_test(
    db: Session,
    user: User,
    test_id: int,
    *,
    name: str,
    source: str,
    environment: dict[str, Any],
    expected_version: int | None = None,
) -> TempoTest:
    test = get_test(db, test_id)
    check_can_change(user, test.owner_id, "test")
    if expected_version is not None and test.version != expected_version:
        raise Conflict(
            "This test was updated elsewhere; reload or save as a new test.",
            code="changed",
            version=test.version,
        )
    test.name = name
    test.source = source
    test.environment = environment
    test.version += 1
    test.updated_by_id = user.id
    test.updated_at = utcnow()
    db.commit()
    db.refresh(test)
    return test


def delete_test(db: Session, user: User, test_id: int) -> None:
    test = get_test(db, test_id)
    check_can_change(user, test.owner_id, "test")
    db.delete(test)
    db.commit()


def list_environments(db: Session, *, q: str = "") -> list[TempoEnvironment]:
    rows = list(
        db.scalars(select(TempoEnvironment).order_by(TempoEnvironment.updated_at.desc(), TempoEnvironment.id.desc()))
    )
    terms = [term.lower() for term in q.split() if term]
    if not terms:
        return rows
    return [
        item
        for item in rows
        if all(
            term in item.name.lower()
            or term in item.description.lower()
            or term in (item.owner.display_name.lower() if item.owner else "")
            for term in terms
        )
    ]


def get_environment(db: Session, env_id: int) -> TempoEnvironment:
    item = db.get(TempoEnvironment, env_id)
    if item is None:
        raise NotFound("No such test environment")
    return item


def create_environment(
    db: Session,
    user: User,
    *,
    name: str,
    description: str,
    environment: dict[str, Any],
) -> TempoEnvironment:
    now = utcnow()
    item = TempoEnvironment(
        name=name,
        description=description,
        environment=environment,
        version=1,
        owner_id=user.id,
        updated_by_id=user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def update_environment(
    db: Session,
    user: User,
    env_id: int,
    *,
    name: str,
    description: str,
    environment: dict[str, Any],
    expected_version: int | None = None,
) -> TempoEnvironment:
    item = get_environment(db, env_id)
    check_can_change(user, item.owner_id, "environment")
    if expected_version is not None and item.version != expected_version:
        raise Conflict(
            "This environment was updated elsewhere; reload or save as a new environment.",
            code="changed",
            version=item.version,
        )
    item.name = name
    item.description = description
    item.environment = environment
    item.version += 1
    item.updated_by_id = user.id
    item.updated_at = utcnow()
    db.commit()
    db.refresh(item)
    return item


def delete_environment(db: Session, user: User, env_id: int) -> None:
    item = get_environment(db, env_id)
    check_can_change(user, item.owner_id, "environment")
    db.delete(item)
    db.commit()
