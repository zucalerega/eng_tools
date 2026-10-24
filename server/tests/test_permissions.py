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


def test_check_ins_cant_use_files_you_cant_see(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.checkin(chief, {"Secret/Engine.SLDPRT": b"engine", "Public/Fin.SLDPRT": b"fin"})
    team.grant(chief, "Public", "alice@x.test", "editor")
    rocket = team.upload(alice, b"rocket")

    def check_in(reference: str, version: int | None = None):
        uses = [{"path": reference, "version": version}]
        item = {"path": "Public/Rocket.SLDASM", "sha256": rocket, "size": 6, "references": uses}
        return client.post("/api/checkin", json={"host": "PC-1", "items": [item]}, headers=alice)

    # Using it, at any version, is using a file that isn't there: whether it is, and its versions, stay hidden.
    for version in (None, 1, 9):
        for reference in ("Secret/Engine.SLDPRT", "Secret/Nothing.SLDPRT"):
            response = check_in(reference, version)
            assert (response.status_code, response.json().get("error")) == (400, "missing_references"), response.text
            assert response.json()["details"]["missing"] == [{"file": "Public/Rocket.SLDASM", "reference": reference}]
    engine = team.listing(chief, "Secret")["files"][0]
    assert client.get(f"/api/files/{engine['id']}", headers=chief).json()["used_by"] == []
    assert check_in("Public/Fin.SLDPRT").status_code == 200


def test_a_folder_you_cant_see_answers_as_a_free_name_would(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.checkin(
        chief,
        {
            "Secret/Inner/Plan.STEP": b"plan",
            "Recovery/Chutes/Main.SLDPRT": b"main",
            "Recovery/Drogue/Drogue.SLDPRT": b"d",
        },
    )
    team.grant(chief, "Recovery/Chutes", "alice@x.test", "editor")  # Recovery is only her way through to Chutes

    def create(path: str) -> tuple[int, dict]:
        response = client.post("/api/folders", json={"path": path}, headers=alice)
        return response.status_code, response.json()

    # Not "exists": she can't add folders where it is, as she can't where any free name is.
    pairs = [("Secret", "Nothing"), ("Secret/Inner", "Nothing/Inner"), ("Recovery/Drogue", "Recovery/Main")]
    for hidden, free in pairs:
        assert create(hidden) == create(free)
    assert create("Recovery/Drogue") == (
        403,
        {
            "error": "forbidden",
            "message": "You need editor access to Recovery to create folders in Recovery",
            "details": {"needed": "editor", "folder": "Recovery"},
        },
    )
    assert create("Recovery")[1]["error"] == "exists"  # she can see that one
    assert create("Recovery/Chutes/Spare")[0] == 201


def test_files_and_folders_you_cant_see_answer_as_ones_that_arent_there(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.checkin(
        chief, {"Secret/Plan.STEP": b"plan", "Recovery/Budget.STEP": b"budget", "Recovery/Chutes/Main.SLDPRT": b"m"}
    )
    team.grant(chief, "Recovery/Chutes", "alice@x.test", "editor")  # she can't see Recovery's own files

    def check_in(path: str) -> tuple[int, dict]:
        response = team.checkin(alice, {path: b"mine"})
        return response.status_code, response.json()

    def move_to(folder: str) -> tuple[int, dict]:
        body = {"files": ["Recovery/Chutes/Main.SLDPRT"], "folders": [], "to": folder}
        response = client.post("/api/move", json=body, headers=alice)
        return response.status_code, response.json()

    # A file where she can't see files, one in a folder she can't see, a new one there, and that folder to move into:
    # each answers as if nothing were there.
    assert check_in("Recovery/Budget.STEP") == check_in("Recovery/Other.STEP")
    assert check_in("Secret/Plan.STEP") == check_in("Nothing/Plan.STEP")
    assert check_in("Secret/New.STEP") == check_in("Nothing/New.STEP")
    assert move_to("Secret") == move_to("Nothing")
    assert move_to("Secret")[0] == 403
    assert [f["name"] for f in team.listing(chief, "Recovery")["files"]] == ["Budget.STEP"]  # nothing changed


def test_files_you_cant_see_that_use_a_file_go_unnamed(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    assemblies = ["Public/Rocket.SLDASM", "Secret/Engine.SLDASM", "Secret/Stand.SLDASM"]
    team.checkin(
        chief,
        {"Library/Bolt.STEP": b"bolt", **{path: path.encode() for path in assemblies}},
        refs={path: ["Library/Bolt.STEP"] for path in assemblies},
    )
    for folder in ("Library", "Public"):
        team.grant(chief, folder, "alice@x.test", "editor")

    # They still keep it from going, or moving where they wouldn't find it, so they're counted, but not named.
    deleted = client.post("/api/delete", json={"files": ["Library/Bolt.STEP"]}, headers=alice)
    assert (deleted.status_code, deleted.json()["error"]) == (409, "in_use")
    assert deleted.json()["message"] == "Still used by Public/Rocket.SLDASM and 2 files you can't see"
    assert deleted.json()["details"]["used_by"] == [{"path": "Library/Bolt.STEP", "used_by": "Public/Rocket.SLDASM"}]

    body = {"files": ["Library/Bolt.STEP"], "folders": [], "to": "Public"}  # where the rocket would find it
    moved = client.post("/api/move", json=body, headers=alice)
    assert (moved.status_code, moved.json()["error"]) == (409, "in_use")
    assert moved.json()["message"].startswith(
        "Library/Bolt.STEP is used by 2 files you can't see, and SolidWorks wouldn't find it after this."
    )
    assert moved.json()["details"]["used_by"] == []

    renamed = client.post("/api/rename", json={"file": "Library/Bolt.STEP", "name": "M5 Bolt.STEP"}, headers=alice)
    assert (renamed.status_code, renamed.json()["error"]) == (409, "in_use")
    assert renamed.json()["message"].startswith("Library/Bolt.STEP is used by Public/Rocket.SLDASM and 2 files you")
    for response in (deleted, moved, renamed):
        assert "Secret" not in response.text and "Engine" not in response.text and "Stand" not in response.text
    # Whoever can see them all is told of each.
    named = client.post("/api/delete", json={"files": ["Library/Bolt.STEP"]}, headers=chief).json()["message"]
    assert named == "Still used by Public/Rocket.SLDASM, Secret/Engine.SLDASM, Secret/Stand.SLDASM"


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


def test_only_admins_see_or_change_the_whitelist(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    for response in (
        client.get("/api/settings", headers=alice),
        client.patch("/api/settings", json={"whitelist": True}, headers=alice),
    ):
        assert (response.status_code, response.json()["error"]) == (403, "admin_only")
    assert client.get("/api/settings", headers=chief).json() == {"whitelist": False, "min_client_version": None}
    # Admin events, like account changes, aren't in anyone else's activity feed.
    team.whitelist(chief, True)
    assert "update_settings" in [e["action"] for e in client.get("/api/activity", headers=chief).json()]
    assert "update_settings" not in [e["action"] for e in client.get("/api/activity", headers=alice).json()]
