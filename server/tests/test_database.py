"""Migrations match the models and keep what's there, and concurrent writers are serialized safely."""

from concurrent.futures import ThreadPoolExecutor

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from yjsp_server.db import Base, make_engine, migrate
from yjsp_server.errors import Conflict
from yjsp_server.models import User
from yjsp_server.vault import vault


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


def test_upgrades_keep_yorgs_data(tmp_path):
    """Datasets got folders by copying their table (on SQLite), which channels point at."""
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}")
    migrate(engine, "0004")
    when = "'2026-09-01 00:00:00.000000'"
    with engine.begin() as db:
        db.exec_driver_sql(
            "INSERT INTO users (id, email, name, status, is_admin, created_at) "
            f"VALUES (1, 'chief@x.test', 'Chief', 'active', 1, {when})"
        )
        db.exec_driver_sql(
            "INSERT INTO yorg_datasets (id, name, description, filename, size, sha256, status, rows, channel_count, "
            "read_options, read_info, warnings, events, created_at, created_by, updated_at) VALUES (1, 'Hotfire 3', '', "
            f"'hotfire.csv', 10, 'ab', 'ready', 5, 1, '{{}}', '{{}}', '[]', '[]', {when}, 1, {when})"
        )
        db.exec_driver_sql(
            "INSERT INTO yorg_channels (id, dataset_id, position, name, unit, kind, labels, count, time_file, value_file) "
            "VALUES (1, 1, 1, 'PT-1', 'psi', 'number', '[]', 5, 'time.f64', 'c1.f64')"
        )

    migrate(engine)
    with engine.connect() as db:
        joined = "SELECT d.name, d.folder_id, c.name FROM yorg_channels c JOIN yorg_datasets d ON d.id = c.dataset_id"
        assert db.exec_driver_sql(joined).one() == ("Hotfire 3", None, "PT-1")


def test_upgrades_keep_views(tmp_path):
    """Views got folders: those saved before are at the top, as they were."""
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}")
    migrate(engine, "0006")
    when = "'2026-09-01 00:00:00.000000'"
    with engine.begin() as db:
        db.exec_driver_sql(
            "INSERT INTO users (id, email, name, status, is_admin, created_at) "
            f"VALUES (1, 'chief@x.test', 'Chief', 'active', 1, {when})"
        )
        db.exec_driver_sql(
            "INSERT INTO yorg_views (id, name, description, datasets, config, created_at, created_by, updated_at) "
            f"VALUES (1, 'Tanks', '', '[3]', '{{\"panels\": []}}', {when}, 1, {when})"
        )

    migrate(engine)
    with engine.connect() as db:
        assert db.exec_driver_sql("SELECT name, folder, datasets, config FROM yorg_views").one() == (
            "Tanks",
            "",
            "[3]",
            '{"panels": []}',
        )


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
