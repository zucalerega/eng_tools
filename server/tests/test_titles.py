"""What people call files (their titles), which files are a vendor's, and the names files had before: beside part
numbers, which make file names numbers (docs/vault.md, "Titles")."""


def files(response) -> dict[str, dict]:
    assert response.status_code == 200, response.text
    return {entry["file"]["path"]: entry["file"] for entry in response.json()["files"]}


def describe(client, who, *changes: dict):
    return client.post("/api/files/metadata", json={"files": list(changes)}, headers=who)


def test_a_file_is_called_by_its_name_until_someone_names_it(team, client):
    chief = team.member("chief@x.test", admin=True)
    fin = files(team.checkin(chief, {"Fins/Fin Bracket.SLDPRT": b"fin", "Fins/README": b"notes"}))
    assert (fin["Fins/Fin Bracket.SLDPRT"]["title"], fin["Fins/Fin Bracket.SLDPRT"]["vendor"]) == ("Fin Bracket", False)
    assert fin["Fins/README"]["title"] == "README"  # no type to leave off
    assert fin["Fins/Fin Bracket.SLDPRT"]["former_names"] == []


def test_editors_name_files_without_a_new_version(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    fin = files(team.checkin(chief, {"Fins/Fin.SLDPRT": b"fin"}))["Fins/Fin.SLDPRT"]
    team.grant(chief, "Fins", "alice@x.test", "editor")
    assert team.checkout(alice, "Fins/Fin.SLDPRT", host="ALICE-PC").status_code == 200  # someone else's lock is fine
    before = client.get("/api/sync", headers=chief).json()["seq"]

    named = describe(client, chief, {"file": fin["id"], "title": "  Fin,  left side  "})
    assert named.status_code == 200, named.text
    [after] = named.json()["files"]
    assert (after["title"], after["version"], after["name"]) == ("Fin,  left side", 1, "Fin.SLDPRT")
    # Clients pick it up with what else changed, without syncing everything again.
    synced = client.get("/api/sync", params={"since": before}, headers=chief).json()
    assert (synced["full"], [f["title"] for f in synced["files"]]) == (False, ["Fin,  left side"])
    event = client.get("/api/activity", headers=chief).json()[0]
    assert (event["action"], event["detail"]) == (
        "describe",
        {"path": "Fins/Fin.SLDPRT", "title": "Fin,  left side", "was": "Fin"},
    )


def test_a_title_says_something(team, client):
    chief = team.member("chief@x.test", admin=True)
    fin = files(team.checkin(chief, {"Fin.SLDPRT": b"fin"}))["Fin.SLDPRT"]
    for title, why in (("   ", "empty"), ("x" * 201, "200 characters"), ("Fin\tleft", "tab")):
        refused = describe(client, chief, {"file": fin["id"], "title": title})
        assert (refused.status_code, refused.json()["error"]) == (400, "bad_title"), why
    # Nothing changed, all or nothing.
    other = files(team.checkin(chief, {"Tab.SLDPRT": b"tab"}))["Tab.SLDPRT"]
    both = describe(client, chief, {"file": other["id"], "title": "Tab, outer"}, {"file": fin["id"], "title": ""})
    assert both.status_code == 400
    assert {f["path"]: f["title"] for f in team.listing(chief)["files"]} == {"Fin.SLDPRT": "Fin", "Tab.SLDPRT": "Tab"}


def test_who_may_name_files(team, client):
    chief = team.member("chief@x.test", admin=True)
    viewer = team.member("viewer@x.test")
    outsider = team.member("outsider@x.test")
    fin = files(team.checkin(chief, {"Fins/Fin.SLDPRT": b"fin", "Secret/Plan.SLDPRT": b"plan"}))
    team.grant(chief, "Fins", "viewer@x.test", "viewer")
    refused = describe(client, viewer, {"file": fin["Fins/Fin.SLDPRT"]["id"], "title": "Mine"})
    assert refused.status_code == 403
    hidden = describe(client, outsider, {"file": fin["Secret/Plan.SLDPRT"]["id"], "title": "Mine"})
    assert hidden.status_code == 404  # what you can't see isn't there


def test_files_from_a_vendor_are_marked(team, client):
    chief = team.member("chief@x.test", admin=True)
    path = "Library/Bearing 6203-2RS.SLDPRT"
    assert files(team.checkin(chief, {path: b"bearing"}))[path]["vendor"] is False  # its name doesn't say whose it is
    [marked] = describe(client, chief, {"file": path, "vendor": True}).json()["files"]
    assert (marked["vendor"], marked["title"]) == (True, "Bearing 6203-2RS")
    event = client.get("/api/activity", headers=chief).json()[0]
    assert (event["action"], event["detail"]["vendor"]) == ("describe", True)


def test_a_renamed_file_keeps_the_names_it_had(team, client):
    chief = team.member("chief@x.test", admin=True)
    fin = files(team.checkin(chief, {"Fins/Fin.SLDPRT": b"fin"}))["Fins/Fin.SLDPRT"]
    for name in ("fin.sldprt", "Fin left.SLDPRT", "Fin port.SLDPRT"):  # a change of case changes nothing
        assert client.post("/api/rename", json={"file": fin["id"], "name": name}, headers=chief).status_code == 200
    moved = client.post("/api/move", json={"files": [fin["id"]], "folders": [], "to": "Tail"}, headers=chief)
    assert moved.status_code == 200, moved.text
    detail = client.get(f"/api/files/{fin['id']}", headers=chief).json()["file"]
    assert (detail["path"], detail["former_names"]) == ("Tail/Fin port.SLDPRT", ["fin.sldprt", "Fin left.SLDPRT"])
    assert detail["title"] == "Fin"  # a rename leaves what it's called alone
