"""Buildflow: the team's programs, each one's bill of design laid out by admins, and its components' progress, links,
and people, kept by anyone."""

from datetime import UTC, datetime

from yjsp_server.models import UserStatus

API = "/api/buildflow"


def program(team, who, name: str = "Elytra", template: str = "rocket", **more) -> dict:
    made = team.client.post(f"{API}/programs", json={"name": name, "template": template, **more}, headers=who)
    assert made.status_code == 201, made.text
    return made.json()


def opened(team, who, made: dict) -> dict:
    response = team.client.get(f"{API}/programs/{made['id']}", headers=who)
    assert response.status_code == 200, response.text
    return response.json()


def named(bill: dict, name: str) -> dict:
    return next(c for c in bill["components"] if c["name"] == name)


def stone(bill: dict, name: str) -> dict:
    return next(m for m in bill["milestones"] if m["name"] == name)


def progress(team, who, component: dict, milestone: dict, **body):
    return team.client.put(f"{API}/components/{component['id']}/progress/{milestone['id']}", json=body, headers=who)


def at(component: dict, milestone: dict) -> dict | None:
    return next((p for p in component["progress"] if p["milestone_id"] == milestone["id"]), None)


def activity(team, who, made: dict) -> list[str]:
    response = team.client.get(f"{API}/programs/{made['id']}/activity", headers=who)
    assert response.status_code == 200, response.text
    return [f"{e['component'] or '-'}: {e['what']}" for e in response.json()]


# --- programs are laid out by admins --------------------------------------------------------------------------------


def test_an_admin_makes_a_program_from_a_layout_and_everyone_sees_its_bill_of_design(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief, description="Our liquid rocket")
    assert (made["name"], made["description"], made["can_edit"]) == ("Elytra", "Our liquid rocket", True)

    bill = opened(team, alice, made)
    assert bill["can_edit"] is False
    assert [(m["phase"], m["name"]) for m in bill["milestones"]] == [
        ("design", "DCR"),
        ("design", "CoDR"),
        ("design", "PDR"),
        ("design", "CDR"),
        ("build", "Drawings"),
        ("build", "Procurement"),
        ("build", "Manufacturing"),
        ("build", "Inspection"),
        ("test", "TRR"),
        ("test", "Testing"),
        ("test", "QRR"),
        ("launch", "Integration"),
        ("launch", "FRR"),
        ("launch", "Flight"),
    ]
    assert stone(bill, "CDR")["title"] == "Critical Design Review" and stone(bill, "CDR")["review"] is True
    assert [s["name"] for s in bill["subsystems"]] == ["Propulsion", "Fluids", "Structures", "Avionics", "Recovery"]
    assert bill["component_count"] == len(bill["components"]) == 19
    mov = named(bill, "Main oxidizer valve")
    assert (mov["bought"], mov["x"], mov["y"], mov["progress"], mov["links"]) == (True, 30, 1.8, [], [])
    assert [s["kind"] for s in bill["profile"]["sections"]][:3] == ["engine", "body", "tank"]
    assert bill["removed"] == []
    # Every component starts not started in every phase.
    assert bill["phases"]["design"] == {"done": 0, "in_progress": 0, "blocked": 0, "not_started": 19, "skipped": 0}
    assert bill["last_milestone"] == {"design": "CDR", "build": "Inspection", "test": "QRR", "launch": "Flight"}

    listed = team.client.get(f"{API}/programs", headers=alice).json()
    assert [(p["name"], p["component_count"]) for p in listed] == [("Elytra", 19)]
    assert "components" not in listed[0]


