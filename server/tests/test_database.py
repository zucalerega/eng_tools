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


def test_upgrades_keep_the_part_numbers_from_before(tmp_path):
    """Parts and assemblies named by numbers of their own before part numbers (Ground Structures': a project's number,
    then its parts') keep them, and numbers handed out start after the largest any file's name has."""
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}")
    migrate(engine, "0020")
    when = "'2026-09-01 00:00:00.000000'"
    with engine.begin() as db:
        db.exec_driver_sql(
            "INSERT INTO users (id, email, name, status, is_admin, created_at, site_seconds) "
            f"VALUES (1, 'chief@x.test', 'Chief', 'active', 1, {when}, 0)"
        )
        db.exec_driver_sql("INSERT INTO vault_state (id, seq, access_seq) VALUES (1, 5, 0)")
        _folder(db, 1, None, "")
        names = [
            "00000011-001.SLDPRT",
            "00000011-501.SLDASM",
            "00000004-010-6.SLDPRT",
            "00000011-001.SLDDRW",
            "00000021-001.PDF",
            "Fin.SLDPRT",
        ]
        for id, name in enumerate(names, 1):
            db.exec_driver_sql(
                "INSERT INTO files (id, folder_id, name, name_key, latest_version, created_at, created_by, change_seq) "
                f"VALUES ({id}, 1, '{name}', '{name.lower()}', 1, {when}, 1, 1)"
            )

    migrate(engine)
    with engine.connect() as db:
        held = "SELECT number, kind, file_id, legacy, issued_by FROM part_numbers ORDER BY file_id"
        assert db.exec_driver_sql(held).all() == [
            (11, "001", 1, 1, None),
            (11, "501", 2, 1, None),
            (4, "010", 3, 1, None),
        ]
        assert db.exec_driver_sql("SELECT next_number, numbering FROM vault_state").one() == (22, "off")
        assert db.exec_driver_sql("SELECT code, applies FROM part_kinds ORDER BY code").all() == [
            ("001", "part"),
            ("501", "assembly"),
        ]


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


def test_upgrades_give_piper_diagrams_folders_of_their_own(tmp_path):
    """Diagrams' folder paths became folders, by copying their table (on SQLite), which revisions point at."""
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}")
    migrate(engine, "0026")
    with engine.begin() as db:
        for user_id, email in [(1, "chief@x.test"), (2, "bob@x.test")]:
            db.exec_driver_sql(
                "INSERT INTO users (id, email, name, status, is_admin, created_at) "
                f"VALUES ({user_id}, '{email}', 'Chief', 'active', 1, '2026-09-01 00:00:00.000000')"
            )
        # Feed, the first in Vespula/GSE (Bob's); Fill, in it by another case; Igniter, in Vespula/Prop; Scratch, at the top.
        for diagram_id, name, folder, by, day in [
            (1, "Fill", "vespula/gse", 1, 3),
            (2, "Feed", "Vespula/GSE", 2, 2),
            (3, "Igniter", "Vespula/Prop", 1, 4),
            (4, "Scratch", "", 1, 5),
        ]:
            when = f"'2026-09-0{day} 00:00:00.000000'"
            db.exec_driver_sql(
                "INSERT INTO piper_diagrams (id, name, folder, description, version, revision, summary, created_at, "
                f"created_by, updated_at) VALUES ({diagram_id}, '{name}', '{folder}', '', 1, 1, '{{}}', {when}, {by}, "
                f"{when})"
            )
            db.exec_driver_sql(
                "INSERT INTO piper_revisions (id, diagram_id, number, drawing, size, note, created_at, saved_at) "
                f"VALUES ({diagram_id}, {diagram_id}, 1, x'00', 1, '', {when}, {when})"
            )

    migrate(engine)
    with engine.connect() as db:
        folders = {
            row.id: row
            for row in db.exec_driver_sql("SELECT id, parent_id, name, created_by, created_at FROM piper_folders")
        }
        assert sorted(
            (row.name, folders[row.parent_id].name if row.parent_id else None) for row in folders.values()
        ) == [
            ("GSE", "Vespula"),
            ("Prop", "Vespula"),
            ("Vespula", None),
        ]
        gse = next(row for row in folders.values() if row.name == "GSE")
        assert (gse.created_by, gse.created_at[:10]) == (2, "2026-09-02")  # its first diagram's maker, and when
        placed = db.exec_driver_sql(
            "SELECT d.name, d.folder_id, r.number FROM piper_diagrams d JOIN piper_revisions r ON "
            "r.diagram_id = d.id ORDER BY d.id"
        ).all()
        named = {name: (folders[folder].name if folder else None, number) for name, folder, number in placed}
        assert named == {"Fill": ("GSE", 1), "Feed": ("GSE", 1), "Igniter": ("Prop", 1), "Scratch": (None, 1)}


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


