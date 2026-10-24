"""Part numbers (docs/vault.md, "Part numbers"): the kinds admins keep, numbers handed out in order, and the files that
take them, named by them, for good."""

import pytest


def files(response) -> dict[str, dict]:
    assert response.status_code == 200, response.text
    return {entry["file"]["path"]: entry["file"] for entry in response.json()["files"]}


def reserve(client, who, kind: str = "001", **body):
    return client.post("/api/numbers", json={"kind": kind, **body}, headers=who)


def numbered(client, who, kind: str = "001", **body) -> str:
    response = reserve(client, who, kind, **body)
    assert response.status_code == 200, response.text
    [issued] = response.json()["numbers"]
    return issued["number"]


def turn_on(client, chief, mode: str = "offer") -> None:
    assert client.put("/api/numbering", json={"mode": mode}, headers=chief).status_code == 200


@pytest.fixture
def chief(team):
    return team.member("chief@x.test", admin=True)


@pytest.fixture
def alice(team, chief):
    alice = team.member("alice@x.test")
    team.client.post("/api/folders", json={"path": "Fins"}, headers=chief)
    team.grant(chief, "Fins", "alice@x.test", "editor")
    return alice


def test_the_vault_starts_with_a_kind_for_parts_and_one_for_assemblies(client, chief):
    kinds = client.get("/api/part-kinds", headers=chief).json()
    assert [(k["code"], k["label"], k["applies"], k["retired"]) for k in kinds] == [
        ("001", "Part", "part", False),
        ("501", "Assembly", "assembly", False),
    ]
    assert client.get("/api/numbering", headers=chief).json() == {"mode": "off", "next_number": 1}


def test_admins_keep_the_kinds(client, chief, alice):
    added = client.post(
        "/api/part-kinds", json={"code": "002", "label": "Sheet metal", "applies": "part"}, headers=chief
    )
    assert added.status_code == 201, added.text
    for body, code in (
        ({"code": "02", "label": "Short", "applies": "part"}, "bad_kind"),
        ({"code": "003", "label": " ", "applies": "part"}, "bad_kind"),
        ({"code": "002", "label": "Again", "applies": "part"}, "exists"),
    ):
        assert client.post("/api/part-kinds", json=body, headers=chief).json()["error"] == code
    refused = client.post("/api/part-kinds", json={"code": "004", "label": "Mine", "applies": "any"}, headers=alice)
    assert refused.status_code == 403

    retired = client.patch("/api/part-kinds/002", json={"retired": True, "label": "Sheet metal part"}, headers=chief)
    assert (retired.json()["retired"], retired.json()["label"]) == (True, "Sheet metal part")
    assert reserve(client, chief, "002").json()["error"] == "bad_kind"  # retired: no new numbers of it


def test_numbers_are_handed_out_in_order_once_admins_turn_them_on(client, chief, alice):
    off = reserve(client, alice)
    assert (off.status_code, off.json()["error"]) == (403, "numbering_off")
    first = numbered(client, chief)  # admins get them before, to number the vault
    assert first == "00000001-001"

    turn_on(client, chief)
    second = reserve(client, alice, "501", title="Fin can", count=2).json()["numbers"]
    assert [(n["number"], n["title"]) for n in second] == [("00000002-501", "Fin can"), ("00000003-501", "Fin can")]
    assert [n["number"] for n in client.get("/api/numbers", headers=alice).json()["numbers"]] == [
        "00000002-501",
        "00000003-501",
    ]
    # Numbers only go up: an admin can skip ahead, never back.
    assert client.put("/api/numbering", json={"next_number": 2}, headers=chief).json()["error"] == "bad_next_number"
    assert client.put("/api/numbering", json={"next_number": 22}, headers=chief).json()["next_number"] == 22
    assert numbered(client, alice) == "00000022-001"
    assert client.put("/api/numbering", json={"mode": "require"}, headers=alice).status_code == 403


