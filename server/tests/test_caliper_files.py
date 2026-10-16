"""Caliper's models made from SolidWorks files themselves: the 3D view SolidWorks saves in each part and assembly
(vault/solidworks.py). The files are SparkFun's servo (fixtures/solidworks/README.md), checked against SolidWorks' own
bounding boxes, which it keeps in the assembly."""

import json
import random
import struct
import zlib
from collections.abc import Callable
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


def strips(display: bytes) -> list[int]:
    """Where each face's array of its strips' lengths starts, in a display list as SolidWorks before 2024 writes it:
    just after the face's counts of triangles and strips."""
    marker = struct.pack("<3I", 4, 8, 2)
    places = []
    at = display.find(marker)
    while at >= 0:
        triangles, count = struct.unpack_from("<2I", display, at - 8)
        if 0 < count < 1 << 16 and count == struct.unpack_from("<I", display, at + 12)[0]:
            lengths = struct.unpack_from(f"<{count}I", display, at + 16)
            if triangles == sum(lengths) - 2 * count:
                places.append(at)
        at = display.find(marker, at + 1)
    assert places
    return places


def in_2024_layout(display: bytes, first: int = 1) -> bytes:
    """A display list as SolidWorks 2024 and later write it: 32 bytes between each face's counts and its arrays, the
    uint32s 1, 0, 0, a number of the face's, and four 0s (first: something other than the 1, which no SolidWorks
    wrote)."""
    changed = bytearray(display)
    for i, at in reversed(list(enumerate(strips(display)))):
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


def face_records(display: bytes) -> list[tuple[int, int]]:
    """Each face's edges and record, in the case's display list (one body, in SolidWorks 2016's layout): where its
    edges' data starts, just past its normals, and where its record ends, at the next face's tag, or for the last, 20
    bytes before the body's properties (vault/solidworks.py)."""
    faces = []
    for at in strips(display):
        count = struct.unpack_from("<I", display, at + 12)[0]
        vertices = sum(struct.unpack_from(f"<{count}I", display, at + 16))
        faces.append((at - 8, at + 16 + 4 * count + 2 * (16 + 12 * vertices)))
    ends = [start - 2 for start, _ in faces[1:]] + [display.index(b"uoBodyPropInfo_c") - 6 - 20]
    return [(edges, end) for (_, edges), end in zip(faces, ends, strict=True)]


def ending(display: bytes, last: Callable[[bytes], bytes]) -> bytes:
    """The case's display list with each face's record ending as another SolidWorks ends it: its last 4 bytes, a
    uint32 as SolidWorks 2014 to 2017 end it, made into what `last` makes of them."""
    changed = bytearray(display)
    for _, end in reversed(face_records(display)):
        changed[end - 4 : end] = last(display[end - 4 : end])
    return bytes(changed)


def with_false_anchors(display: bytes) -> bytes:
    """The case's display list with the bytes that come before a face's own appearance, 01 00 00 00 ff ff ff ff, in the
    edges' data of its first three faces too, as SolidWorks' own sometimes have them: followed by none, ahead of the
    first face's own appearance; by the number of an object that isn't an appearance, ahead of the second face's
    reference to the first's; and by the appearances' class, with no appearance after it."""
    changed = bytearray(display)
    first = face_records(display)[:3]
    for (edges, _), tag in reversed(list(zip(first, (b"\x00\x00", b"\x01\x00", b"\x33\x80"), strict=True))):
        changed[edges:edges] = struct.pack("<Ii", 1, -1) + tag
    return bytes(changed)


