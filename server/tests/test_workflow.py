"""Check-in/check-out, history, references, trash, uploads, and the sync feed."""

import hashlib


def test_add_check_out_check_in_and_history(team, client):
    chief = team.member("chief@x.test", admin=True)

    added = team.checkin(chief, {"Structures/Fins/Fin.SLDPRT": b"fin v1"}, comment="first fin")
    assert added.status_code == 200, added.text
    [entry] = added.json()["files"]
    assert entry["status"] == "created"
    fin = entry["file"]
    assert (fin["path"], fin["version"], fin["checked_out"]) == ("Structures/Fins/Fin.SLDPRT", 1, None)

    refused = team.checkin(chief, {"Structures/Fins/Fin.SLDPRT": b"fin v2"})
    assert refused.status_code == 409
    assert refused.json()["error"] == "not_checked_out"

    out = team.checkout(chief, "structures/fins/FIN.sldprt")  # paths are case-insensitive
    assert out.status_code == 200, out.text
    assert out.json()["files"][0]["checked_out"]["host"] == "PC-1"

    updated = team.checkin(chief, {"Structures/Fins/Fin.SLDPRT": b"fin v2"}, comment="thicker root")
    [entry] = updated.json()["files"]
    assert (entry["status"], entry["file"]["version"], entry["file"]["checked_out"]) == ("updated", 2, None)

    detail = client.get(f"/api/files/{fin['id']}", headers=chief).json()
    assert [(v["number"], v["comment"]) for v in detail["versions"]] == [(2, "thicker root"), (1, "first fin")]
    assert client.get(f"/api/files/{fin['id']}/content", headers=chief).content == b"fin v2"
    old = client.get(f"/api/files/{fin['id']}/content", params={"version": 1}, headers=chief)
    assert old.content == b"fin v1"
    assert old.headers["x-cvc-version"] == "1"
    assert "Fin.SLDPRT" in old.headers["content-disposition"]


