"""Reading Caliper's 3D models ahead (vault/reading.py): the server makes each SolidWorks file's model from the file
once it's checked in, so that it's there when the file's first opened. The server's thread takes these steps; here the
tests take them, at times of their own."""

from datetime import timedelta
from pathlib import Path

from yjsp_server.db import utcnow
from yjsp_server.vault import solidworks
from yjsp_server.vault.reading import GRACE, Reader

from .test_caliper import mesh, put_model
from .test_caliper_files import OLDER, made_by, readers

FIXTURES = Path(__file__).parent / "fixtures" / "solidworks"


def files(response) -> dict[str, dict]:
    assert response.status_code == 200, response.text
    return {entry["file"]["name"]: entry["file"] for entry in response.json()["files"]}


def models(client, who, file: dict) -> list[tuple[int, str, str]]:
    response = client.get(f"/api/files/{file['id']}/caliper", headers=who)
    assert response.status_code == 200, response.text
    return [(m["version"], m["source"], m["created_by"]["email"]) for m in response.json()["models"]]


def steps(reader: Reader, later: timedelta = 2 * GRACE) -> int:
    """Take the reader's steps until there's nothing left to read, a while after the check-ins; how many it took."""
    taken = 0
    while reader.step(utcnow() + later):
        taken += 1
        assert taken < 100
    return taken


def test_a_checked_in_file_is_read_before_anyone_opens_it(team, client, app):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.grant(chief, "", "alice@x.test", "editor")
    part = (FIXTURES / "Embout.SLDPRT").read_bytes()
    checked = files(team.checkin(alice, {"Servo/Embout.SLDPRT": part, "Servo/Notes.txt": b"notes"}))
    spline = checked["Embout.SLDPRT"]
    reader = app.state.caliper_reader

    # Not at once: Vault for SolidWorks makes its own of what it checks in, a moment later.
    assert reader.step() is False
    assert models(client, chief, spline) == []
    assert steps(reader) == 1  # the part; the notes aren't a SolidWorks file
    assert models(client, chief, spline) == [(1, "view", "alice@x.test")]  # whose check-in it was
    assert steps(reader) == 0

    # Its next version is read in turn; the one before keeps its model.
    assert team.checkout(alice, "Servo/Embout.SLDPRT").status_code == 200
    assert team.checkin(alice, {"Servo/Embout.SLDPRT": part + b"\0"}).status_code == 200
    assert steps(reader) == 1
    assert [version for version, _, _ in models(client, chief, spline)] == [2, 1]  # newest first


def test_only_what_wants_a_model_is_read_ahead(team, client, app):
    """Not a version Vault for SolidWorks made a model of, nor a file in the trash; a file that can't be read is tried
    once, and a model an older reader made is read again."""
    chief = team.member("chief@x.test", admin=True)
    part = (FIXTURES / "Embout.SLDPRT").read_bytes()
    checked = files(
        team.checkin(
            chief,
            {
                "Servo/Made.SLDPRT": part,
                "Servo/Binned.SLDPRT": part + b"\0",
                "Servo/Broken.SLDPRT": b"not a SolidWorks file",
                "Servo/Older.SLDPRT": part + b"\0\0",
            },
        )
    )
    made, binned, broken, older = (checked[f"{name}.SLDPRT"] for name in ("Made", "Binned", "Broken", "Older"))
    assert put_model(team, chief, made, mesh=team.upload(chief, mesh())).status_code == 200
    assert client.post("/api/delete", json={"files": [binned["id"]]}, headers=chief).status_code == 200
    reader = app.state.caliper_reader

    assert steps(reader) == 2  # the broken one, and the older one
    assert models(client, chief, made) == [(1, "solidworks", "chief@x.test")]
    assert models(client, chief, binned) == models(client, chief, broken) == []
    assert steps(reader) == 0  # the broken one isn't tried again

    made_by(team, older, OLDER["part"], units="in")
    assert steps(reader) == 0  # this reader tried it already: a newer one comes with a restart
    again = Reader(app.state.sessionmaker, app.state.vault_store)
    assert steps(again) == 2  # the broken one once more, and the older reader's
    assert set(readers(team, older).values()) == {solidworks.READER}


def test_a_version_whose_author_no_longer_sees_it_is_read_all_the_same(team, client, app):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.grant(chief, "", "alice@x.test", "editor")
    part = (FIXTURES / "Embout.SLDPRT").read_bytes()
    spline = files(team.checkin(alice, {"Servo/Embout.SLDPRT": part}))["Embout.SLDPRT"]
    team.grant(chief, "", "alice@x.test", None)

    assert steps(app.state.caliper_reader) == 1
    assert models(client, chief, spline) == [(1, "view", "chief@x.test")]