def test_a_faces_own_appearance_is_found_past_its_edges(team, client):
    """A face's own appearance comes after its edges and the bytes 01 00 00 00 ff ff ff ff (vault/solidworks.py), but
    its edges' data can have those bytes in it too, as 16 faces of the team's 16 FAN TEE did, which cost the tee all its
    colors. Only those followed by an appearance, or by none or a reference and then just the rest of the face's record,
    count, however SolidWorks ends the record: with them in its edges, the case reads as the very same mesh, colors and
    all."""
    chief = team.member("chief@x.test", admin=True)
    case = contents("Servomoteur.SLDPRT")
    text = "moSimpleSurfIdRep_c,18,44, "
    face_id = b"\xff\xfe\xff" + bytes([len(text)]) + text.encode("utf-16-le")
    endings: dict[str, Callable[[bytes], bytes]] = {
        "2012": lambda last: b"",
        "2016": lambda last: last,
        "2019": lambda last: last + bytes(4) + face_id,  # a uint64, and the face's id
        "2021": lambda last: last + bytes(4) + face_id + bytes(4),
        "2022": lambda last: last + bytes(4) + face_id + bytes(8),
    }

    def saved(last: Callable[[bytes], bytes]) -> bytes:
        return repacked(case, "Contents/DisplayLists", lambda display: with_false_anchors(ending(display, last)))

    versions = {f"Servomoteur {year}.SLDPRT": saved(last) for year, last in endings.items()}
    checked = files(team.checkin(chief, {"Servomoteur.SLDPRT": case} | versions))
    params = {"version": 1, "configuration": "Default"}
    meshes = {}
    for name, file in checked.items():
        made = make(client, chief, file)
        assert made.status_code == 200, made.text
        meshes[name] = client.get(f"/api/files/{file['id']}/caliper/mesh", params=params, headers=chief)
    header, _, _ = unpack(meshes["Servomoteur.SLDPRT"].content)
    assert sum(face.get("color") == DARK_GRAY for face in header["bodies"][0]["faces"]) == 39
    etag = meshes["Servomoteur.SLDPRT"].headers["etag"]
    assert [name for name in versions if meshes[name].headers["etag"] != etag] == []


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


def test_a_3d_view_caliper_cant_follow_gives_way_to_the_solid(team, client):
    """A view with faces the reader can't find in it is in a layout it doesn't know: the part's solid is read instead,
    as it is for a part without a view. Without a solid either, the view's reason stands, and only a part without a
    view says SolidWorks saved none."""
    chief = team.member("chief@x.test", admin=True)
    case = contents("Servomoteur.SLDPRT")
    odd = repacked(case, "Contents/DisplayLists", lambda d: in_2024_layout(d, first=7))
    checked = files(
        team.checkin(
            chief,
            {
                "Odd.SLDPRT": odd,
                "Bare.SLDPRT": without_3d_view(case),
                "OddAlone.SLDPRT": without_solid(odd),
                "BareAlone.SLDPRT": without_solid(without_3d_view(case)),
            },
        )
    )
    made = {name: make(client, chief, file) for name, file in checked.items()}
    assert (made["Odd.SLDPRT"].status_code, made["Bare.SLDPRT"].status_code) == (200, 200)
    assert measured(client, chief, checked["Odd.SLDPRT"])[3] == measured(client, chief, checked["Bare.SLDPRT"])[3]
    odd_alone, bare_alone = made["OddAlone.SLDPRT"], made["BareAlone.SLDPRT"]
    assert (odd_alone.status_code, odd_alone.json()["error"]) == (422, "unreadable_file")
    assert "can't make sense of the 3D view SolidWorks saved in it" in odd_alone.json()["message"]
    assert (bare_alone.status_code, bare_alone.json()["error"]) == (422, "unreadable_file")
    assert "SolidWorks saved no 3D view in it" in bare_alone.json()["message"]


def without_solid(data: bytes) -> bytes:
    """A file without its solid: its partition stream, renamed."""
    return data.replace(swapped(b"Contents/Config-0-Partition"), swapped(b"Contents/Config-0-Partitioz"))


def without_old_3d_view(data: bytes) -> bytes:
    """An OLE file (SolidWorks 2014 and older) without its display list: its stream renamed in its directory."""
    return data.replace("DisplayLists".encode("utf-16-le"), "DisplayListz".encode("utf-16-le"))


