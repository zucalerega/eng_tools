"""How full the server's disk is, how much of it Vault's files, Yorg's, and the database take, and whether its data is
copied off it: for admins."""

import json


def test_admins_see_how_much_of_the_disk_vault_yorg_and_the_database_take(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    before = team.client.get("/api/storage", headers=chief).json()

    # A version in Vault is its file's bytes; a dataset in Yorg is its upload and the arrays read from it.
    team.checkin(chief, {"Fin.SLDPRT": b"x" * 5000})
    csv = b"time,pressure\n" + b"".join(b"%d,%d\n" % (i, i * 2) for i in range(1000))
    response = team.client.post("/api/yorg/datasets", params={"filename": "run.csv"}, content=csv, headers=alice)
    assert response.status_code == 201, response.text

    after = team.client.get("/api/storage", headers=chief).json()
    assert after["vault"] - before["vault"] == 5000
    assert after["yorg"] - before["yorg"] > len(csv)
    assert after["database"] > 0
    assert 0 < after["free"] < after["total"]
    assert after["total"] - after["free"] >= after["vault"] + after["yorg"] + after["database"]

    # It's the server's business: members don't see it.
    refused = team.client.get("/api/storage", headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")


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
