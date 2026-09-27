"""Moving and renaming: SolidWorks references stay findable, check-outs stay put, and every client hears."""


def move(client, who, *, files=(), folders=(), to=""):
    return client.post("/api/move", json={"files": list(files), "folders": list(folders), "to": to}, headers=who)


def rename(client, who, name, *, file=None, folder=None):
    return client.post("/api/rename", json={"file": file, "folder": folder, "name": name}, headers=who)


def test_moving_files_into_a_folder(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Inbox/Bracket.SLDPRT": b"bracket", "Inbox/Notes.txt": b"notes"})
    before = client.get("/api/sync", headers=chief).json()

    moved = move(client, chief, files=["Inbox/Bracket.SLDPRT"], to="Structures/Brackets")  # made on the way
    assert moved.status_code == 200, moved.text
    assert [f["path"] for f in moved.json()["files"]] == ["Structures/Brackets/Bracket.SLDPRT"]
    after = client.get("/api/sync", params={"since": before["seq"]}, headers=chief).json()
    assert after["full"] is True  # every client gets everything again: paths changed
    assert {f["path"] for f in after["files"]} == {"Structures/Brackets/Bracket.SLDPRT", "Inbox/Notes.txt"}
    event = client.get("/api/activity", headers=chief).json()[0]
    assert (event["action"], event["detail"]["moved_from"]) == ("move", "Inbox/Bracket.SLDPRT")

    into_a_file = move(client, chief, files=["Inbox/Notes.txt"], to="Structures/Brackets/Bracket.SLDPRT")
    assert into_a_file.json()["error"] == "exists"
    team.checkin(chief, {"Inbox/Bracket.SLDPRT": b"another bracket"})
    taken = move(client, chief, files=["Inbox/Bracket.SLDPRT"], to="Structures/Brackets")
    assert (taken.status_code, taken.json()["error"]) == (409, "exists")


def test_parts_stay_where_their_assemblies_find_them(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(
        chief,
        {"Rocket/Fins/Fin.SLDPRT": b"fin", "Rocket/Fin Can.SLDASM": b"can"},
        refs={"Rocket/Fin Can.SLDASM": ["Rocket/Fins/Fin.SLDPRT"]},
    )
    lost = move(client, chief, files=["Rocket/Fins/Fin.SLDPRT"], to="Parts")  # alone, away from its assembly
    assert (lost.status_code, lost.json()["error"]) == (409, "in_use")
    assert lost.json()["details"]["used_by"] == [{"path": "Rocket/Fins/Fin.SLDPRT", "used_by": "Rocket/Fin Can.SLDASM"}]

    # Into the assembly's own folder is fine, where SolidWorks looks; so is the whole folder, both together.
    assert move(client, chief, files=["Rocket/Fins/Fin.SLDPRT"], to="Rocket").status_code == 200
    assert move(client, chief, folders=["Rocket"], to="Vehicles").status_code == 200
    assert [f["name"] for f in team.listing(chief, "Vehicles/Rocket")["files"]] == ["Fin Can.SLDASM", "Fin.SLDPRT"]

    # Names are how SolidWorks finds files, so a used one keeps its name; the assembly nothing uses can change.
    assert rename(client, chief, "Fin v2.SLDPRT", file="Vehicles/Rocket/Fin.SLDPRT").json()["error"] == "in_use"
    assert rename(client, chief, "Fin Can v2.SLDASM", file="Vehicles/Rocket/Fin Can.SLDASM").status_code == 200


def test_folders_move_with_their_insides_in_place(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(
        chief,
        {"Engine/Parts/Injector.SLDPRT": b"injector", "Engine/Engine.SLDASM": b"engine"},
        refs={"Engine/Engine.SLDASM": ["Engine/Parts/Injector.SLDPRT"]},
    )
    moved = move(client, chief, folders=["Engine"], to="Propulsion")
    assert [f["path"] for f in moved.json()["folders"]] == ["Propulsion/Engine"]
    assert [f["path"] for f in team.listing(chief, "Propulsion/Engine/Parts")["files"]] == [
        "Propulsion/Engine/Parts/Injector.SLDPRT"
    ]
    # The assembly is outside Parts: renaming Parts would lose the injector to it. Renaming Engine is fine.
    assert rename(client, chief, "Components", folder="Propulsion/Engine/Parts").json()["error"] == "in_use"
    assert rename(client, chief, "Main Engine", folder="Propulsion/Engine").status_code == 200
    assert move(client, chief, folders=["Propulsion"], to="Propulsion/Main Engine").json()["error"] == "bad_move"


def test_checked_out_files_stay_put(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.grant(chief, "", None, "editor")
    team.checkin(alice, {"Tank/Tank.SLDPRT": b"tank"})
    team.checkout(alice, "Tank/Tank.SLDPRT", host="ALICE-PC")
    refused = move(client, chief, folders=["Tank"], to="Propulsion")
    assert (refused.status_code, refused.json()["error"]) == (409, "checked_out")
    assert "ALICE-PC" in refused.json()["message"]


def test_moving_takes_edit_access_and_folders_take_a_lead(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.checkin(chief, {"Avionics/Board.STEP": b"board", "Recovery/Chute.SLDPRT": b"chute"})
    team.grant(chief, "Avionics", "alice@x.test", "editor")
    team.grant(chief, "Recovery", "alice@x.test", "viewer")
    assert move(client, alice, files=["Avionics/Board.STEP"], to="Recovery").status_code == 403  # can't add there
    assert move(client, alice, files=["Avionics/Board.STEP"], to="Avionics/Boards").status_code == 200
    assert move(client, alice, folders=["Avionics/Boards"], to="").status_code == 403  # a folder takes a lead
    assert rename(client, alice, "PCBs", folder="Avionics/Boards").status_code == 403


def test_renaming(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Fins/Fin.SLDPRT": b"fin", "Fins/Tab.SLDPRT": b"tab"})
    assert rename(client, chief, "Tab.SLDPRT", file="Fins/Fin.SLDPRT").json()["error"] == "exists"
    assert rename(client, chief, "Fin.STEP", file="Fins/Fin.SLDPRT").json()["error"] == "bad_rename"  # same kind
    assert rename(client, chief, "Fin: 2.SLDPRT", file="Fins/Fin.SLDPRT").json()["error"] == "bad_path"
    assert rename(client, chief, "fin.sldprt", file="Fins/Fin.SLDPRT").status_code == 200  # just the case
    renamed = rename(client, chief, "Fin Set", folder="Fins")
    assert [f["path"] for f in renamed.json()["folders"]] == ["Fin Set"]
    assert [f["path"] for f in team.listing(chief, "Fin Set")["files"]] == ["Fin Set/fin.sldprt", "Fin Set/Tab.SLDPRT"]
    assert [e["action"] for e in client.get("/api/activity", headers=chief).json()[:2]] == ["rename_folder", "rename"]
