"""Piper: the team's diagrams, their drawings saved one version at a time, their history, and their releases."""

import hashlib
import json
import struct
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from sqlalchemy import select

from yjsp_server.models import User, UserStatus
from yjsp_server.piper import diagrams
from yjsp_server.piper.models import Diagram, Revision
from yjsp_server.piper.releases import letter

API = "/api/piper/diagrams"
EMPTY = {"format": 1, "parts": [], "lines": [], "fluids": [], "style": {}}


def part(id: str, kind: str = "ball_valve", x: float = 0, y: float = 0, **more) -> dict:
    return {"id": id, "kind": kind, "x": x, "y": y, **more}


def line(id: str, start: str, end: str, **more) -> dict:
    return {"id": id, "from": {"part": start, "port": "out"}, "to": {"part": end, "port": "in"}, **more}


def drawing(*parts, lines: tuple = (), **more) -> dict:
    return {**EMPTY, "parts": list(parts), "lines": list(lines), **more}


def pages(*sheets: tuple[str, dict], **more) -> dict:
    """A drawing of format 2: each page's id, and what's on it (a drawing())."""
    listed = [{"id": id, "name": id.upper(), "parts": on["parts"], "lines": on["lines"]} for id, on in sheets]
    return {"format": 2, "pages": listed, "fluids": [], "style": {}, **more}


def make(team, who, name: str = "Feed system", **body) -> dict:
    made = team.client.post(API, json={"name": name, **body}, headers=who)
    assert made.status_code == 201, made.text
    return made.json()


def opened(team, who, diagram: dict) -> dict:
    response = team.client.get(f"{API}/{diagram['id']}", headers=who)
    assert response.status_code == 200, response.text
    return response.json()


def save(team, who, diagram: dict, sent, version: int, **more):
    body = {"drawing": sent, "version": version, **more}
    return team.client.put(f"{API}/{diagram['id']}/drawing", json=body, headers=who)


def saved(team, who, diagram: dict, sent: dict, version: int, **more) -> dict:
    response = save(team, who, diagram, sent, version, **more)
    assert response.status_code == 200, response.text
    return response.json()


def history(team, who, diagram: dict) -> list[tuple[int, str, str, int | None]]:
    """Its revisions, the latest first: each one's number, author, name, and the revision it was restored from."""
    response = team.client.get(f"{API}/{diagram['id']}/revisions", headers=who)
    assert response.status_code == 200, response.text
    return [(r["number"], r["author"]["email"], r["note"], r["restored_from"]) for r in response.json()]


def kept(team, who, diagram: dict, number: int) -> dict:
    response = team.client.get(f"{API}/{diagram['id']}/revisions/{number}", headers=who)
    assert response.status_code == 200, response.text
    return response.json()


def lock(team, who, diagram: dict, **body):
    """Start editing a diagram (or say you're still at it)."""
    return team.client.post(f"{API}/{diagram['id']}/lock", json=body or None, headers=who)


def editing(team, who, diagram: dict) -> str | None:
    """Who's editing a diagram, by their email, as the diagram's lock says."""
    response = team.client.get(f"{API}/{diagram['id']}/lock", headers=who)
    assert response.status_code == 200, response.text
    held = response.json()["editing"]
    return held["by"]["email"] if held else None


def age_lock(team, diagram: dict, minutes: int) -> None:
    """As if whoever's editing a diagram had last said so `minutes` earlier."""
    with team.app.state.sessionmaker() as db:
        found = db.get(Diagram, diagram["id"])
        found.lock_seen_at -= timedelta(minutes=minutes)
        db.commit()


def age(team, diagram: dict, number: int, minutes: int) -> None:
    """As if a revision had begun `minutes` earlier."""
    with team.app.state.sessionmaker() as db:
        found = db.scalar(select(Revision).where(Revision.diagram_id == diagram["id"], Revision.number == number))
        found.created_at -= timedelta(minutes=minutes)
        db.commit()


# --- diagrams are the team's --------------------------------------------------------------------------------------


