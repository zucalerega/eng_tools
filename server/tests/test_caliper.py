"""Caliper's 3D models: a part's mesh, an assembly's components, who may make them, and who sees what."""

import gzip
import json
import struct

from yjsp_server.vault import caliper

# A tetrahedron, in millimeters: one body of four faces, a triangle each.
CORNERS = [(0.0, 0.0, 0.0), (10.0, 0.0, 0.0), (0.0, 10.0, 0.0), (0.0, 0.0, 10.0)]
TRIANGLES = [(0, 2, 1), (0, 1, 3), (0, 3, 2), (1, 2, 3)]
IDENTITY = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]


def mesh(
    vertices: list[tuple[float, float, float]] = CORNERS,
    triangles: list[tuple[int, int, int]] = TRIANGLES,
    *,
    header: dict | None = None,
    magic: bytes = caliper.MAGIC,
    packed: bool = True,
) -> bytes:
    """A mesh in Caliper's format (vault/caliper.py), as Vault for SolidWorks makes them."""
    faces = [{"first": i, "count": 1} for i in range(len(triangles))]
    body = {"name": "Boss-Extrude1", "solid": True, "color": [0.79, 0.82, 0.93], "opacity": 1, "faces": faces}
    text = json.dumps(header or {"vertices": len(vertices), "triangles": len(triangles), "bodies": [body]}).encode()
    text += b" " * (-len(text) % 4)
    points = [c for vertex in vertices for c in vertex]
    corners = [i for triangle in triangles for i in triangle]
    raw = magic + struct.pack("<II", caliper.FORMAT, len(text)) + text
    raw += struct.pack(f"<{len(points)}f", *points) + struct.pack(f"<{len(corners)}I", *corners)
    return gzip.compress(raw) if packed else raw


def component(name: str, file: dict | None = None, *, configuration: str = "Default", **more) -> dict:
    found = {"file_id": file["id"], "version": file["version"]} if file else {}
    return {"name": name, **found, "configuration": configuration, "transform": IDENTITY, **more}


def put_model(team, who, file: dict, **body):
    body = {"version": file["version"], "configuration": "Default", "units": "mm", **body}
    return team.client.put(f"/api/files/{file['id']}/caliper", json=body, headers=who)


def files(response) -> dict[str, dict]:
    assert response.status_code == 200, response.text
    return {entry["file"]["name"]: entry["file"] for entry in response.json()["files"]}


def test_a_parts_model_is_its_mesh(team, client):
    chief = team.member("chief@x.test", admin=True)
    tab = files(team.checkin(chief, {"Fins/Tab.SLDPRT": b"tab v1"}))["Tab.SLDPRT"]
    assert client.get(f"/api/files/{tab['id']}/caliper", headers=chief).json() == {"models": []}
    params = {"version": 1, "configuration": "Default"}
    missing = client.get(f"/api/files/{tab['id']}/caliper/mesh", params=params, headers=chief)
    assert (missing.status_code, missing.json()["error"]) == (404, "no_model")

    sha = team.upload(chief, mesh())
    made = put_model(team, chief, tab, mesh=sha, units="in")
    assert made.status_code == 200, made.text
    assert made.json()["kind"] == "part"
    [model] = client.get(f"/api/files/{tab['id']}/caliper", headers=chief).json()["models"]
    assert (model["version"], model["configuration"], model["kind"], model["units"]) == (1, "Default", "part", "in")
    assert (model["source"], model["created_by"]["email"]) == ("solidworks", "chief@x.test")

    # It's sent as it's stored, gzip-compressed, for the browser to unpack; and not again while it's the same.
    shape = client.get(f"/api/files/{tab['id']}/caliper/mesh", params=params, headers=chief)
    assert shape.status_code == 200
    assert shape.headers["content-encoding"] == "gzip"
    assert shape.content == mesh(packed=False)  # unpacked on the way, like a browser does
    again = client.get(
        f"/api/files/{tab['id']}/caliper/mesh", params=params, headers={**chief, "If-None-Match": shape.headers["etag"]}
    )
    assert again.status_code == 304