def test_upgrades_keep_what_claudes_answers_cost(tmp_path):
    """Reads that keep the help ready are no one's question: the table is copied to allow them, and what each person's
    questions cost comes through as it was."""
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}")
    migrate(engine, "0028")
    when = "'2026-10-28 14:00:00.000000'"
    with engine.begin() as db:
        db.exec_driver_sql(
            "INSERT INTO users (id, email, name, status, is_admin, created_at, site_seconds, solidworks_seconds) "
            f"VALUES (1, 'alice@x.test', 'Alice', 'active', 0, {when}, 0, 0)"
        )
        db.exec_driver_sql(
            "INSERT INTO assistant_requests (id, user_id, at, model, input_tokens, cache_write_tokens, "
            f"cache_read_tokens, output_tokens, cost) VALUES (1, 1, {when}, 'claude-sonnet-5-5', 1000, 50000, 0, 500, "
            "207000)"
        )

    migrate(engine)
    with engine.begin() as db:
        db.exec_driver_sql(
            "INSERT INTO assistant_requests (id, user_id, at, model, input_tokens, cache_write_tokens, "
            f"cache_read_tokens, output_tokens, cost) VALUES (2, NULL, {when}, 'claude-sonnet-5-5', 10, 0, 75000, 0, "
            "7520)"
        )
    with engine.connect() as db:
        assert db.exec_driver_sql(
            "SELECT u.email, r.cost FROM assistant_requests r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.id"
        ).all() == [("alice@x.test", 207000), (None, 7520)]


def test_upgrades_say_which_models_were_made_in_solidworks(tmp_path):
    """Caliper says where each model came from: the ones Vault for SolidWorks made are known by their reader (0); the
    server's from before it noted how stay unsaid, and Caliper calls them read from the file."""
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}")
    migrate(engine, "0030")
    when = "'2026-11-01 12:00:00.000000'"
    with engine.begin() as db:
        db.exec_driver_sql(
            "INSERT INTO users (id, email, name, status, is_admin, created_at, site_seconds, solidworks_seconds) "
            f"VALUES (1, 'chief@x.test', 'Chief', 'active', 1, {when}, 0, 0)"
        )
        db.exec_driver_sql(
            f"INSERT INTO folders (id, parent_id, name, name_key, created_at, change_seq) VALUES (1, NULL, '', '', {when}, 0)"
        )
        db.exec_driver_sql(
            "INSERT INTO files (id, folder_id, name, name_key, latest_version, created_at, created_by, change_seq) "
            f"VALUES (1, 1, 'Fin.SLDPRT', 'fin.sldprt', 1, {when}, 1, 1)"
        )
        db.exec_driver_sql(
            f"INSERT INTO checkins (id, user_id, host, comment, created_at) VALUES (1, 1, 'PC', '', {when})"
        )
        db.exec_driver_sql(f"INSERT INTO blobs (sha256, size, created_at) VALUES ('{'a' * 64}', 3, {when})")
        db.exec_driver_sql(
            "INSERT INTO versions (id, file_id, number, checkin_id, blob_sha256, size, created_at, created_by) "
            f"VALUES (1, 1, 1, 1, '{'a' * 64}', 3, {when}, 1)"
        )
        db.exec_driver_sql(
            "INSERT INTO caliper_models (id, version_id, configuration, units, mesh_sha256, created_at, created_by, "
            f"reader) VALUES (1, 1, 'Default', 'mm', '{'a' * 64}', {when}, 1, 0), "
            f"(2, 1, 'Long', 'mm', '{'a' * 64}', {when}, 1, 3), (3, 1, 'Short', 'mm', '{'a' * 64}', {when}, 1, NULL)"
        )

    migrate(engine)
    with engine.connect() as db:
        assert db.exec_driver_sql("SELECT configuration, source FROM caliper_models ORDER BY id").all() == [
            ("Default", "solidworks"),
            ("Long", None),
            ("Short", None),
        ]


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
