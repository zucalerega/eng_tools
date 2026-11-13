"""Tempo's API (/api/tempo): saved sequence tests and reusable test environments."""

from typing import Annotated

from fastapi import APIRouter, Path, Query, Response

from ..api.deps import DB, ActiveUser
from . import store
from .schemas import EnvironmentIn, EnvironmentOut, TestDetailOut, TestIn, TestOut

router = APIRouter(prefix="/api/tempo", tags=["tempo"])


@router.get("/tests")
def get_tests(user: ActiveUser, db: DB, q: Annotated[str, Query(max_length=500)] = "") -> list[TestOut]:
    """List saved sequence tests (metadata only, most recently updated first)."""
    return [TestOut.of(item, can_change=store.can_change(user, item.owner_id)) for item in store.list_tests(db, q=q)]


@router.post("/tests", status_code=201)
def post_test(body: TestIn, user: ActiveUser, db: DB) -> TestDetailOut:
    """Save a new sequence test with its exact Python source and test environment."""
    created = store.create_test(db, user, name=body.name, source=body.source, environment=body.environment)
    return TestDetailOut.of_detail(created, can_change=True)


@router.get("/tests/{test_id}")
def get_test(user: ActiveUser, db: DB, test_id: Annotated[int, Path(ge=1)]) -> TestDetailOut:
    """Load a saved sequence test with its exact Python source and test environment."""
    found = store.get_test(db, test_id)
    return TestDetailOut.of_detail(found, can_change=store.can_change(user, found.owner_id))


@router.put("/tests/{test_id}")
def put_test(body: TestIn, user: ActiveUser, db: DB, test_id: Annotated[int, Path(ge=1)]) -> TestDetailOut:
    """Update an existing saved sequence test (owner or admin)."""
    updated = store.update_test(
        db,
        user,
        test_id,
        name=body.name,
        source=body.source,
        environment=body.environment,
        expected_version=body.expected_version,
    )
    return TestDetailOut.of_detail(updated, can_change=store.can_change(user, updated.owner_id))


@router.delete("/tests/{test_id}", status_code=204)
def delete_test(user: ActiveUser, db: DB, test_id: Annotated[int, Path(ge=1)]) -> Response:
    """Delete a saved sequence test (owner or admin)."""
    store.delete_test(db, user, test_id)
    return Response(status_code=204)


@router.get("/environments")
def get_environments(user: ActiveUser, db: DB, q: Annotated[str, Query(max_length=500)] = "") -> list[EnvironmentOut]:
    """List reusable test environments (most recently updated first)."""
    return [
        EnvironmentOut.of(item, can_change=store.can_change(user, item.owner_id))
        for item in store.list_environments(db, q=q)
    ]


@router.post("/environments", status_code=201)
def post_environment(body: EnvironmentIn, user: ActiveUser, db: DB) -> EnvironmentOut:
    """Save a new reusable test environment."""
    created = store.create_environment(
        db, user, name=body.name, description=body.description, environment=body.environment
    )
    return EnvironmentOut.of(created, can_change=True)


@router.get("/environments/{env_id}")
def get_environment(user: ActiveUser, db: DB, env_id: Annotated[int, Path(ge=1)]) -> EnvironmentOut:
    """Load a reusable test environment."""
    found = store.get_environment(db, env_id)
    return EnvironmentOut.of(found, can_change=store.can_change(user, found.owner_id))


@router.put("/environments/{env_id}")
def put_environment(
    body: EnvironmentIn, user: ActiveUser, db: DB, env_id: Annotated[int, Path(ge=1)]
) -> EnvironmentOut:
    """Update an existing reusable test environment (owner or admin)."""
    updated = store.update_environment(
        db,
        user,
        env_id,
        name=body.name,
        description=body.description,
        environment=body.environment,
        expected_version=body.expected_version,
    )
    return EnvironmentOut.of(updated, can_change=store.can_change(user, updated.owner_id))


@router.delete("/environments/{env_id}", status_code=204)
def delete_environment(user: ActiveUser, db: DB, env_id: Annotated[int, Path(ge=1)]) -> Response:
    """Delete a reusable test environment (owner or admin)."""
    store.delete_environment(db, user, env_id)
    return Response(status_code=204)