def test_meshes_are_checked(team, client, monkeypatch):
    chief = team.member("chief@x.test", admin=True)
    tab = files(team.checkin(chief, {"Tab.SLDPRT": b"tab"}))["Tab.SLDPRT"]

    def refused(data: bytes) -> str:
        response = put_model(team, chief, tab, mesh=team.upload(chief, data))
        assert response.status_code == 400, response.text
        assert response.json()["error"] == "bad_mesh"
        return response.json()["message"]

    assert "gzip" in refused(mesh(packed=False))
    assert "CMSH" in refused(mesh(magic=b"STEP"))
    assert "ends early" in refused(mesh()[:-10])
    assert "4 vertices" in refused(mesh(header={"vertices": 4, "triangles": 5, "bodies": []}))
    assert "vertex it doesn't have" in refused(mesh(triangles=[(0, 1, 4), *TRIANGLES[1:]]))
    past = {"name": "Boss-Extrude1", "color": [1, 1, 1], "faces": [{"first": 3, "count": 2}]}
    assert "past the mesh's last triangle" in refused(mesh(header={"vertices": 4, "triangles": 4, "bodies": [past]}))
    assert "header" in refused(mesh(header={"vertices": 4, "triangles": 4, "bodies": [{"name": "No color"}]}))
    monkeypatch.setattr(caliper, "MAX_UNPACKED", 100)  # a gzip bomb, in small
    assert "at most" in refused(mesh())

    not_uploaded = put_model(team, chief, tab, mesh="0" * 64)
    assert (not_uploaded.status_code, not_uploaded.json()["error"]) == (400, "blob_missing")


def test_an_assembly_model_places_its_parts(team, client):
    chief = team.member("chief@x.test", admin=True)
    made = files(team.checkin(chief, {"Fins/Fin.SLDPRT": b"fin", "Fins/Tail.SLDASM": b"tail"}))
    uses = {"Fins/Fin Can.SLDASM": ["Fins/Fin.SLDPRT", "Fins/Tail.SLDASM"]}
    can = files(team.checkin(chief, {"Fins/Fin Can.SLDASM": b"can"}, refs=uses))
    fin, tail, assembly = made["Fin.SLDPRT"], made["Tail.SLDASM"], can["Fin Can.SLDASM"]
    assert put_model(team, chief, fin, mesh=team.upload(chief, mesh())).status_code == 200
    bracket = team.upload(chief, mesh([(c[0] + 1, c[1], c[2]) for c in CORNERS]))  # a virtual part, kept in the can
    moved = [1.0, 0.0, 0.0, 50.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, -2.5]
    components = [
        component("Fin-1", fin),
        component("Fin-2", fin, transform=moved, hidden=True, color=[1, 0, 0]),
        component("Fin-3", fin, configuration="Long"),
        {"name": "Bracket^Fin Can", "transform": IDENTITY, "mesh": bracket},
        component("Tail-1", tail),  # a sub-assembly with nothing under it: none of its parts were found
    ]
    response = put_model(team, chief, assembly, components=components, units="in")
    assert response.status_code == 200, response.text
    assert response.json()["kind"] == "assembly"

    params = {"version": 1, "configuration": "Default"}
    got = client.get(f"/api/files/{assembly['id']}/caliper/assembly", params=params, headers=chief).json()
    assert (got["model"]["units"], got["left_out"]) == ("in", 0)
    # Each says what its file is, so a sub-assembly with nothing under it isn't taken for a part.
    assert [c["kind"] for c in got["components"]] == ["part", "part", "part", None, "assembly"]
    one, two, three, virtual, _ = got["components"]
    assert (one["name"], one["file_id"], one["version"], one["model"]) == ("Fin-1", fin["id"], 1, True)
    assert (two["transform"], two["hidden"], two["color"]) == (moved, True, [1, 0, 0])
    assert three["model"] is False  # Fin has no model in its Long configuration
    assert (virtual["file_id"], virtual["mesh"], virtual["model"]) == (None, bracket, False)
    # Where each one's shape came from: SolidWorks, as Vault for SolidWorks made the models; the Long fin, nowhere yet.
    assert [c["source"] for c in got["components"]] == ["solidworks", "solidworks", None, "solidworks", None]
    assert got["model"]["source"] == "solidworks"
    shape = client.get(f"/api/files/{assembly['id']}/caliper/mesh", params={**params, "mesh": bracket}, headers=chief)
    assert shape.content.startswith(caliper.MAGIC)
    other = client.get(f"/api/files/{assembly['id']}/caliper/mesh", params={**params, "mesh": "f" * 64}, headers=chief)
    assert other.status_code == 404
    # An assembly's own mesh is its parts'.
    assert client.get(f"/api/files/{assembly['id']}/caliper/mesh", params=params, headers=chief).status_code == 400


