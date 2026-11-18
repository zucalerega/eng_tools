"""Buildflow's design reviews: a review held at one of a program's review milestones for several of its components at
once (a subsystem's PDR, say), its day each one's due date there, passing it passing each one, with its files and the
notes taken in it. Anyone keeps them, as they do progress."""

from .test_buildflow import API, activity, at, named, opened, program, progress, stone

FEED = ["Main oxidizer valve", "Main fuel valve", "LOX tank", "LOX vent valve", "Fuel tank", "Pressure regulator"]


def review(team, who, made: dict, **body):
    return team.client.post(f"{API}/programs/{made['id']}/reviews", json=body, headers=who)


def held(team, who, made: dict, **body) -> dict:
    response = review(team, who, made, **body)
    assert response.status_code == 201, response.text
    return response.json()


def change(team, who, found: dict, **body):
    return team.client.patch(f"{API}/reviews/{found['id']}", json=body, headers=who)


def ids(bill: dict, names: list[str]) -> list[int]:
    return [named(bill, name)["id"] for name in names]


def test_a_review_covers_several_components_and_its_day_is_each_ones_due_date(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, alice, made)
    pdr = stone(bill, "PDR")
    # One's PDR has passed already: the review leaves it as it is.
    assert progress(team, alice, named(bill, "LOX tank"), pdr, status="done", done_on="2026-10-01").status_code == 200

    found = held(
        team,
        alice,
        made,
        milestone_id=pdr["id"],
        name="Feed system PDR",
        held_on="2026-12-03",
        component_ids=ids(bill, FEED),
    )
    assert (found["name"], found["milestone_id"], found["held_on"], found["notes"]) == (
        "Feed system PDR",
        pdr["id"],
        "2026-12-03",
        "",
    )
    assert found["component_ids"] == ids(bill, FEED)
    assert found["created_by"]["email"] == "alice@x.test"

    bill = opened(team, alice, made)
    for name in FEED:
        kept = at(named(bill, name), pdr)
        if name == "LOX tank":
            assert (kept["status"], kept["due"], kept["done_on"]) == ("done", None, "2026-10-01")
        else:
            assert (kept["status"], kept["due"]) == ("not_started", "2026-12-03")
    assert at(named(bill, "Injector"), pdr) is None  # not in it
    assert [r["name"] for r in bill["reviews"]] == ["Feed system PDR"]
    listed = team.client.get(f"{API}/programs/{made['id']}/reviews", headers=alice).json()
    assert [r["id"] for r in listed] == [found["id"]]
    assert "-: Feed system PDR: a PDR for 6 components, on Dec 3, 2026" in activity(team, alice, made)
    assert "Main fuel valve: PDR: due Dec 3, 2026 (Feed system PDR)" in activity(team, alice, made)


