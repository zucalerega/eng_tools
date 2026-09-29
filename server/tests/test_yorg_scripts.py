"""Yorg's scripts: Python that admins keep on the server, in folders, to run in their browsers."""

import pytest


def test_scripts_are_for_admins(team):
    chief = team.member("chief@x.test", admin=True)
    bob = team.member("bob@x.test")
    assert team.client.get("/api/yorg/scripts", headers=bob).status_code == 403
    response = team.client.post("/api/yorg/scripts", json={"name": "Mine", "code": "print(1)"}, headers=bob)
    assert response.status_code == 403
    assert team.client.get("/api/yorg/scripts", headers=chief).json() == []


def test_scripts_are_saved_in_folders_changed_and_deleted(team):
    chief = team.member("chief@x.test", admin=True)
    code = 'pt = yorg.channel("PT-TANK")\nprint(pt.values.max())\n'
    created = team.client.post(
        "/api/yorg/scripts",
        json={"name": " Tank peak ", "folder": " Hotfires \\ Tanks// ", "code": code},
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
    other = team.client.post("/api/yorg/scripts", json={"name": "Loose"}, headers=chief).json()
    assert (other["folder"], other["code"]) == ("", "")

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
    ],
)
def test_a_script_that_cant_be_saved(team, body):
    chief = team.member("chief@x.test", admin=True)
    assert team.client.post("/api/yorg/scripts", json=body, headers=chief).status_code == 422
