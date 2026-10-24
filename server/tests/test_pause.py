"""An admin's pause (docs/vault.md, "Pausing the vault"): changes wait, but the admin's own, from the computer they
paused it on; everyone can still look, and undo their check-outs."""


def test_while_the_vault_is_paused_changes_wait_but_the_admins(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    client.post("/api/folders", json={"path": "Fins"}, headers=chief)
    team.grant(chief, "Fins", "alice@x.test", "editor")
    assert team.checkin(alice, {"Fins/Fin.SLDPRT": b"fin"}).status_code == 200
    assert team.checkout(alice, "Fins/Fin.SLDPRT").status_code == 200

    body = {"host": "RENUMBER-PC", "reason": "numbering every file"}
    assert client.put("/api/vault/pause", json=body, headers=chief).status_code == 200
    pause = client.get("/api/sync", headers=alice).json()["paused"]
    assert (pause["by"]["name"], pause["host"], pause["reason"]) == ("Chief", "RENUMBER-PC", "numbering every file")

    refused = team.checkin(alice, {"Fins/Fin.SLDPRT": b"fin v2"})
    assert (refused.status_code, refused.json()["error"]) == (409, "paused")
    assert "numbering every file" in refused.json()["message"]
    for response in (
        client.post("/api/rename", json={"file": "Fins/Fin.SLDPRT", "name": "Fin2.SLDPRT"}, headers=alice),
        client.post("/api/folders", json={"path": "Fins/New"}, headers=alice),
        client.post(
            "/api/files/metadata", json={"files": [{"file": "Fins/Fin.SLDPRT", "title": "Fin"}]}, headers=alice
        ),
        team.checkout(chief, "Fins/Fin.SLDPRT", host="CHIEF-LAPTOP", force=True),  # the admin, on another computer
    ):
        assert (response.status_code, response.json()["error"]) == (409, "paused")
    # Looking, and undoing your own check-out, go on.
    assert client.get("/api/folders", params={"path": "Fins"}, headers=alice).status_code == 200
    assert team.undo(alice, "Fins/Fin.SLDPRT").status_code == 200
    # The admin's changes, from the computer they paused it on, go on.
    assert team.checkout(chief, "Fins/Fin.SLDPRT", host="RENUMBER-PC").status_code == 200
    assert team.checkin(chief, {"Fins/Fin.SLDPRT": b"fin v2"}, host="RENUMBER-PC").status_code == 200

    assert client.delete("/api/vault/pause", headers=chief).status_code == 204
    assert client.get("/api/sync", headers=alice).json()["paused"] is None
    assert team.checkout(alice, "Fins/Fin.SLDPRT").status_code == 200


def test_only_admins_pause_the_vault(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    assert client.put("/api/vault/pause", json={"host": "ALICE-PC"}, headers=alice).status_code == 403
    assert client.get("/api/vault/pause", headers=alice).json() is None
    assert client.put("/api/vault/pause", json={"host": "CHIEF-PC"}, headers=chief).status_code == 200
    assert client.delete("/api/vault/pause", headers=alice).status_code == 403
    assert client.get("/api/vault/pause", headers=alice).json()["by"]["name"] == "Chief"
