"""Buildflow's shop, from the team's machining tracker: the parts queued to be machined (anyone keeps the queue), how far
each person's trained on each machine (each says their own; admins anyone's), and the machines (admins')."""

from yjsp_server.models import UserStatus

from .test_buildflow import API, activity, named, opened, program

SHOP = f"{API}/shop"


def the_shop(team, who, **params) -> dict:
    response = team.client.get(SHOP, params=params, headers=who)
    assert response.status_code == 200, response.text
    return response.json()


def machine_id(team, who, name: str) -> int:
    return next(m["id"] for m in the_shop(team, who)["machines"] if m["name"] == name)


def queue(team, who, **body):
    return team.client.post(f"{SHOP}/parts", json=body, headers=who)


def queued(team, who, **body) -> dict:
    made = queue(team, who, **body)
    assert made.status_code == 201, made.text
    return made.json()


def change(team, who, part: dict, **body):
    return team.client.patch(f"{SHOP}/parts/{part['id']}", json=body, headers=who)


def load_of(shop: dict, machine: int) -> dict:
    return next(each for each in shop["load"] if each["machine_id"] == machine)


# --- the queue ------------------------------------------------------------------------------------------------------


def test_anyone_queues_a_part_they_asked_for_and_moves_it_through_the_queue(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    mill = machine_id(team, alice, "Mill")
    part = queued(
        team,
        alice,
        name="Injector faceplate",
        machine_id=mill,
        material="C101 copper",
        quantity=2,
        hours=6.5,
        drawing="/vault/file/12",
        cad="https://cad.example.org/faceplate",
        need_by="2026-12-04",
    )
    assert (part["status"], part["requester"]["email"], part["machinist"]) == ("queued", "alice@x.test", None)
    assert (part["material"], part["quantity"], part["hours"], part["drawing"]) == (
        "C101 copper",
        2,
        6.5,
        "/vault/file/12",
    )

    # Bob picks it up, and makes it.
    started = change(team, bob, part, status="in_progress", machinist_id=team.ids["bob@x.test"])
    assert started.status_code == 200, started.text
    assert (started.json()["status"], started.json()["machinist"]["email"]) == ("in_progress", "bob@x.test")
    assert started.json()["updated_by"]["email"] == "bob@x.test"
    shop = the_shop(team, alice)
    assert (load_of(shop, mill)["parts"], load_of(shop, mill)["hours"]) == (1, 6.5)
    done = change(team, bob, part, status="done").json()
    assert done["done_at"] is not None
    assert load_of(the_shop(team, alice), mill)["parts"] == 0
    # Not done after all: it isn't done on any day.
    assert change(team, bob, part, status="blocked", note="Out of copper").json()["done_at"] is None


def test_the_queue_shows_whats_under_way_then_held_up_then_waiting_then_done(team):
    alice = team.member("alice@x.test")
    lathe = machine_id(team, alice, "Lathe")
    names = ["Waiting later", "Done", "Under way", "Held up", "Waiting sooner"]
    made = {name: queued(team, alice, name=name, machine_id=lathe) for name in names}
    change(team, alice, made["Done"], status="done")
    change(team, alice, made["Under way"], status="in_progress")
    change(team, alice, made["Held up"], status="blocked")
    change(team, alice, made["Waiting sooner"], need_by="2026-11-20")
    change(team, alice, made["Waiting later"], need_by="2026-12-20")
    order = [p["name"] for p in the_shop(team, alice)["parts"]]
    assert order == ["Under way", "Held up", "Waiting sooner", "Waiting later", "Done"]


def test_someone_else_can_be_who_asked_for_a_part_but_only_a_member(team):
    alice = team.member("alice@x.test")
    team.member("carol@x.test")
    team.member("gone@x.test", status=UserStatus.DISABLED)
    mill = machine_id(team, alice, "Mill")
    for_carol = queued(team, alice, name="Bracket", machine_id=mill, requester_id=team.ids["carol@x.test"])
    assert for_carol["requester"]["email"] == "carol@x.test"
    no_one = queued(team, alice, name="Spacer", machine_id=mill, requester_id=None)
    assert no_one["requester"] is None
    for bad in (9999, team.ids["gone@x.test"]):
        refused = queue(team, alice, name="Shim", machine_id=mill, machinist_id=bad)
        assert (refused.status_code, refused.json()["error"]) == (400, "not_a_member")


def test_a_parts_drawing_and_cad_are_links_as_a_components_are(team):
    alice = team.member("alice@x.test")
    mill = machine_id(team, alice, "Mill")
    for address in ("javascript:alert(1)", "//elsewhere.example.org/x", "data:text/html,hi"):
        refused = queue(team, alice, name="Plate", machine_id=mill, drawing=address)
        assert (refused.status_code, refused.json()["error"]) == (400, "bad_link"), address
    part = queued(team, alice, name="Plate", machine_id=mill, cad="/vault/file/7")
    assert change(team, alice, part, drawing="ftp://x.example.org/a").json()["error"] == "bad_link"
    assert change(team, alice, part, cad="").json()["cad"] == ""


def test_taking_a_part_off_the_queue_keeps_it_to_put_back(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    part = queued(team, alice, name="Fin can ring", machine_id=machine_id(team, alice, "Lathe"))
    taken = team.client.delete(f"{SHOP}/parts/{part['id']}", headers=bob)
    assert taken.status_code == 200 and taken.json()["removed_at"] is not None
    assert the_shop(team, alice)["parts"] == []
    assert [p["name"] for p in the_shop(team, alice, removed=True)["parts"]] == ["Fin can ring"]
    refused = change(team, alice, part, quantity=3)
    assert (refused.status_code, refused.json()["error"]) == (409, "removed")
    back = team.client.post(f"{SHOP}/parts/{part['id']}/restore", headers=alice)
    assert back.status_code == 200 and back.json()["removed_at"] is None
    assert [p["name"] for p in the_shop(team, alice)["parts"]] == ["Fin can ring"]


# --- parts for a program's components -------------------------------------------------------------------------------


def test_a_part_for_a_component_shows_on_its_program(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    injector = named(opened(team, alice, made), "Injector")
    mill = machine_id(team, alice, "Mill")
    part = queued(team, alice, name="Injector faceplate", machine_id=mill, component_id=injector["id"])
    assert (part["program"], part["component"]) == (
        {"id": made["id"], "name": "Elytra"},
        {"id": injector["id"], "name": "Injector"},
    )
    queued(team, alice, name="Something else", machine_id=mill)
    for_it = team.client.get(f"{SHOP}/parts", params={"component_id": injector["id"]}, headers=alice).json()
    assert [p["name"] for p in for_it] == ["Injector faceplate"]
    change(team, alice, part, status="done")
    assert activity(team, alice, made)[:2] == [
        "Injector: Injector faceplate, in the shop: done",
        "Injector: Queued Injector faceplate in the shop, on the Mill",
    ]

    # For the program as a whole, or for nothing at all.
    whole = change(team, alice, part, program_id=made["id"]).json()
    assert (whole["program"]["name"], whole["component"]) == ("Elytra", None)
    neither = change(team, alice, part, component_id=None).json()
    assert (neither["program"], neither["component"]) == (None, None)


def test_a_part_cant_be_for_a_component_removed_or_an_archived_program(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, alice, made)
    fins, igniter = named(bill, "Fins"), named(bill, "Igniter")
    mill = machine_id(team, alice, "Mill")
    part = queued(team, alice, name="Igniter boss", machine_id=mill, component_id=igniter["id"])
    assert team.client.delete(f"{API}/components/{fins['id']}", headers=chief).status_code == 200
    refused = queue(team, alice, name="Fin", machine_id=mill, component_id=fins["id"])
    assert (refused.status_code, refused.json()["error"]) == (409, "removed")

    assert team.client.post(f"{API}/programs/{made['id']}/archive", headers=chief).status_code == 200
    refused = queue(team, alice, name="Another boss", machine_id=mill, component_id=igniter["id"])
    assert (refused.status_code, refused.json()["error"]) == (409, "archived")
    # One for it already is the shop's to finish.
    assert change(team, alice, part, status="done", component_id=igniter["id"]).status_code == 200


# --- who's trained on what ------------------------------------------------------------------------------------------


def test_each_person_says_how_far_theyre_trained_and_admins_can_say_anyones(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.member("bob@x.test")
    mill, lathe = machine_id(team, alice, "Mill"), machine_id(team, alice, "Lathe")
    mine = team.client.put(
        f"{SHOP}/skills/{team.ids['alice@x.test']}", json={"levels": {mill: 2, lathe: 1}}, headers=alice
    )
    assert mine.status_code == 200, mine.text
    assert mine.json()["levels"] == {str(mill): 2, str(lathe): 1}
    refused = team.client.put(f"{SHOP}/skills/{team.ids['bob@x.test']}", json={"levels": {mill: 3}}, headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
    by_admin = team.client.put(f"{SHOP}/skills/{team.ids['bob@x.test']}", json={"levels": {mill: 3}}, headers=chief)
    assert by_admin.status_code == 200, by_admin.text

    shop = the_shop(team, alice)
    assert [(t["user"]["email"], t["levels"]) for t in shop["trained"]] == [
        ("alice@x.test", {str(mill): 2, str(lathe): 1}),
        ("bob@x.test", {str(mill): 3}),
    ]
    # Who can make the mill's parts: those who run it on their own, and train others on it.
    assert (load_of(shop, mill)["operators"], load_of(shop, mill)["trainers"]) == (2, 1)
    assert (load_of(shop, lathe)["operators"], load_of(shop, lathe)["trainers"]) == (0, 0)

    # Back to not trained; machines left out stay as they were.
    team.client.put(f"{SHOP}/skills/{team.ids['alice@x.test']}", json={"levels": {lathe: 0}}, headers=alice)
    assert the_shop(team, alice)["trained"][0]["levels"] == {str(mill): 2}
    for bad in ({mill: 4}, {mill: -1}):
        response = team.client.put(f"{SHOP}/skills/{team.ids['alice@x.test']}", json={"levels": bad}, headers=alice)
        assert response.status_code == 422
    unknown = team.client.put(f"{SHOP}/skills/{team.ids['alice@x.test']}", json={"levels": {999: 1}}, headers=alice)
    assert unknown.status_code == 404


def test_someone_whos_left_the_team_runs_nothing(team):
    chief = team.member("chief@x.test", admin=True)
    team.member("dana@x.test")
    mill = machine_id(team, chief, "Mill")
    team.client.put(f"{SHOP}/skills/{team.ids['dana@x.test']}", json={"levels": {mill: 3}}, headers=chief)
    assert load_of(the_shop(team, chief), mill)["operators"] == 1
    disabled = team.client.patch(f"/api/users/{team.ids['dana@x.test']}", json={"status": "disabled"}, headers=chief)
    assert disabled.status_code == 200, disabled.text
    shop = the_shop(team, chief)
    assert (shop["trained"], load_of(shop, mill)["operators"]) == ([], 0)


# --- the machines (admins) ------------------------------------------------------------------------------------------


def test_the_shop_starts_with_the_trackers_machines_and_admins_keep_the_list(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    shop = the_shop(team, alice)
    assert [m["name"] for m in shop["machines"]] == ["Lathe", "Mill", "Waterjet", "CNC"]
    assert shop["can_edit_machines"] is False and the_shop(team, chief)["can_edit_machines"] is True

    refused = team.client.post(f"{SHOP}/machines", json={"name": "Laser cutter"}, headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
    laser = team.client.post(f"{SHOP}/machines", json={"name": "Laser cutter"}, headers=chief).json()
    taken = team.client.post(f"{SHOP}/machines", json={"name": "laser CUTTER"}, headers=chief)
    assert (taken.status_code, taken.json()["error"]) == (409, "name_taken")
    renamed = team.client.patch(f"{SHOP}/machines/{laser['id']}", json={"name": "CO2 laser"}, headers=chief)
    assert renamed.json()["name"] == "CO2 laser"

    # Retired, it takes no new parts, and keeps those made on it.
    part = queued(team, alice, name="Gasket", machine_id=laser["id"])
    retired = team.client.patch(f"{SHOP}/machines/{laser['id']}", json={"retired": True}, headers=chief)
    assert retired.json()["retired"] is True
    refused = queue(team, alice, name="Another gasket", machine_id=laser["id"])
    assert (refused.status_code, refused.json()["error"]) == (409, "machine_retired")
    assert change(team, alice, part, status="done").status_code == 200
    assert [each["machine_id"] for each in the_shop(team, alice)["load"]] == [
        m["id"] for m in shop["machines"]
    ]  # a retired machine has no load to show
    team.client.patch(f"{SHOP}/machines/{laser['id']}", json={"retired": False}, headers=chief)
    assert queue(team, alice, name="Another gasket", machine_id=laser["id"]).status_code == 201


# --- where people are trained ---------------------------------------------------------------------------------------


def place(team, who, name: str) -> dict:
    made = team.client.post(f"{SHOP}/places", json={"name": name}, headers=who)
    assert made.status_code == 201, made.text
    return made.json()


def test_admins_keep_the_places_people_are_trained_in(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    assert the_shop(team, alice)["places"] == []  # each school has its own: admins add them

    refused = team.client.post(f"{SHOP}/places", json={"name": "Makerspace"}, headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
    shop_floor, makerspace = place(team, chief, "Machine shop"), place(team, chief, "Makerspace")
    taken = team.client.post(f"{SHOP}/places", json={"name": "MAKERSPACE "}, headers=chief)
    assert (taken.status_code, taken.json()["error"]) == (409, "name_taken")
    assert "There's a place called Makerspace already" in taken.json()["message"]
    renamed = team.client.patch(f"{SHOP}/places/{makerspace['id']}", json={"name": "Student makerspace"}, headers=chief)
    assert renamed.json()["name"] == "Student makerspace"
    refused = team.client.patch(f"{SHOP}/places/{shop_floor['id']}", json={"retired": True}, headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
    unknown = team.client.patch(f"{SHOP}/places/999", json={"retired": True}, headers=chief)
    assert unknown.status_code == 404

    # Retired, it's still listed, to bring back, and keeps who was trained there.
    team.client.put(f"{SHOP}/skills/{team.ids['alice@x.test']}", json={"places": {shop_floor["id"]: 2}}, headers=alice)
    retired = team.client.patch(f"{SHOP}/places/{shop_floor['id']}", json={"retired": True}, headers=chief)
    assert retired.json()["retired"] is True
    shop = the_shop(team, alice)
    assert [(p["name"], p["retired"]) for p in shop["places"]] == [
        ("Machine shop", True),
        ("Student makerspace", False),
    ]
    assert shop["trained"][0]["places"] == {str(shop_floor["id"]): 2}
    # A place and a machine are kept apart: one can be called what the other is.
    assert team.client.post(f"{SHOP}/places", json={"name": "Lathe"}, headers=chief).status_code == 201


def test_each_person_says_where_theyre_trained_and_admins_can_say_anyones(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.member("bob@x.test")
    shop_floor, makerspace = place(team, chief, "Machine shop"), place(team, chief, "Makerspace")
    mill = machine_id(team, alice, "Mill")
    mine = team.client.put(
        f"{SHOP}/skills/{team.ids['alice@x.test']}",
        json={"levels": {mill: 2}, "places": {shop_floor["id"]: 2, makerspace["id"]: 1}},
        headers=alice,
    )
    assert mine.status_code == 200, mine.text
    assert (mine.json()["levels"], mine.json()["places"]) == (
        {str(mill): 2},
        {str(shop_floor["id"]): 2, str(makerspace["id"]): 1},
    )
    bobs = f"{SHOP}/skills/{team.ids['bob@x.test']}"
    refused = team.client.put(bobs, json={"places": {makerspace["id"]: 3}}, headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
    # Bob's trained only at the makerspace, where he trains others: he's on the list all the same.
    assert team.client.put(bobs, json={"places": {makerspace["id"]: 3}}, headers=chief).status_code == 200
    shop = the_shop(team, alice)
    assert [(t["user"]["email"], t["levels"], t["places"]) for t in shop["trained"]] == [
        ("alice@x.test", {str(mill): 2}, {str(shop_floor["id"]): 2, str(makerspace["id"]): 1}),
        ("bob@x.test", {}, {str(makerspace["id"]): 3}),
    ]
    # A place's training doesn't make someone a machine's operator.
    assert load_of(shop, mill)["operators"] == 1

    # Back to not trained there; the machines and places left out stay as they were.
    alices = f"{SHOP}/skills/{team.ids['alice@x.test']}"
    team.client.put(alices, json={"places": {makerspace["id"]: 0}}, headers=alice)
    assert the_shop(team, alice)["trained"][0]["levels"] == {str(mill): 2}
    assert the_shop(team, alice)["trained"][0]["places"] == {str(shop_floor["id"]): 2}
    for bad in ({shop_floor["id"]: 4}, {shop_floor["id"]: -1}):
        assert team.client.put(alices, json={"places": bad}, headers=alice).status_code == 422
    unknown = team.client.put(alices, json={"places": {999: 1}}, headers=alice)
    assert unknown.status_code == 404
    # Nothing's said when one of them isn't there: not the machine's level either.
    assert team.client.put(alices, json={"levels": {mill: 3}, "places": {999: 1}}, headers=alice).status_code == 404
    assert the_shop(team, alice)["trained"][0]["levels"] == {str(mill): 2}

    # Someone who's left the team isn't counted anywhere.
    disabled = team.client.patch(f"/api/users/{team.ids['bob@x.test']}", json={"status": "disabled"}, headers=chief)
    assert disabled.status_code == 200, disabled.text
    assert [t["user"]["email"] for t in the_shop(team, chief)["trained"]] == ["alice@x.test"]
