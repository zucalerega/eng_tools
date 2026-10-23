"""Renames in a check-in (docs/vault.md, "Renaming in a check-in"): a file goes in by its new name, with every file
that uses it, saved with that name, all or nothing; and a dry run finds every problem without changing anything."""

import pytest


@pytest.fixture
def alice(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    client.post("/api/folders", json={"path": "Fins"}, headers=chief)
    team.grant(chief, "Fins", "alice@x.test", "editor")
    return alice


def checkin(team, who, items: dict[str, bytes], *, renames=(), refs=None, dry_run=False):
    """A check-in with renames; refs: each item's references, as the API has them ({"file_id": ...} or {"path": ...})."""
    listed = [
        {"path": path, "sha256": team.upload(who, data), "size": len(data), "references": (refs or {}).get(path, [])}
        for path, data in items.items()
    ]
    body = {"host": "PC-1", "items": listed, "renames": list(renames), "dry_run": dry_run}
    return team.client.post("/api/checkin", json=body, headers=who)


def by_path(response) -> dict[str, dict]:
    assert response.status_code == 200, response.text
    return {entry["file"]["path"]: entry for entry in response.json()["files"]}


def fin_and_can(team, who) -> tuple[dict, dict]:
    """A fin, and the fin can that uses it, both checked out to who on PC-1."""
    files = by_path(
        team.checkin(
            who,
            {"Fins/Fin.SLDPRT": b"fin", "Fins/Fin Can.SLDASM": b"can"},
            refs={"Fins/Fin Can.SLDASM": ["Fins/Fin.SLDPRT"]},
        )
    )
    assert team.checkout(who, "Fins/Fin.SLDPRT", "Fins/Fin Can.SLDASM").status_code == 200
    return files["Fins/Fin.SLDPRT"]["file"], files["Fins/Fin Can.SLDASM"]["file"]


def test_a_part_renamed_goes_in_with_the_assembly_that_uses_it(team, client, alice):
    fin, can = fin_and_can(team, alice)
    before = client.get("/api/sync", headers=alice).json()["seq"]
    result = checkin(
        team,
        alice,
        {"Fins/Fin left.SLDPRT": b"fin", "Fins/Fin Can.SLDASM": b"can v2"},
        renames=[{"file": fin["id"], "name": "Fin left.SLDPRT"}],
        refs={"Fins/Fin Can.SLDASM": [{"file_id": fin["id"]}]},
    )
    files = by_path(result)
    assert {path: (f["status"], f["file"]["version"]) for path, f in files.items()} == {
        "Fins/Fin left.SLDPRT": ("renamed", 1),  # the same contents: no new version
        "Fins/Fin Can.SLDASM": ("updated", 2),
    }
    [uses] = client.get(f"/api/files/{can['id']}", headers=alice).json()["versions"][0]["references"]
    assert (uses["file_id"], uses["path"]) == (fin["id"], "Fins/Fin left.SLDPRT")
    part = client.get(f"/api/files/{fin['id']}", headers=alice).json()["file"]
    assert (part["former_names"], part["checked_out"], part["title"]) == (["Fin.SLDPRT"], None, "Fin")
    # Clients follow it by id, from what changed: no need to sync everything again.
    synced = client.get("/api/sync", params={"since": before}, headers=alice).json()
    assert (synced["full"], sorted(f["path"] for f in synced["files"])) == (
        False,
        ["Fins/Fin Can.SLDASM", "Fins/Fin left.SLDPRT"],
    )
    actions = [e["action"] for e in client.get("/api/activity", headers=alice).json()[:2]]
    assert sorted(actions) == ["checkin", "rename"]


def test_every_file_using_a_renamed_one_goes_in_with_it_saved_anew(team, client, alice):
    fin, can = fin_and_can(team, alice)
    rename = [{"file": fin["id"], "name": "Fin left.SLDPRT"}]
    left = checkin(team, alice, {"Fins/Fin left.SLDPRT": b"fin"}, renames=rename)
    assert (left.status_code, left.json()["error"]) == (409, "in_use")
    assert left.json()["details"]["used_by"] == ["Fins/Fin Can.SLDASM"]
    same = checkin(team, alice, {"Fins/Fin left.SLDPRT": b"fin", "Fins/Fin Can.SLDASM": b"can"}, renames=rename)
    assert (same.status_code, same.json()["error"]) == (409, "in_use")  # still naming it as it was
    alone = checkin(team, alice, {"Fins/Fin Can.SLDASM": b"can v2"}, renames=rename)
    assert (alone.status_code, alone.json()["error"]) == (400, "bad_rename")  # the renamed file goes in too
    assert client.get(f"/api/files/{fin['id']}", headers=alice).json()["file"]["name"] == "Fin.SLDPRT"


def test_a_file_renamed_is_one_checked_out_to_you_here(team, client, alice):
    fin, _ = fin_and_can(team, alice)
    assert team.undo(alice, "Fins/Fin.SLDPRT").status_code == 200
    refused = checkin(
        team, alice, {"Fins/Fin left.SLDPRT": b"fin"}, renames=[{"file": fin["id"], "name": "Fin left.SLDPRT"}]
    )
    assert (refused.status_code, refused.json()["error"]) == (409, "not_checked_out")


def test_names_can_change_places(team, client, alice):
    files = by_path(team.checkin(alice, {"Fins/Port.SLDPRT": b"port", "Fins/Starboard.SLDPRT": b"starboard"}))
    port, starboard = files["Fins/Port.SLDPRT"]["file"], files["Fins/Starboard.SLDPRT"]["file"]
    assert team.checkout(alice, "Fins/Port.SLDPRT", "Fins/Starboard.SLDPRT").status_code == 200
    swapped = checkin(
        team,
        alice,
        {"Fins/Starboard.SLDPRT": b"port", "Fins/Port.SLDPRT": b"starboard"},
        renames=[{"file": port["id"], "name": "Starboard.SLDPRT"}, {"file": starboard["id"], "name": "Port.SLDPRT"}],
    )
    assert {path: f["file"]["id"] for path, f in by_path(swapped).items()} == {
        "Fins/Starboard.SLDPRT": port["id"],
        "Fins/Port.SLDPRT": starboard["id"],
    }


def test_a_part_renamed_by_its_number_takes_it_and_its_drawing_follows(team, client, alice):
    admin = team.member("admin@x.test", admin=True)
    files = by_path(
        team.checkin(
            alice,
            {"Fins/Fin.SLDPRT": b"fin", "Fins/Fin.SLDDRW": b"drawing"},
            refs={"Fins/Fin.SLDDRW": ["Fins/Fin.SLDPRT"]},
        )
    )
    fin, drawing = files["Fins/Fin.SLDPRT"]["file"], files["Fins/Fin.SLDDRW"]["file"]
    [issued] = client.post("/api/numbers", json={"kind": "001"}, headers=admin).json()["numbers"]
    number = issued["number"]
    assert team.checkout(alice, "Fins/Fin.SLDPRT", "Fins/Fin.SLDDRW").status_code == 200
    result = checkin(
        team,
        alice,
        {f"Fins/{number}.SLDPRT": b"fin", f"Fins/{number}.SLDDRW": b"drawing v2"},
        # The drawing first: the part takes its number before the drawing is named after it.
        renames=[{"file": drawing["id"], "name": f"{number}.SLDDRW"}, {"file": fin["id"], "name": f"{number}.SLDPRT"}],
        refs={f"Fins/{number}.SLDDRW": [{"file_id": fin["id"]}]},
    )
    assert sorted(by_path(result)) == [f"Fins/{number}.SLDDRW", f"Fins/{number}.SLDPRT"]
    fixed = client.post("/api/rename", json={"file": fin["id"], "name": "Fin.SLDPRT"}, headers=alice)
    assert fixed.json()["error"] == "part_number_fixed"


def test_a_dry_run_finds_every_problem_and_changes_nothing(team, client, alice):
    fin, can = fin_and_can(team, alice)
    rename = [{"file": fin["id"], "name": "Fin left.SLDPRT"}]
    ghost = {"path": "Fins/Ghost.SLDPRT", "sha256": "0" * 64, "size": 1}  # never uploaded
    body = {"host": "PC-1", "renames": rename, "dry_run": True, "items": [ghost]}
    body["items"].append({"path": "Fins/Fin left.SLDPRT", "sha256": team.upload(alice, b"fin"), "size": 3})
    found = client.post("/api/checkin", json=body, headers=alice)
    assert found.status_code == 200, found.text
    assert [p["error"] for p in found.json()["problems"]] == ["blob_missing", "in_use"]

    clean = checkin(
        team,
        alice,
        {"Fins/Fin left.SLDPRT": b"fin", "Fins/Fin Can.SLDASM": b"can v2"},
        renames=rename,
        refs={"Fins/Fin Can.SLDASM": [{"file_id": fin["id"]}]},
        dry_run=True,
    )
    would = clean.json()
    assert (would["checkin_id"], would["files"], would["problems"]) == (None, [], [])
    assert would["planned"] == [
        {"status": "renamed", "path": "Fins/Fin left.SLDPRT"},
        {"status": "updated", "path": "Fins/Fin Can.SLDASM"},
    ]
    # Nothing changed.
    still = client.get(f"/api/files/{fin['id']}", headers=alice).json()["file"]
    assert (still["name"], still["checked_out"]["host"], still["former_names"]) == ("Fin.SLDPRT", "PC-1", [])
    assert client.get(f"/api/files/{can['id']}", headers=alice).json()["file"]["version"] == 1


def test_references_name_files_by_id_too(team, client, alice):
    files = by_path(team.checkin(alice, {"Fins/Fin.SLDPRT": b"fin"}))
    fin = files["Fins/Fin.SLDPRT"]["file"]
    can = checkin(team, alice, {"Fins/Can.SLDASM": b"can"}, refs={"Fins/Can.SLDASM": [{"file_id": fin["id"]}]})
    assert by_path(can)["Fins/Can.SLDASM"]["file"]["uses"] == [{"file_id": fin["id"], "version": 1}]
    nowhere = checkin(team, alice, {"Fins/Tail.SLDASM": b"tail"}, refs={"Fins/Tail.SLDASM": [{"file_id": 999}]})
    assert (nowhere.status_code, nowhere.json()["error"]) == (400, "missing_references")
