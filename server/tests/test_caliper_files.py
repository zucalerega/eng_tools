"""Caliper's models made from SolidWorks files themselves: the 3D view SolidWorks saves in each part and assembly
(vault/solidworks.py). The files are SparkFun's servo (fixtures/solidworks/README.md), checked against SolidWorks' own
bounding boxes, which it keeps in the assembly."""

import json
import random
import struct
import zlib
from pathlib import Path

from .test_caliper import IDENTITY, mesh, put_model

FIXTURES = Path(__file__).parent / "fixtures" / "solidworks"
DARK_GRAY = [0.251, 0.251, 0.251]  # the servo case's color: RGB 64, 64, 64


def contents(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def files(response) -> dict[str, dict]:
    assert response.status_code == 200, response.text
    return {entry["file"]["name"]: entry["file"] for entry in response.json()["files"]}


def make(client, who, file: dict, version: int = 1):
    return client.post(f"/api/files/{file['id']}/caliper/make", json={"version": version}, headers=who)


def unpack(raw: bytes) -> tuple[dict, list[tuple[float, float, float]], list[int]]:
    """A mesh's header, its vertices (mm), and its triangles' corners."""
    assert raw[:4] == b"CMSH"
    _version, length = struct.unpack_from("<II", raw, 4)
    header = json.loads(raw[12 : 12 + length])
    vertices, triangles = header["vertices"], header["triangles"]
    floats = struct.unpack_from(f"<{3 * vertices}f", raw, 12 + length)
    corners = list(struct.unpack_from(f"<{3 * triangles}I", raw, 12 + length + 12 * vertices))
    return header, [tuple(floats[i : i + 3]) for i in range(0, len(floats), 3)], corners


def box(points) -> list[float]:
    return [round(min(p[i] for p in points), 3) for i in range(3)] + [
        round(max(p[i] for p in points), 3) for i in range(3)
    ]


def test_a_part_is_read_from_its_file(team, client):
    chief = team.member("chief@x.test", admin=True)
    case = files(team.checkin(chief, {"Servo/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT")}))[
        "Servomoteur.SLDPRT"
    ]

    made = make(client, chief, case)
    assert made.status_code == 200, made.text
    model = made.json()
    assert (model["version"], model["configuration"], model["kind"], model["units"]) == (1, "Default", "part", "mm")
    assert client.get(f"/api/files/{case['id']}/caliper", headers=chief).json()["models"] == [model]

    shape = client.get(
        f"/api/files/{case['id']}/caliper/mesh", params={"version": 1, "configuration": "Default"}, headers=chief
    )
    assert shape.headers["content-encoding"] == "gzip"
    header, vertices, corners = unpack(shape.content)
    assert (header["vertices"], header["triangles"]) == (len(vertices), 2430)
    assert max(corners) < len(vertices)
    [body] = header["bodies"]
    assert (body["name"], len(body["faces"]), body["solid"]) == ("Boss-Extrude1", 52, True)
    # As SolidWorks keeps it: 54.3 x 41.7 x 20.7 mm, from its own origin.
    assert box(vertices) == [-23.182, 0.0, -9.489, 31.118, 41.7, 11.211]
    # Its faces have their own colors: most of them dark gray, and a light label.
    colors = [face["color"] for face in body["faces"]]
    assert sum(color == DARK_GRAY for color in colors) == 39
    assert [0.7529, 0.7529, 0.7529] in colors

    # It's made once: asked again, the same model comes back.
    assert make(client, chief, case).json() == model


