"""Buildflow's build plan: each component's lead time (from ordering it, or starting it, to having it), the day it has
to be ready by, and the components that have to be ready before it can be started. Anyone keeps it, as they do
progress; what each component needs never goes round in a circle."""

from .test_buildflow import API, activity, named, opened, program


def change(team, who, component: dict, **body):
    return team.client.patch(f"{API}/components/{component['id']}", json=body, headers=who)


def needs(team, who, component: dict, *others: dict):
    body = {"component_ids": [other["id"] for other in others]}
    return team.client.put(f"{API}/components/{component['id']}/needs", json=body, headers=who)


def test_anyone_gives_a_component_its_lead_time_and_the_day_its_to_be_ready_by(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    regulator = named(opened(team, alice, made), "Pressure regulator")
    assert (regulator["lead_days"], regulator["need_by"], regulator["needs"]) == (None, None, [])

    planned = change(team, alice, regulator, lead_days=84, need_by="2027-03-01")
    assert planned.status_code == 200, planned.text
    assert (planned.json()["lead_days"], planned.json()["need_by"]) == (84, "2027-03-01")
    said = activity(team, alice, made)
    assert "Pressure regulator: Lead time: 12 weeks" in said
    assert "Pressure regulator: Ready by Mar 1, 2027" in said
    assert change(team, alice, regulator, lead_days=10).json()["lead_days"] == 10
    assert "Pressure regulator: Lead time: 10 days" in activity(team, alice, made)

    # Null takes them off; a lead time is days, not negative, and at most ten years.
    cleared = change(team, alice, regulator, lead_days=None, need_by=None)
    assert (cleared.json()["lead_days"], cleared.json()["need_by"]) == (None, None)
    assert "Pressure regulator: No lead time" in activity(team, alice, made)
    assert change(team, alice, regulator, lead_days=-1).status_code == 422
    assert change(team, alice, regulator, lead_days=4000).status_code == 422
    # Saying it again says nothing new.
    before = len(activity(team, alice, made))
    assert change(team, alice, regulator, lead_days=None).status_code == 200
    assert len(activity(team, alice, made)) == before


def test_a_component_needs_others_first_and_never_one_that_needs_it(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    bill = opened(team, alice, made)
    structure, chamber, injector, igniter = (
        named(bill, name) for name in ("Thrust structure", "Thrust chamber", "Injector", "Igniter")
    )

    said = needs(team, alice, structure, chamber, injector)
    assert said.status_code == 200, said.text
    assert said.json()["needs"] == [chamber["id"], injector["id"]]
    assert "Thrust structure: Needs first: Thrust chamber, Injector" in activity(team, alice, made)
    assert needs(team, alice, chamber, igniter).json()["needs"] == [igniter["id"]]

    # Not one that needs it, near or far; not itself.
    back = needs(team, alice, chamber, structure)
    assert back.status_code == 400 and back.json()["error"] == "needs_cycle"
    assert back.json()["message"].startswith("Thrust structure needs Thrust chamber already")
    far = needs(team, alice, igniter, structure)
    assert far.status_code == 400 and far.json()["error"] == "needs_cycle"
    assert "(through Thrust chamber)" in far.json()["message"]
    itself = needs(team, alice, igniter, igniter)
    assert itself.status_code == 400 and itself.json()["error"] == "needs_cycle"

    # Nothing first, as it's said.
    assert needs(team, alice, structure).json()["needs"] == []
    assert "Thrust structure: Needs nothing first" in activity(team, alice, made)


def test_what_a_component_needs_is_on_its_program_and_not_removed(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = program(team, chief)
    other = opened(team, alice, program(team, chief, "Hopper", "hopper"))
    bill = opened(team, alice, made)
    fins, nose = named(bill, "Fins"), named(bill, "Nose cone")

    assert needs(team, alice, fins, other["components"][0]).status_code == 404
    assert team.client.delete(f"{API}/components/{nose['id']}", headers=chief).status_code == 200
    gone = needs(team, alice, fins, nose)
    assert gone.status_code == 409 and gone.json()["error"] == "removed"

    # A component removed keeps what it needs, as everything said of it.
    assert team.client.post(f"{API}/components/{nose['id']}/restore", headers=chief).status_code == 200
    assert needs(team, alice, fins, nose).status_code == 200
    assert team.client.delete(f"{API}/components/{fins['id']}", headers=chief).status_code == 200
    removed = next(c for c in opened(team, chief, made)["removed"] if c["name"] == "Fins")
    assert removed["needs"] == [nose["id"]]
    assert team.client.post(f"{API}/programs/{made['id']}/archive", headers=chief).status_code == 200
    archived = change(team, alice, nose, lead_days=14)
    assert archived.status_code == 409 and archived.json()["error"] == "archived"