def measured(client, who, file: dict) -> tuple[float, float, list[float], str]:
    """A part's mesh's area (mm2), volume (mm3), box, and etag."""
    shape = client.get(
        f"/api/files/{file['id']}/caliper/mesh", params={"version": 1, "configuration": "Default"}, headers=who
    )
    assert shape.status_code == 200, shape.text
    _, vertices, corners = unpack(shape.content)
    area = volume = 0.0
    for i in range(0, len(corners), 3):
        a, b, c = (vertices[k] for k in corners[i : i + 3])
        u, v = [b[k] - a[k] for k in range(3)], [c[k] - a[k] for k in range(3)]
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        area += (n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5 / 2
        volume += sum(a[k] * (b[(k + 1) % 3] * c[(k + 2) % 3] - b[(k + 2) % 3] * c[(k + 1) % 3]) for k in range(3)) / 6
    return area, volume, box(vertices), shape.headers["etag"]


def test_a_part_without_a_3d_view_is_read_from_its_solid(team, client):
    """A part SolidWorks saved no display list in, as vendors' parts often are, is read from the solid SolidWorks keeps
    of it (Parasolid's): Caliper's own triangles of the very shape its display list has, within their tolerance, with
    the colors its faces have. From SolidWorks 2014 and older too."""
    chief = team.member("chief@x.test", admin=True)
    checked = by_path(
        team.checkin(
            chief,
            {
                "Viewed/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT"),
                "Bare/Servomoteur.SLDPRT": without_3d_view(contents("Servomoteur.SLDPRT")),
                "Viewed/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Bare/Embout.SLDPRT": without_3d_view(contents("Embout.SLDPRT")),
                "Viewed/11351_body.SLDPRT": contents("11351_body.SLDPRT"),
                "Bare/11351_body.SLDPRT": without_old_3d_view(contents("11351_body.SLDPRT")),
            },
        )
    )
    for path, file in checked.items():
        made = make(client, chief, file)
        assert made.status_code == 200, f"{path}: {made.text}"
        assert (made.json()["configuration"], made.json()["units"]) == ("Default", "mm")
    for name in ("Servomoteur.SLDPRT", "Embout.SLDPRT", "11351_body.SLDPRT"):
        viewed, bare = (measured(client, chief, checked[f"{folder}/{name}"]) for folder in ("Viewed", "Bare"))
        assert abs(bare[0] - viewed[0]) < viewed[0] / 500, name  # area, within 0.2%
        assert abs(bare[1] - viewed[1]) < viewed[1] / 500, name  # volume
        assert all(abs(a - b) < 0.002 for a, b in zip(bare[2], viewed[2], strict=True)), name  # box, to 2 microns

    shape = client.get(
        f"/api/files/{checked['Bare/Servomoteur.SLDPRT']['id']}/caliper/mesh",
        params={"version": 1, "configuration": "Default"},
        headers=chief,
    )
    [body] = unpack(shape.content)[0]["bodies"]
    assert (body["name"], len(body["faces"]), body["solid"], body["color"]) == ("Body", 52, True, DARK_GRAY)
    colors = [face.get("color") for face in body["faces"]]
    assert sum(color is None for color in colors) == 39 and [0.7529, 0.7529, 0.7529] in colors
    shape = client.get(
        f"/api/files/{checked['Bare/Embout.SLDPRT']['id']}/caliper/mesh",
        params={"version": 1, "configuration": "Default"},
        headers=chief,
    )
    assert [(b["name"], len(b["faces"])) for b in unpack(shape.content)[0]["bodies"]] == [("Body 1", 3), ("Body 2", 78)]


def renamed(data: bytes, name: str, new: str) -> bytes:
    """A SolidWorks file with one stream under another name."""
    marker = b"\x14\x00\x06\x00\x08\x00"
    at = data.find(marker)
    while at >= 0:
        head = at + len(marker)
        tag, crc, packed, size, length = struct.unpack_from("<5I", data, head)
        start = head + 20 + length
        if data[head + 20 : start] == swapped(name.encode()):
            try:
                old = zlib.decompressobj(-15).decompress(data[start : start + packed])
            except zlib.error:
                old = b""
            if len(old) == size and zlib.crc32(old) == crc:
                header = marker + struct.pack("<5I", tag, crc, packed, size, len(new))
                return data[:at] + header + swapped(new.encode()) + data[start:]
        at = data.find(marker, at + 1)
    raise KeyError(name)


def classes(*names: str) -> bytes:
    """An MFC archive naming these classes, as a part's features do (each new one: 0xFFFF, a schema, a length, the
    name)."""
    return b"".join(b"\xff\xff\x01\x00" + struct.pack("<H", len(name)) + name.encode() for name in names)


def with_crcs(data: bytes, crc: int, only: str | None = None) -> bytes:
    """A file whose streams all have one CRC field, as some programs that write SolidWorks files leave them; or just
    the one named."""
    marker = b"\x14\x00\x06\x00\x08\x00"
    out = bytearray(data)
    at = data.find(marker)
    while at >= 0:
        head = at + len(marker)
        if head + 20 <= len(data):
            length = struct.unpack_from("<I", data, head + 16)[0]
            if only is None or data[head + 20 : head + 20 + length] == swapped(only.encode()):
                struct.pack_into("<I", out, head + 4, crc)
        at = data.find(marker, at + 1)
    return bytes(out)