def test_a_parts_bodies_keep_their_names(team, client):
    chief = team.member("chief@x.test", admin=True)
    spline = files(team.checkin(chief, {"Embout.SLDPRT": contents("Embout.SLDPRT")}))["Embout.SLDPRT"]
    assert make(client, chief, spline).status_code == 200
    shape = client.get(
        f"/api/files/{spline['id']}/caliper/mesh", params={"version": 1, "configuration": "Default"}, headers=chief
    )
    header, vertices, _ = unpack(shape.content)
    assert [(b["name"], len(b["faces"])) for b in header["bodies"]] == [("Fillet3", 78), ("Boss-Extrude2", 3)]
    assert header["triangles"] == 1696
    assert box(vertices) == [-2.652, -4.0, -2.636, 2.652, 4.0, 2.657]
    # No appearance of its own: SolidWorks' default color.
    assert {tuple(b["color"]) for b in header["bodies"]} == {(0.7922, 0.8196, 0.9333)}
    assert all("color" not in face for b in header["bodies"] for face in b["faces"])


def test_an_assembly_is_read_with_its_components(team, client):
    chief = team.member("chief@x.test", admin=True)
    checked = files(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": contents("9347.SLDASM"),
                "Servo/Parts/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Servo/Parts/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT"),
            },
            refs={"Servo/9347.SLDASM": ["Servo/Parts/Embout.SLDPRT", "Servo/Parts/Servomoteur.SLDPRT"]},
        )
    )
    servo, spline, case = checked["9347.SLDASM"], checked["Embout.SLDPRT"], checked["Servomoteur.SLDPRT"]

    made = make(client, chief, servo)
    assert made.status_code == 200, made.text
    assert (made.json()["kind"], made.json()["configuration"]) == ("assembly", "Default")
    assembly = client.get(
        f"/api/files/{servo['id']}/caliper/assembly", params={"version": 1, "configuration": "Default"}, headers=chief
    ).json()
    assert assembly["left_out"] == 0
    found = {c["name"]: c for c in assembly["components"]}
    assert sorted(found) == ["Embout-1", "Servomoteur-1"]
    # Each is its file, at the version the assembly uses, which can be opened on its own; and carries its shape as the
    # assembly shows it, so the assembly is whole though its parts have no models of their own yet.
    for component, file in ((found["Embout-1"], spline), (found["Servomoteur-1"], case)):
        assert (component["file_id"], component["version"], component["configuration"]) == (file["id"], 1, "Default")
        assert component["mesh"] and component["model"] is False and component["hidden"] is False

    # Placed where SolidWorks has them, the parts fill the box SolidWorks keeps for the assembly.
    placed = []
    for component in assembly["components"]:
        shape = client.get(
            f"/api/files/{servo['id']}/caliper/mesh",
            params={"version": 1, "configuration": "Default", "mesh": component["mesh"]},
            headers=chief,
        )
        _, vertices, _ = unpack(shape.content)
        rows = component["transform"]
        placed += [
            tuple(sum(rows[4 * i + j] * p[j] for j in range(3)) + rows[4 * i + 3] for i in range(3)) for p in vertices
        ]
    assert box(placed) == [-18.54, -45.018, -11.886, 38.881, 0.682, 19.669]

    # A part's own model, made from its own file, is the very shape the assembly carries: one blob.
    make(client, chief, spline)
    own = client.get(
        f"/api/files/{spline['id']}/caliper/mesh", params={"version": 1, "configuration": "Default"}, headers=chief
    )
    assert own.headers["etag"] == f'"{found["Embout-1"]["mesh"]}"'


def by_path(response) -> dict[str, dict]:
    assert response.status_code == 200, response.text
    return {entry["file"]["path"]: entry["file"] for entry in response.json()["files"]}


def swapped(name: bytes) -> bytes:
    """A stream's name as SolidWorks stores it: each byte's halves swapped."""
    return bytes(((b << 4) | (b >> 4)) & 0xFF for b in name)


def without_3d_view(data: bytes) -> bytes:
    """A file in which SolidWorks saved no display list: its streams of that name, renamed."""
    return data.replace(swapped(b"Contents/DisplayLists"), swapped(b"Contents/DisplayListz"))


