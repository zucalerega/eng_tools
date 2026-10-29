"""What one request may cost the server: its body's size, before anyone signs in (limits.py); the disk an upload must
leave free (disk.make_room); and how many SolidWorks files are read for 3D views at once, and how often (vault.py)."""

import asyncio
import hashlib
import os
import shutil
import threading

from yjsp_server import disk
from yjsp_server.limits import MOST_BODY, BodyLimit
from yjsp_server.vault import solidworks
from yjsp_server.vault import vault as vault_module

from .test_caliper_files import files, make


def test_a_body_too_big_is_refused_before_anyone_signs_in(client):
    # Said up front: refused without reading it.
    big = client.post(
        "/auth/client/token", content=b"x" * (MOST_BODY + 1), headers={"Content-Type": "application/json"}
    )
    assert (big.status_code, big.json()["error"]) == (413, "too_large")
    assert "upload files one at a time" in big.json()["message"]

    # Not said up front (chunked): refused all the same. (The test client sends the whole body before the server sees
    # any of it, so a body here must have an end: that the server stops reading one that doesn't is checked below.)
    def chunks():
        for _ in range(MOST_BODY // (1 << 20) + 2):
            yield b"x" * (1 << 20)

    chunked = client.post("/auth/client/token", content=chunks(), headers={"Content-Type": "application/json"})
    assert (chunked.status_code, chunked.json()["error"]) == (413, "too_large")

    # A body within the limit goes on as before, to the sign-in's own answer.
    small = client.post("/auth/client/token", json={"code": "c0de", "verifier": "v" * 43})
    assert small.status_code != 413


def test_a_body_without_an_end_is_read_only_to_the_limit():
    # As a server would get one, a megabyte at a time and never the last: refused once past the limit, and no more read.
    pulled = 0

    async def receive():
        nonlocal pulled
        pulled += 1
        assert pulled < 100, "read on past the limit"
        return {"type": "http.request", "body": b"x" * (1 << 20), "more_body": True}

    sent = []

    async def send(message):
        sent.append(message)

    async def app(scope, receive, send):
        raise AssertionError("a body too big reached the app")

    scope = {"type": "http", "method": "POST", "path": "/auth/client/token", "headers": []}
    asyncio.run(BodyLimit(app)(scope, receive, send))
    assert sent[0]["status"] == 413
    assert pulled == MOST_BODY // (1 << 20) + 1


def test_uploads_stream_past_that_limit_to_their_own(team):
    chief = team.member("chief@x.test", admin=True)
    contents = os.urandom(MOST_BODY + (1 << 20))
    sha = hashlib.sha256(contents).hexdigest()
    put = team.client.put(f"/api/blobs/{sha}", content=contents, headers=chief)
    assert (put.status_code, put.json()["size"]) == (201, len(contents))


def test_an_upload_must_leave_the_server_room_to_work(team, monkeypatch, settings):
    chief = team.member("chief@x.test", admin=True)
    # As if the disk were nearly full: a floor of all of it, which what's free (however it changes meanwhile) never is.
    monkeypatch.setattr(disk, "FLOOR", shutil.disk_usage(settings.vault_dir.parent).total)

    contents = b"a fin"
    refused = team.client.put(f"/api/blobs/{hashlib.sha256(contents).hexdigest()}", content=contents, headers=chief)
    assert (refused.status_code, refused.json()["error"]) == (507, "disk_full")
    assert "ask an admin to make room" in refused.json()["message"]
    data = team.client.post("/api/yorg/datasets", params={"filename": "run.csv"}, content=b"t,p\n0,1\n", headers=chief)
    assert (data.status_code, data.json()["error"]) == (507, "disk_full")

    monkeypatch.setattr(disk, "FLOOR", 0)
    put = team.client.put(f"/api/blobs/{hashlib.sha256(contents).hexdigest()}", content=contents, headers=chief)
    assert put.status_code == 201


def test_a_file_caliper_cant_read_isnt_read_again(team, client, monkeypatch):
    chief = team.member("chief@x.test", admin=True)
    reads = []
    original = solidworks.read_part
    monkeypatch.setattr(solidworks, "read_part", lambda *given: reads.append(1) or original(*given))
    part = files(team.checkin(chief, {"Junk.SLDPRT": b"not a part " + os.urandom(16)}))["Junk.SLDPRT"]

    for _ in range(3):
        refused = make(client, chief, part)
        assert (refused.status_code, refused.json()["error"]) == (422, "unreadable_file")
        assert refused.json()["message"].startswith("Junk.SLDPRT v1: ")
    assert len(reads) == 1  # its contents never change, so neither does the answer


def test_only_a_couple_of_solidworks_files_are_read_at_once(team, client, monkeypatch):
    chief = team.member("chief@x.test", admin=True)
    part = files(team.checkin(chief, {"Wait.SLDPRT": b"not a part either " + os.urandom(16)}))["Wait.SLDPRT"]
    full = threading.BoundedSemaphore(1)
    full.acquire()  # someone else's file is being read
    monkeypatch.setattr(vault_module, "_READING", full)
    monkeypatch.setattr(vault_module, "_READING_WAIT", 0.01)

    busy = make(client, chief, part)
    assert (busy.status_code, busy.json()["error"]) == (409, "busy")
    assert "try again in a minute" in busy.json()["message"]
