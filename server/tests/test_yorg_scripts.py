"""Yorg's scripts: Python that anyone keeps on the server, in folders, to run in their browsers; each changed only by
whoever saved it, or an admin."""

import json

import pytest


def test_scripts_are_everyones_and_changed_by_whoever_saved_them(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    saved = team.client.post("/api/yorg/scripts", json={"name": "Mine", "code": "print(1)"}, headers=alice)
    assert saved.status_code == 201, saved.text
    script = saved.json()
    assert (script["created_by"], script["can_change"]) == ("Alice", True)
    url = f"/api/yorg/scripts/{script['id']}"

    # Bob sees it and runs it, but can't change or delete it: he keeps a copy of his own.
    listed = team.client.get("/api/yorg/scripts", headers=bob).json()
    assert [(one["name"], one["can_change"]) for one in listed] == [("Mine", False)]
    assert team.client.get(url, headers=bob).json()["code"] == "print(1)"
    changed = team.client.put(url, json={"name": "Bob's now", "code": "print(2)"}, headers=bob)
    assert (changed.status_code, changed.json()["error"]) == (403, "not_yours")
    assert team.client.delete(url, headers=bob).status_code == 403
    copy = team.client.post("/api/yorg/scripts", json={"name": "Mine (copy)", "code": "print(1)"}, headers=bob)
    assert copy.json()["can_change"] is True

    # Alice changes hers; an admin, anyone's.
    assert team.client.put(url, json={"name": "Mine", "code": "print(3)"}, headers=alice).status_code == 200
    assert team.client.get(url, headers=chief).json()["can_change"] is True
    assert team.client.delete(url, headers=chief).status_code == 204


def test_scripts_saved_before_they_were_everyones_are_changed_by_admins(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    old = team.client.post("/api/yorg/scripts", json={"name": "Old"}, headers=chief).json()
    # As one saved while scripts were only admins': no one's in particular.
    path = team.client.app.state.yorg_scripts.root / f"{old['id']}.json"
    kept = json.loads(path.read_text())
    del kept["created_by_id"]
    path.write_text(json.dumps(kept))

    url = f"/api/yorg/scripts/{old['id']}"
    assert team.client.get(url, headers=alice).json()["can_change"] is False
    assert team.client.put(url, json={"name": "Taken"}, headers=alice).status_code == 403
    assert team.client.put(url, json={"name": "Renamed"}, headers=chief).status_code == 200


def test_scripts_are_saved_in_folders_changed_and_deleted(team):
    chief = team.member("chief@x.test", admin=True)
    code = 'pt = yorg.channel("PT-TANK")\nprint(pt.values.max())\n'
    created = team.client.post(
        "/api/yorg/scripts",
        json={"name": " Tank peak ", "folder": " Hotfires \\ Tanks// ", "code": code, "datasets": [3, 1]},
        headers=chief,
    )
    assert created.status_code == 201, created.text
    script = created.json()
    assert (script["name"], script["folder"], script["code"], script["created_by"]) == (
        "Tank peak",
        "Hotfires/Tanks",
        code,
        "Chief",
    )
    assert script["datasets"] == [3, 1]  # the tests it works on, the first first
    other = team.client.post("/api/yorg/scripts", json={"name": "Loose"}, headers=chief).json()
    assert (other["folder"], other["code"], other["datasets"]) == ("", "", [])

    # The list has no code (it can be long); a script has it.
    listed = team.client.get("/api/yorg/scripts", headers=chief).json()
    assert [(one["name"], "code" in one) for one in listed] == [("Loose", False), ("Tank peak", False)]
    assert team.client.get(f"/api/yorg/scripts/{script['id']}", headers=chief).json()["code"] == code

    moved = team.client.put(
        f"/api/yorg/scripts/{script['id']}",
        json={"name": "Tank peak", "folder": "Cold flows", "code": code + "print(2)\n"},
        headers=chief,
    )
    assert moved.status_code == 200, moved.text
    again = team.client.get(f"/api/yorg/scripts/{script['id']}", headers=chief).json()
    assert (again["folder"], again["code"].endswith("print(2)\n"), again["created_by"]) == ("Cold flows", True, "Chief")

    assert team.client.delete(f"/api/yorg/scripts/{script['id']}", headers=chief).status_code == 204
    missing = team.client.get(f"/api/yorg/scripts/{script['id']}", headers=chief)
    assert (missing.status_code, missing.json()["message"]) == (
        404,
        "There's no such script: someone may have deleted it",
    )


@pytest.mark.parametrize(
    "body",
    [
        {"name": "   "},
        {"name": "x" * 121},
        {"name": "Big", "code": "#" * (512 * 1024 + 1)},
        {"name": "Deep", "folder": "a/" * 151},
        {"name": "Many tests", "datasets": list(range(21))},
    ],
)
def test_a_script_that_cant_be_saved(team, body):
    chief = team.member("chief@x.test", admin=True)
    assert team.client.post("/api/yorg/scripts", json=body, headers=chief).status_code == 422
