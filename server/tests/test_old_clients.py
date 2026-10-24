"""Admins can have the vault take changes only from Vault clients at least as new as a version they set (Admin > People,
clients.refuse_old). Older add-ins and CLIs can still read it, and are told how to update; browsers aren't Vault
clients. Unset, as it starts, it changes nothing."""

import hashlib

from .test_add_in import signed_in_with
from .test_trash import program

OLD = {"User-Agent": "vault-client/0.5.2.0"}  # as the add-in and the CLI say their version (VaultApi.cs)


def offering(settings, tmp_path, version: tuple[int, int, int] = (0, 5, 4)) -> None:
    """The server offers the add-in's installer at that version, as once a release's downloads are on it."""
    settings.downloads_dir = tmp_path / "downloads"
    settings.downloads_dir.mkdir(exist_ok=True)
    (settings.downloads_dir / "Vault-Setup.exe").write_bytes(program(version))


def take_changes_from(client, admin: dict[str, str], version: str | None):
    """Set the oldest client that can change the vault, as an admin does in Admin > People."""
    return client.patch("/api/settings", json={"min_client_version": version}, headers=admin)


def editors(app, team, email: str, client_name: str) -> tuple[dict[str, str], dict[str, str]]:
    """An admin, and someone who can edit everywhere, signed in with a client named as the add-in or the CLI names
    itself."""
    chief = team.member("chief@x.test", admin=True)
    team.member(email)
    team.grant(chief, "", None, "editor")
    return chief, signed_in_with(app, team, email, client_name)


def files(team, who: dict[str, str], folder: str) -> dict[str, dict]:
    return {f["name"]: f for f in team.listing(who, folder)["files"]}


def test_until_admins_set_an_oldest_client_any_client_changes_the_vault(app, client, team):
    chief, alice = editors(app, team, "alice@x.test", "SolidWorks add-in on ALICE-PC")
    assert client.get("/api/settings", headers=chief).json()["min_client_version"] is None
    ancient = alice | {"User-Agent": "vault-client/0.1.0.0"}
    assert team.checkin(ancient, {"Engine/Injector.SLDPRT": b"v1"}).status_code == 200
    assert team.checkout(ancient, "Engine/Injector.SLDPRT").status_code == 200
    assert team.undo(ancient, "Engine/Injector.SLDPRT").status_code == 200


def test_an_add_in_older_than_admins_set_cant_change_the_vault(app, settings, client, team, tmp_path):
    offering(settings, tmp_path)
    chief, alice = editors(app, team, "alice@x.test", "SolidWorks add-in on ALICE-PC")
    team.checkin(alice, {"Engine/Injector.SLDPRT": b"injector v1"})
    team.checkin(alice, {"Engine/Valve.SLDPRT": b"valve v1"}, keep=True)  # checked out to her, on PC-1
    injector = files(team, alice, "Engine")["Injector.SLDPRT"]
    setting = take_changes_from(client, chief, "0.5.4")
    assert (setting.status_code, setting.json()["min_client_version"]) == (200, "0.5.4")

    old = alice | OLD
    valve_v2 = team.upload(alice, b"valve v2")  # by a newer client: uploading is a change too, below
    valve_v3 = hashlib.sha256(b"valve v3").hexdigest()
    checkin = {
        "comment": "lighter",
        "host": "PC-1",
        "items": [{"path": "Engine/Valve.SLDPRT", "sha256": valve_v2, "size": 8, "references": []}],
    }
    refused = {
        "check in": client.post("/api/checkin", json=checkin, headers=old),
        "upload": client.put(f"/api/blobs/{valve_v3}", content=b"valve v3", headers=old),
        "check out": team.checkout(old, "Engine/Injector.SLDPRT"),  # and Keep mine, which checks the file out
        "take over": team.checkout(old, "Engine/Valve.SLDPRT", host="LAB-PC", force=True),
        "undo": team.undo(old, "Engine/Valve.SLDPRT"),
        "revert": client.post(f"/api/files/{injector['id']}/revert", json={"version": 1}, headers=old),
        "delete": client.post("/api/delete", json={"files": ["Engine/Injector.SLDPRT"]}, headers=old),
        "restore": client.post(f"/api/files/{injector['id']}/restore", headers=old),
        "move": client.post("/api/move", json={"files": ["Engine/Injector.SLDPRT"], "to": "Old"}, headers=old),
        "rename": client.post(
            "/api/rename", json={"file": "Engine/Injector.SLDPRT", "name": "Inj.SLDPRT"}, headers=old
        ),
        "new folder": client.post("/api/folders", json={"path": "Engine/Tests"}, headers=old),
        "access": client.put("/api/grants", json={"path": "Engine", "user_id": None, "role": "viewer"}, headers=old),
        "3D model": client.put(
            f"/api/files/{injector['id']}/caliper",
            json={"version": 1, "configuration": "Default", "units": "mm", "mesh": valve_v2},
            headers=old,
        ),
    }
    for what, response in refused.items():
        assert (response.status_code, response.json()["error"]) == (426, "client_too_old"), what
    told = refused["check in"].json()
    assert told["message"] == (
        "Vault for SolidWorks 0.5.2 is too old to make changes in this vault, which takes 0.5.4 and newer. Click Update "
        "at the top of the Vault tab, then close SolidWorks; or download Vault-Setup.exe from the web app's SolidWorks "
        "page."
    )
    assert told["details"] == {"version": "0.5.2", "min_client_version": "0.5.4"}

    # Nothing changed: no versions, check-outs, folders, or models.
    after = files(team, alice, "Engine")
    assert (after["Injector.SLDPRT"]["version"], after["Injector.SLDPRT"]["checked_out"]) == (1, None)
    assert (after["Valve.SLDPRT"]["version"], after["Valve.SLDPRT"]["checked_out"]["host"]) == (1, "PC-1")
    assert [f["name"] for f in team.listing(alice, "")["folders"]] == ["Engine"]
    assert team.listing(alice, "Engine")["folders"] == []
    assert client.head(f"/api/blobs/{valve_v3}", headers=alice).status_code == 404
    assert client.get(f"/api/files/{injector['id']}/caliper", headers=alice).json() == {"models": []}