def test_everyone_approved_makes_opens_and_saves_any_diagram(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    made = make(team, alice, folder="Vespula/GSE", description="LOX and RP-1 to the engine")
    assert (made["version"], made["revision"], made["parts"], made["lines"], made["fluids"]) == (1, 1, 0, 0, [])
    assert made["drawing"] == EMPTY  # none given: an empty one
    assert (made["created_by"]["email"], made["updated_by"]["email"]) == ("alice@x.test", "alice@x.test")
    assert made["deleted_at"] is None

    listed = team.client.get(API, headers=bob).json()
    assert [(d["name"], d["folder"], d["description"], d["can_delete"]) for d in listed] == [
        ("Feed system", "Vespula/GSE", "LOX and RP-1 to the engine", False)
    ]
    assert "drawing" not in listed[0]

    sent = drawing(
        part("v1", tag="BV-1"),
        part("t1", kind="tank", x=-200, tag="T-1"),
        lines=(line("l1", "t1", "v1", fluid="LOX"), line("l2", "v1", "t1", fluid="LOX")),
    )
    after = saved(team, bob, made, sent, 1)
    assert "drawing" not in after
    assert (after["version"], after["revision"]) == (2, 2)  # his save begins a revision of his own
    assert (after["parts"], after["lines"], after["fluids"]) == (2, 2, ["LOX"])
    assert (after["created_by"]["email"], after["updated_by"]["email"]) == ("alice@x.test", "bob@x.test")
    assert opened(team, alice, made)["drawing"] == sent


def test_piper_is_for_approved_members(team):
    alice = team.member("alice@x.test")
    waiting = team.member("new@x.test", status=UserStatus.PENDING)
    made = make(team, alice)
    refused = team.client.post(API, json={"name": "Mine"}, headers=waiting)
    assert (refused.status_code, refused.json()["error"]) == (403, "pending_approval")
    assert team.client.get(API, headers=waiting).status_code == 403
    assert team.client.get(f"{API}/{made['id']}", headers=waiting).status_code == 403
    assert save(team, waiting, made, drawing(), 1).status_code == 403
    assert team.client.get(API).status_code == 401


def test_renaming_moving_and_describing_leave_the_drawing_alone(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    made = make(team, alice, folder=" Vespula \\ GSE// ")  # a path, tidied as Yorg's views' are
    assert made["folder"] == "Vespula/GSE"
    url = f"{API}/{made['id']}"

    changed = team.client.patch(url, json={"name": " Feed system, rev B ", "folder": "Vespula"}, headers=bob).json()
    assert (changed["name"], changed["folder"], changed["description"]) == ("Feed system, rev B", "Vespula", "")
    assert (changed["version"], changed["updated_by"]["email"]) == (1, "bob@x.test")
    described = team.client.patch(url, json={"description": "Both tanks"}, headers=alice).json()
    assert (described["name"], described["folder"]) == ("Feed system, rev B", "Vespula")  # what's left out stays
    assert described["description"] == "Both tanks"
    assert team.client.patch(url, json={"folder": ""}, headers=alice).json()["folder"] == ""  # to the top
    # A save from before the changes is still taken: they aren't changes to the drawing.
    assert saved(team, alice, made, drawing(part("v1")), 1)["version"] == 2

    assert team.client.patch(url, json={"name": "  "}, headers=alice).status_code == 422
    assert team.client.patch(url, json={"folder": "x" * 301}, headers=alice).status_code == 422
    assert team.client.post(API, json={"name": "Long", "description": "x" * 5001}, headers=alice).status_code == 422


def test_diagrams_are_found_by_every_word_searched_for(team):
    alice = team.member("alice@x.test")
    feed = make(team, alice, name="Feed system", folder="Vespula/GSE")
    stand = make(team, alice, name="Hotfire stand", description="LOX side of the test stand")
    tagged = drawing(part("pt", kind="pressure_transducer", tag="PT-101"), lines=(line("l", "pt", "pt", tag="L-7"),))
    make(team, alice, name="Pressurant", drawing=tagged)

    def found(q: str, **params) -> list[str]:
        response = team.client.get(API, params={"q": q, **params}, headers=alice)
        assert response.status_code == 200, response.text
        return [d["name"] for d in response.json()]

    assert found("") == ["Pressurant", "Hotfire stand", "Feed system"]  # the most recently changed first
    assert found("FEED") == ["Feed system"]
    assert found("gse") == ["Feed system"]  # its folder
    assert found("lox") == ["Hotfire stand"]  # its description
    assert found("pt-101") == ["Pressurant"]  # a part's tag
    assert found("l-7") == ["Pressurant"]  # a line's
    assert found("  stand   LOX ") == ["Hotfire stand"]
    assert found("feed lox") == []  # every word, not any

    team.client.patch(f"{API}/{feed['id']}", json={"description": "Tanks to the engine"}, headers=alice)
    assert found("") == ["Feed system", "Pressurant", "Hotfire stand"]
    team.client.delete(f"{API}/{stand['id']}", headers=alice)
    assert found("lox") == []
    assert found("lox", deleted="true") == ["Hotfire stand"]


# --- folders ------------------------------------------------------------------------------------------------------

FOLDERS = "/api/piper/folders"


def folder(team, who, name: str, parent: int | None = None) -> dict:
    made = team.client.post(FOLDERS, json={"name": name, "parent_id": parent}, headers=who)
    assert made.status_code == 201, made.text
    return made.json()


def test_folders_are_made_renamed_and_moved_by_anyone_and_deleted_once_empty(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    vespula = folder(team, alice, " Vespula ")
    gse = folder(team, alice, "GSE", vespula["id"])
    assert (gse["path"], gse["parent_id"], gse["created_by"]["email"]) == ("Vespula/GSE", vespula["id"], "alice@x.test")

    # Two in a folder can't differ only in case, and a name has no slashes (a diagram's folder can be its path).
    taken = team.client.post(FOLDERS, json={"name": "gse", "parent_id": vespula["id"]}, headers=bob)
    assert (taken.status_code, taken.json()["error"]) == (409, "name_taken")
    assert team.client.post(FOLDERS, json={"name": "GSE"}, headers=bob).status_code == 201  # at the top, it's free
    assert team.client.post(FOLDERS, json={"name": "a/b"}, headers=bob).status_code == 422
    missing = team.client.post(FOLDERS, json={"name": "Ox", "parent_id": 999}, headers=bob)
    assert (missing.status_code, missing.json()["error"]) == (404, "not_found")

    # Anyone renames or moves one, as anyone moves a diagram; never into itself.
    renamed = team.client.patch(f"{FOLDERS}/{gse['id']}", json={"name": "Ground"}, headers=bob).json()
    assert (renamed["name"], renamed["path"], renamed["parent_id"]) == ("Ground", "Vespula/Ground", vespula["id"])
    cycle = team.client.patch(f"{FOLDERS}/{vespula['id']}", json={"parent_id": gse["id"]}, headers=bob)
    assert (cycle.status_code, cycle.json()["error"]) == (409, "cycle")
    listed = team.client.get(FOLDERS, headers=bob).json()
    assert [(one["name"], one["path"]) for one in listed] == [  # by name, whatever its case
        ("Ground", "Vespula/Ground"),
        ("GSE", "GSE"),
        ("Vespula", "Vespula"),
    ]

    # One with a diagram in it isn't deleted; once its diagram's deleted, it is, and that diagram goes up a folder.
    made = make(team, alice, folder_id=gse["id"])
    assert (made["folder"], made["folder_id"]) == ("Vespula/Ground", gse["id"])
    busy = team.client.delete(f"{FOLDERS}/{gse['id']}", headers=bob)
    assert (busy.status_code, busy.json()["error"]) == (409, "not_empty")
    team.client.delete(f"{API}/{made['id']}", headers=alice)
    assert team.client.delete(f"{FOLDERS}/{gse['id']}", headers=bob).status_code == 204
    restored = team.client.post(f"{API}/{made['id']}/restore", headers=alice).json()
    assert (restored["folder"], restored["folder_id"]) == ("Vespula", vespula["id"])
    assert team.client.delete(f"{FOLDERS}/{vespula['id']}", headers=bob).json()["error"] == "not_empty"


def test_a_diagram_put_in_a_folder_by_its_path_goes_in_the_folders_on_it(team):
    """As clients from before folders were their own name it: the folders on the path, made where they aren't there."""
    alice = team.member("alice@x.test")
    first = make(team, alice, name="Feed", folder="Vespula/GSE")
    second = make(team, alice, name="Fill", folder=" vespula / gse ")  # whatever its case
    assert first["folder_id"] == second["folder_id"]
    assert second["folder"] == "Vespula/GSE"
    assert [one["path"] for one in team.client.get(FOLDERS, headers=alice).json()] == ["Vespula/GSE", "Vespula"]
    url = f"{API}/{first['id']}"
    top = team.client.patch(url, json={"folder_id": None}, headers=alice).json()
    assert (top["folder"], top["folder_id"]) == ("", None)
    back = team.client.patch(url, json={"folder": "Vespula"}, headers=alice).json()
    assert back["folder"] == "Vespula"
    lost = team.client.patch(url, json={"folder_id": 999}, headers=alice)
    assert (lost.status_code, lost.json()["error"]) == (404, "not_found")
    # The list searches the folders' path too.
    found = team.client.get(API, params={"q": "gse"}, headers=alice).json()
    assert [one["name"] for one in found] == ["Fill"]


def test_diagrams_are_moved_deleted_and_restored_together_or_not_at_all(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    a, b = make(team, alice, name="A"), make(team, alice, name="B")
    c = make(team, bob, name="C")
    gse = folder(team, alice, "GSE")

    # Anyone moves anyone's.
    moved = team.client.post(f"{API}/move", json={"diagrams": [a["id"], c["id"]], "folder_id": gse["id"]}, headers=bob)
    assert [(one["name"], one["folder"], one["updated_by"]["email"]) for one in moved.json()] == [
        ("A", "GSE", "bob@x.test"),
        ("C", "GSE", "bob@x.test"),
    ]
    nowhere = team.client.post(f"{API}/move", json={"diagrams": [b["id"], 999], "folder_id": gse["id"]}, headers=bob)
    assert (nowhere.status_code, nowhere.json()["error"]) == (404, "not_found")
    assert opened(team, bob, b)["folder"] == ""  # none of them moved

    # Only your own are deleted (or any, for an admin): all of them, or none.
    mixed = team.client.post(f"{API}/delete", json={"diagrams": [a["id"], c["id"]]}, headers=bob)
    assert (mixed.status_code, mixed.json()["error"]) == (403, "not_yours")
    assert opened(team, bob, c)["deleted_at"] is None
    gone = team.client.post(f"{API}/delete", json={"diagrams": [a["id"], b["id"]]}, headers=alice).json()
    assert all(one["deleted_at"] for one in gone)
    stuck = team.client.post(f"{API}/move", json={"diagrams": [a["id"]], "folder_id": None}, headers=alice)
    assert (stuck.status_code, stuck.json()["error"]) == (409, "deleted")
    assert team.client.post(f"{API}/restore", json={"diagrams": [a["id"]]}, headers=bob).status_code == 403
    back = team.client.post(f"{API}/restore", json={"diagrams": [a["id"], b["id"]]}, headers=alice).json()
    assert [(one["name"], one["folder"], one["deleted_at"]) for one in back] == [("A", "GSE", None), ("B", "", None)]
    assert team.client.post(f"{API}/delete", json={"diagrams": []}, headers=alice).status_code == 422


# --- saving -------------------------------------------------------------------------------------------------------


def test_a_save_from_an_old_version_is_refused_and_says_who_saved_since(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    made = make(team, alice)
    first = drawing(part("v1"))
    assert saved(team, bob, made, first, 1)["version"] == 2

    # Alice still has version 1: her save is refused, and says who saved it since, when, and its version now.
    late = save(team, alice, made, drawing(part("v2")), 1)
    assert late.status_code == 409, late.text
    assert (late.json()["error"], late.json()["message"]) == ("changed", "Bob saved Feed system after you opened it")
    details = late.json()["details"]
    assert (details["version"], details["updated_by"]["email"]) == (2, "bob@x.test")
    after = opened(team, alice, made)
    assert datetime.fromisoformat(details["updated_at"]) == datetime.fromisoformat(after["updated_at"])
    assert (after["version"], after["drawing"]) == (2, first)  # nothing of hers was kept

    # Saved from the version it's at, hers is taken, over his, which stays in the history.
    assert saved(team, alice, made, drawing(part("v2")), 2)["version"] == 3
    assert history(team, alice, made) == [
        (3, "alice@x.test", "", None),
        (2, "bob@x.test", "", None),
        (1, "alice@x.test", "", None),
    ]
    assert kept(team, alice, made, 2)["drawing"] == first

    # Her own save from another window, which she's saved from since, is refused too.
    assert saved(team, alice, made, drawing(part("v3")), 3)["version"] == 4
    again = save(team, alice, made, drawing(part("v4")), 3)
    assert again.status_code == 409, again.text
    assert again.json()["message"] == "You saved Feed system in another window after you opened it here"


def test_saves_from_one_version_have_one_winner(app, team):
    alice = team.member("alice@x.test")
    made = make(team, alice)
    emails = [f"member{i}@x.test" for i in range(8)]
    for email in emails:
        team.member(email)

    def attempt(email: str) -> str:
        with app.state.sessionmaker() as db:
            user = db.scalar(select(User).where(User.email == email))
            try:
                diagrams.save(db, user, made["id"], drawing(part(email)), 1)
            except diagrams.Changed:
                return "changed"
            return "saved"

    with ThreadPoolExecutor(len(emails)) as pool:
        results = list(pool.map(attempt, emails))
    assert sorted(results) == ["changed"] * 7 + ["saved"]
    after = opened(team, alice, made)
    assert (after["version"], after["drawing"]) == (2, drawing(part(emails[results.index("saved")])))
    assert len(history(team, alice, made)) == 2


def test_one_persons_saves_take_turns_with_a_revision_for_half_an_hour(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    made = make(team, alice)

    # Hers, while the revision she began is younger than half an hour: one revision, as she left it.
    saved(team, alice, made, drawing(part("v1")), 1)
    saved(team, alice, made, drawing(part("v1"), part("v2")), 2)
    assert history(team, alice, made) == [(1, "alice@x.test", "", None)]
    first = kept(team, alice, made, 1)
    assert first["drawing"] == drawing(part("v1"), part("v2"))
    assert datetime.fromisoformat(first["saved_at"]) > datetime.fromisoformat(first["created_at"])

    # Someone else's save begins a revision of their own, which takes their saves in turn.
    saved(team, bob, made, drawing(part("v3")), 3)
    saved(team, bob, made, drawing(part("v4")), 4)
    age(team, made, 2, minutes=29)
    after = saved(team, bob, made, drawing(part("v5")), 5)
    assert (after["version"], after["revision"]) == (6, 2)

    # Half an hour after it began, a save begins another; and so does a fresh one, whenever.
    age(team, made, 2, minutes=2)
    saved(team, bob, made, drawing(part("v6")), 6)
    saved(team, bob, made, drawing(part("v7")), 7, fresh=True)
    assert history(team, bob, made) == [
        (4, "bob@x.test", "", None),
        (3, "bob@x.test", "", None),
        (2, "bob@x.test", "", None),
        (1, "alice@x.test", "", None),
    ]
    assert [kept(team, bob, made, n)["drawing"] for n in (2, 3, 4)] == [
        drawing(part("v5")),
        drawing(part("v6")),
        drawing(part("v7")),
    ]

    # A named revision stays as it is: the next save begins another.
    url = f"{API}/{made['id']}/revisions/4"
    named = team.client.patch(url, json={"note": "  Rev B, for HF-3 "}, headers=alice)
    assert (named.status_code, named.json()["note"], named.json()["number"]) == (200, "Rev B, for HF-3", 4)
    assert saved(team, bob, made, drawing(part("v8")), 8)["revision"] == 5
    assert kept(team, bob, made, 4) == {**named.json(), "drawing": drawing(part("v7"))}
    assert team.client.patch(url, json={"note": "x" * 201}, headers=alice).status_code == 422
    assert team.client.patch(f"{API}/{made['id']}/revisions/9", json={"note": "x"}, headers=alice).status_code == 404


def test_restoring_a_revision_makes_it_the_drawing_again(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    made = make(team, alice, drawing=drawing(part("v1")))
    saved(team, bob, made, drawing(part("v2")), 1)
    url = f"{API}/{made['id']}/revisions/1/restore"

    # Only from the version it's at, as a save.
    stale = team.client.post(url, json={"version": 1}, headers=alice)
    assert (stale.status_code, stale.json()["error"], stale.json()["details"]["version"]) == (409, "changed", 2)

    restored = team.client.post(url, json={"version": 2}, headers=alice)
    assert restored.status_code == 200, restored.text
    body = restored.json()
    assert (body["version"], body["revision"], body["drawing"], body["parts"]) == (3, 3, drawing(part("v1")), 1)
    assert opened(team, bob, made)["drawing"] == drawing(part("v1"))
    # A new revision that says where it came from: the drawings after it stay in the history.
    assert history(team, alice, made) == [
        (3, "alice@x.test", "", 1),
        (2, "bob@x.test", "", None),
        (1, "alice@x.test", "", None),
    ]
    assert kept(team, alice, made, 2)["drawing"] == drawing(part("v2"))
    late = save(team, bob, made, drawing(part("v3")), 2)
    assert late.json()["message"] == "Alice restored Feed system to revision 1 after you opened it"

    # It stays as it was restored: her next save begins another.
    assert saved(team, alice, made, drawing(part("v1"), part("v4")), 3)["revision"] == 4

    # A revision that isn't there restores nothing, and the diagram stays at its version.
    missing = team.client.post(f"{API}/{made['id']}/revisions/9/restore", json={"version": 4}, headers=alice)
    assert (missing.status_code, missing.json()["message"]) == (404, "Feed system has no revision 9")
    assert opened(team, alice, made)["version"] == 4
    assert saved(team, alice, made, drawing(part("v5")), 4)["version"] == 5


def test_one_person_edits_a_diagram_at_a_time(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    made = make(team, alice, drawing=drawing(part("v1")))
    saved(team, alice, made, drawing(part("v2")), 1)
    assert editing(team, bob, made) is None

    taken = lock(team, alice, made)
    assert taken.status_code == 200, taken.text
    held = taken.json()["editing"]
    assert held["by"]["email"] == "alice@x.test"
    assert [d["editing"]["by"]["email"] for d in team.client.get(API, headers=bob).json()] == ["alice@x.test"]

    # Until she's done, no one else edits it, saves over it, or restores a revision of it: each is told who's at it.
    refused = lock(team, bob, made)
    assert (refused.status_code, refused.json()["error"]) == (409, "locked")
    assert (
        refused.json()["message"] == "Alice is editing Feed system: you can look at it, and edit it once they're done"
    )
    assert refused.json()["details"]["editing"] == {"by": held["by"], "since": held["since"]}
    late = save(team, bob, made, drawing(part("bob")), 2)
    assert (late.status_code, late.json()["error"]) == (409, "locked")
    assert late.json()["message"] == (
        "Alice is editing Feed system: your change isn't saved: save yours as a new diagram, or load theirs"
    )
    back = team.client.post(f"{API}/{made['id']}/revisions/1/restore", json={"version": 2}, headers=bob)
    assert (back.status_code, back.json()["error"]) == (409, "locked")
    assert opened(team, bob, made)["version"] == 2

    # Her saves go on, and her editor saying she's still at it keeps when she started.
    assert saved(team, alice, made, drawing(part("v3")), 2)["editing"]["since"] == held["since"]
    assert lock(team, alice, made).json()["editing"] == held
    # Anyone can still rename it, and name its revisions: that isn't its drawing.
    assert team.client.patch(f"{API}/{made['id']}", json={"name": "Feed"}, headers=bob).status_code == 200

    # Bob letting go of what isn't his changes nothing; once she's done, it's anyone's to edit.
    assert team.client.delete(f"{API}/{made['id']}/lock", headers=bob).json()["editing"]["by"] == held["by"]
    done = team.client.delete(f"{API}/{made['id']}/lock", headers=alice)
    assert (done.status_code, done.json()["editing"]) == (200, None)
    assert lock(team, bob, made).json()["editing"]["by"]["email"] == "bob@x.test"
    assert saved(team, bob, made, drawing(part("bob")), 3)["version"] == 4


def test_a_diagram_no_one_has_heard_from_its_editor_about_in_ten_minutes_is_let_go(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    made = make(team, alice)
    since = lock(team, alice, made).json()["editing"]["since"]

    # Her editor says she's at it every minute or so: nine minutes since isn't long enough.
    age_lock(team, made, minutes=9)
    assert lock(team, bob, made).status_code == 409
    assert lock(team, alice, made).json()["editing"]["since"] == since
    age_lock(team, made, minutes=9)
    assert editing(team, bob, made) == "alice@x.test"

    # Ten minutes without a word (her laptop shut): it's let go, and her save, back, holds it again.
    age_lock(team, made, minutes=10)
    assert editing(team, bob, made) is None
    again = saved(team, alice, made, drawing(part("v1")), 1)
    assert again["editing"]["by"]["email"] == "alice@x.test"
    assert again["editing"]["since"] > since

    # Let go again, and taken by Bob: her next save is refused, and says who.
    age_lock(team, made, minutes=10)
    assert lock(team, bob, made).status_code == 200
    late = save(team, alice, made, drawing(part("v2")), 2)
    assert (late.status_code, late.json()["details"]["editing"]["by"]["email"]) == (409, "bob@x.test")


def test_an_admin_takes_over_editing_a_diagram(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    made = make(team, alice)
    lock(team, alice, made)

    refused = lock(team, bob, made, force=True)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
    taken = lock(team, chief, made, force=True)
    assert taken.status_code == 200, taken.text
    assert taken.json()["editing"]["by"]["email"] == "chief@x.test"
    late = save(team, alice, made, drawing(part("v1")), 1)
    assert (late.status_code, late.json()["details"]["editing"]["by"]["email"]) == (409, "chief@x.test")
    assert saved(team, chief, made, drawing(part("v1")), 1)["version"] == 2


def test_saves_and_deleted_diagrams_hold_nothing(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    made = make(team, alice)

    # A save by someone not editing it (a tab from before Piper had editing) doesn't hold it for them.
    assert saved(team, bob, made, drawing(part("v1")), 1)["editing"] is None
    assert lock(team, alice, made).status_code == 200

    # A deleted diagram is no one's to edit: what was held lets go, and comes back with it.
    assert team.client.delete(f"{API}/{made['id']}", headers=alice).json()["editing"] is None
    refused = lock(team, bob, made)
    assert (refused.status_code, refused.json()["error"]) == (409, "deleted")
    team.client.post(f"{API}/{made['id']}/restore", headers=alice)
    assert editing(team, bob, made) == "alice@x.test"

    missing = team.client.post(f"{API}/999/lock", headers=alice)
    assert missing.status_code == 404


def test_of_two_starting_to_edit_at_once_one_does(app, team):
    alice = team.member("alice@x.test")
    made = make(team, alice)
    emails = [f"member{i}@x.test" for i in range(8)]
    for email in emails:
        team.member(email)

    def attempt(email: str) -> str:
        with app.state.sessionmaker() as db:
            user = db.scalar(select(User).where(User.email == email))
            try:
                diagrams.take_lock(db, user, made["id"])
            except diagrams.Locked:
                return "locked"
            return "editing"

    with ThreadPoolExecutor(len(emails)) as pool:
        results = list(pool.map(attempt, emails))
    assert sorted(results) == ["editing"] + ["locked"] * 7
    assert editing(team, alice, made) == emails[results.index("editing")]


def test_only_whoever_made_a_diagram_or_an_admin_deletes_it(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    made = make(team, alice)
    url = f"{API}/{made['id']}"
    assert [opened(team, who, made)["can_delete"] for who in (alice, bob, chief)] == [True, False, True]

    refused = team.client.delete(url, headers=bob)
    assert (refused.status_code, refused.json()["error"]) == (403, "not_yours")
    deleted = team.client.delete(url, headers=alice)
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["deleted_by"]["email"] == "alice@x.test"
    assert team.client.get(API, headers=bob).json() == []
    assert [d["id"] for d in team.client.get(API, params={"deleted": "true"}, headers=bob).json()] == [made["id"]]

    # It still opens, saying it's deleted, with its history; but nothing changes it until it's restored.
    gone = opened(team, bob, made)
    assert (gone["deleted_by"]["email"], gone["drawing"]) == ("alice@x.test", EMPTY)
    assert [n for n, *_ in history(team, bob, made)] == [1]
    changes = [
        save(team, alice, made, drawing(part("v1")), 1),
        team.client.patch(url, json={"name": "Mine"}, headers=alice),
        team.client.patch(f"{url}/revisions/1", json={"note": "Rev A"}, headers=alice),
        team.client.post(f"{url}/revisions/1/restore", json={"version": 1}, headers=alice),
    ]
    for response in changes:
        assert (response.status_code, response.json()["error"]) == (409, "deleted"), response.text
    assert changes[0].json()["message"] == "Feed system is deleted: restore it first"

    refused = team.client.post(f"{url}/restore", headers=bob)
    assert (refused.status_code, refused.json()["error"]) == (403, "not_yours")
    back = team.client.post(f"{url}/restore", headers=alice).json()
    assert (back["deleted_at"], back["deleted_by"], back["version"]) == (None, None, 1)
    assert saved(team, bob, made, drawing(part("v1")), 1)["version"] == 2

    # An admin deletes and restores anyone's.
    assert team.client.delete(url, headers=chief).json()["deleted_by"]["email"] == "chief@x.test"
    assert team.client.post(f"{url}/restore", headers=chief).json()["deleted_at"] is None


def test_a_diagram_or_a_revision_that_isnt_there(team):
    alice = team.member("alice@x.test")
    responses = [
        team.client.get(f"{API}/999", headers=alice),
        team.client.patch(f"{API}/999", json={"name": "X"}, headers=alice),
        team.client.delete(f"{API}/999", headers=alice),
        team.client.post(f"{API}/999/restore", headers=alice),
        team.client.put(f"{API}/999/drawing", json={"drawing": EMPTY, "version": 1}, headers=alice),
        team.client.get(f"{API}/999/revisions", headers=alice),
        team.client.get(f"{API}/999/revisions/1", headers=alice),
        team.client.post(f"{API}/999/revisions/1/restore", json={"version": 1}, headers=alice),
    ]
    for response in responses:
        assert (response.status_code, response.json()["error"]) == (404, "not_found"), response.text
    assert responses[0].json()["message"] == "There's no diagram 999"
    made = make(team, alice)
    missing = team.client.get(f"{API}/{made['id']}/revisions/2", headers=alice)
    assert (missing.status_code, missing.json()["message"]) == (404, "Feed system has no revision 2")


# --- drawings -----------------------------------------------------------------------------------------------------


def test_a_drawing_comes_back_as_it_was_sent(team):
    """Whatever the web app keeps in a drawing comes back: its own fields, whole numbers as whole numbers, and keys in
    their order."""
    alice = team.member("alice@x.test")
    sent = {
        "format": 1,
        "parts": [
            {
                "id": "v1",
                "kind": "ball_valve",
                "x": 120,
                "y": -40.5,
                "tag": "BV-1",
                "rotation": 90,
                "props": {"Cv": "1.2", "size": "½ in", "normal": "NC"},
                "label": {"dx": 0, "dy": -30},
            },
            {"id": "pt1", "kind": "pressure_transducer", "x": 0.1, "y": 1e-7, "tag": "PT-101", "props": {}},
        ],
        "lines": [
            {
                "id": "l1",
                "from": {"part": "v1", "port": "out"},
                "to": {"x": 300, "y": 0},
                "fluid": "LOX",
                "points": [[120, -40.5], [300, 0]],
                "manual": True,
                "note": None,
            }
        ],
        "fluids": [{"id": "LOX", "color": "#3b82f6", "label": "LOX"}],
        "style": {"states": {"open": "#16a34a", "closed": "#dc2626"}, "grid": 10},
        "web": {"made_with": "0.6.0"},
    }
    made = make(team, alice, drawing=sent)
    assert json.dumps(made["drawing"]) == json.dumps(sent)
    after = opened(team, alice, made)
    assert json.dumps(after["drawing"]) == json.dumps(sent)
    assert (after["parts"], after["lines"], after["fluids"]) == (2, 1, ["LOX"])

    # So does a revision's, with its JSON's size; the list of revisions leaves the drawings out.
    first = kept(team, alice, made, 1)
    assert json.dumps(first["drawing"]) == json.dumps(sent)
    assert first["size"] == len(json.dumps(sent, separators=(",", ":"), ensure_ascii=False).encode())
    listed = team.client.get(f"{API}/{made['id']}/revisions", headers=alice).json()
    assert [(r["number"], r["size"], "drawing" in r) for r in listed] == [(1, first["size"], False)]


def test_a_drawing_is_checked_before_it_is_kept(team):
    alice = team.member("alice@x.test")
    made = make(team, alice)

    def refused(sent) -> str:
        response = save(team, alice, made, sent, 1)
        assert (response.status_code, response.json()["error"]) == (422, "invalid_drawing"), response.text
        return response.json()["message"]

    deep: dict = {}
    for _ in range(60):
        deep = {"in": deep}
    assert refused({"parts": [], "lines": []}) == "The drawing has no format"
    assert refused({**EMPTY, "format": 0}) == "The drawing's format has to be at least 1"
    assert refused({**EMPTY, "format": "1"}) == "The drawing's format isn't a whole number"
    assert refused({"format": 1, "lines": []}) == "The drawing has no list of parts"
    assert refused({**EMPTY, "parts": "valves"}) == "The drawing's parts aren't a list"
    assert refused(drawing(part("v1"), "a valve")) == "Part 2 isn't an object"
    assert refused(drawing(part("v1"), {"id": "v2", "x": 0, "y": 0})) == "Part 2 has no kind"
    assert refused(drawing(part("v1", kind=""))) == "Part 1 has no kind"
    assert refused(drawing(part("v1", x="10"))) == "Part 1's x isn't a number"
    assert refused(drawing(part("v1", tag="T" * 101))) == "Part 1's tag is longer than 100 characters"
    assert refused(drawing(part("v1"), lines=({"id": "l1", "from": {"part": "v1"}},))) == "Line 1 has no end (to)"
    assert refused(drawing(lines=(line("l1", "v1", "v2", fluid=7),))) == "Line 1's fluid isn't text"
    assert refused(drawing(part("v1"), lines=(line("v1", "v1", "v1"),))) == "Two parts or lines share the id v1"
    assert refused({**EMPTY, "style": deep}) == "The drawing has objects and lists in each other more than 50 deep"

    # Numbers and text that JSON doesn't have, but Python reads anyway: they couldn't be sent back.
    def refused_raw(parts: str, style: str = "{}") -> str:
        body = '{"version": 1, "drawing": {"format": 1, "parts": [' + parts + '], "lines": [], "style": ' + style + "}}"
        response = team.client.put(
            f"{API}/{made['id']}/drawing", content=body, headers={**alice, "content-type": "application/json"}
        )
        assert (response.status_code, response.json()["error"]) == (422, "invalid_drawing"), response.text
        return response.json()["message"]

    infinite = '{"id": "v1", "kind": "ball_valve", "x": 1e999, "y": 0}'
    assert refused_raw(infinite) == "Part 1's x isn't a finite number"
    assert refused_raw("", style='{"zoom": NaN}') == "The drawing has a number that isn't finite"
    assert refused_raw("", style='{"label": "\\ud800"}') == "The drawing has text that isn't valid Unicode"

    # Up to 2 MB of JSON; and a drawing has to be an object.
    big = save(team, alice, made, {**EMPTY, "notes": "x" * (2 * 1024 * 1024)}, 1)
    assert (big.status_code, big.json()["error"]) == (413, "too_large")
    assert big.json()["message"] == "A drawing can be up to 2 MB"
    assert save(team, alice, made, ["not", "a", "drawing"], 1).status_code == 422

    # Nothing was kept, and a new diagram's drawing is checked the same way.
    after = opened(team, alice, made)
    assert (after["version"], after["drawing"]) == (1, EMPTY)
    new = team.client.post(API, json={"name": "Valves", "drawing": {"format": 1, "parts": []}}, headers=alice)
    assert (new.status_code, new.json()["message"]) == (422, "The drawing has no list of lines")
    assert [d["name"] for d in team.client.get(API, headers=alice).json()] == ["Feed system"]


def test_a_drawing_with_pages_is_kept_and_listed_by_all_of_them(team):
    alice = team.member("alice@x.test")
    vehicle = drawing(
        part("pt", kind="pressure_transducer", tag="PT-101"), lines=(line("l1", "pt", "pt", tag="L-7", fluid="lox"),)
    )
    gse = drawing(
        part("bv", tag="BV-201"),
        part("off", kind="offpage", props={"page": "vehicle", "part": "pt"}),
        lines=(line("l2", "bv", "off", fluid="ghe"),),
    )
    sent = pages(("vehicle", vehicle), ("gse", gse))
    made = make(team, alice, drawing=sent)
    assert json.dumps(made["drawing"]) == json.dumps(sent)
    assert (made["parts"], made["lines"], made["pages"], made["fluids"]) == (3, 2, 2, ["lox", "ghe"])
    # Its second page's tags find it too.
    found = team.client.get(API, params={"q": "bv-201"}, headers=alice).json()
    assert [d["name"] for d in found] == ["Feed system"]
    # A drawing from before pages is one.
    assert make(team, alice, name="Valves", drawing=drawing(part("v1")))["pages"] == 1


def test_a_drawing_with_pages_is_checked_page_by_page(team):
    alice = team.member("alice@x.test")
    made = make(team, alice)

    def refused(sent) -> str:
        response = save(team, alice, made, sent, 1)
        assert (response.status_code, response.json()["error"]) == (422, "invalid_drawing"), response.text
        return response.json()["message"]

    one = drawing(part("v1"))
    assert refused({"format": 2, "parts": [], "lines": []}) == "The drawing has no list of pages"
    assert refused({"format": 2, "pages": []}) == "The drawing has no pages"
    assert refused({"format": 2, "pages": "one"}) == "The drawing's pages aren't a list"
    assert refused({"format": 2, "pages": [{"parts": [], "lines": []}]}) == "Page 1 has no id"
    assert refused({"format": 2, "pages": [{"id": "a", "parts": []}]}) == "Page 1 has no list of lines"
    assert refused(pages(("a", one), ("b", one))) == "Two parts or lines share the id v1"
    assert refused(pages(("a", one), ("a", drawing(part("v2"))))) == "Two pages share the id a"
    assert refused(pages(("a", one), ("b", drawing(part("v2", kind=""))))) == "Page 2's part 1 has no kind"
    no_end = drawing(lines=({"id": "l1", "from": {"part": "v1"}},))
    assert refused(pages(("a", one), ("b", no_end))) == "Page 2's line 1 has no end (to)"
    named = pages(("a", one))
    named["pages"][0]["name"] = "N" * 101
    assert refused(named) == "Page 1's name is longer than 100 characters"
    assert refused({"format": 2, "pages": [named["pages"][0] | {"name": "A"}, "b"]}) == "Page 2 isn't an object"
    many = pages(*((f"p{n}", drawing()) for n in range(101)))
    assert refused(many) == "The drawing has more than 100 pages"
    # As many parts on all its pages as a drawing can have on one.
    full = pages(*((f"p{n}", drawing(*(part(f"v{n}-{m}") for m in range(1001)))) for n in range(5)))
    assert refused(full) == "The drawing has more than 5000 parts on its pages"
    assert opened(team, alice, made)["version"] == 1


def test_a_save_from_before_pages_is_refused_over_a_drawing_with_them(team):
    """A tab opened before Piper had pages would save one page of them: it's told to reload, and nothing changes."""
    alice = team.member("alice@x.test")
    made = make(team, alice, drawing=drawing(part("v1")))
    two = pages(("a", drawing(part("v1"))), ("b", drawing(part("v2"))))
    after = saved(team, alice, made, two, 1, fresh=True)
    old = save(team, alice, made, drawing(part("v1"), part("v3")), after["version"])
    assert (old.status_code, old.json()["error"]) == (409, "drawing_newer"), old.text
    assert old.json()["message"] == (
        "Feed system has pages, which this tab's Piper is too old to keep: reload the page, then make your change again"
    )
    still = opened(team, alice, made)
    assert (still["version"], still["revision"], still["pages"]) == (after["version"], 2, 2)
    assert json.dumps(still["drawing"]) == json.dumps(two)

    # Restoring a revision from before them is meant: it's the drawing again, and saves of its format go again.
    url = f"{API}/{made['id']}/revisions/1/restore"
    restored = team.client.post(url, json={"version": after["version"]}, headers=alice)
    assert (restored.status_code, restored.json()["pages"]) == (200, 1), restored.text
    assert saved(team, alice, made, drawing(part("v1"), part("v3")), restored.json()["version"])["parts"] == 2


def test_a_save_from_before_simulation_is_refused_over_a_drawing_saved_since(team):
    """A tab opened before Piper's drawings kept their simulation's settings would save them without: it's told to
    reload, and nothing changes."""
    alice = team.member("alice@x.test")
    made = make(team, alice, drawing=drawing(part("v1")))
    simulated = {**pages(("a", drawing(part("v1") | {"sim": {"as": "", "settings": {"cda": 5e-5}}}))), "format": 3}
    after = saved(team, alice, made, simulated, 1)
    old = save(team, alice, made, pages(("a", drawing(part("v1")))), after["version"])
    assert (old.status_code, old.json()["error"]) == (409, "drawing_newer"), old.text
    assert old.json()["message"] == (
        "Feed system has simulation settings, which this tab's Piper is too old to keep: reload the page, then make "
        "your change again"
    )
    assert json.dumps(opened(team, alice, made)["drawing"]) == json.dumps(simulated)


# --- releases -----------------------------------------------------------------------------------------------------


def ask_release(team, who, diagram: dict, revision: int, *approvers: str, note: str = ""):
    body = {"revision": revision, "approvers": [team.ids[email] for email in approvers], "note": note}
    return team.client.post(f"{API}/{diagram['id']}/releases", json=body, headers=who)


def asked(team, who, diagram: dict, revision: int, *approvers: str, note: str = "") -> dict:
    response = ask_release(team, who, diagram, revision, *approvers, note=note)
    assert response.status_code == 201, response.text
    return response.json()


def say(team, who, diagram: dict, release: dict, what: str, comment: str = ""):
    path = f"{API}/{diagram['id']}/releases/{release['id']}/{what}"
    return team.client.post(path, json={"comment": comment} if what != "withdraw" else None, headers=who)


def said(team, who, diagram: dict, release: dict, what: str, comment: str = "") -> dict:
    response = say(team, who, diagram, release, what, comment)
    assert response.status_code == 200, response.text
    return response.json()


def test_a_revision_is_released_once_every_approver_named_approves_it_and_then_never_changes(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    cy = team.member("cy@x.test")
    made = make(team, alice)
    first = drawing(part("v1", tag="BV-1"))
    saved(team, alice, made, first, 1)
    asking = asked(team, alice, made, 1, "bob@x.test", "cy@x.test", note="For HF-3's readiness review")
    assert (asking["state"], asking["letter"], asking["revision"], asking["can_withdraw"]) == ("pending", None, 1, True)
    assert [(a["approver"]["email"], a["decision"]) for a in asking["approvals"]] == [
        ("bob@x.test", "pending"),
        ("cy@x.test", "pending"),
    ]
    # Waiting to be released, the revision already stays as it is: her next save starts another.
    after = saved(team, alice, made, drawing(part("v1", tag="BV-1"), part("v2", tag="BV-2")), 2)
    assert after["revision"] == 2
    assert kept(team, alice, made, 1)["drawing"] == first

    one = said(team, bob, made, asking, "approve", "Looks right")
    assert (one["state"], [a["decision"] for a in one["approvals"]]) == ("pending", ["approved", "pending"])
    both = said(team, cy, made, asking, "approve")
    assert (both["state"], both["letter"]) == ("released", "A")
    assert both["decided_at"] is not None
    assert [(a["approver"]["email"], a["comment"]) for a in both["approvals"]] == [
        ("bob@x.test", "Looks right"),
        ("cy@x.test", ""),
    ]
    listed = opened(team, bob, made)
    assert (listed["released"], listed["released_revision"]) == ("A", 1)
    revisions = team.client.get(f"{API}/{made['id']}/revisions", headers=alice).json()
    assert [(r["number"], r["released"], r["release_pending"]) for r in revisions] == [
        (2, None, False),
        (1, "A", False),
    ]
    # Released, its name stays as it was.
    renamed = team.client.patch(f"{API}/{made['id']}/revisions/1", json={"note": "Changed"}, headers=alice)
    assert (renamed.status_code, renamed.json()["error"]) == (409, "revision_released")

    # The next release is B, of a later revision.
    second = asked(team, bob, made, 2, "alice@x.test")
    assert said(team, alice, made, second, "approve")["letter"] == "B"
    assert opened(team, alice, made)["released"] == "B"
    listed = team.client.get(f"{API}/{made['id']}/releases", headers=cy).json()
    assert [(r["letter"], r["revision"], r["can_withdraw"]) for r in listed] == [("B", 2, False), ("A", 1, False)]


def test_a_rejection_ends_a_release_and_whoever_asked_can_withdraw_one(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    admin = team.member("boss@x.test", admin=True)
    made = make(team, alice)
    asking = asked(team, alice, made, 1, "bob@x.test")
    turned = said(team, bob, made, asking, "reject", "PT-101's range is wrong")
    assert (turned["state"], turned["letter"], turned["approvals"][0]["comment"]) == (
        "rejected",
        None,
        "PT-101's range is wrong",
    )
    again = say(team, bob, made, asking, "approve")
    assert (again.status_code, again.json()["error"]) == (409, "already_decided")
    assert opened(team, alice, made)["released"] is None
    # Rejected, the revision can be named again, and put forward again.
    assert (
        team.client.patch(f"{API}/{made['id']}/revisions/1", json={"note": "Fixed"}, headers=alice).status_code == 200
    )

    retry = asked(team, alice, made, 1, "bob@x.test")
    for stranger in (bob, team.member("cy@x.test")):
        refused = say(team, stranger, made, retry, "withdraw")
        assert (refused.status_code, refused.json()["error"]) == (403, "not_yours")
    assert said(team, alice, made, retry, "withdraw")["state"] == "withdrawn"
    third = asked(team, alice, made, 1, "bob@x.test")
    assert said(team, admin, made, third, "withdraw")["state"] == "withdrawn"  # an admin can too


def test_who_can_be_asked_and_when(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    team.member("waiting@x.test", status=UserStatus.PENDING)
    made = make(team, alice)
    saved(team, alice, made, drawing(part("v1")), 1, fresh=True)  # revision 2

    for approvers in ((), ("alice@x.test",)):
        refused = ask_release(team, alice, made, 1, *approvers)
        assert (refused.status_code, refused.json()["error"]) == (422, "needs_approver"), approvers
    refused = ask_release(team, alice, made, 1, "waiting@x.test")
    assert (refused.status_code, refused.json()["error"]) == (422, "needs_approver")
    missing = ask_release(team, alice, made, 9, "bob@x.test")
    assert missing.status_code == 404

    # Naming yourself too is fine, beside someone else; both have to approve.
    asking = asked(team, alice, made, 1, "alice@x.test", "bob@x.test")
    pending = ask_release(team, bob, made, 2, "alice@x.test")
    assert (pending.status_code, pending.json()["error"]) == (409, "release_pending")
    renamed = team.client.patch(f"{API}/{made['id']}/revisions/1", json={"note": "Rev A"}, headers=alice)
    assert (renamed.status_code, renamed.json()["error"]) == (409, "release_pending")
    stranger = say(team, team.member("cy@x.test"), made, asking, "approve")
    assert (stranger.status_code, stranger.json()["error"]) == (403, "not_an_approver")
    said(team, alice, made, asking, "approve")
    twice = say(team, alice, made, asking, "approve")
    assert (twice.status_code, twice.json()["error"]) == (409, "already_decided")
    assert said(team, bob, made, asking, "approve")["letter"] == "A"

    # Each release is of a revision after the last one released.
    older = ask_release(team, alice, made, 1, "bob@x.test")
    assert (older.status_code, older.json()["error"]) == (409, "older_than_released")
    assert asked(team, alice, made, 2, "bob@x.test")["revision"] == 2


def test_release_letters_run_on_past_z():
    assert [letter(n) for n in (1, 2, 26, 27, 28, 52, 53, 702, 703)] == [
        "A",
        "B",
        "Z",
        "AA",
        "AB",
        "AZ",
        "BA",
        "ZZ",
        "AAA",
    ]


# --- color schemes ------------------------------------------------------------------------------------------------

SCHEMES = "/api/piper/schemes"
STATES = {"no": "#2e9e4f", "nc": "#d64541", "fip": "#5b7a99", "other": "#e0a500"}


def test_the_team_starts_with_yjsp_standard_as_its_default_scheme(team):
    alice = team.member("alice@x.test")
    listed = team.client.get(SCHEMES, headers=alice).json()
    assert [(s["name"], s["is_default"], s["can_delete"]) for s in listed] == [("YJSP standard", True, False)]
    fluids = {fluid["id"]: fluid for fluid in listed[0]["fluids"]}
    assert fluids["lox"] == {"id": "lox", "name": "Liquid oxygen", "label": "LOX", "color": "#2f6fd6", "gas": False}
    assert fluids["combustion"]["gas"] is True
    assert listed[0]["states"] == STATES


def test_anyone_makes_and_changes_a_scheme_and_an_admin_picks_the_default(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    admin = team.member("boss@x.test", admin=True)
    body = {
        "name": "Test stand",
        "fluids": [{"id": "lox", "name": "LOX", "label": "LOX", "color": "#0000ff"}],
        "states": STATES,
    }
    made = team.client.post(SCHEMES, json=body, headers=alice)
    assert made.status_code == 201, made.text
    scheme = made.json()
    assert (scheme["is_default"], scheme["can_delete"], scheme["fluids"][0]["gas"]) == (False, True, False)

    changed = team.client.patch(f"{SCHEMES}/{scheme['id']}", json={"name": "Stand 2"}, headers=bob)
    assert (changed.status_code, changed.json()["name"], changed.json()["updated_by"]["email"]) == (
        200,
        "Stand 2",
        "bob@x.test",
    )
    assert changed.json()["fluids"] == scheme["fluids"]  # left out, left as it was
    assert changed.json()["updated_at"] > scheme["updated_at"]
    same = team.client.patch(f"{SCHEMES}/{scheme['id']}", json={"name": "Stand 2"}, headers=alice).json()
    assert (same["updated_at"], same["updated_by"]["email"]) == (changed.json()["updated_at"], "bob@x.test")

    refused = team.client.post(f"{SCHEMES}/{scheme['id']}/default", headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
    picked = team.client.post(f"{SCHEMES}/{scheme['id']}/default", headers=admin)
    assert picked.json()["is_default"] is True
    listed = team.client.get(SCHEMES, headers=alice).json()
    assert [(s["name"], s["is_default"]) for s in listed] == [("Stand 2", True), ("YJSP standard", False)]

    # The default can't go; another, only its maker's or an admin's to delete.
    gone = team.client.delete(f"{SCHEMES}/{scheme['id']}", headers=admin)
    assert (gone.status_code, gone.json()["error"]) == (409, "scheme_default")
    standard = listed[1]["id"]
    assert team.client.delete(f"{SCHEMES}/{standard}", headers=alice).json()["error"] == "not_yours"
    assert team.client.delete(f"{SCHEMES}/{standard}", headers=admin).status_code == 204
    assert [s["name"] for s in team.client.get(SCHEMES, headers=alice).json()] == ["Stand 2"]


def test_a_scheme_is_checked_before_it_is_kept(team):
    alice = team.member("alice@x.test")
    for fluids, states in (
        ([{"id": "lox", "name": "LOX", "label": "LOX", "color": "blue"}], STATES),
        ([{"id": "Has spaces", "name": "X", "label": "X", "color": "#000000"}], STATES),
        ([], {**STATES, "fip": "#12345"}),
    ):
        refused = team.client.post(SCHEMES, json={"name": "Bad", "fluids": fluids, "states": states}, headers=alice)
        assert refused.status_code == 422, (fluids, states)
    assert team.client.patch(f"{SCHEMES}/999", json={"name": "X"}, headers=alice).status_code == 404


# --- pictures -----------------------------------------------------------------------------------------------------


def png(width: int, height: int, color: bytes = b"\xff\x00\x00\x80") -> bytes:
    """A PNG of one color, RGBA, as a program saves one."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\x00" + color * width for _ in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def jpeg_header(width: int, height: int) -> bytes:
    """The start of a JPEG, as far as its size: JFIF's marker, a quantization table, and the frame's header."""
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    tables = b"\xff\xdb" + struct.pack(">H", 67) + bytes(65)
    frame = b"\xff\xc0" + struct.pack(">HBHHB", 17, 8, height, width, 3) + bytes(9)
    return b"\xff\xd8" + app0 + tables + frame + b"\xff\xda" + struct.pack(">H", 12) + bytes(10) + b"\xff\xd9"


def upload(team, who, data: bytes):
    return team.client.post("/api/piper/images", content=data, headers={**who, "content-type": "image/png"})


def test_a_picture_is_kept_as_it_was_uploaded_and_named_by_what_is_in_it(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    data = png(3, 2)
    added = upload(team, alice, data)
    assert added.status_code == 201, added.text
    body = added.json()
    sha = hashlib.sha256(data).hexdigest()
    assert (body["sha256"], body["content_type"], body["width"], body["height"], body["size"]) == (
        sha,
        "image/png",
        3,
        2,
        len(data),
    )
    assert body["uploaded_by"]["email"] == "alice@x.test"
    # The same bytes again are the same picture, whoever adds them.
    again = upload(team, bob, data).json()
    assert (again["sha256"], again["uploaded_by"]["email"]) == (sha, "alice@x.test")
    jpeg = upload(team, bob, jpeg_header(640, 480)).json()
    assert (jpeg["content_type"], jpeg["width"], jpeg["height"]) == ("image/jpeg", 640, 480)

    # Anyone signed in gets it back as it was, kept by the browser as long as it likes.
    got = team.client.get(f"/api/piper/images/{sha}", headers=bob)
    assert (got.status_code, got.content, got.headers["content-type"]) == (200, data, "image/png")
    assert got.headers["etag"] == f'"{sha}"'
    assert "immutable" in got.headers["cache-control"]
    kept = team.client.get(f"/api/piper/images/{sha}", headers={**bob, "if-none-match": f'"{sha}"'})
    assert (kept.status_code, kept.content) == (304, b"")
    # Not anyone else's, nor one that isn't there.
    assert team.client.get(f"/api/piper/images/{sha}").status_code == 401
    missing = team.client.get(f"/api/piper/images/{'0' * 64}", headers=bob)
    assert (missing.status_code, missing.json()["error"]) == (404, "not_found")
    assert team.client.get("/api/piper/images/not-a-name", headers=bob).status_code == 422


def test_a_picture_has_to_be_a_png_or_a_jpeg_of_a_sensible_size(team):
    alice = team.member("alice@x.test")

    def refused(data: bytes) -> tuple[int, str, str]:
        response = upload(team, alice, data)
        return response.status_code, response.json()["error"], response.json()["message"]

    status, code, said = refused(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>")
    assert (status, code) == (415, "not_an_image")
    assert said.startswith("That isn't a PNG or a JPEG picture")
    assert refused(b"GIF89a" + bytes(20))[:2] == (415, "not_an_image")
    assert refused(b"")[:2] == (415, "not_an_image")
    assert refused(png(0, 0))[:2] == (415, "not_an_image")
    status, code, said = refused(jpeg_header(9000, 9000))
    assert (status, code) == (413, "too_large")
    assert said.startswith("That picture is 9000 by 9000 pixels")
    status, code, said = refused(png(1, 1) + bytes(5 * 1024 * 1024))
    assert (status, code, said) == (413, "too_large", "A picture can be up to 5 MB")
