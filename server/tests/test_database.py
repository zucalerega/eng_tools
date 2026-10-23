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


def test_upgrades_give_files_titles(tmp_path):
    """Files take their names, without their types, as their titles; none is a vendor's yet. Their versions, which
    point at them, come through."""
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}")
    migrate(engine, "0016")
    when = "'2026-09-01 00:00:00.000000'"
    with engine.begin() as db:
        db.exec_driver_sql(
            "INSERT INTO users (id, email, name, status, is_admin, created_at, site_seconds) "
            f"VALUES (1, 'chief@x.test', 'Chief', 'active', 1, {when}, 0)"
        )
        _folder(db, 1, None, "")
        db.exec_driver_sql(
            "INSERT INTO files (id, folder_id, name, name_key, latest_version, created_at, created_by, change_seq) "
            f"VALUES (1, 1, 'Fin Bracket.SLDPRT', 'fin bracket.sldprt', 1, {when}, 1, 1), "
            f"(2, 1, 'README', 'readme', 1, {when}, 1, 1)"
        )
        db.exec_driver_sql(
            f"INSERT INTO checkins (id, user_id, host, comment, created_at) VALUES (1, 1, 'PC', '', {when})"
        )
        db.exec_driver_sql(f"INSERT INTO blobs (sha256, size, created_at) VALUES ('ab', 3, {when})")
        db.exec_driver_sql(
            "INSERT INTO versions (id, file_id, number, checkin_id, blob_sha256, size, created_at, created_by) "
            f"VALUES (1, 1, 1, 1, 'ab', 3, {when}, 1)"
        )

    migrate(engine)
    with engine.connect() as db:
        assert db.exec_driver_sql("SELECT id, title, vendor FROM files ORDER BY id").all() == [
            (1, "Fin Bracket", 0),
            (2, "README", 0),
        ]
        assert db.exec_driver_sql("SELECT f.title FROM versions v JOIN files f ON f.id = v.file_id").scalar() == (
            "Fin Bracket"
        )
        assert db.exec_driver_sql("SELECT COUNT(*) FROM former_names").scalar() == 0


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


def test_upgrades_keep_accounts(tmp_path):
    """Accounts got a Georgia Tech identity: those from before, and what points at them, are as they were."""
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}")
    migrate(engine, "0007")
    when = "'2026-09-01 00:00:00.000000'"
    with engine.begin() as db:
        db.exec_driver_sql(
            "INSERT INTO users (id, email, name, google_sub, status, is_admin, created_at) "
            f"VALUES (1, 'chief@x.test', 'Chief', 'google-chief', 'active', 1, {when}), "
            f"(2, 'alice@x.test', 'Alice', 'google-alice', 'active', 0, {when})"
        )
        db.exec_driver_sql(
            "INSERT INTO tokens (id, user_id, kind, name, token_hash, created_at) "
            f"VALUES (1, 2, 'client', 'vault CLI', 'ab', {when})"
        )

    migrate(engine)
    with engine.connect() as db:
        assert db.exec_driver_sql("SELECT email, google_sub, microsoft_oid FROM users ORDER BY id").all() == [
            ("chief@x.test", "google-chief", None),
            ("alice@x.test", "google-alice", None),
        ]
        assert db.exec_driver_sql("SELECT u.email FROM tokens t JOIN users u ON u.id = t.user_id").scalar() == (
            "alice@x.test"
        )
    with engine.begin() as db:  # one account per Georgia Tech account
        db.exec_driver_sql("UPDATE users SET microsoft_oid = 'oid-1' WHERE id = 1")
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.exec_driver_sql("UPDATE users SET microsoft_oid = 'oid-1' WHERE id = 2")


def test_upgrades_keep_time_on_the_site(tmp_path):
    """Time in SolidWorks is counted beside time on the web app: what was counted before stays, and nobody has any
    time in SolidWorks yet."""
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}")
    migrate(engine, "0014")
    when = "'2026-10-15 14:00:00.000000'"
    with engine.begin() as db:
        db.exec_driver_sql(
            "INSERT INTO users (id, email, name, status, is_admin, created_at, site_seconds) "
            f"VALUES (1, 'chief@x.test', 'Chief', 'active', 1, {when}, 0), "
            f"(2, 'alice@x.test', 'Alice', 'active', 0, {when}, 600)"
        )
        db.exec_driver_sql(
            "INSERT INTO tokens (id, user_id, kind, name, token_hash, created_at) "
            f"VALUES (1, 2, 'client', 'SolidWorks add-in on ALICE-PC', 'ab', {when})"
        )
        db.exec_driver_sql(f"INSERT INTO site_usage (hour, user_id, site_seconds) VALUES ({when}, 2, 600)")

    migrate(engine)
    with engine.connect() as db:
        assert db.exec_driver_sql("SELECT email, site_seconds, solidworks_seconds FROM users ORDER BY id").all() == [
            ("chief@x.test", 0, 0),
            ("alice@x.test", 600, 0),
        ]
        assert db.exec_driver_sql(
            "SELECT u.email, s.site_seconds, s.solidworks_seconds FROM site_usage s JOIN users u ON u.id = s.user_id"
        ).all() == [("alice@x.test", 600, 0)]
        assert db.exec_driver_sql("SELECT u.email FROM tokens t JOIN users u ON u.id = t.user_id").scalar() == (
            "alice@x.test"
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