def in_2024_layout(display: bytes, first: int = 1) -> bytes:
    """A display list as SolidWorks 2024 and later write it: 32 bytes between each face's counts and its arrays, the
    uint32s 1, 0, 0, a number of the face's, and four 0s (first: something other than the 1, which no SolidWorks
    wrote)."""
    strips = struct.pack("<3I", 4, 8, 2)
    places = []
    at = display.find(strips)
    while at >= 0:
        triangles, count = struct.unpack_from("<2I", display, at - 8)
        if 0 < count < 1 << 16 and count == struct.unpack_from("<I", display, at + 12)[0]:
            lengths = struct.unpack_from(f"<{count}I", display, at + 16)
            if triangles == sum(lengths) - 2 * count:
                places.append(at)
        at = display.find(strips, at + 1)
    assert places
    changed = bytearray(display)
    for i, at in reversed(list(enumerate(places))):
        changed[at:at] = struct.pack("<8I", first, 0, 0, 0x201A94 + i, 0, 0, 0, 0)
    return bytes(changed)


def test_a_part_saved_by_solidworks_2024_or_later_is_read(team, client):
    """From SolidWorks 2024 on, 32 more bytes come in each face of a part's 3D view (vault/solidworks.py): the case
    saved that way reads as the very same mesh, the same blob."""
    chief = team.member("chief@x.test", admin=True)
    case = contents("Servomoteur.SLDPRT")
    checked = files(
        team.checkin(
            chief,
            {
                "Servomoteur.SLDPRT": case,
                "Servomoteur 2025.SLDPRT": repacked(case, "Contents/DisplayLists", in_2024_layout),
            },
        )
    )
    meshes = []
    for file in checked.values():
        made = make(client, chief, file)
        assert made.status_code == 200, made.text
        assert (made.json()["kind"], made.json()["units"]) == ("part", "mm")
        params = {"version": 1, "configuration": "Default"}
        meshes.append(client.get(f"/api/files/{file['id']}/caliper/mesh", params=params, headers=chief).headers["etag"])
    assert meshes[0] == meshes[1]


def test_parts_and_assemblies_saved_by_solidworks_2014_or_older_are_read(team, client):
    """SolidWorks 2014 and older saved files as OLE compound documents of the same streams, most of them packed
    (vault/solidworks.py): SparkFun's box and lid, checked against their STL exports and the box SolidWorks keeps for
    the assembly."""
    chief = team.member("chief@x.test", admin=True)
    checked = files(
        team.checkin(
            chief,
            {
                "Box/11351_assembly.SLDASM": contents("11351_assembly.SLDASM"),
                "Box/11351_body.SLDPRT": contents("11351_body.SLDPRT"),
                "Box/11351_lid.SLDPRT": contents("11351_lid.SLDPRT"),
            },
            refs={"Box/11351_assembly.SLDASM": ["Box/11351_body.SLDPRT", "Box/11351_lid.SLDPRT"]},
        )
    )
    params = {"version": 1, "configuration": "Default"}
    for name, faces, size in (
        ("11351_body.SLDPRT", 55, [119.634, 95.25, 33.02]),
        ("11351_lid.SLDPRT", 44, [119.634, 5.842, 95.25]),
    ):
        made = make(client, chief, checked[name])
        assert made.status_code == 200, made.text
        # Their units aren't in the file in a form Caliper reads: they start in mm.
        assert (made.json()["configuration"], made.json()["units"]) == ("Default", "mm")
        shape = client.get(f"/api/files/{checked[name]['id']}/caliper/mesh", params=params, headers=chief)
        header, vertices, _ = unpack(shape.content)
        assert [len(body["faces"]) for body in header["bodies"]] == [faces]
        low = box(vertices)
        assert [round(low[3 + i] - low[i], 3) for i in range(3)] == size

    # The assembly's own view carries its parts' triangles. The box isn't turned: SolidWorks keeps just where it is.
    assert make(client, chief, checked["11351_assembly.SLDASM"]).status_code == 200
    assembly = client.get(
        f"/api/files/{checked['11351_assembly.SLDASM']['id']}/caliper/assembly", params=params, headers=chief
    ).json()
    found = {c["name"]: c for c in assembly["components"]}
    assert sorted(found) == ["11351_body-1", "11351_lid-1"]
    placed = []
    for component in assembly["components"]:
        assert component["mesh"]
        shape = client.get(
            f"/api/files/{checked['11351_assembly.SLDASM']['id']}/caliper/mesh",
            params={**params, "mesh": component["mesh"]},
            headers=chief,
        )
        _, vertices, _ = unpack(shape.content)
        rows = component["transform"]
        placed += [
            tuple(sum(rows[4 * i + j] * p[j] for j in range(3)) + rows[4 * i + 3] for i in range(3)) for p in vertices
        ]
    assert box(placed) == [12.308, 40.787, 90.584, 131.942, 136.037, 127.414]