def test_old_clients_still_read_the_vault_and_update_themselves(app, settings, client, team, tmp_path):
    offering(settings, tmp_path)
    chief, alice = editors(app, team, "alice@x.test", "SolidWorks add-in on ALICE-PC")
    team.checkin(alice, {"Engine/Injector.SLDPRT": b"injector"})
    injector = files(team, alice, "Engine")["Injector.SLDPRT"]
    take_changes_from(client, chief, "0.5.4")

    old = alice | OLD
    for path in (
        "/api/me",
        "/api/folders?path=Engine",
        "/api/sync",
        f"/api/files/{injector['id']}",
        f"/api/files/{injector['id']}/content",
        f"/api/files/{injector['id']}/caliper",
        "/api/checkouts",
        "/api/activity",
        "/api/downloads",
        "/api/downloads/Vault-Setup.exe",  # its Update
    ):
        assert client.get(path, headers=old).status_code == 200, path
    assert client.head(f"/api/blobs/{hashlib.sha256(b'injector').hexdigest()}", headers=old).status_code == 200
    wanted = {"models": [{"file_id": injector["id"], "version": 1, "configuration": "Default"}]}
    assert client.post("/api/caliper/missing", json=wanted, headers=old).status_code == 200  # what it would make


def test_clients_as_new_as_admins_set_and_browsers_still_change_the_vault(app, settings, client, team, tmp_path):
    offering(settings, tmp_path)
    chief, alice = editors(app, team, "alice@x.test", "SolidWorks add-in on ALICE-PC")
    team.checkin(alice, {"Engine/Injector.SLDPRT": b"v1"})
    take_changes_from(client, chief, "0.5.4")

    # The oldest it takes, written as clients send it, and newer ones.
    for version in ("0.5.4.0", "0.5.4.1", "0.6.0.0", "1.0.0.0"):
        current = alice | {"User-Agent": f"vault-client/{version}"}
        assert team.checkout(current, "Engine/Injector.SLDPRT").status_code == 200, version
        assert team.undo(current, "Engine/Injector.SLDPRT").status_code == 200, version
    # Requests that don't say a Vault client's version: a script's, or these tests' own (TestClient's User-Agent).
    for agent in ({"User-Agent": "vault-client/"}, {"User-Agent": "python-httpx/0.28"}, {}):
        assert team.checkout(alice | agent, "Engine/Injector.SLDPRT").status_code == 200, agent
        assert team.undo(alice | agent, "Engine/Injector.SLDPRT").status_code == 200, agent

    # The web app, signed in with its session cookie, from a browser, which says it's no Vault client.
    client.get("/auth/dev-login", params={"email": "alice@x.test"}, follow_redirects=False)
    browser = {"X-YJSP-Request": "1", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    web = client.post("/api/checkout", json={"files": ["Engine/Injector.SLDPRT"], "host": "web"}, headers=browser)
    assert (web.status_code, web.json()["files"][0]["checked_out"]["host"]) == (200, "web")


def test_an_old_vault_command_is_told_to_get_the_new_vault_exe(app, settings, client, team, tmp_path):
    offering(settings, tmp_path)
    chief, bob = editors(app, team, "bob@x.test", "vault CLI on BOB-PC")
    team.checkin(bob, {"Engine/Injector.SLDPRT": b"v1"})
    take_changes_from(client, chief, "0.5.4")
    refused = team.checkout(bob | OLD, "Engine/Injector.SLDPRT")
    assert (refused.status_code, refused.json()["message"]) == (
        426,
        "This vault command (0.5.2) is too old to make changes in this vault, which takes 0.5.4 and newer. Download "
        "the new vault.exe from the web app's SolidWorks page.",
    )


def test_add_ins_without_update_and_cvcs_clients_are_told_to_run_setup(app, settings, client, team, tmp_path):
    offering(settings, tmp_path)
    chief, alice = editors(app, team, "alice@x.test", "SolidWorks add-in on ALICE-PC")
    team.member("bob@x.test")
    bob = signed_in_with(app, team, "bob@x.test", "cvc CLI on BOB-PC")
    team.checkin(alice, {"Engine/Injector.SLDPRT": b"v1"})
    take_changes_from(client, chief, "0.5.4")

    # Update came in 0.5.0. CVC's add-in, from before 0.4.0, said its version as CVC's, under the same sign-in name.
    run_setup = (
        "is too old to make changes in this vault, which takes 0.5.4 and newer. Download Vault-Setup.exe from the web "
        "app's SolidWorks page, then close SolidWorks and run it."
    )
    for agent, version in (("vault-client/0.4.0.0", "0.4.0"), ("cvc-client/0.3.0.0", "0.3.0")):
        refused = team.checkout(alice | {"User-Agent": agent}, "Engine/Injector.SLDPRT")
        assert (refused.status_code, refused.json()["message"]) == (426, f"Vault for SolidWorks {version} {run_setup}")
    cvc_cli = team.checkout(bob | {"User-Agent": "cvc-client/0.3.0.0"}, "Engine/Injector.SLDPRT")
    assert (cvc_cli.status_code, cvc_cli.json()["message"]) == (
        426,
        "This vault command (0.3.0) is too old to make changes in this vault, which takes 0.5.4 and newer. Download "
        "the new vault.exe from the web app's SolidWorks page.",
    )


def test_only_admins_set_the_oldest_client_and_only_to_one_add_ins_can_update_to(settings, client, team, tmp_path):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    refused = take_changes_from(client, alice, "0.5.4")
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
    # With no installer on the server, no add-in could update to any: refused, rather than lock the team out.
    nothing = take_changes_from(client, chief, "0.5.4")
    assert (nothing.status_code, nothing.json()["error"]) == (409, "no_installer")

    offering(settings, tmp_path)
    for typed, status, error in (
        ("0.5.5", 409, "not_offered"),  # newer than the installer offered: put its downloads on the server first
        ("0.6", 409, "not_offered"),
        ("soon", 400, "bad_version"),
        ("0.5.4-beta", 400, "bad_version"),
    ):
        response = take_changes_from(client, chief, typed)
        assert (response.status_code, response.json()["error"]) == (status, error), typed
    assert client.get("/api/settings", headers=chief).json()["min_client_version"] is None  # none of those took

    assert take_changes_from(client, chief, "v0.5.4").json()["min_client_version"] == "0.5.4"  # as a release's tag
    assert take_changes_from(client, chief, " 0.5.2 ").json()["min_client_version"] == "0.5.2"  # older than offered
    # The whitelist changes on its own, and leaves it.
    assert client.patch("/api/settings", json={"whitelist": True}, headers=chief).json() == {
        "whitelist": True,
        "min_client_version": "0.5.2",
    }
    assert take_changes_from(client, chief, None).json()["min_client_version"] is None  # any client again
    assert take_changes_from(client, chief, "0.5.4").json()["min_client_version"] == "0.5.4"
    assert take_changes_from(client, chief, "").json()["min_client_version"] is None

    # Each change is in the activity log, which only admins see.
    changes = [
        e["detail"] for e in client.get("/api/activity", headers=chief).json() if e["action"] == "update_settings"
    ]
    assert changes == [
        {"min_client_version": None},
        {"min_client_version": "0.5.4"},
        {"min_client_version": None},
        {"whitelist": True},
        {"min_client_version": "0.5.2"},
        {"min_client_version": "0.5.4"},
    ]
