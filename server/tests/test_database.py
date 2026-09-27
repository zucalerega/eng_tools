"""Migrations match the models and keep what's there, and concurrent writers are serialized safely."""

from concurrent.futures import ThreadPoolExecutor

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from cvc_server import vault
from cvc_server.db import Base, make_engine, migrate
from cvc_server.errors import Conflict
from cvc_server.models import User


def test_migrations_match_models(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path / 'm.db'}")
    migrate(engine)
    with engine.connect() as connection:
        assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []


def _folder(db, id: int, parent: int | None, name: str, deleted: str | None = None) -> None:
    db.exec_driver_sql(
        "INSERT INTO folders (id, parent_id, name, name_key, created_at, change_seq, deleted_at) "
        "VALUES (?, ?, ?, ?, '2026-09-01 00:00:00.000000', 1, ?)",
        (id, parent, name, name.lower(), deleted),
    )


def test_upgrades_keep_the_vault(tmp_path):
    """SQLite changes a table by copying it: what other tables point at in it has to come through."""
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}")
    migrate(engine, "0001")
    with engine.begin() as db:  # a vault from before folders had a trash: a file and a grant in a folder
        db.exec_driver_sql(
            "INSERT INTO users (id, email, name, status, is_admin, created_at) "
            "VALUES (1, 'chief@x.test', 'Chief', 'active', 1, '2026-09-01 00:00:00.000000')"
        )
        db.exec_driver_sql(
            "INSERT INTO folders (id, parent_id, name, name_key, created_at, change_seq) "
            "VALUES (1, NULL, '', '', '2026-09-01 00:00:00.000000', 0), "
            "(2, 1, 'Motor', 'motor', '2026-09-01 00:00:00.000000', 1)"
        )
        db.exec_driver_sql(
            "INSERT INTO files (id, folder_id, name, name_key, latest_version, created_at, created_by, change_seq) "
            "VALUES (1, 2, 'Grain.SLDPRT', 'grain.sldprt', 1, '2026-09-01 00:00:00.000000', 1, 1)"
        )
        db.exec_driver_sql(
            "INSERT INTO grants (id, folder_id, role, created_at) VALUES (1, 2, 'editor', '2026-09-01 00:00:00.000000')"
        )

    migrate(engine)
    with engine.connect() as db:
        assert db.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1  # checked again
        assert db.exec_driver_sql("SELECT f.name, d.name FROM files f JOIN folders d ON d.id = f.folder_id").one() == (
            "Grain.SLDPRT",
            "Motor",
        )
        assert db.exec_driver_sql("SELECT folder_id FROM grants").scalar() == 2
    with engine.begin() as db:  # a deleted folder's name can be taken again, and a live one's still can't
        db.exec_driver_sql("UPDATE folders SET deleted_at = '2026-09-02 00:00:00.000000' WHERE id = 2")
        _folder(db, 3, 1, "Motor")
    with pytest.raises(IntegrityError), engine.begin() as db:
        _folder(db, 4, 1, "MOTOR")


def test_concurrent_checkouts_have_one_winner(app, team):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Nozzle.SLDPRT": b"nozzle"})
    emails = [f"member{i}@x.test" for i in range(8)]
    for email in emails:
        team.member(email, admin=True)

    def attempt(email: str) -> str:
        with app.state.sessionmaker() as db:
            user = db.scalar(select(User).where(User.email == email))
            try:
                vault.checkout(db, user, ["Nozzle.SLDPRT"], host=email)
            except Conflict:
                return "taken"
            return "won"

    with ThreadPoolExecutor(len(emails)) as pool:
        results = list(pool.map(attempt, emails))
    assert sorted(results) == ["taken"] * 7 + ["won"]