def test_an_assembly_whose_3d_view_is_older_than_its_components_shows_them_where_they_are(team, client):
    """SolidWorks' display list can be older than the XML that lists the components (the team's OVNT and PRQD
    assemblies), and then the XML is right: placed by it, the parts fill the box SolidWorks keeps for the assembly. So
    the components go where the XML puts them, and the display list's shapes, as old, aren't used."""
    chief = team.member("chief@x.test", admin=True)

    def moved(tree: bytes) -> bytes:  # the spline 6.35 mm further along y, in the XML only
        return tree.replace(b"0.001710010157499106 -0.00331766815477726", b"0.001710010157499106 0.00303233184522274")

    checked = files(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": repacked(contents("9347.SLDASM"), "swXmlContents/COMPINSTANCETREE", moved),
                "Servo/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Servo/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT"),
            },
            refs={"Servo/9347.SLDASM": ["Servo/Embout.SLDPRT", "Servo/Servomoteur.SLDPRT"]},
        )
    )
    servo = checked["9347.SLDASM"]
    assert make(client, chief, servo).status_code == 200
    assembly = client.get(
        f"/api/files/{servo['id']}/caliper/assembly", params={"version": 1, "configuration": "Default"}, headers=chief
    ).json()
    found = {c["name"]: c for c in assembly["components"]}
    assert round(found["Embout-1"]["transform"][7], 3) == 3.032  # the XML's place, not the display list's -3.318
    # Each part shows its own file's shape.
    assert [(c["mesh"], c["file_id"]) for c in assembly["components"]] == [
        (None, checked["Embout.SLDPRT"]["id"]),
        (None, checked["Servomoteur.SLDPRT"]["id"]),
    ]


def test_a_part_kept_inside_an_assembly_without_a_3d_view_says_so(team, client):
    """A virtual part, as SolidWorks Routing's tubes are, is kept inside its assembly, and SolidWorks builds a routed
    tube again whenever it opens the assembly: from 2024 on, nothing in the file has its shape. It stays in the model,
    as virtual, for Caliper to say why it shows nothing, rather than be taken for a part missing from the vault."""
    chief = team.member("chief@x.test", admin=True)

    def virtual(tree: bytes) -> bytes:  # the case kept inside the assembly
        case = tree.index(b'swName="Servomoteur" swReferenceNumber')
        return tree[:case] + tree[case:].replace(b'swIsVirtualComponent="NO"', b'swIsVirtualComponent="YES"', 1)

    servo = repacked(without_3d_view(contents("9347.SLDASM")), "swXmlContents/COMPINSTANCETREE", virtual)
    checked = files(
        team.checkin(
            chief,
            {"Servo/9347.SLDASM": servo, "Servo/Embout.SLDPRT": contents("Embout.SLDPRT")},
            refs={"Servo/9347.SLDASM": ["Servo/Embout.SLDPRT"]},
        )
    )
    assert make(client, chief, checked["9347.SLDASM"]).status_code == 200
    shown = client.get(
        f"/api/files/{checked['9347.SLDASM']['id']}/caliper/assembly",
        params={"version": 1, "configuration": "Default"},
        headers=chief,
    ).json()
    assert [(c["name"], c["file_id"] is not None, c["mesh"], c["virtual"]) for c in shown["components"]] == [
        ("Embout-1", True, None, False),
        ("Servomoteur-1", False, None, True),
    ]


