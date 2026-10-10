"""The trash: files and whole folders deleted, and brought back as they were."""

import hashlib
import struct

from yjsp_server.models import UserStatus


def delete(client, who, *, files=(), folders=(), force=False):
    body = {"files": list(files), "folders": list(folders), "force": force}
    return client.post("/api/delete", json=body, headers=who)


def restore_folder(client, who, folder_id):
    return client.post(f"/api/folders/{folder_id}/restore", headers=who)


def test_a_folder_goes_to_the_trash_with_everything_in_it(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Motor/Grain.SLDPRT": b"grain", "Motor/Nozzle/Throat.SLDPRT": b"throat", "Keep.STEP": b"keep"})
    before = client.get("/api/sync", headers=chief).json()

    deleted = delete(client, chief, folders=["Motor"])
    assert deleted.status_code == 200, deleted.text
    assert [f["path"] for f in deleted.json()["folders"]] == ["Motor"]
    assert team.listing(chief)["folders"] == []
    # Every client syncs everything again, and drops what isn't there anymore.
    after = client.get("/api/sync", params={"since": before["seq"]}, headers=chief).json()
    assert after["full"] is True
    assert (after["folders"], [f["path"] for f in after["files"]]) == ([], ["Keep.STEP"])
    trash = team.listing(chief, deleted=True)
    assert [(f["name"], f["deleted_by"]["email"]) for f in trash["folders"]] == [("Motor", "chief@x.test")]
    event = client.get("/api/activity", headers=chief).json()[0]
    assert (event["action"], event["detail"]) == ("delete_folder", {"path": "Motor", "files": 2})

    # Its name is free for a new folder; the deleted one comes back once that's out of the way, with all it had.
    team.checkin(chief, {"Motor/Case.SLDPRT": b"case"})
    motor = trash["folders"][0]["id"]
    assert restore_folder(client, chief, motor).json()["error"] == "exists"
    delete(client, chief, folders=["Motor"])
    restored = restore_folder(client, chief, motor)
    assert (restored.status_code, restored.json()["deleted_at"]) == (200, None)
    assert [f["name"] for f in team.listing(chief, "Motor")["files"]] == ["Grain.SLDPRT"]
    assert [f["name"] for f in team.listing(chief, "Motor/Nozzle")["files"]] == ["Throat.SLDPRT"]
    assert [f["name"] for f in team.listing(chief, deleted=True)["folders"]] == ["Motor"]  # the newer one
    assert client.get("/api/activity", headers=chief).json()[0]["action"] == "restore_folder"


def test_a_restored_folder_leaves_what_was_deleted_from_it_before(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Recovery/Chute.SLDPRT": b"chute", "Recovery/Old Chute.SLDPRT": b"old"})
    delete(client, chief, files=["Recovery/Old Chute.SLDPRT"])
    delete(client, chief, folders=["Recovery"])
    before = client.get("/api/sync", headers=chief).json()

    recovery = team.listing(chief, deleted=True)["folders"][0]["id"]
    assert restore_folder(client, chief, recovery).status_code == 200
    assert [f["name"] for f in team.listing(chief, "Recovery")["files"]] == ["Chute.SLDPRT"]
    assert [f["name"] for f in team.listing(chief, "Recovery", deleted=True)["files"]] == ["Old Chute.SLDPRT"]
    # Clients hear about it as a change like any other.
    after = client.get("/api/sync", params={"since": before["seq"]}, headers=chief).json()
    assert after["full"] is False
    assert ([f["path"] for f in after["folders"]], [f["path"] for f in after["files"]]) == (
        ["Recovery"],
        ["Recovery/Chute.SLDPRT"],
    )


def test_restoring_a_file_brings_its_folder_back(team, client):
    chief = team.member("chief@x.test", admin=True)
    files = team.checkin(chief, {"Motor/Grain.SLDPRT": b"grain", "Motor/Case.SLDPRT": b"case"}).json()["files"]
    grain = next(f["file"]["id"] for f in files if f["file"]["name"] == "Grain.SLDPRT")
    delete(client, chief, folders=["Motor"])

    restored = client.post(f"/api/files/{grain}/restore", headers=chief)
    assert (restored.status_code, restored.json()["path"]) == (200, "Motor/Grain.SLDPRT")
    assert [f["name"] for f in team.listing(chief, "Motor")["files"]] == ["Grain.SLDPRT"]  # just it
    assert team.listing(chief, deleted=True)["folders"] == []


def test_a_folder_keeps_what_files_elsewhere_use_and_what_someone_has_checked_out(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.grant(chief, "", None, "editor")
    team.checkin(
        chief, {"Parts/Fin.SLDPRT": b"fin", "Rocket.SLDASM": b"rocket"}, refs={"Rocket.SLDASM": ["Parts/Fin.SLDPRT"]}
    )
    in_use = delete(client, chief, folders=["Parts"])
    assert (in_use.status_code, in_use.json()["error"]) == (409, "in_use")
    assert in_use.json()["details"]["used_by"] == [{"path": "Parts/Fin.SLDPRT", "used_by": "Rocket.SLDASM"}]

    team.checkout(alice, "Parts/Fin.SLDPRT", host="ALICE-PC")
    taken = delete(client, chief, folders=["Parts"], force=True)
    assert (taken.status_code, taken.json()["error"]) == (409, "checked_out")
    team.undo(alice, "Parts/Fin.SLDPRT")
    assert delete(client, chief, folders=["Parts"], force=True).status_code == 200
    assert delete(client, chief, folders=[""]).json()["error"] == "bad_delete"  # not the whole vault


def test_deleting_a_folder_takes_a_lead_of_it(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.checkin(chief, {"Avionics/Board.STEP": b"board"})
    team.grant(chief, "Avionics", "alice@x.test", "editor")
    assert delete(client, alice, folders=["Avionics"]).status_code == 403
    assert delete(client, alice, files=["Avionics/Board.STEP"]).status_code == 200  # files take an editor
    team.grant(chief, "Avionics", "alice@x.test", "lead")
    assert delete(client, alice, folders=["Avionics"]).status_code == 200
    avionics = team.listing(chief, deleted=True)["folders"][0]["id"]
    # Alice's lead went into the trash with the folder, and comes back with it.
    assert restore_folder(client, alice, avionics).status_code == 200
    assert team.listing(alice, "Avionics")["folder"]["role"] == "lead"


def test_members_download_the_software(settings, tmp_path, team, client):
    downloads = tmp_path / "downloads"
    downloads.mkdir()
    (downloads / "Vault-Setup.exe").write_bytes(b"MZ installer")
    (downloads / ".notes").write_text("not for download")
    settings.downloads_dir = downloads
    chief = team.member("chief@x.test", admin=True)

    assert [(d["name"], d["size"]) for d in client.get("/api/downloads", headers=chief).json()] == [
        ("Vault-Setup.exe", 12)
    ]
    got = client.get("/api/downloads/Vault-Setup.exe", headers=chief)
    assert got.content == b"MZ installer" and "attachment" in got.headers["content-disposition"]
    assert client.get("/api/downloads/.notes", headers=chief).status_code == 404
    waiting = team.member("new@x.test", status=UserStatus.PENDING)
    assert client.get("/api/downloads", headers=waiting).status_code == 403
    assert client.get("/api/downloads/Vault-Setup.exe").status_code == 401


def program(version: tuple[int, int, int], carrying: bytes = b"") -> bytes:
    """A stand-in Windows program with a version resource (VS_VERSIONINFO), after anything it carries inside it."""
    major, minor, build = version
    fixed = struct.pack("<IIII", 0xFEEF04BD, 0x10000, (major << 16) | minor, build << 16)
    return b"MZ" + carrying + b"\0" * 64 + "VS_VERSION_INFO".encode("utf-16-le") + b"\0\0" + fixed + b"\0" * 36


def test_downloads_say_their_hash_and_programs_their_version(settings, tmp_path, team, client):
    # The add-in compares the installer's version with its own to offer an update, and checks the installer's hash
    # before running it.
    downloads = tmp_path / "downloads"
    downloads.mkdir()
    old = program((0, 4, 0))
    setup = program((0, 5, 1), carrying=old)  # as Vault-Setup.exe carries the add-in: its own version comes last
    (downloads / "Vault-Setup.exe").write_bytes(setup)
    (downloads / "vault.exe").write_bytes(b"MZ without a version")
    (downloads / "README.txt").write_bytes(program((9, 9, 9)))  # not a program, whatever it holds
    settings.downloads_dir = downloads
    chief = team.member("chief@x.test", admin=True)

    listed = {d["name"]: d for d in client.get("/api/downloads", headers=chief).json()}
    assert {name: d["version"] for name, d in listed.items()} == {
        "README.txt": None,
        "Vault-Setup.exe": "0.5.1",
        "vault.exe": None,
    }
    assert listed["Vault-Setup.exe"]["sha256"] == hashlib.sha256(setup).hexdigest()

    # A new installer in its place says so at once.
    newer = program((0, 6, 0))
    (downloads / "Vault-Setup.exe").write_bytes(newer)
    listed = {d["name"]: d for d in client.get("/api/downloads", headers=chief).json()}
    assert (listed["Vault-Setup.exe"]["version"], listed["Vault-Setup.exe"]["sha256"]) == (
        "0.6.0",
        hashlib.sha256(newer).hexdigest(),
    )