def test_editors_hold_a_few_unused_numbers_at_a_time(client, chief, alice):
    turn_on(client, chief)
    assert reserve(client, alice, count=20).status_code == 200
    too_many = reserve(client, alice)
    assert (too_many.status_code, too_many.json()["error"]) == (409, "too_many_numbers")

    mine = [n["number"] for n in client.get("/api/numbers", headers=alice).json()["numbers"]]
    given = client.post("/api/numbers/release", json={"numbers": mine[:5]}, headers=alice)
    assert [n["number"] for n in given.json()["numbers"]] == mine[:5]
    assert numbered(client, alice) == "00000021-001"  # a number given back is never handed out again
    by_admin = client.post("/api/numbers/release", json={"numbers": mine[5:6]}, headers=chief)
    assert [n["number"] for n in by_admin.json()["numbers"]] == mine[5:6]  # admins give back anyone's


def test_a_new_part_named_by_its_number_takes_it_with_its_title(team, client, chief, alice):
    turn_on(client, chief)
    number = numbered(client, alice, title="Fin bracket")
    fin = files(team.checkin(alice, {f"Fins/{number}.SLDPRT": b"fin"}))[f"Fins/{number}.SLDPRT"]
    assert (fin["name"], fin["title"]) == (f"{number}.SLDPRT", "Fin bracket")
    assert client.get("/api/numbers", headers=alice).json()["numbers"] == []  # used

    # It's the file's for good: no other file takes it, and it can't be given back.
    again = team.checkin(alice, {f"Fins/Copy/{number}.SLDPRT": b"copy"})
    assert (again.status_code, again.json()["error"]) == (409, "part_number_taken")
    kept = client.post("/api/numbers/release", json={"numbers": [number]}, headers=alice)
    assert kept.json()["error"] == "part_number_used"


def test_a_number_fits_what_its_file_is(team, client, chief, alice):
    turn_on(client, chief)
    assembly = numbered(client, alice, "501")
    for name, code in (
        (f"{assembly}.SLDPRT", "bad_part_number"),  # an assembly's number on a part
        ("00000099-001.SLDPRT", "unknown_part_number"),  # never handed out
        (f"{assembly} left.SLDASM", "bad_part_number"),  # an assembly's name is its number alone
    ):
        refused = team.checkin(alice, {f"Fins/{name}": b"x"})
        assert (refused.status_code, refused.json()["error"]) == (400, code), name
    assert team.checkin(alice, {f"Fins/{assembly}.SLDASM": b"can"}).status_code == 200


def test_drawings_pdfs_and_exports_are_named_after_a_number_a_file_has(team, client, chief, alice):
    turn_on(client, chief)
    number = numbered(client, alice)
    # A part, its drawing, and a PDF and a STEP file of it, in one check-in: the part takes the number first.
    checked = team.checkin(
        alice,
        {
            f"Fins/{number} - machining.SLDDRW": b"drawing",
            f"Fins/{number}.PDF": b"pdf",
            f"Fins/{number}.STEP": b"step",
            f"Fins/{number}.SLDPRT": b"fin",
        },
        refs={f"Fins/{number} - machining.SLDDRW": [f"Fins/{number}.SLDPRT"]},
    )
    assert [f["path"] for f in [e["file"] for e in checked.json()["files"]]] == [
        f"Fins/{number} - machining.SLDDRW",
        f"Fins/{number}.PDF",
        f"Fins/{number}.STEP",
        f"Fins/{number}.SLDPRT",
    ]  # in the order they came
    unheld = numbered(client, alice)
    refused = team.checkin(alice, {f"Fins/{unheld}.PDF": b"pdf"})
    assert (refused.status_code, refused.json()["error"]) == (400, "unknown_part_number")


def test_once_numbers_are_required_new_cad_files_need_one(team, client, chief, alice):
    files(team.checkin(alice, {"Fins/Rail.SLDPRT": b"rail"}))
    turn_on(client, chief, "require")
    refused = team.checkin(alice, {"Fins/Fin.SLDPRT": b"fin"})
    assert (refused.status_code, refused.json()["error"]) == (400, "part_number_needed")
    # A vendor's part keeps its vendor's name, as McMaster's numbers say, or as the one checking it in says; and
    # documents keep theirs.
    ok = team.checkin(alice, {"Fins/91251A463_Socket Head Screw.SLDPRT": b"screw", "Fins/Notes.PDF": b"notes"})
    assert files(ok)["Fins/91251A463_Socket Head Screw.SLDPRT"]["vendor"] is True
    sha = team.upload(alice, b"bearing")
    vendor = {"path": "Fins/Bearing 6203.SLDPRT", "sha256": sha, "size": 7, "vendor": True}
    said = client.post("/api/checkin", json={"host": "PC-1", "items": [vendor]}, headers=alice)
    assert files(said)["Fins/Bearing 6203.SLDPRT"]["vendor"] is True
    # A file from before goes on as it is.
    assert team.checkout(alice, "Fins/Rail.SLDPRT").status_code == 200
    assert team.checkin(alice, {"Fins/Rail.SLDPRT": b"rail v2"}).status_code == 200