def test_a_part_that_is_an_import_and_nothing_else_is_read_from_what_it_imported(team, client):
    """Where a part's partition keeps no bodies, as in a vendor's part that's an import and nothing else, the bodies it
    imported are its own: read, but only if its features are the import and what makes or changes no body. Some
    programs that write SolidWorks files leave every stream's CRC field one value, which the solid's checks stand in
    for."""
    chief = team.member("chief@x.test", admin=True)
    bare = without_3d_view(contents("Servomoteur.SLDPRT"))
    imported = renamed(bare, "Contents/Config-0-Partition", "Config-0-FeatureBodies/LocalBodies")

    def features(*names: str) -> bytes:
        return repacked(imported, "Contents/Config-0-ResolvedFeatures", lambda _: classes(*names))

    only = features("moRefPlane_c", "moOriginProfileFeature_c", "moBaseBody_c", "moPMarkRecord_c")
    checked = files(
        team.checkin(
            chief,
            {
                "Bare.SLDPRT": bare,
                "Imported.SLDPRT": only,
                "Unchecked.SLDPRT": with_crcs(only, 0x74610FB1),
                "Cut.SLDPRT": features("moRefPlane_c", "moBaseBody_c", "moICE_c"),
                "Drawn.SLDPRT": features("moRefPlane_c", "moProfileFeature_c"),
            },
        )
    )
    for name in ("Bare.SLDPRT", "Imported.SLDPRT", "Unchecked.SLDPRT"):
        made = make(client, chief, checked[name])
        assert made.status_code == 200, f"{name}: {made.text}"
    tags = {
        measured(client, chief, checked[name])[3] for name in ("Bare.SLDPRT", "Imported.SLDPRT", "Unchecked.SLDPRT")
    }
    assert len(tags) == 1  # the same solid, the same mesh
    # A feature that may have changed the imported body (an extrude cut), or no import at all: not the part's.
    for name in ("Cut.SLDPRT", "Drawn.SLDPRT"):
        refused = make(client, chief, checked[name])
        assert (refused.status_code, refused.json()["error"]) == (422, "unreadable_file")
        assert "SolidWorks saved no 3D view in it" in refused.json()["message"]
    # A stream whose CRC is wrong, in a file whose others are right, is damaged: not read.
    mixed = files(team.checkin(chief, {"Mixed.SLDPRT": with_crcs(only, 0x1234, "Config-0-FeatureBodies/LocalBodies")}))
    mixed = mixed["Mixed.SLDPRT"]
    refused = make(client, chief, mixed)
    assert (refused.status_code, refused.json()["error"]) == (422, "unreadable_file")


def transmitted(stream: bytes, change) -> bytes:
    """A solid's stream with its first transmit file changed (change: its bytes to the new ones), packed again."""
    tag = bytes.fromhex("231dd571da8148a2a85898b21b89ef99")
    at = stream.index(tag)
    end = at + struct.unpack_from("<I", stream, at - 4)[0]
    pieces, place = [], at + len(tag)
    while place + 8 <= end:
        size, packed = struct.unpack_from("<II", stream, place)
        if size == 0:
            break
        pieces.append(zlib.decompress(stream[place + 8 : place + 8 + packed]))
        place += 8 + packed
    new = change(b"".join(pieces))
    body = zlib.compress(new)
    region = tag + struct.pack("<II", len(new), len(body)) + body + struct.pack("<II", 0, 0)
    return stream[: at - 4] + struct.pack("<I", len(region)) + region + stream[end:]


def test_a_damaged_solid_is_refused_or_read_never_an_error(team, client):
    """A solid has no checks of its own but its stream's CRC, and the reader is careful: whatever the bytes, it reads
    them or refuses them."""
    chief = team.member("chief@x.test", admin=True)
    pick = random.Random(13006)

    def damage(solid: bytes) -> bytes:
        damaged = bytearray(solid)
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

    bare = without_3d_view(contents("Servomoteur.SLDPRT"))
    damaged = {
        f"Damaged-{i}.SLDPRT": repacked(bare, "Contents/Config-0-Partition", lambda s: transmitted(s, damage))
        for i in range(40)
    }
    for file in files(team.checkin(chief, damaged)).values():
        made = make(client, chief, file)
        assert made.status_code in (200, 422), made.text


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