def test_only_admins_lay_programs_out(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    refused = team.client.post(f"{API}/programs", json={"name": "Hopper"}, headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")

    made = program(team, chief, "Hopper", "hopper")
    bill = opened(team, chief, made)
    engine = named(bill, "Engine")
    for path, body in [
        (f"/programs/{made['id']}", {"name": "Hopper 2"}),
        (f"/programs/{made['id']}/milestones", {"phase": "test", "name": "Hotfire"}),
        (f"/programs/{made['id']}/subsystems", {"name": "Recovery"}),
        (f"/programs/{made['id']}/components", {"subsystem_id": bill["subsystems"][0]["id"], "name": "Gimbal"}),
        (f"/components/{engine['id']}", {"name": "Main engine"}),
        (f"/components/{engine['id']}", {"x": 1, "y": 2}),
    ]:
        method = team.client.post if path.endswith(("milestones", "subsystems", "components")) else team.client.patch
        response = method(f"{API}{path}", json=body, headers=alice)
        assert (response.status_code, response.json()["error"]) == (403, "admin_only"), path
    assert team.client.delete(f"{API}/components/{engine['id']}", headers=alice).status_code == 403
    assert team.client.post(f"{API}/programs/{made['id']}/archive", headers=alice).status_code == 403


def test_program_names_are_unique_whatever_their_case(team):
    chief = team.member("chief@x.test", admin=True)
    program(team, chief, "Felicette 2", "blank")
    taken = team.client.post(f"{API}/programs", json={"name": "FELICETTE 2"}, headers=chief)
    assert (taken.status_code, taken.json()["error"]) == (409, "name_taken")
    other = program(team, chief, "HETS", "stand")
    renamed = team.client.patch(f"{API}/programs/{other['id']}", json={"name": "felicette 2"}, headers=chief)
    assert (renamed.status_code, renamed.json()["error"]) == (409, "name_taken")


def test_a_blank_program_starts_with_the_milestones_alone(team):
    chief = team.member("chief@x.test", admin=True)
    bill = opened(team, chief, program(team, chief, "Felicette 2", "blank"))
    assert (len(bill["milestones"]), bill["subsystems"], bill["components"]) == (14, [], [])
    assert bill["profile"] == {"sections": [], "stand": False}


def test_an_admin_lays_a_program_out(team):
    chief = team.member("chief@x.test", admin=True)
    made = program(team, chief, "Felicette 2", "blank")
    sections = [
        {"kind": "engine", "length": 10, "diameter": 6, "count": 3},
        {"kind": "tank", "length": 40, "diameter": 6, "label": "Propellant", "fins": True},
        {"kind": "nose", "length": 20, "diameter": 6},
    ]
    drawn = team.client.patch(f"{API}/programs/{made['id']}", json={"profile": {"sections": sections}}, headers=chief)
    assert drawn.status_code == 200, drawn.text
    assert drawn.json()["profile"]["sections"][0] == {
        "kind": "engine",
        "length": 10,
        "diameter": 6,
        "label": "",
        "count": 3,
        "fins": False,
        "legs": False,
    }

    def add(path: str, body: dict) -> dict:
        response = team.client.post(f"{API}/programs/{made['id']}/{path}", json=body, headers=chief)
        assert response.status_code == 201, response.text
        return response.json()

    structures = add("subsystems", {"name": "Structures"})
    propulsion = add("subsystems", {"name": "Propulsion", "position": 0})
    fins = add("components", {"subsystem_id": structures["id"], "name": "Fins", "x": 15, "y": 5})
    nose = add("components", {"subsystem_id": structures["id"], "name": "Nose cone", "description": "Ogive"})
    motor = add("components", {"subsystem_id": propulsion["id"], "name": "Motor", "bought": True, "x": 5, "y": 0})
    assert (nose["x"], nose["y"], nose["description"], motor["bought"]) == (None, None, "Ogive", True)
    taken = team.client.post(
        f"{API}/programs/{made['id']}/components",
        json={"subsystem_id": structures["id"], "name": "fins"},
        headers=chief,
    )
    assert (taken.status_code, taken.json()["error"]) == (409, "name_taken")

    # The nose before the fins, then the fins into Propulsion, first.
    moved = team.client.patch(f"{API}/components/{nose['id']}", json={"position": 0, "x": 60, "y": 0}, headers=chief)
    assert (moved.json()["position"], moved.json()["x"]) == (0, 60)
    team.client.patch(
        f"{API}/components/{fins['id']}", json={"subsystem_id": propulsion["id"], "position": 0}, headers=chief
    )
    bill = opened(team, chief, made)
    assert [s["name"] for s in bill["subsystems"]] == ["Propulsion", "Structures"]
    assert [(c["name"], c["position"]) for c in bill["components"]] == [("Fins", 0), ("Motor", 1), ("Nose cone", 0)]
    # Off the drawing again: x and y null.
    off = team.client.patch(f"{API}/components/{nose['id']}", json={"x": None, "y": None}, headers=chief)
    assert (off.json()["x"], off.json()["y"]) == (None, None)
    assert activity(team, chief, made)[:3] == [
        "Fins: Moved it to Propulsion",
        "Motor: Added Motor to Propulsion",
        "Nose cone: Added Nose cone to Structures",
    ]


def test_a_vehicle_drawing_is_checked(team):
    chief = team.member("chief@x.test", admin=True)
    made = program(team, chief, "Hopper", "blank")
    for sections in (
        [{"kind": "wing", "length": 1, "diameter": 1}],
        [{"kind": "body", "length": 0, "diameter": 1}],
        [{"kind": "body", "length": 1, "diameter": -2}],
        [{"kind": "engine", "length": 1, "diameter": 1, "count": 12}],
        [{"kind": "body", "length": 1, "diameter": 1, "color": "red"}],
        [{"kind": "body", "length": 1, "diameter": 1}] * 41,
    ):
        refused = team.client.patch(
            f"{API}/programs/{made['id']}", json={"profile": {"sections": sections}}, headers=chief
        )
        assert refused.status_code == 422, sections


# --- progress is anyone's -------------------------------------------------------------------------------------------


def test_anyone_keeps_a_components_progress_and_the_activity_says_so(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, alice, made)
    tank, cdr, pdr = named(bill, "LOX tank"), stone(bill, "CDR"), stone(bill, "PDR")

    passed = progress(team, alice, tank, pdr, status="done", done_on="2026-10-02", note="Two actions: weld coupons")
    assert passed.status_code == 200, passed.text
    kept = at(passed.json(), pdr)
    assert (kept["status"], kept["done_on"], kept["note"], kept["updated_by"]["email"]) == (
        "done",
        "2026-10-02",
        "Two actions: weld coupons",
        "alice@x.test",
    )
    due = progress(team, alice, tank, cdr, status="in_progress", due="2026-12-04")
    assert at(due.json(), cdr)["due"] == "2026-12-04"
    # Done with no day said: today. Not done any more: no day.
    today = datetime.now(UTC).date().isoformat()
    assert at(progress(team, alice, tank, cdr, status="done").json(), cdr)["done_on"] == today
    assert (
        at(progress(team, alice, tank, cdr, status="blocked", note="Waiting on the weld").json(), cdr)["done_on"]
        is None
    )
    # What's left out stays: the due date, and the note.
    kept = at(progress(team, alice, tank, cdr, status="in_progress").json(), cdr)
    assert (kept["due"], kept["note"]) == ("2026-12-04", "Waiting on the weld")
    assert at(progress(team, alice, tank, cdr, due=None).json(), cdr)["due"] is None

    assert activity(team, chief, made)[:6] == [
        "LOX tank: CDR: no due date",
        "LOX tank: CDR: in progress",
        "LOX tank: CDR: blocked; note changed",
        "LOX tank: CDR: passed",
        "LOX tank: CDR: in progress; due Dec 4, 2026",
        "LOX tank: PDR: passed; note changed",
    ]
    assert opened(team, chief, made)["components"][5]["updated_by"]["email"] == "alice@x.test"


def test_a_change_that_changes_nothing_isnt_noted(team):
    chief = team.member("chief@x.test", admin=True)
    made = program(team, chief)
    bill = opened(team, chief, made)
    tank, cdr = named(bill, "LOX tank"), stone(bill, "CDR")
    progress(team, chief, tank, cdr, status="in_progress")
    before = activity(team, chief, made)
    assert progress(team, chief, tank, cdr, status="in_progress").status_code == 200
    assert progress(team, chief, named(bill, "Fins"), cdr, status="not_started").status_code == 200
    assert activity(team, chief, made) == before


def test_a_programs_summary_counts_its_components_in_each_phase(team):
    chief = team.member("chief@x.test", admin=True)
    made = program(team, chief)
    bill = opened(team, chief, made)
    design = [m for m in bill["milestones"] if m["phase"] == "design"]
    tank, fuel, fins, mov = (named(bill, n) for n in ("LOX tank", "Fuel tank", "Fins", "Main oxidizer valve"))
    for milestone in design:
        progress(team, chief, tank, milestone, status="done")
        progress(team, chief, fuel, milestone, status="done")
        progress(team, chief, mov, milestone, status="skipped")  # bought: no design reviews
    progress(team, chief, fins, design[0], status="done")
    progress(team, chief, fins, design[1], status="blocked")
    progress(team, chief, named(bill, "Igniter"), design[0], status="in_progress")

    summary = next(p for p in team.client.get(f"{API}/programs", headers=chief).json() if p["id"] == made["id"])
    assert summary["phases"]["design"] == {"done": 2, "in_progress": 1, "blocked": 1, "not_started": 14, "skipped": 1}
    assert summary["through"] == {"design": 2, "build": 0, "test": 0, "launch": 0}


def test_progress_needs_the_programs_own_milestone(team):
    chief = team.member("chief@x.test", admin=True)
    elytra = opened(team, chief, program(team, chief))
    hopper = opened(team, chief, program(team, chief, "Hopper", "hopper"))
    wrong = progress(team, chief, named(elytra, "Fins"), stone(hopper, "CDR"), status="done")
    assert wrong.status_code == 404
    unknown = progress(team, chief, named(elytra, "Fins"), stone(elytra, "CDR"), status="finished")
    assert unknown.status_code == 422


def test_links_are_web_addresses_or_the_sites_own_pages(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, alice, made)
    tank, cdr = named(bill, "LOX tank"), stone(bill, "CDR")

    def link(**body):
        return team.client.post(f"{API}/components/{tank['id']}/links", json={"phase": "design", **body}, headers=alice)

    cad = link(kind="cad", url="/vault/file/12", title="LOX tank assembly")
    assert cad.status_code == 201, cad.text
    slides = link(kind="review", url="https://docs.google.com/presentation/d/x", milestone_id=cdr["id"], phase="test")
    data = link(kind="data", url="/yorg?datasets=4", phase="test")
    assert data.status_code == 201
    links = slides.json()["links"]
    assert [(k["kind"], k["phase"], k["milestone_id"], k["title"]) for k in links] == [
        ("cad", "design", None, "LOX tank assembly"),
        ("review", "design", cdr["id"], ""),  # on CDR: in CDR's phase, whatever was said
    ]
    assert links[0]["added_by"]["email"] == "alice@x.test"
    for url in (
        "javascript:alert(1)",
        "data:text/html,hi",
        "//evil.example/x",
        "/\\evil.example",
        "ftp://x.test/a",
        "a b",
    ):
        refused = link(url=url)
        assert (refused.status_code, refused.json()["error"]) == (400, "bad_link"), url
    assert "a link is an http or https address" in link(url="javascript:x").json()["message"]
    assert link(url="").status_code == 422
    gone = team.client.delete(f"{API}/links/{links[0]['id']}", headers=chief)
    assert [k["kind"] for k in gone.json()["links"]] == ["review", "data"]
    assert team.client.delete(f"{API}/links/{links[0]['id']}", headers=chief).status_code == 404
    assert activity(team, chief, made)[:2] == [
        "LOX tank: Removed CAD: LOX tank assembly",
        "LOX tank: Added test data: /yorg?datasets=4",
    ]


def test_whos_on_a_component_in_each_phase(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.member("bob@x.test")
    team.member("carol@x.test", status=UserStatus.DISABLED)
    made = program(team, chief)
    bill = opened(team, alice, made)
    fins = named(bill, "Fins")
    ids = team.ids

    def people(phase: str, *emails: str):
        body = {"phase": phase, "user_ids": [ids[e] for e in emails]}
        return team.client.put(f"{API}/components/{fins['id']}/people", json=body, headers=alice)

    made_by = people("build", "bob@x.test", "alice@x.test", "bob@x.test")
    assert made_by.status_code == 200, made_by.text
    assert [(p["phase"], p["user"]["email"]) for p in made_by.json()["people"]] == [
        ("build", "bob@x.test"),
        ("build", "alice@x.test"),
    ]
    people("design", "alice@x.test")
    after = people("build", "alice@x.test").json()["people"]
    assert [(p["phase"], p["user"]["email"]) for p in after] == [("design", "alice@x.test"), ("build", "alice@x.test")]
    refused = people("test", "carol@x.test")
    assert (refused.status_code, refused.json()["error"]) == (400, "not_a_member")
    assert activity(team, chief, made)[:3] == [
        "Fins: Manufacturing: Alice",
        "Fins: Designing: Alice",
        "Fins: Manufacturing: Bob, Alice",
    ]


def test_anyone_describes_a_component_and_names_its_lead(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    fins = named(opened(team, alice, made), "Fins")
    changed = team.client.patch(
        f"{API}/components/{fins['id']}",
        json={"description": "Four, 1/8 in 6061", "lead_id": team.ids["alice@x.test"]},
        headers=alice,
    )
    assert changed.status_code == 200, changed.text
    assert (changed.json()["description"], changed.json()["lead"]["email"]) == ("Four, 1/8 in 6061", "alice@x.test")
    cleared = team.client.patch(f"{API}/components/{fins['id']}", json={"lead_id": None}, headers=alice)
    assert cleared.json()["lead"] is None
    nobody = team.client.patch(f"{API}/components/{fins['id']}", json={"lead_id": 9999}, headers=alice)
    assert (nobody.status_code, nobody.json()["error"]) == (400, "not_a_member")
    assert activity(team, chief, made)[:3] == ["Fins: No lead", "Fins: Lead: Alice", "Fins: Changed its description"]


# --- nothing said of a component is lost ----------------------------------------------------------------------------


def test_a_removed_component_keeps_everything_until_an_admin_brings_it_back(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, chief, made)
    fins, cdr = named(bill, "Fins"), stone(bill, "CDR")
    progress(team, alice, fins, cdr, status="done", note="Flutter margin 2.1")

    removed = team.client.delete(f"{API}/components/{fins['id']}", headers=chief)
    assert removed.status_code == 200 and removed.json()["removed_at"] is not None
    assert [c["name"] for c in opened(team, chief, made)["removed"]] == ["Fins"]
    assert opened(team, alice, made)["removed"] == []  # admins' to bring back
    assert "Fins" not in [c["name"] for c in opened(team, alice, made)["components"]]
    late = progress(team, alice, fins, cdr, status="blocked")
    assert (late.status_code, late.json()["error"]) == (409, "removed")

    back = team.client.post(f"{API}/components/{fins['id']}/restore", headers=chief)
    assert back.status_code == 200
    assert at(back.json(), cdr)["note"] == "Flutter margin 2.1"
    assert named(opened(team, alice, made), "Fins")["position"] == 3  # at the end of Structures, after the nose cone


def test_a_milestone_with_anything_kept_on_it_stays(team):
    chief = team.member("chief@x.test", admin=True)
    made = program(team, chief)
    bill = opened(team, chief, made)
    fins, dcr, qrr = named(bill, "Fins"), stone(bill, "DCR"), stone(bill, "QRR")
    progress(team, chief, fins, dcr, status="done")
    used = team.client.delete(f"{API}/milestones/{dcr['id']}", headers=chief)
    assert (used.status_code, used.json()["error"]) == (409, "milestone_in_use")
    assert "progress on 1 component" in used.json()["message"]
    team.client.post(
        f"{API}/components/{fins['id']}/links",
        json={"phase": "test", "url": "/x", "milestone_id": qrr["id"]},
        headers=chief,
    )
    linked = team.client.delete(f"{API}/milestones/{qrr['id']}", headers=chief)
    assert (linked.status_code, linked.json()["error"]) == (409, "milestone_in_use")

    # One only ever not started goes, its blank progress with it.
    flight = stone(bill, "Flight")
    progress(team, chief, fins, flight, status="in_progress")
    progress(team, chief, fins, flight, status="not_started")
    assert team.client.delete(f"{API}/milestones/{flight['id']}", headers=chief).status_code == 204
    after = opened(team, chief, made)
    assert [m["name"] for m in after["milestones"] if m["phase"] == "launch"] == ["Integration", "FRR"]
    assert after["last_milestone"]["launch"] == "FRR"


def test_milestones_are_renamed_and_moved_with_their_links(team):
    chief = team.member("chief@x.test", admin=True)
    made = program(team, chief)
    bill = opened(team, chief, made)
    fins, trr = named(bill, "Fins"), stone(bill, "TRR")
    team.client.post(
        f"{API}/components/{fins['id']}/links",
        json={"phase": "test", "url": "/x", "milestone_id": trr["id"]},
        headers=chief,
    )
    moved = team.client.patch(
        f"{API}/milestones/{trr['id']}", json={"phase": "build", "position": 0, "name": "MRR"}, headers=chief
    )
    assert moved.status_code == 200, moved.text
    after = opened(team, chief, made)
    assert [m["name"] for m in after["milestones"] if m["phase"] == "build"][:2] == ["MRR", "Drawings"]
    assert [m["name"] for m in after["milestones"] if m["phase"] == "test"] == ["Testing", "QRR"]
    assert named(after, "Fins")["links"][0]["phase"] == "build"
    taken = team.client.patch(f"{API}/milestones/{trr['id']}", json={"name": "cdr"}, headers=chief)
    assert (taken.status_code, taken.json()["error"]) == (409, "name_taken")
    added = team.client.post(
        f"{API}/programs/{made['id']}/milestones",
        json={"phase": "test", "name": "Hotfire", "title": "Static fire", "review": False, "position": 1},
        headers=chief,
    )
    assert added.status_code == 201
    assert [m["name"] for m in opened(team, chief, made)["milestones"] if m["phase"] == "test"] == [
        "Testing",
        "Hotfire",
        "QRR",
    ]


def test_a_subsystem_goes_only_once_its_empty(team):
    chief = team.member("chief@x.test", admin=True)
    made = program(team, chief)
    bill = opened(team, chief, made)
    recovery = next(s for s in bill["subsystems"] if s["name"] == "Recovery")
    full = team.client.delete(f"{API}/subsystems/{recovery['id']}", headers=chief)
    assert (full.status_code, full.json()["error"]) == (409, "not_empty")
    for part in ("Drogue parachute", "Main parachute"):
        team.client.delete(f"{API}/components/{named(bill, part)['id']}", headers=chief)
    removed_only = team.client.delete(f"{API}/subsystems/{recovery['id']}", headers=chief)
    assert (removed_only.status_code, removed_only.json()["error"]) == (409, "not_empty")
    assert "removed components" in removed_only.json()["message"]
    empty = team.client.post(f"{API}/programs/{made['id']}/subsystems", json={"name": "GSE"}, headers=chief).json()
    assert team.client.delete(f"{API}/subsystems/{empty['id']}", headers=chief).status_code == 204


def test_an_archived_program_is_kept_as_it_was(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief, "Hopper", "hopper")
    bill = opened(team, chief, made)
    archived = team.client.post(f"{API}/programs/{made['id']}/archive", headers=chief)
    assert archived.status_code == 200 and archived.json()["archived_at"] is not None
    assert team.client.get(f"{API}/programs", headers=alice).json() == []
    assert [p["name"] for p in team.client.get(f"{API}/programs?archived=true", headers=alice).json()] == ["Hopper"]
    late = progress(team, alice, named(bill, "Engine"), stone(bill, "CDR"), status="done")
    assert (late.status_code, late.json()["error"]) == (409, "archived")
    renamed = team.client.patch(f"{API}/programs/{made['id']}", json={"name": "Hopper 2"}, headers=chief)
    assert (renamed.status_code, renamed.json()["error"]) == (409, "archived")

    team.client.post(f"{API}/programs/{made['id']}/restore", headers=chief)
    assert progress(team, alice, named(bill, "Engine"), stone(bill, "CDR"), status="done").status_code == 200


def test_programs_are_in_the_order_admins_put_them_in(team):
    chief = team.member("chief@x.test", admin=True)
    for name in ("Hopper", "Elytra", "Felicette 2", "HETS"):
        program(team, chief, name, "blank")
    hets = next(p for p in team.client.get(f"{API}/programs", headers=chief).json() if p["name"] == "HETS")
    team.client.patch(f"{API}/programs/{hets['id']}", json={"position": 1}, headers=chief)
    listed = team.client.get(f"{API}/programs", headers=chief).json()
    assert [p["name"] for p in listed] == ["Hopper", "HETS", "Elytra", "Felicette 2"]


def test_someone_not_signed_in_sees_nothing(team, client):
    assert client.get(f"{API}/programs").status_code == 401
    pending = team.member("new@x.test", status=UserStatus.PENDING)
    assert client.get(f"{API}/programs", headers=pending).status_code == 403
