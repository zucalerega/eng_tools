"""How full the server's disk is, how much of it Vault's files, Yorg's, Piper's, and the database take, and whether its
data is copied off it: for admins; and in short, for everyone's home page."""

import json

from yjsp_server import disk


def test_admins_see_how_much_of_the_disk_vault_yorg_piper_and_the_database_take(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    before = team.client.get("/api/storage", headers=chief).json()

    # A version in Vault is its file's bytes; a dataset in Yorg is its upload and the arrays read from it; a diagram in
    # Piper is its drawing, in the database.
    team.checkin(chief, {"Fin.SLDPRT": b"x" * 5000})
    csv = b"time,pressure\n" + b"".join(b"%d,%d\n" % (i, i * 2) for i in range(1000))
    response = team.client.post("/api/yorg/datasets", params={"filename": "run.csv"}, content=csv, headers=alice)
    assert response.status_code == 201, response.text
    response = team.client.post("/api/piper/diagrams", json={"name": "Feed system"}, headers=alice)
    assert response.status_code == 201, response.text

    after = team.client.get("/api/storage", headers=chief).json()
    assert after["vault"] - before["vault"] == 5000
    assert after["yorg"] - before["yorg"] > len(csv)
    assert after["piper"] > before["piper"]
    assert after["database"] >= after["piper"] > 0
    assert 0 < after["free"] < after["total"]
    assert after["total"] - after["free"] >= after["vault"] + after["yorg"] + after["database"]

    # It's the server's business: members don't see what the database takes, or the backups.
    refused = team.client.get("/api/storage", headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")


def test_everyone_sees_how_much_of_the_disk_each_app_takes_at_most_a_minute_old(team, monkeypatch):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.client.post("/api/piper/diagrams", json={"name": "Feed system"}, headers=alice)
    summary = team.client.get("/api/storage/summary", headers=alice)
    assert summary.status_code == 200, summary.text
    shown = summary.json()
    assert set(shown) == {"total", "free", "vault", "yorg", "piper"}  # not the database's own size, nor the backups
    assert shown["piper"] > 0
    assert 0 < shown["free"] < shown["total"]

    # Measured at most once a minute: the home page asks on every visit, and measuring walks Vault's every file.
    team.checkin(chief, {"Fin.SLDPRT": b"x" * 5000})
    assert team.client.get("/api/storage/summary", headers=alice).json()["vault"] == shown["vault"]
    monkeypatch.setattr(disk, "RECENT", 0.0)
    assert team.client.get("/api/storage/summary", headers=alice).json()["vault"] == shown["vault"] + 5000

    # Signed in, and approved: someone still waiting for an admin sees nothing of the server.
    assert team.client.get("/api/storage/summary").status_code == 401


def test_admins_see_whether_the_data_is_copied_off_the_server(settings, team, tmp_path):
    chief = team.member("chief@x.test", admin=True)
    settings.backup_status = tmp_path / "offsite.json"

    # No report: no off-site backup on this server.
    assert team.client.get("/api/storage", headers=chief).json()["backup"] is None

    # What deploy/yjsp-offsite writes after a good night and a failed weekly check.
    settings.backup_status.write_text(
        json.dumps(
            {
                "backed_up_at": "2026-10-15T09:00:41Z",
                "snapshot": "0a1b2c3d",
                "backup_failed_at": None,
                "backup_error": None,
                "verify_failed_at": "2026-10-12T10:03:00Z",
                "verify_error": "restoring Vault's files: ab/cd/abcd came back different",
            }
        )
    )
    backup = team.client.get("/api/storage", headers=chief).json()["backup"]
    assert backup == {
        "backed_up_at": "2026-10-15T09:00:41Z",
        "snapshot": "0a1b2c3d",
        "backup_failed_at": None,
        "backup_error": None,
        "verified_at": None,
        "verify_failed_at": "2026-10-12T10:03:00Z",
        "verify_error": "restoring Vault's files: ab/cd/abcd came back different",
    }

    # A report it can't read says so, rather than looking like no backup at all.
    settings.backup_status.write_text("{half a report")
    assert "can't be read" in team.client.get("/api/storage", headers=chief).json()["backup"]["backup_error"]