def test_a_review_is_held_at_a_review_for_the_programs_own_components(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    other = program(team, chief, "Hopper", "hopper")
    bill = opened(team, alice, made)
    theirs = opened(team, alice, other)["components"][0]

    work = review(team, alice, made, milestone_id=stone(bill, "Manufacturing")["id"], name="Shop review")
    assert work.status_code == 400 and work.json()["error"] == "not_a_review"
    assert "Manufacturing is work, not a review" in work.json()["message"]
    elsewhere = review(
        team, alice, made, milestone_id=stone(bill, "CDR")["id"], name="CDR", component_ids=[theirs["id"]]
    )
    assert elsewhere.status_code == 404
    unknown = review(team, alice, made, milestone_id=stone(opened(team, alice, other), "CDR")["id"], name="CDR")
    assert unknown.status_code == 404

    # Not one removed from the program, nor in an archived program.
    removed = named(bill, "Igniter")
    assert team.client.delete(f"{API}/components/{removed['id']}", headers=chief).status_code == 200
    gone = review(team, alice, made, milestone_id=stone(bill, "CDR")["id"], name="CDR", component_ids=[removed["id"]])
    assert gone.status_code == 409 and gone.json()["error"] == "removed"
    assert team.client.post(f"{API}/programs/{made['id']}/archive", headers=chief).status_code == 200
    archived = review(team, alice, made, milestone_id=stone(bill, "CDR")["id"], name="CDR")
    assert archived.status_code == 409 and archived.json()["error"] == "archived"


def test_a_reviews_day_moves_its_components_due_dates_and_those_added_get_it(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, alice, made)
    cdr = stone(bill, "CDR")
    found = held(
        team,
        alice,
        made,
        milestone_id=cdr["id"],
        name="Fluids CDR",
        held_on="2027-01-12",
        component_ids=ids(bill, FEED[:2]),
    )

    # A new day for it is a new due date for each.
    moved = change(team, alice, found, held_on="2027-01-19")
    assert moved.status_code == 200 and moved.json()["held_on"] == "2027-01-19"
    bill = opened(team, alice, made)
    assert [at(named(bill, name), cdr)["due"] for name in FEED[:2]] == ["2027-01-19", "2027-01-19"]

    # One added gets its day; one taken off keeps the date it had.
    changed = change(team, alice, found, component_ids=ids(bill, ["Main fuel valve", "Fuel tank"]))
    assert changed.json()["component_ids"] == ids(bill, ["Main fuel valve", "Fuel tank"])
    bill = opened(team, alice, made)
    assert at(named(bill, "Fuel tank"), cdr)["due"] == "2027-01-19"
    assert at(named(bill, "Main oxidizer valve"), cdr)["due"] == "2027-01-19"
    said = activity(team, alice, made)
    assert "-: Fluids CDR: added Fuel tank" in said and "-: Fluids CDR: took off Main oxidizer valve" in said

    # No day yet takes the review's off them, and leaves a date of a component's own.
    assert progress(team, alice, named(bill, "Fuel tank"), cdr, due="2027-02-01").status_code == 200
    assert change(team, alice, found, held_on=None).json()["held_on"] is None
    bill = opened(team, alice, made)
    assert at(named(bill, "Main fuel valve"), cdr)["due"] is None
    assert at(named(bill, "Fuel tank"), cdr)["due"] == "2027-02-01"

    # Renamed, and its notes taken, it says so.
    renamed = change(team, alice, found, name="Feed system CDR", notes="- RFA 1: torque spec on the MOV flange")
    assert (renamed.json()["name"], renamed.json()["notes"]) == (
        "Feed system CDR",
        "- RFA 1: torque spec on the MOV flange",
    )
    said = activity(team, alice, made)
    assert "-: Renamed the review Fluids CDR to Feed system CDR" in said
    assert "-: Feed system CDR: notes changed" in said
    # A change that changes nothing says nothing.
    before = len(activity(team, alice, made))
    assert change(team, alice, found, name="Feed system CDR").status_code == 200
    assert len(activity(team, alice, made)) == before


def test_passing_a_review_passes_each_component_it_covers(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, alice, made)
    pdr = stone(bill, "PDR")
    # One that didn't need it, and one that passed earlier, stay as they are.
    assert progress(team, alice, named(bill, "LOX vent valve"), pdr, status="skipped").status_code == 200
    assert progress(team, alice, named(bill, "LOX tank"), pdr, status="done", done_on="2026-10-01").status_code == 200
    found = held(
        team,
        alice,
        made,
        milestone_id=pdr["id"],
        name="Feed system PDR",
        held_on="2026-12-03",
        component_ids=ids(bill, FEED),
    )

    passed = team.client.post(f"{API}/reviews/{found['id']}/pass", json={}, headers=alice)
    assert passed.status_code == 200, passed.text
    bill = opened(team, alice, made)
    statuses = {name: (at(named(bill, name), pdr)["status"], at(named(bill, name), pdr)["done_on"]) for name in FEED}
    assert statuses == {
        "Main oxidizer valve": ("done", "2026-12-03"),
        "Main fuel valve": ("done", "2026-12-03"),
        "LOX tank": ("done", "2026-10-01"),
        "LOX vent valve": ("skipped", None),
        "Fuel tank": ("done", "2026-12-03"),
        "Pressure regulator": ("done", "2026-12-03"),
    }
    said = activity(team, alice, made)
    assert "-: Feed system PDR: passed, 4 components" in said
    assert "Fuel tank: PDR: passed (Feed system PDR)" in said

    # Each one's progress is still its own: one back with actions to close.
    regulator = named(bill, "Pressure regulator")
    assert progress(team, alice, regulator, pdr, status="in_progress", note="RFA: relief setting").status_code == 200
    # Passing it again passes only that one, on the day said.
    again = team.client.post(f"{API}/reviews/{found['id']}/pass", json={"done_on": "2026-12-10"}, headers=alice)
    assert again.status_code == 200
    kept = at(named(opened(team, alice, made), "Pressure regulator"), pdr)
    assert (kept["status"], kept["done_on"], kept["note"]) == ("done", "2026-12-10", "RFA: relief setting")
    assert "-: Feed system PDR: passed, 1 component" in activity(team, alice, made)


def test_a_reviews_files_are_links_and_removing_it_keeps_it(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, alice, made)
    found = held(team, alice, made, milestone_id=stone(bill, "CDR")["id"], name="Avionics CDR")
    files = f"{API}/reviews/{found['id']}/files"

    slides = "https://team.sharepoint.com/sites/rocketry/Shared%20Documents/Reviews/Avionics%20CDR.pptx"
    added = team.client.post(files, json={"url": slides, "title": "Slides"}, headers=alice)
    assert added.status_code == 201, added.text
    [kept] = added.json()["files"]
    assert (kept["title"], kept["url"], kept["added_by"]["email"]) == ("Slides", slides, "alice@x.test")
    bad = team.client.post(files, json={"url": "javascript:alert(1)"}, headers=alice)
    assert bad.status_code == 400 and bad.json()["error"] == "bad_link"
    assert "isn't a link a review can have" in bad.json()["message"]
    assert "-: Avionics CDR: added Slides" in activity(team, alice, made)

    gone = team.client.delete(f"{files}/{kept['id']}", headers=alice)
    assert gone.status_code == 200 and gone.json()["files"] == []
    assert team.client.delete(f"{files}/{kept['id']}", headers=alice).status_code == 404

    # Removed, it's kept, off the program's list, changed by no one until it's brought back.
    removed = team.client.delete(f"{API}/reviews/{found['id']}", headers=alice)
    assert removed.status_code == 200 and removed.json()["removed_at"] is not None
    assert opened(team, alice, made)["reviews"] == []
    back_list = team.client.get(f"{API}/programs/{made['id']}/reviews", params={"removed": True}, headers=alice)
    assert [r["id"] for r in back_list.json()] == [found["id"]]
    refused = change(team, alice, found, notes="Late notes")
    assert refused.status_code == 409 and refused.json()["error"] == "removed"
    assert team.client.post(f"{API}/reviews/{found['id']}/restore", headers=alice).status_code == 200
    assert [r["name"] for r in opened(team, alice, made)["reviews"]] == ["Avionics CDR"]


def test_a_component_removed_stays_in_its_review_and_a_milestone_with_reviews_stays(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, alice, made)
    pdr = stone(bill, "PDR")
    found = held(
        team,
        alice,
        made,
        milestone_id=pdr["id"],
        name="Recovery PDR",
        component_ids=ids(bill, ["Drogue parachute", "Main parachute"]),
    )
    main = named(bill, "Main parachute")

    # Removed from the program, it stays in the review, and the review's changes leave it be.
    assert team.client.delete(f"{API}/components/{main['id']}", headers=chief).status_code == 200
    kept = change(team, alice, found, component_ids=ids(bill, ["Drogue parachute"]))
    assert kept.json()["component_ids"] == ids(bill, ["Drogue parachute", "Main parachute"])
    passed = team.client.post(f"{API}/reviews/{found['id']}/pass", json={"done_on": "2026-12-01"}, headers=alice)
    assert passed.status_code == 200
    assert "-: Recovery PDR: passed, 1 component" in activity(team, alice, made)
    assert team.client.post(f"{API}/components/{main['id']}/restore", headers=chief).status_code == 200
    assert at(named(opened(team, alice, made), "Main parachute"), pdr) is None  # not passed while it was off

    # A milestone a review's held at stays: rename it instead.
    refused = team.client.delete(f"{API}/milestones/{stone(bill, 'PDR')['id']}", headers=chief)
    assert refused.status_code == 409 and refused.json()["error"] == "milestone_in_use"
    assert "1 review" in refused.json()["message"]
