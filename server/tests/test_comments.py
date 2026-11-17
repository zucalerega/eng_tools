"""Changing a check-in's comment after it's made (docs/vault.md, "Editing a check-in's comment"): its author, or a lead
of its files' folders, fixes a typo or says more, with no new version; the activity log keeps what it said before."""


def history(client, who, file_id: int) -> list[dict]:
    response = client.get(f"/api/files/{file_id}", headers=who)
    assert response.status_code == 200, response.text
    return response.json()["versions"]


def edit(client, who, checkin_id: int, comment: str):
    return client.put(f"/api/checkins/{checkin_id}/comment", json={"comment": comment}, headers=who)


def checked_in(team, who, files: dict[str, bytes], comment: str) -> tuple[int, dict[str, int]]:
    """A check-in's id, and its files' ids by path."""
    response = team.checkin(who, files, comment=comment)
    assert response.status_code == 200, response.text
    body = response.json()
    return body["checkin_id"], {entry["file"]["path"]: entry["file"]["id"] for entry in body["files"]}


def test_whoever_checked_it_in_fixes_the_comment_on_every_file_in_it(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.grant(chief, "", "alice@x.test", "editor")
    checkin, ids = checked_in(team, alice, {"Fins/Fin.SLDPRT": b"fin", "Fins/Can.SLDASM": b"can"}, comment="frist cut")
    seq = client.get("/api/sync", headers=alice).json()["seq"]
    [before] = history(client, alice, ids["Fins/Fin.SLDPRT"])
    assert (before["comment"], before["comment_edited_at"], before["comment_editable"]) == ("frist cut", None, True)

    edited = edit(client, alice, checkin, "  First cut of the fin  ")
    assert edited.status_code == 200, edited.text
    body = edited.json()
    assert (body["checkin_id"], body["comment"], body["edited_by"]["name"]) == (
        checkin,
        "First cut of the fin",
        "Alice",
    )

    # One comment for the check-in: every file in it says so, with no new version, and nothing for clients to sync.
    for path, file_id in ids.items():
        [version] = history(client, chief, file_id)
        assert (version["number"], version["comment"], version["comment_edited_by"]["name"]) == (
            1,
            "First cut of the fin",
            "Alice",
        ), path
        assert version["comment_edited_at"] == body["edited_at"]
    assert client.get("/api/sync", params={"since": seq}, headers=alice).json()["files"] == []

    # The activity log keeps what it said, for each file.
    events = [e for e in client.get("/api/activity", headers=chief).json() if e["action"] == "edit_comment"]
    assert sorted((e["detail"]["path"], e["detail"]["was"], e["detail"]["comment"]) for e in events) == [
        ("Fins/Can.SLDASM", "frist cut", "First cut of the fin"),
        ("Fins/Fin.SLDPRT", "frist cut", "First cut of the fin"),
    ]
    assert {(e["user"]["name"], e["detail"]["number"], e["detail"]["checkin"]) for e in events} == {
        ("Alice", 1, checkin)
    }

    # Saving it as it is changes nothing, and logs nothing.
    assert edit(client, alice, checkin, "First cut of the fin").status_code == 200
    assert len([e for e in client.get("/api/activity", headers=chief).json() if e["action"] == "edit_comment"]) == 2


def test_a_comment_says_something(team, client):
    chief = team.member("chief@x.test", admin=True)
    checkin, ids = checked_in(team, chief, {"Fin.SLDPRT": b"fin"}, comment="fin")
    refused = edit(client, chief, checkin, "   ")
    assert (refused.status_code, refused.json()["error"]) == (400, "bad_comment")
    assert edit(client, chief, checkin, "x" * 5001).status_code == 422
    assert history(client, chief, ids["Fin.SLDPRT"])[0]["comment"] == "fin"


def test_who_may_change_a_comment(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    lead = team.member("lead@x.test")
    viewer = team.member("viewer@x.test")
    outsider = team.member("outsider@x.test")
    for folder in ("Fins", "Engine"):
        client.post("/api/folders", json={"path": folder}, headers=chief)
        team.grant(chief, folder, "alice@x.test", "editor")
        team.grant(chief, folder, "bob@x.test", "editor")
        team.grant(chief, folder, "viewer@x.test", "viewer")
    team.grant(chief, "Fins", "lead@x.test", "lead")
    fins, ids = checked_in(team, alice, {"Fins/Fin.SLDPRT": b"fin"}, comment="fin")
    both, both_ids = checked_in(team, alice, {"Fins/Tab.SLDPRT": b"tab", "Engine/Valve.SLDPRT": b"valve"}, comment="x")

    # Another editor, or a viewer, may not; whoever can't see its files is told it isn't there.
    for who in (bob, viewer):
        refused = edit(client, who, fins, "theirs")
        assert (refused.status_code, refused.json()["error"]) == (403, "comment_locked")
        assert history(client, who, ids["Fins/Fin.SLDPRT"])[0]["comment_editable"] is False
    assert edit(client, outsider, fins, "mine").status_code == 404
    assert edit(client, chief, 9999, "nothing").status_code == 404

    # A lead of its folder may, and an admin; a lead of only some of its files' folders may not.
    assert history(client, lead, ids["Fins/Fin.SLDPRT"])[0]["comment_editable"] is True
    assert edit(client, lead, fins, "Fin, as the lead says").status_code == 200
    assert history(client, lead, both_ids["Fins/Tab.SLDPRT"])[0]["comment_editable"] is False
    assert (edit(client, lead, both, "Tab and valve").json()["error"]) == "comment_locked"
    assert edit(client, chief, both, "Tab and valve").status_code == 200

    # Its author, only while they can still change every file in it.
    team.grant(chief, "Engine", "alice@x.test", "viewer")
    refused = edit(client, alice, both, "mine again")
    assert (refused.status_code, refused.json()["error"]) == (403, "comment_locked")
    assert "ask a lead" in refused.json()["message"]
    assert edit(client, alice, fins, "Fin, as I meant it").status_code == 200


def test_a_reverts_comment_stays(team, client):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Fin.SLDPRT": b"fin"}, comment="first")
    assert team.checkout(chief, "Fin.SLDPRT").status_code == 200
    _, ids = checked_in(team, chief, {"Fin.SLDPRT": b"fin v2"}, comment="second")
    file_id = ids["Fin.SLDPRT"]
    assert client.post(f"/api/files/{file_id}/revert", json={"version": 1}, headers=chief).status_code == 200
    reverted, second, first = history(client, chief, file_id)
    assert (reverted["comment"], reverted["comment_editable"]) == ("Reverted to v1", False)
    refused = edit(client, chief, reverted["checkin_id"], "Back to v1")
    assert (refused.status_code, refused.json()["error"]) == (403, "comment_locked")
    # The versions before it can still be changed.
    assert (second["comment_editable"], first["comment_editable"]) == (True, True)
    assert edit(client, chief, first["checkin_id"], "First").status_code == 200


def test_deleted_files_comments_can_still_be_fixed(team, client):
    chief = team.member("chief@x.test", admin=True)
    checkin, ids = checked_in(team, chief, {"Old/Fin.SLDPRT": b"fin"}, comment="fin")
    assert client.post("/api/delete", json={"files": ["Old/Fin.SLDPRT"]}, headers=chief).status_code == 200
    assert edit(client, chief, checkin, "The old fin").status_code == 200
    assert history(client, chief, ids["Old/Fin.SLDPRT"])[0]["comment"] == "The old fin"