def test_each_configuration_of_an_assembly_is_shown(team, client):
    """An assembly's XML lists the components of each of its configurations (the team's have up to three), placed and
    suppressed as each has them. Each up to date has a model; one SolidWorks says needs rebuilding has none, as its
    places may be old."""
    chief = team.member("chief@x.test", admin=True)

    def configurations(tree: bytes) -> bytes:
        start = tree.index(b'<swModel id="2"')
        top = tree[start : tree.index(b"</swModel>", start) + len(b"</swModel>")]
        out = top.replace(b'id="2"', b'id="99"', 1).replace(
            b'swConfigurationName="Default"', b'swConfigurationName="Spline out"', 1
        )
        out = out.replace(b"0.001710010157499106 -0.00331766815477726", b"0.001710010157499106 0.00668233184522274")
        tree = tree.replace(top, top + out)
        more = (
            b'<swConfiguration id="98" swName="Spline out" swID="1" swMostRecentConfiguration="NO" '
            b'swConfigurationNeedsUpdate="NO" swModelRef="99"/>'
            b'<swConfiguration id="97" swName="Old" swID="2" swMostRecentConfiguration="NO" '
            b'swConfigurationNeedsUpdate="YES" swModelRef="99"/>'
        )
        return tree.replace(b"</swConfigurationList>", more + b"</swConfigurationList>")

    checked = files(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": repacked(
                    contents("9347.SLDASM"), "swXmlContents/COMPINSTANCETREE", configurations
                ),
                "Servo/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Servo/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT"),
            },
            refs={"Servo/9347.SLDASM": ["Servo/Embout.SLDPRT", "Servo/Servomoteur.SLDPRT"]},
        )
    )
    servo = checked["9347.SLDASM"]
    made = make(client, chief, servo)
    assert made.json()["configuration"] == "Default"  # the one SolidWorks had open
    models = client.get(f"/api/files/{servo['id']}/caliper", headers=chief).json()["models"]
    assert [model["configuration"] for model in models] == ["Default", "Spline out"]

    def spline(configuration: str) -> dict:
        shown = client.get(
            f"/api/files/{servo['id']}/caliper/assembly",
            params={"version": 1, "configuration": configuration},
            headers=chief,
        ).json()
        return {c["name"]: c for c in shown["components"]}["Embout-1"]

    assert round(spline("Default")["transform"][7], 3) == -3.318
    assert round(spline("Spline out")["transform"][7], 3) == 6.682
    # The parts are in their configurations as before, so the display list's shapes serve both.
    assert spline("Spline out")["mesh"] == spline("Default")["mesh"] is not None


def test_a_step_file_placed_in_an_assembly_says_its_format(team, client):
    """A STEP or IGES file placed with SolidWorks' 3D Interconnect is a component with no SolidWorks kind: the web app
    reads it as it is, as it does the file on its own."""
    chief = team.member("chief@x.test", admin=True)
    checked = files(team.checkin(chief, {"Bay/Board.STEP": b"ISO-10303-21;", "Bay/Fin.SLDPRT": b"fin"}))
    bay = files(
        team.checkin(chief, {"Bay/Bay.SLDASM": b"bay"}, refs={"Bay/Bay.SLDASM": ["Bay/Board.STEP", "Bay/Fin.SLDPRT"]})
    )["Bay.SLDASM"]
    components = [
        {"name": "Board-1", "file_id": checked["Board.STEP"]["id"], "version": 1, "transform": IDENTITY},
        {"name": "Fin-1", "file_id": checked["Fin.SLDPRT"]["id"], "version": 1, "transform": IDENTITY},
    ]
    assert put_model(team, chief, bay, components=components).status_code == 200
    shown = client.get(
        f"/api/files/{bay['id']}/caliper/assembly", params={"version": 1, "configuration": "Default"}, headers=chief
    ).json()
    assert [(c["name"], c["kind"], c["format"]) for c in shown["components"]] == [
        ("Board-1", None, "step"),
        ("Fin-1", "part", None),
    ]