def test_models_must_fit_their_files(team):
    chief = team.member("chief@x.test", admin=True)
    made = files(team.checkin(chief, {"Fin.SLDPRT": b"fin", "Can.SLDASM": b"can", "Fin.STEP": b"step"}))
    fin, can, step = made["Fin.SLDPRT"], made["Can.SLDASM"], made["Fin.STEP"]
    sha = team.upload(chief, mesh())

    def refused(file: dict, status: int = 400, error: str = "bad_model", **body) -> str:
        response = put_model(team, chief, file, **body)
        assert (response.status_code, response.json()["error"]) == (status, error), response.text
        return response.json()["message"]

    assert "an assembly" in refused(can, mesh=sha)
    assert "a part" in refused(fin, components=[])
    assert "isn't one" in refused(step, mesh=sha)
    assert "no version 2" in refused(fin, status=404, error="not_found", mesh=sha, version=2)
    assert "isn't in the vault" in refused(can, components=[component("Ghost-1", {"id": 999, "version": 1})])
    assert "doesn't have" in refused(can, components=[component("Fin-1", {**fin, "version": 2})])
    assert "no file, shape" in refused(can, components=[{"name": "Empty", "transform": IDENTITY}])
    deep: list[dict] = []
    for _ in range(33):
        deep = [{"name": "Level", "transform": IDENTITY, "children": deep or [component("Fin-1", fin)]}]
    assert "levels deep" in refused(can, components=deep)
    furlongs = put_model(team, chief, fin, mesh=sha, units="furlong")
    assert furlongs.status_code == 422


