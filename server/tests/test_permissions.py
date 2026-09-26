"""Folder roles: viewer, editor, lead, and admins."""


def test_subteam_folders(team, client):
    chief = team.member("chief@x.test", admin=True)
    prop = team.member("prop@x.test")  # propulsion member
    newbie = team.member("newbie@x.test")
    team.checkin(chief, {"Propulsion/Injector.SLDPRT": b"inj", "Avionics/Board.STEP": b"board"})
    team.grant(chief, "", None, "viewer")  # everyone can see everything
    team.grant(chief, "Propulsion", "prop@x.test", "editor")

    assert team.checkout(prop, "Propulsion/Injector.SLDPRT").status_code == 200
    denied = team.checkout(prop, "Avionics/Board.STEP")
    assert denied.status_code == 403
    assert "editor access to Avionics" in denied.json()["message"]
    assert team.checkout(newbie, "Avionics/Board.STEP").status_code == 403
    board = team.listing(newbie, "Avionics")["files"][0]
    assert client.get(f"/api/files/{board['id']}/content", headers=newbie).content == b"board"

    assert team.listing(prop, "Propulsion")["folder"]["role"] == "editor"
    assert team.listing(prop, "Avionics")["folder"]["role"] == "viewer"
    assert team.listing(chief, "Avionics")["folder"]["role"] == "admin"

    # Only leads and admins manage access.
    response = client.put("/api/grants", json={"path": "Propulsion", "user_id": None, "role": "editor"}, headers=prop)
    assert response.status_code == 403


def test_people_only_see_folders_they_have_access_to(team, client):
    chief = team.member("chief@x.test", admin=True)
    rec = team.member("rec@x.test")
    team.checkin(
        chief, {"Recovery/Chutes/Main.SLDPRT": b"main", "Recovery/Plan.STEP": b"plan", "Payload/Cam.STEP": b"cam"}
    )
    team.grant(chief, "Recovery/Chutes", "rec@x.test", "viewer")

    root = team.listing(rec)
    assert [f["path"] for f in root["folders"]] == ["Recovery"]  # a way through to Chutes
    recovery = team.listing(rec, "Recovery")
    assert (recovery["folder"]["role"], recovery["files"]) == (None, [])  # can't see files here
    assert [f["name"] for f in team.listing(rec, "Recovery/Chutes")["files"]] == ["Main.SLDPRT"]

    assert client.get("/api/folders", params={"path": "Payload"}, headers=rec).status_code == 404
    cam = team.listing(chief, "Payload")["files"][0]
    assert client.get(f"/api/files/{cam['id']}", headers=rec).status_code == 404  # not 403: don't reveal it
    assert [f["path"] for f in client.get("/api/sync", headers=rec).json()["files"]] == ["Recovery/Chutes/Main.SLDPRT"]


def test_leads_manage_their_folder(team, client):
    chief = team.member("chief@x.test", admin=True)
    lead = team.member("lead@x.test")
    member = team.member("member@x.test")
    team.checkin(chief, {"Structures/Airframe.SLDASM": b"af"})
    team.grant(chief, "Structures", "lead@x.test", "lead")

    team.grant(lead, "Structures", "member@x.test", "editor")
    assert team.checkout(member, "Structures/Airframe.SLDASM").status_code == 200
    grants = client.get("/api/grants", params={"path": "Structures"}, headers=member).json()["grants"]
    assert {(g["user"]["email"], g["role"]) for g in grants} == {("lead@x.test", "lead"), ("member@x.test", "editor")}

    outside = client.put("/api/grants", json={"path": "", "user_id": None, "role": "viewer"}, headers=lead)
    assert outside.status_code == 403

    team.grant(lead, "Structures", "member@x.test", None)  # remove
    assert team.checkout(member, "Structures/Airframe.SLDASM").status_code == 404  # can't see it anymore


def test_inherited_grants_are_listed_root_first(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.member("alice@x.test")
    team.checkin(chief, {"Propulsion/Tank/Tank.SLDPRT": b"t"})
    team.grant(chief, "", None, "viewer")
    team.grant(chief, "Propulsion/Tank", "alice@x.test", "editor")
    grants = client.get("/api/grants", params={"path": "Propulsion/Tank"}, headers=chief).json()["grants"]
    assert [(g["folder"], g["user"] and g["user"]["email"], g["role"]) for g in grants] == [
        ("", None, "viewer"),
        ("Propulsion/Tank", "alice@x.test", "editor"),
    ]


def test_only_admins_manage_accounts(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    assert client.post("/api/users", json={"email": "new@x.test"}, headers=alice).status_code == 403
    assert client.post("/api/users", json={"email": "new@x.test"}, headers=chief).status_code == 201
    assert (
        client.patch(f"/api/users/{team.ids['alice@x.test']}", json={"is_admin": True}, headers=alice).status_code
        == 403
    )
    me = team.ids["chief@x.test"]
    assert (
        client.patch(f"/api/users/{me}", json={"status": "disabled"}, headers=chief).json()["error"] == "self_lockout"
    )

    disabled = client.patch(f"/api/users/{team.ids['alice@x.test']}", json={"status": "disabled"}, headers=chief)
    assert disabled.json()["status"] == "disabled"
    assert client.get("/api/folders", headers=alice).json()["error"] == "disabled"