def test_a_3d_view_caliper_cant_follow_isnt_called_empty(team, client):
    """A view with faces the reader can't find in it is in a layout it doesn't know, and says so; only a part without a
    view says SolidWorks saved none."""
    chief = team.member("chief@x.test", admin=True)
    case = contents("Servomoteur.SLDPRT")
    checked = files(
        team.checkin(
            chief,
            {
                "Odd.SLDPRT": repacked(case, "Contents/DisplayLists", lambda d: in_2024_layout(d, first=7)),
                "Bare.SLDPRT": without_3d_view(case),
            },
        )
    )
    odd, bare = (make(client, chief, checked[name]) for name in ("Odd.SLDPRT", "Bare.SLDPRT"))
    assert (odd.status_code, odd.json()["error"]) == (422, "unreadable_file")
    assert "can't make sense of the 3D view SolidWorks saved in it" in odd.json()["message"]
    assert (bare.status_code, bare.json()["error"]) == (422, "unreadable_file")
    assert "SolidWorks saved no 3D view in it" in bare.json()["message"]


def test_an_assembly_without_references_finds_its_parts_by_their_paths(team, client):
    """Versions checked in from the web app, or brought over from Kenesto, record no references: an assembly's parts are
    found in the vault by the paths SolidWorks saved for them, at the versions they had when the assembly's version was
    made. Without a 3D view of its own, the assembly is read from its XML, each part to show its own model."""
    chief = team.member("chief@x.test", admin=True)
    # SolidWorks saved the parts as C:\Users\...\Desktop\Servomoteur SM-S4303R\: of the two splines, the one in a folder
    # of that name is the assembly's.
    folder = "Servo/Servomoteur SM-S4303R"
    checked = by_path(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": without_3d_view(contents("9347.SLDASM")),
                f"{folder}/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Spares/Embout.SLDPRT": contents("Embout.SLDPRT"),
                f"{folder}/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT"),
            },
        )
    )
    servo, spline, case = (
        checked[p] for p in ("Servo/9347.SLDASM", f"{folder}/Embout.SLDPRT", f"{folder}/Servomoteur.SLDPRT")
    )
    # The case changes after the assembly's version: that version still has the case it had.
    assert team.checkout(chief, f"{folder}/Servomoteur.SLDPRT").status_code == 200
    by_path(team.checkin(chief, {f"{folder}/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT") + b" "}))

    made = make(client, chief, servo)
    assert made.status_code == 200, made.text
    params = {"version": 1, "configuration": "Default"}
    assembly = client.get(f"/api/files/{servo['id']}/caliper/assembly", params=params, headers=chief).json()
    found = {c["name"]: (c["file_id"], c["version"], c["mesh"], c["model"]) for c in assembly["components"]}
    assert found == {"Embout-1": (spline["id"], 1, None, False), "Servomoteur-1": (case["id"], 1, None, False)}
    # Each part's own model is made from its file, as Caliper asks for it.
    assert make(client, chief, spline).status_code == 200


def test_an_assembly_whose_parts_caliper_cant_tell_apart_or_find(team, client):
    chief = team.member("chief@x.test", admin=True)
    # Two splines in folders of the name SolidWorks saved (Servomoteur SM-S4303R): neither is taken for the other.
    checked = by_path(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": without_3d_view(contents("9347.SLDASM")),
                "A/Servomoteur SM-S4303R/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "B/Servomoteur SM-S4303R/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Servomoteur SM-S4303R/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT"),
            },
        )
    )
    servo = checked["Servo/9347.SLDASM"]
    assert make(client, chief, servo).status_code == 200
    params = {"version": 1, "configuration": "Default"}
    assembly = client.get(f"/api/files/{servo['id']}/caliper/assembly", params=params, headers=chief).json()
    assert [c["name"] for c in assembly["components"]] == ["Servomoteur-1"]