def test_who_can_add_and_make_models_again(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")  # edits Propulsion
    bob = team.member("bob@x.test")  # edits Structures, and sees Propulsion
    viewer = team.member("viewer@x.test")  # edits nothing
    made = files(team.checkin(chief, {"Propulsion/Injector.SLDPRT": b"injector", "Structures/Fin.SLDPRT": b"fin"}))
    injector = made["Injector.SLDPRT"]
    team.grant(chief, "", None, "viewer")
    team.grant(chief, "Propulsion", "alice@x.test", "editor")
    team.grant(chief, "Structures", "bob@x.test", "editor")
    first, second = team.upload(chief, mesh()), team.upload(chief, mesh(CORNERS[::-1]))

    assert put_model(team, viewer, injector, mesh=first).status_code == 403  # uploads nothing anywhere
    assert put_model(team, bob, injector, mesh=first).status_code == 200  # a model that was missing
    again = put_model(team, bob, injector, mesh=second)  # but not in place of one, outside his folder
    assert again.status_code == 403
    assert "editor access to Propulsion" in again.json()["message"]
    assert put_model(team, alice, injector, mesh=second).status_code == 200
    [model] = client.get(f"/api/files/{injector['id']}/caliper", headers=chief).json()["models"]
    assert model["created_by"]["email"] == "alice@x.test"
    params = {"version": 1, "configuration": "Default"}
    shape = client.get(f"/api/files/{injector['id']}/caliper/mesh", params=params, headers=viewer)
    assert shape.content == mesh(CORNERS[::-1], packed=False)


def test_components_of_files_you_cant_see_are_left_out(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = files(team.checkin(chief, {"Rocket/Fin.SLDPRT": b"fin", "Secret/Motor.SLDASM": b"motor"}))
    made |= files(team.checkin(chief, {"Secret/Grain.SLDPRT": b"grain"}))
    team.grant(chief, "Rocket", "alice@x.test", "editor")  # but not Secret
    fin, motor, grain = made["Fin.SLDPRT"], made["Motor.SLDASM"], made["Grain.SLDPRT"]
    rocket = files(team.checkin(chief, {"Rocket/Rocket.SLDASM": b"rocket"}))["Rocket.SLDASM"]
    igniter = team.upload(chief, mesh())
    components = [
        component("Fin-1", fin),
        component(
            "Motor-1", motor, children=[component("Grain-1", grain), {**component("Igniter^Motor"), "mesh": igniter}]
        ),
    ]
    assert put_model(team, chief, rocket, components=components).status_code == 200

    params = {"version": 1, "configuration": "Default"}
    seen = client.get(f"/api/files/{rocket['id']}/caliper/assembly", params=params, headers=alice).json()
    assert [c["name"] for c in seen["components"]] == ["Fin-1"]
    assert seen["left_out"] == 1  # the motor, with everything in it
    hidden = client.get(f"/api/files/{rocket['id']}/caliper/mesh", params={**params, "mesh": igniter}, headers=alice)
    assert hidden.status_code == 404
    everything = client.get(f"/api/files/{rocket['id']}/caliper/assembly", params=params, headers=chief).json()
    assert [c["name"] for c in everything["components"][1]["children"]] == ["Grain-1", "Igniter^Motor"]
    # Nor can she name them in models of her own.
    refused = put_model(team, alice, rocket, components=[component("Grain-1", grain)], configuration="Mine")
    assert refused.status_code == 400
    assert client.get(f"/api/files/{grain['id']}/caliper", headers=alice).status_code == 404


def test_which_models_are_missing(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    made = files(team.checkin(chief, {"Rocket/Fin.SLDPRT": b"fin", "Secret/Grain.SLDPRT": b"grain"}))
    fin, grain = made["Fin.SLDPRT"], made["Grain.SLDPRT"]
    team.grant(chief, "Rocket", "alice@x.test", "editor")
    assert put_model(team, chief, fin, mesh=team.upload(chief, mesh())).status_code == 200

    def missing(who: dict[str, str], *models: tuple[dict, int, str]) -> list[tuple[int, int, str]]:
        body = {"models": [{"file_id": f["id"], "version": v, "configuration": c} for f, v, c in models]}
        response = client.post("/api/caliper/missing", json=body, headers=who)
        assert response.status_code == 200, response.text
        return [(m["file_id"], m["version"], m["configuration"]) for m in response.json()["missing"]]

    asked = [(fin, 1, "Default"), (fin, 1, "Long"), (fin, 2, "Default"), (grain, 1, "Default"), (fin, 1, "Long")]
    assert missing(chief, *asked) == [(fin["id"], 1, "Long"), (grain["id"], 1, "Default")]
    assert missing(alice, *asked) == [(fin["id"], 1, "Long")]  # not the grain, which she can't see


def again(team, who, path: str, data: bytes) -> dict:
    """A file's next version, checked in."""
    assert team.checkout(who, path).status_code == 200
    return files(team.checkin(who, {path: data}))[path.rsplit("/", 1)[-1]]


def assembly_of(client, who, file: dict, parts: str | None = None) -> dict[str, dict]:
    """An assembly's components, as Caliper asks for them, by name at every level."""
    params = {"version": file["version"], "configuration": "Default", **({"parts": parts} if parts else {})}
    response = client.get(f"/api/files/{file['id']}/caliper/assembly", params=params, headers=who)
    assert response.status_code == 200, response.text
    found: dict[str, dict] = {}

    def visit(components: list[dict]) -> None:
        for c in components:
            found[c["name"]] = c
            visit(c["children"])

    visit(response.json()["components"])
    return found


def test_an_assemblys_parts_show_at_their_latest_versions(team, client):
    """A part checked in since the assembly was shows at its latest version, as SolidWorks would show the assembly once
    it had the latest files, where the assembly has the version it was checked in with; each says both. Its own model
    draws it, not the shape the assembly's 3D view kept of the older one. As checked in is still there to see."""
    chief = team.member("chief@x.test", admin=True)
    made = files(team.checkin(chief, {"Fins/Fin.SLDPRT": b"fin", "Fins/Tab.SLDPRT": b"tab"}))
    fin, tab = made["Fin.SLDPRT"], made["Tab.SLDPRT"]
    rocket = files(
        team.checkin(
            chief, {"Rocket.SLDASM": b"rocket"}, refs={"Rocket.SLDASM": ["Fins/Fin.SLDPRT", "Fins/Tab.SLDPRT"]}
        )
    )["Rocket.SLDASM"]
    old_tab, bracket = team.upload(chief, mesh()), team.upload(chief, mesh(CORNERS[::-1]))
    components = [
        component("Fin-1", fin),
        component("Tab-1", tab, mesh=old_tab),  # as the assembly's 3D view kept it
        {**component("Bracket^Rocket"), "mesh": bracket, "virtual": True},
    ]
    assert put_model(team, chief, rocket, components=components).status_code == 200
    fin2 = again(team, chief, "Fins/Fin.SLDPRT", b"fin v2")
    again(team, chief, "Fins/Tab.SLDPRT", b"tab v2")
    assert put_model(team, chief, fin2, mesh=team.upload(chief, mesh())).status_code == 200

    as_built = assembly_of(client, chief, rocket)  # unless asked, as it was checked in
    assert {name: (c["version"], c["checked_in_version"], c["latest_version"]) for name, c in as_built.items()} == {
        "Fin-1": (1, 1, 2),
        "Tab-1": (1, 1, 2),
        "Bracket^Rocket": (None, None, None),
    }
    assert assembly_of(client, chief, rocket, "checked_in") == as_built

    latest = assembly_of(client, chief, rocket, "latest")
    assert {name: (c["version"], c["checked_in_version"]) for name, c in latest.items()} == {
        "Fin-1": (2, 1),
        "Tab-1": (2, 1),
        "Bracket^Rocket": (None, None),
    }
    assert (latest["Fin-1"]["model"], latest["Fin-1"]["source"]) == (True, "solidworks")
    # The tab's v2 has no model yet: Caliper has the server make it, rather than show v1's shape.
    assert (latest["Tab-1"]["mesh"], latest["Tab-1"]["model"], latest["Tab-1"]["source"]) == (None, False, None)
    assert latest["Bracket^Rocket"]["mesh"] == bracket  # kept inside the assembly: as it was
    assert latest["Fin-1"]["transform"] == as_built["Fin-1"]["transform"]


def test_a_newer_sub_assembly_shows_its_newer_parts_where_they_are_in_it(team, client):
    """A sub-assembly checked in since, with parts added or moved, shows that version's parts where it has them, if
    it's rigid and that version has a model; a flexible one (its parts where the assembly moved them, not where its own
    model has them) keeps its parts where they were, each at its latest; one with no model yet stays as it was."""
    chief = team.member("chief@x.test", admin=True)
    made = files(team.checkin(chief, {"Motor/Grain.SLDPRT": b"grain", "Motor/Igniter.SLDPRT": b"igniter"}))
    grain, igniter = made["Grain.SLDPRT"], made["Igniter.SLDPRT"]
    motor = files(
        team.checkin(chief, {"Motor/Motor.SLDASM": b"motor"}, refs={"Motor/Motor.SLDASM": ["Motor/Grain.SLDPRT"]})
    )["Motor.SLDASM"]
    up = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0]  # 5 mm along z, in the motor
    assert put_model(team, chief, motor, components=[component("Grain-1", grain, transform=up)]).status_code == 200
    rocket = files(team.checkin(chief, {"Rocket.SLDASM": b"rocket"}, refs={"Rocket.SLDASM": ["Motor/Motor.SLDASM"]}))[
        "Rocket.SLDASM"
    ]
    aft = [0.0, -1.0, 0.0, 100.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]  # turned a quarter about z, 100 mm along x
    grain_there = [0.0, -1.0, 0.0, 100.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0]
    rigid = component("Motor-1", motor, transform=aft, children=[component("Grain-1", grain, transform=grain_there)])
    flexed = component(
        "Motor-2", motor, transform=aft, children=[component("Grain-1", grain, transform=[*grain_there[:11], 9.0])]
    )
    assert put_model(team, chief, rocket, components=[rigid, flexed]).status_code == 200

    # The motor's v2, with the igniter added and the grain moved; its model is relative to the motor.
    motor2 = again(team, chief, "Motor/Motor.SLDASM", b"motor v2")
    lower = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 2.0]
    nose = [1.0, 0.0, 0.0, 30.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    wire = team.upload(chief, mesh(CORNERS[::-1]))  # a virtual part, kept in the motor's v2
    newer = [
        component("Grain-1", grain, transform=lower),
        component("Igniter-1", igniter, transform=nose),
        {**component("Wire^Motor"), "mesh": wire, "virtual": True},
    ]
    response = client.get(
        f"/api/files/{rocket['id']}/caliper/assembly",
        params={"version": 1, "configuration": "Default", "parts": "latest"},
        headers=chief,
    )
    shown = response.json()["components"]
    assert [(c["name"], c["version"], c["latest_version"]) for c in shown] == [("Motor-1", 1, 2), ("Motor-2", 1, 2)]
    assert put_model(team, chief, motor2, components=newer).status_code == 200

    response = client.get(
        f"/api/files/{rocket['id']}/caliper/assembly",
        params={"version": 1, "configuration": "Default", "parts": "latest"},
        headers=chief,
    )
    one, two = response.json()["components"]
    assert (one["version"], one["checked_in_version"]) == (2, 1)
    assert [(c["name"], c["transform"], c["checked_in_version"]) for c in one["children"]] == [
        ("Grain-1", [0.0, -1.0, 0.0, 100.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 2.0], None),
        ("Igniter-1", [0.0, -1.0, 0.0, 100.0, 1.0, 0.0, 0.0, 30.0, 0.0, 0.0, 1.0, 0.0], None),
        ("Wire^Motor", [0.0, -1.0, 0.0, 100.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0], None),
    ]
    # The rocket's model shows the wire the motor's v2 keeps, so its shape is the rocket's to give.
    params = {"version": 1, "configuration": "Default", "mesh": wire}
    assert client.get(f"/api/files/{rocket['id']}/caliper/mesh", params=params, headers=chief).status_code == 200
    # Flexed: its grain stays where the rocket moved it.
    assert (two["version"], [(c["name"], c["transform"][11]) for c in two["children"]]) == (1, [("Grain-1", 9.0)])
