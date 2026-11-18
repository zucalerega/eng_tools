"""Buildflow's bills of materials: a program's parts to buy, read in from the team's own spreadsheets, each for one of its
components, and read in again as those change, keeping what the site says that the spreadsheet doesn't. Anyone keeps
the BOM, as they do progress."""

from .test_buildflow import API, activity, named, opened, program


def read_in(team, who, made: dict, lines: list[dict], **more):
    return team.client.put(f"{API}/programs/{made['id']}/bom", json={"lines": lines, **more}, headers=who)


def bom(team, who, made: dict, **params) -> list[dict]:
    response = team.client.get(f"{API}/programs/{made['id']}/bom", params=params, headers=who)
    assert response.status_code == 200, response.text
    return response.json()


def test_a_bom_read_in_is_each_components_parts_and_read_in_again_keeps_what_the_site_says(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, alice, made)
    mov, injector = named(bill, "Main oxidizer valve"), named(bill, "Injector")
    first = [
        {
            "component_id": mov["id"],
            "part_number": "SS-63TS8",
            "description": "1/2 in ball valve",
            "quantity": 1,
            "vendor": "Swagelok",
            "unit_cost": 41250,
            "lead_days": 70,
            "url": "https://www.swagelok.com/en/catalog",
        },
        {
            "component_id": injector["id"],
            "part_number": "91251A463",
            "description": "Socket head screw",
            "quantity": 12,
            "vendor": "McMaster-Carr",
            "unit_cost": 38,
            "lead_days": 2,
        },
        {"description": "C101 copper plate, 1 in", "quantity": 1.5, "unit": "ft", "lead_days": 21},
    ]
    response = read_in(team, alice, made, first, file="Elytra BOM.xlsx")
    assert response.status_code == 200, response.text
    assert {key: response.json()[key] for key in ("added", "changed", "removed")} == {
        "added": 3,
        "changed": 0,
        "removed": 0,
    }
    lines = bom(team, alice, made)
    assert [(line["part_number"], line["component_id"], line["status"]) for line in lines] == [
        ("SS-63TS8", mov["id"], "to_order"),
        ("91251A463", injector["id"], "to_order"),
        ("", None, "to_order"),  # not matched to a component
    ]
    assert (lines[0]["unit_cost"], lines[0]["lead_days"], lines[2]["quantity"], lines[2]["unit"]) == (
        41250,
        70,
        1.5,
        "ft",
    )
    assert "-: Read in the BOM from Elytra BOM.xlsx: 3 lines, 3 new, 0 changed, 0 taken off" in activity(
        team, alice, made
    )

    # The valve's ordered, and a note says so, on the site.
    valve = lines[0]
    ordered = team.client.patch(
        f"{API}/bom/lines/{valve['id']}", json={"status": "ordered", "note": "PO 1142"}, headers=alice
    )
    assert ordered.status_code == 200 and ordered.json()["status"] == "ordered"
    assert "Main oxidizer valve: BOM: SS-63TS8: ordered" in activity(team, alice, made)

    # Read in again: the valve kept (its status and note too), the screws' count changed, the plate gone, a new part.
    second = [
        {
            "component_id": mov["id"],
            "part_number": "ss-63ts8 ",
            "description": "1/2 in ball valve",
            "quantity": 1,
            "vendor": "Swagelok",
            "unit_cost": 41250,
            "lead_days": 70,
            "url": "https://www.swagelok.com/en/catalog",
        },
        {
            "component_id": injector["id"],
            "part_number": "91251A463",
            "description": "Socket head screw",
            "quantity": 16,
            "vendor": "McMaster-Carr",
            "unit_cost": 38,
            "lead_days": 2,
        },
        {
            "component_id": injector["id"],
            "part_number": "9452K33",
            "description": "O-ring, -214",
            "quantity": 4,
            "lead_days": 3,
            "status": "received",
        },
    ]
    again = read_in(team, alice, made, second, file="Elytra BOM.xlsx").json()
    assert {key: again[key] for key in ("added", "changed", "removed")} == {"added": 1, "changed": 2, "removed": 1}
    lines = bom(team, alice, made)
    assert [(line["part_number"], line["status"], line["note"]) for line in lines] == [
        ("ss-63ts8", "ordered", "PO 1142"),
        ("91251A463", "to_order", ""),
        ("9452K33", "received", ""),
    ]
    assert lines[0]["id"] == valve["id"]
    assert [line["part_number"] for line in bom(team, alice, made, component_id=injector["id"])] == [
        "91251A463",
        "9452K33",
    ]


def test_one_components_bom_read_in_leaves_the_rest(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, alice, made)
    mov, injector = named(bill, "Main oxidizer valve"), named(bill, "Injector")
    read_in(
        team,
        alice,
        made,
        [
            {"component_id": mov["id"], "part_number": "SS-63TS8"},
            {"component_id": injector["id"], "part_number": "91251A463"},
        ],
    )
    # The injector's own BOM: every line is the injector's, and the valve's stays.
    response = read_in(
        team, alice, made, [{"part_number": "9452K33"}, {"part_number": "91251A463"}], component_id=injector["id"]
    )
    assert response.status_code == 200, response.text
    assert [line["part_number"] for line in response.json()["lines"]] == ["9452K33", "91251A463"]
    assert {(line["part_number"], line["component_id"]) for line in bom(team, alice, made)} == {
        ("SS-63TS8", mov["id"]),
        ("9452K33", injector["id"]),
        ("91251A463", injector["id"]),
    }
    assert "Injector: Read in Injector's BOM from a spreadsheet: 2 lines, 1 new, 0 changed, 0 taken off" in activity(
        team, alice, made
    )


def test_a_bom_line_says_what_it_is_for_one_of_the_programs_own_components(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    other = opened(team, alice, program(team, chief, "Hopper", "hopper"))
    bill = opened(team, alice, made)

    nameless = read_in(team, alice, made, [{"quantity": 2}])
    assert nameless.status_code == 422
    bad = read_in(team, alice, made, [{"part_number": "X-1", "url": "javascript:alert(1)"}])
    assert bad.status_code == 400 and bad.json()["error"] == "bad_link"
    elsewhere = read_in(team, alice, made, [{"part_number": "X-1", "component_id": other["components"][0]["id"]}])
    assert elsewhere.status_code == 404
    igniter = named(bill, "Igniter")
    assert team.client.delete(f"{API}/components/{igniter['id']}", headers=chief).status_code == 200
    removed = read_in(team, alice, made, [{"part_number": "X-1", "component_id": igniter["id"]}])
    assert removed.status_code == 409 and removed.json()["error"] == "removed"
    assert bom(team, alice, made) == []  # nothing read in from any of them

    # A line added by hand, and taken off.
    added = team.client.post(
        f"{API}/programs/{made['id']}/bom/lines", json={"description": "Teflon tape"}, headers=alice
    )
    assert added.status_code == 201, added.text
    assert "-: Added to the BOM: Teflon tape" in activity(team, alice, made)
    assert team.client.delete(f"{API}/bom/lines/{added.json()['id']}", headers=alice).status_code == 204
    assert bom(team, alice, made) == []
    assert team.client.delete(f"{API}/bom/lines/{added.json()['id']}", headers=alice).status_code == 404

    assert team.client.post(f"{API}/programs/{made['id']}/archive", headers=chief).status_code == 200
    archived = read_in(team, alice, made, [{"part_number": "X-1"}])
    assert archived.status_code == 409 and archived.json()["error"] == "archived"