def test_an_assembly_with_nothing_to_show_says_so(team, client):
    """No 3D view of its own, and none of its parts in the vault: nothing is made, and the reason says what to do. Files
    with the parts' names, in folders of other names, aren't taken for them: a name alone could be any file's."""
    chief = team.member("chief@x.test", admin=True)
    checked = by_path(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": without_3d_view(contents("9347.SLDASM")),
                "Elsewhere/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Elsewhere/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT"),
            },
        )
    )
    servo = checked["Servo/9347.SLDASM"]
    refused = make(client, chief, servo)
    assert (refused.status_code, refused.json()["error"]) == (422, "unreadable_file")
    assert refused.json()["message"].startswith("Servo/9347.SLDASM v1: Caliper found none of its parts")
    assert client.get(f"/api/files/{servo['id']}/caliper", headers=chief).json() == {"models": []}


def test_who_may_read_and_see_a_files_model(team, client):
    chief = team.member("chief@x.test", admin=True)
    bob = team.member("bob@x.test")
    eve = team.member("eve@x.test")
    files(team.checkin(chief, {"Servo/Parts/Embout.SLDPRT": contents("Embout.SLDPRT")}))
    files(team.checkin(chief, {"Secret/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT")}))
    servo = files(
        team.checkin(
            chief,
            {"Servo/9347.SLDASM": contents("9347.SLDASM")},
            refs={"Servo/9347.SLDASM": ["Servo/Parts/Embout.SLDPRT", "Secret/Servomoteur.SLDPRT"]},
        )
    )["9347.SLDASM"]
    team.grant(chief, "Servo", "bob@x.test", "viewer")

    # Someone who can only view may: the model comes from the file. Who can't see the file can't.
    assert make(client, eve, servo).status_code == 404
    assert make(client, bob, servo).status_code == 200
    params = {"version": 1, "configuration": "Default"}
    seen = client.get(f"/api/files/{servo['id']}/caliper/assembly", params=params, headers=bob).json()
    assert ([c["name"] for c in seen["components"]], seen["left_out"]) == (["Embout-1"], 1)
    # The model is whole: the case is left out only for those who can't see it.
    whole = client.get(f"/api/files/{servo['id']}/caliper/assembly", params=params, headers=chief).json()
    assert sorted(c["name"] for c in whole["components"]) == ["Embout-1", "Servomoteur-1"]


def test_files_caliper_cant_read(team, client):
    chief = team.member("chief@x.test", admin=True)
    old = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + bytes(4088)  # an OLE compound document's start, and no more
    damaged = contents("Embout.SLDPRT")[:60_000]  # cut off: its streams fail their CRCs
    checked = files(
        team.checkin(
            chief,
            {
                "Old.SLDPRT": old,
                "Text.SLDPRT": b"not a part",
                "Damaged.SLDPRT": damaged,
                "Tab.STEP": b"ISO-10303-21;",
            },
        )
    )

    def refused(name: str) -> tuple[int, str, str]:
        response = make(client, chief, checked[name])
        return response.status_code, response.json()["error"], response.json()["message"]

    status, code, message = refused("Old.SLDPRT")
    assert (status, code) == (422, "unreadable_file")
    assert message.startswith("Old.SLDPRT v1: It's an OLE file, as SolidWorks 2014 and older saved them, that doesn't")
    assert refused("Text.SLDPRT")[:2] == (422, "unreadable_file")
    assert refused("Damaged.SLDPRT")[:2] == (422, "unreadable_file")
    assert refused("Tab.STEP")[:2] == (400, "bad_model")
    assert make(client, chief, checked["Old.SLDPRT"], version=2).status_code == 404
    # Nothing was made of them.
    for file in checked.values():
        assert client.get(f"/api/files/{file['id']}/caliper", headers=chief).json() == {"models": []}