def test_one_editor_at_a_time(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    team.grant(chief, "", None, "editor")  # everyone may edit everything
    team.checkin(alice, {"Nosecone.SLDPRT": b"v1"})

    assert team.checkout(alice, "Nosecone.SLDPRT", host="ALICE-PC").status_code == 200
    taken = team.checkout(bob, "Nosecone.SLDPRT", host="BOB-PC")
    assert taken.status_code == 409
    lock = taken.json()["details"]["files"][0]
    assert (lock["user"], lock["host"]) == ("Alice", "ALICE-PC")

    assert team.checkout(alice, "Nosecone.SLDPRT", host="ALICE-PC").status_code == 200  # already hers: fine
    assert team.checkout(alice, "Nosecone.SLDPRT", host="LAB-PC").status_code == 409  # hers, but elsewhere
    elsewhere = team.checkin(alice, {"Nosecone.SLDPRT": b"v2"}, host="LAB-PC")
    assert elsewhere.json()["error"] == "checked_out_elsewhere"

    assert team.undo(bob, "Nosecone.SLDPRT").status_code == 403  # editors can't break locks
    team.grant(chief, "", "bob@x.test", "lead")
    broken = team.undo(bob, "Nosecone.SLDPRT")
    assert broken.status_code == 200
    assert broken.json()["files"][0]["checked_out"] is None
    events = team.client.get("/api/activity", headers=chief).json()
    assert events[0]["action"] == "break_lock"
    assert events[0]["detail"]["holder"] == "alice@x.test"


def test_activity_shows_what_each_check_in_said(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Fins/Fin.SLDPRT": b"fin", "Fins/Can.SLDASM": b"can"}, comment="first fin can")
    team.checkout(chief, "Fins/Fin.SLDPRT")
    events = client.get("/api/activity", headers=chief).json()
    assert [(e["action"], e["comment"]) for e in events] == [
        ("checkout", None),
        ("add", "first fin can"),
        ("add", "first fin can"),
        ("create_folder", None),
    ]
    assert events[1]["checkin_id"] == events[2]["checkin_id"] is not None


def test_checkout_is_all_or_nothing(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test", admin=True)
    team.checkin(chief, {"A.SLDPRT": b"a", "B.SLDPRT": b"b"})
    team.checkout(chief, "B.SLDPRT", host="CHIEF-PC")
    assert team.checkout(alice, "A.SLDPRT", "B.SLDPRT", host="ALICE-PC").status_code == 409
    assert client.get("/api/checkouts", headers=chief).json()["files"][0]["path"] == "B.SLDPRT"
    assert len(client.get("/api/checkouts", headers=chief).json()["files"]) == 1


def test_unchanged_check_in_releases_without_new_version(team):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Bulkhead.SLDPRT": b"same"})
    team.checkout(chief, "Bulkhead.SLDPRT")
    result = team.checkin(chief, {"Bulkhead.SLDPRT": b"same"}).json()
    assert result["checkin_id"] is None
    assert result["files"][0]["status"] == "unchanged"
    assert result["files"][0]["file"]["version"] == 1
    assert result["files"][0]["file"]["checked_out"] is None


def test_keep_checked_out(team):
    chief = team.member("chief@x.test", admin=True)
    created = team.checkin(chief, {"Motor.SLDASM": b"v1"}, keep=True).json()["files"][0]["file"]
    assert created["checked_out"]["user"]["email"] == "chief@x.test"
    again = team.checkin(chief, {"Motor.SLDASM": b"v2"}, keep=True).json()["files"][0]["file"]
    assert (again["version"], again["checked_out"] is not None) == (2, True)


def test_assembly_checked_in_with_its_parts(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Library/Bolt M5.STEP": b"bolt"})
    result = team.checkin(
        chief,
        {"Fins/Fin Can.SLDASM": b"asm v1", "Fins/Fin.SLDPRT": b"fin v1"},
        comment="fin can",
        refs={"Fins/Fin Can.SLDASM": ["Fins/Fin.SLDPRT", "library/bolt m5.step"]},
    ).json()
    assert result["checkin_id"] is not None
    assembly = next(f["file"] for f in result["files"] if f["file"]["name"] == "Fin Can.SLDASM")

    detail = client.get(f"/api/files/{assembly['id']}", headers=chief).json()
    refs = [(r["path"], r["version"]) for r in detail["versions"][0]["references"]]
    assert refs == [("Fins/Fin.SLDPRT", 1), ("Library/Bolt M5.STEP", 1)]
    assert detail["versions"][0]["checkin_id"] == result["checkin_id"]

    bolt = team.listing(chief, "Library")["files"][0]
    used_by = client.get(f"/api/files/{bolt['id']}", headers=chief).json()["used_by"]
    assert [(u["file"]["path"], u["uses_version"]) for u in used_by] == [("Fins/Fin Can.SLDASM", 1)]


def test_missing_reference_rolls_back_the_whole_check_in(team):
    chief = team.member("chief@x.test", admin=True)
    response = team.checkin(
        chief,
        {"Avionics/Sled.SLDASM": b"sled", "Avionics/Board.STEP": b"board"},
        refs={"Avionics/Sled.SLDASM": ["Avionics/Battery.SLDPRT"]},
    )
    assert response.status_code == 400
    assert response.json()["details"]["missing"] == [
        {"file": "Avionics/Sled.SLDASM", "reference": "Avionics/Battery.SLDPRT"}
    ]
    assert [f["name"] for f in team.listing(chief)["folders"]] == []  # not even the folder was created


def test_delete_protects_parts_in_use_and_restore(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Asm.SLDASM": b"asm", "Part.SLDPRT": b"part"}, refs={"Asm.SLDASM": ["Part.SLDPRT"]})
    part = next(f for f in team.listing(chief)["files"] if f["name"] == "Part.SLDPRT")

    in_use = client.post("/api/delete", json={"files": ["Part.SLDPRT"]}, headers=chief)
    assert in_use.status_code == 409
    assert in_use.json()["details"]["used_by"] == [{"path": "Part.SLDPRT", "used_by": "Asm.SLDASM"}]
    both = client.post("/api/delete", json={"files": ["Part.SLDPRT", "Asm.SLDASM"]}, headers=chief)
    assert both.status_code == 200  # deleting the assembly too is fine

    assert team.listing(chief)["files"] == []
    assert {f["name"] for f in team.listing(chief, deleted=True)["files"]} == {"Asm.SLDASM", "Part.SLDPRT"}
    assert team.checkout(chief, part["id"]).status_code == 404

    restored = client.post(f"/api/files/{part['id']}/restore", headers=chief)
    assert restored.status_code == 200
    assert restored.json()["deleted_at"] is None
    assert [f["name"] for f in team.listing(chief)["files"]] == ["Part.SLDPRT"]


def test_a_deleted_name_can_be_reused_and_restore_then_conflicts(team, client):
    chief = team.member("chief@x.test", admin=True)
    old = team.checkin(chief, {"Ring.SLDPRT": b"old"}).json()["files"][0]["file"]
    client.post("/api/delete", json={"files": [old["id"]]}, headers=chief)
    new = team.checkin(chief, {"Ring.SLDPRT": b"new"}).json()["files"][0]
    assert new["status"] == "created" and new["file"]["id"] != old["id"]
    assert client.post(f"/api/files/{old['id']}/restore", headers=chief).status_code == 409


def test_uploads_are_verified(team, client):
    chief = team.member("chief@x.test", admin=True)
    data = b"solidworks bytes"
    sha = hashlib.sha256(data).hexdigest()
    assert client.head(f"/api/blobs/{sha}", headers=chief).status_code == 404
    wrong = client.put(f"/api/blobs/{'0' * 64}", content=data, headers=chief)
    assert (wrong.status_code, wrong.json()["error"]) == (400, "hash_mismatch")
    assert client.put(f"/api/blobs/{sha}", content=data, headers=chief).status_code == 201
    assert client.put(f"/api/blobs/{sha}", content=data, headers=chief).json()["stored"] is False
    head = client.head(f"/api/blobs/{sha}", headers=chief)
    assert (head.status_code, head.headers["x-cvc-size"]) == (200, str(len(data)))

    body = {"host": "PC-1", "items": [{"path": "X.STEP", "sha256": "1" * 64, "size": 1}]}
    assert client.post("/api/checkin", json=body, headers=chief).json()["error"] == "blob_missing"


def test_bad_names_are_rejected(team):
    chief = team.member("chief@x.test", admin=True)
    response = team.checkin(chief, {"Recovery/Main: 18ft.SLDPRT": b"x"})
    assert (response.status_code, response.json()["error"]) == (400, "bad_path")


def test_a_file_and_folder_cannot_share_a_name(team):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Payload/Camera.STEP": b"cam"})
    assert team.checkin(chief, {"Payload": b"x"}).json()["error"] == "exists"
    assert team.checkin(chief, {"Payload/Camera.STEP/Lens.STEP": b"x"}).json()["error"] == "exists"


def test_sync_feed(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Old.SLDPRT": b"old"})
    first = client.get("/api/sync", headers=chief).json()
    assert first["full"] is True
    assert [f["path"] for f in first["files"]] == ["Old.SLDPRT"]

    team.checkin(chief, {"Engine/Injector.SLDPRT": b"inj"})
    team.checkout(chief, "Old.SLDPRT")
    changes = client.get("/api/sync", params={"since": first["seq"]}, headers=chief).json()
    assert changes["full"] is False
    assert [f["path"] for f in changes["folders"]] == ["Engine"]
    assert {f["path"]: f["checked_out"] is not None for f in changes["files"]} == {
        "Engine/Injector.SLDPRT": False,
        "Old.SLDPRT": True,
    }

    client.post("/api/delete", json={"files": ["Old.SLDPRT"]}, headers=chief)
    deleted = client.get("/api/sync", params={"since": changes["seq"]}, headers=chief).json()
    assert [(f["path"], f["deleted_at"] is not None) for f in deleted["files"]] == [("Old.SLDPRT", True)]

    nothing = client.get("/api/sync", params={"since": deleted["seq"]}, headers=chief).json()
    assert (nothing["full"], nothing["files"], nothing["seq"]) == (False, [], deleted["seq"])

    team.member("new@x.test")
    team.grant(chief, "Engine", "new@x.test", "viewer")
    assert client.get("/api/sync", params={"since": nothing["seq"]}, headers=chief).json()["full"] is True