def test_a_part_number_never_changes(team, client, chief, alice):
    turn_on(client, chief)
    number = numbered(client, alice)
    fin = files(team.checkin(alice, {f"Fins/{number}.SLDPRT": b"fin"}))[f"Fins/{number}.SLDPRT"]
    for name in (f"{number}-left.SLDPRT", "Fin.SLDPRT", "00000099-001.SLDPRT"):
        refused = client.post("/api/rename", json={"file": fin["id"], "name": name}, headers=alice)
        assert (refused.status_code, refused.json()["error"]) == (409, "part_number_fixed"), name
    same = client.post("/api/rename", json={"file": fin["id"], "name": f"{number}.sldprt"}, headers=alice)
    assert same.status_code == 200, same.text  # its type's case is no number

    # A file without one may take one: renamed by a number handed out.
    rail = files(team.checkin(alice, {"Fins/Rail.SLDPRT": b"rail"}))["Fins/Rail.SLDPRT"]
    other = numbered(client, alice, title="Rail, long")
    renamed = client.post("/api/rename", json={"file": rail["id"], "name": f"{other}.SLDPRT"}, headers=alice)
    assert renamed.status_code == 200, renamed.text
    detail = client.get(f"/api/files/{rail['id']}", headers=alice).json()["file"]
    assert (detail["name"], detail["title"], detail["former_names"]) == (f"{other}.SLDPRT", "Rail", ["Rail.SLDPRT"])
    back = client.post("/api/rename", json={"file": rail["id"], "name": "Rail.SLDPRT"}, headers=alice)
    assert back.json()["error"] == "part_number_fixed"


def test_a_drawing_renamed_stays_named_after_what_it_shows(team, client, chief):
    checked = team.checkin(chief, {"Fin.SLDPRT": b"fin", "Fin.SLDDRW": b"drawing"}, refs={"Fin.SLDDRW": ["Fin.SLDPRT"]})
    drawing = files(checked)["Fin.SLDDRW"]
    refused = client.post("/api/rename", json={"file": drawing["id"], "name": "Rail.SLDDRW"}, headers=chief)
    assert (refused.status_code, refused.json()["error"]) == (400, "drawing_name")
    renamed = client.post("/api/rename", json={"file": drawing["id"], "name": "Fin - cuts.SLDDRW"}, headers=chief)
    assert renamed.status_code == 200, renamed.text


def test_a_vendors_part_isnt_named_by_a_number(team, client, chief, alice):
    turn_on(client, chief)
    number = numbered(client, alice)
    fin = files(team.checkin(alice, {f"Fins/{number}.SLDPRT": b"fin"}))[f"Fins/{number}.SLDPRT"]
    refused = client.post("/api/files/metadata", json={"files": [{"file": fin["id"], "vendor": True}]}, headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (400, "bad_part_number")


def test_check_ins_bring_titles_and_refuse_changes_to_an_old_version(team, client, chief, alice):
    files(team.checkin(alice, {"Fins/Fin.SLDPRT": b"fin"}))
    assert team.checkout(alice, "Fins/Fin.SLDPRT").status_code == 200
    sha = team.upload(alice, b"fin v2")
    item = {"path": "Fins/Fin.SLDPRT", "sha256": sha, "size": 6, "title": "Fin, left", "base_version": 1}
    checked = client.post(
        "/api/checkin", json={"host": "PC-1", "items": [item], "keep_checked_out": True}, headers=alice
    )
    assert (files(checked)["Fins/Fin.SLDPRT"]["title"], files(checked)["Fins/Fin.SLDPRT"]["version"]) == (
        "Fin, left",
        2,
    )

    stale = {**item, "sha256": team.upload(alice, b"fin v3"), "size": 6}  # still says it starts from v1
    refused = client.post("/api/checkin", json={"host": "PC-1", "items": [stale]}, headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (409, "out_of_date")