def test_a_version_with_a_model_keeps_it(team, client):
    chief = team.member("chief@x.test", admin=True)
    tab = files(team.checkin(chief, {"Tab.SLDPRT": b"made in SolidWorks"}))["Tab.SLDPRT"]
    # Vault for SolidWorks made its model: that's the one, and the file isn't read.
    assert put_model(team, chief, tab, mesh=team.upload(chief, mesh()), configuration="Long").status_code == 200
    made = make(client, chief, tab)
    assert made.status_code == 200, made.text
    assert (made.json()["configuration"], made.json()["created_by"]["email"]) == ("Long", "chief@x.test")


def repacked(data: bytes, name: str, change) -> bytes:
    """A SolidWorks file with one stream changed (change: its bytes, to the new ones), packed again with its CRC. Files
    start with blocks that look like streams but don't unpack, which SolidWorks (and Caliper) pass over."""
    marker = b"\x14\x00\x06\x00\x08\x00"
    at = data.find(marker)
    while at >= 0:
        head = at + len(marker)
        tag, crc, packed, size, length = struct.unpack_from("<5I", data, head)
        start = head + 20 + length
        if bytes(((b << 4) | (b >> 4)) & 0xFF for b in data[head + 20 : start]) == name.encode():
            try:
                old = zlib.decompressobj(-15).decompress(data[start : start + packed])
            except zlib.error:
                old = b""
            if len(old) != size or zlib.crc32(old) != crc:
                at = data.find(marker, at + 1)
                continue
            new = change(old)
            deflater = zlib.compressobj(6, zlib.DEFLATED, -15)
            body = deflater.compress(new) + deflater.flush()
            header = marker + struct.pack("<5I", tag, zlib.crc32(new), len(body), len(new), length)
            return data[:at] + header + data[head + 20 : start] + body + data[start + packed :]
        at = data.find(marker, at + 1)
    raise KeyError(name)


def test_a_damaged_3d_view_is_refused_or_read_never_an_error(team, client):
    """SolidWorks' display list has no checks of its own beyond its stream's CRC, and the reader is careful: whatever
    the bytes, it reads them or refuses them."""
    chief = team.member("chief@x.test", admin=True)
    pick = random.Random(9347)

    def damage(display: bytes) -> bytes:
        damaged = bytearray(display)
        at = pick.randrange(len(damaged))
        match pick.choice(["flip", "cut", "zero", "repeat"]):
            case "flip":
                for _ in range(pick.randint(1, 20)):
                    damaged[pick.randrange(len(damaged))] ^= 1 << pick.randrange(8)
            case "cut":
                del damaged[at:]
            case "zero":
                damaged[at : at + 400] = bytes(len(damaged[at : at + 400]))
            case "repeat":
                damaged[at:at] = damaged[pick.randrange(len(damaged)) :][:200]
        return bytes(damaged)

    case = contents("Servomoteur.SLDPRT")
    # The case as 2015 and 2024 save it, and the assembly.
    originals = [case, contents("9347.SLDASM"), repacked(case, "Contents/DisplayLists", in_2024_layout)]
    damaged = {
        f"Damaged-{i}.{'SLDASM' if i % 3 == 1 else 'SLDPRT'}": repacked(
            originals[i % 3], "Contents/DisplayLists", damage
        )
        for i in range(60)
    }
    # An OLE file, damaged anywhere: its directory and allocation tables have no checks at all.
    old = contents("11351_assembly.SLDASM"), contents("11351_body.SLDPRT")
    damaged |= {f"Damaged-old-{i}.{'SLDASM' if i % 2 == 0 else 'SLDPRT'}": damage(old[i % 2]) for i in range(40)}
    for file in files(team.checkin(chief, damaged)).values():
        made = make(client, chief, file)
        assert made.status_code in (200, 422), made.text
