"""Caliper's models made from SolidWorks files themselves: the 3D view SolidWorks saves in each part and assembly
(vault/solidworks.py). The files are SparkFun's servo (fixtures/solidworks/README.md), checked against SolidWorks' own
bounding boxes, which it keeps in the assembly."""

import json
import math
import random
import struct
import zlib
from collections.abc import Callable
from pathlib import Path

from sqlalchemy import select

from yjsp_server.vault import parasolid, solidworks
from yjsp_server.vault.models import CaliperModel, Version

from .test_caliper import IDENTITY, mesh, put_model
from .test_caliper import component as model_component

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


def case_kept_inside(tree: bytes) -> bytes:
    """The servo's XML with its case a virtual part, which the assembly keeps inside its file (as Routing's tubes are),
    named as SolidWorks names one: "Servomoteur^Servomoteur SM-S4303R"."""
    case = tree.index(b'swName="Servomoteur" swReferenceNumber')
    rest = tree[case:].replace(b'swIsVirtualComponent="NO"', b'swIsVirtualComponent="YES"', 1)
    rest = rest.replace(b'swName="Servomoteur"', b'swName="Servomoteur^Servomoteur SM-S4303R"', 1)
    return (
        tree[:case].replace(
            b"Servomoteur SM-S4303R\\Servomoteur.SLDPRT",
            b"VC~~\\Servomoteur SM-S4303R\\Servomoteur^Servomoteur SM-S4303R.SLDPRT",
        )
        + rest
    )


def keeping(data: bytes, name: str, kept: bytes) -> bytes:
    """A SolidWorks file that keeps another inside it, as an assembly does a virtual component's: as a stream."""
    deflater = zlib.compressobj(6, zlib.DEFLATED, -15)
    body = deflater.compress(kept) + deflater.flush()
    header = b"\x14\x00\x06\x00\x08\x00" + struct.pack("<5I", 0, zlib.crc32(kept), len(body), len(kept), len(name))
    return data + header + swapped(name.encode()) + body


def servo_keeping_its_case(name: str | None) -> bytes:
    """The servo's assembly with its case kept inside it, under that stream's name (None: not there)."""
    servo = repacked(contents("9347.SLDASM"), "swXmlContents/COMPINSTANCETREE", case_kept_inside)
    return servo if name is None else keeping(servo, name, contents("Servomoteur.SLDPRT"))


def shown(client, who, file: dict) -> dict[str, dict]:
    """An assembly's model's components, made from its file, by name, at every level."""
    assert make(client, who, file).status_code == 200
    assembly = client.get(
        f"/api/files/{file['id']}/caliper/assembly", params={"version": 1, "configuration": "Default"}, headers=who
    ).json()
    found = {}
    pending = list(assembly["components"])
    while pending:
        component = pending.pop()
        found[component["name"]] = component
        pending += component["children"]
    return found


def test_a_part_kept_inside_an_assembly_is_read_from_its_solid(team, client):
    """A virtual part, as SolidWorks Routing's tubes are, is kept inside the file of its assembly: its whole file, as
    the stream VirtualComp/ and its name up to the ^, with -sldprt after that in some files. It's read from its solid,
    never its display list, which SolidWorks leaves as it was when the part was made (a routed tube's is the library
    tube's stub), so it's the very shape of the case's solid. Without its file there, it stays in the model, as virtual,
    for Caliper to say why it shows nothing, rather than be taken for a part missing from the vault."""
    chief = team.member("chief@x.test", admin=True)
    checked = by_path(
        team.checkin(
            chief,
            {
                "Kept/9347.SLDASM": servo_keeping_its_case("VirtualComp/Servomoteur"),
                "Suffixed/9347.SLDASM": servo_keeping_its_case("VirtualComp/Servomoteur-sldprt"),
                "Lost/9347.SLDASM": servo_keeping_its_case(None),
                "Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Bare/Servomoteur.SLDPRT": without_3d_view(contents("Servomoteur.SLDPRT")),
            },
            refs={f"{folder}/9347.SLDASM": ["Embout.SLDPRT"] for folder in ("Kept", "Suffixed", "Lost")},
        )
    )
    assert make(client, chief, checked["Bare/Servomoteur.SLDPRT"]).status_code == 200
    solid = measured(client, chief, checked["Bare/Servomoteur.SLDPRT"])[3].strip('"')
    case = "Servomoteur^Servomoteur SM-S4303R-1"
    for folder in ("Kept", "Suffixed"):
        found = shown(client, chief, checked[f"{folder}/9347.SLDASM"])
        assert (found[case]["file_id"], found[case]["virtual"], found[case]["mesh"]) == (None, True, solid), folder
        assert found["Embout-1"]["file_id"] == checked["Embout.SLDPRT"]["id"]
    lost = shown(client, chief, checked["Lost/9347.SLDASM"])
    assert (lost[case]["file_id"], lost[case]["virtual"], lost[case]["mesh"]) == (None, True, None)


def bay_of(servo: bytes, virtual: bool) -> bytes:
    """An assembly, Bay, whose one component is the servo's assembly (servo: its XML), 10 mm up: kept inside Bay's
    file if virtual, and named as SolidWorks names a virtual component."""
    servo = servo.replace(b'swModelRef="2">', b'swModelRef="31">')  # Bay's configuration, not the servo's
    header = b'<swFile id="30" swDocType="ASSEMBLY" swPath="C:\\Bay\\Bay.SLDASM"/>'
    bay = (
        b'<swModel id="31" swName="Bay" swConfigurationName="Default" swFileRef="30"><swReference id="32" '
        b'swName="%s" swReferenceNumber="1" swIsVirtualComponent="%s" swConfigurationName="Default" swSuppressed="NO" '
        b'swHidden="NO" swModelRef="2" swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.01 1"/></swModel>'
    ) % ((b"Servomoteur SM-S4303R^Bay", b"YES") if virtual else (b"Servomoteur SM-S4303R", b"NO"))
    return servo.replace(b"</swHeader>", header + b"</swHeader>").replace(b"</swModelList>", bay + b"</swModelList>")


def test_a_part_kept_inside_a_sub_assembly_is_read_from_the_sub_assemblys_file(team, client):
    """A sub-assembly keeps its own virtual parts (Routing's routes are sub-assemblies, which keep their tubes): in its
    own file, which the server reads for them where it's a file of its own, or in the file a virtual sub-assembly is
    kept in, in turn."""
    chief = team.member("chief@x.test", admin=True)
    servo = servo_keeping_its_case("VirtualComp/Servomoteur")
    bare = without_3d_view(contents("9347.SLDASM"))
    checked = by_path(
        team.checkin(
            chief,
            {
                "Servo/Servomoteur SM-S4303R.SLDASM": servo,
                "Servo/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Servo/Bay.SLDASM": repacked(
                    bare, "swXmlContents/COMPINSTANCETREE", lambda t: bay_of(case_kept_inside(t), False)
                ),
                "Kept/Bay.SLDASM": keeping(
                    repacked(bare, "swXmlContents/COMPINSTANCETREE", lambda t: bay_of(case_kept_inside(t), True)),
                    "VirtualComp/Servomoteur SM-S4303R-sldasm",
                    servo,
                ),
                "Bare/Servomoteur.SLDPRT": without_3d_view(contents("Servomoteur.SLDPRT")),
            },
            refs={
                "Servo/Bay.SLDASM": ["Servo/Servomoteur SM-S4303R.SLDASM"],
                "Servo/Servomoteur SM-S4303R.SLDASM": ["Servo/Embout.SLDPRT"],
                "Kept/Bay.SLDASM": ["Servo/Embout.SLDPRT"],
            },
        )
    )
    assert make(client, chief, checked["Bare/Servomoteur.SLDPRT"]).status_code == 200
    solid = measured(client, chief, checked["Bare/Servomoteur.SLDPRT"])[3].strip('"')
    case = "Servomoteur^Servomoteur SM-S4303R-1"

    apart = shown(client, chief, checked["Servo/Bay.SLDASM"])
    sub = apart["Servomoteur SM-S4303R-1"]
    assert (sub["file_id"], sub["virtual"]) == (checked["Servo/Servomoteur SM-S4303R.SLDASM"]["id"], False)
    assert (apart[case]["virtual"], apart[case]["mesh"]) == (True, solid)
    assert [round(apart[case]["transform"][i], 3) for i in (3, 7, 11)] == [6.11, -45.018, 13.876]  # placed in Bay
    assert apart["Embout-1"]["file_id"] == checked["Servo/Embout.SLDPRT"]["id"]

    inside = shown(client, chief, checked["Kept/Bay.SLDASM"])
    sub = inside["Servomoteur SM-S4303R^Bay-1"]
    assert (sub["file_id"], sub["virtual"]) == (None, True)
    assert (inside[case]["virtual"], inside[case]["mesh"]) == (True, solid)


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

    # Caliper offers them all, and says which SolidWorks kept up to date. One that wasn't has no model, and says why.
    listed = client.get(f"/api/files/{servo['id']}/caliper/configurations", params={"version": 1}, headers=chief)
    assert [(c["name"], c["active"], c["saved"], c["model"]) for c in listed.json()["configurations"]] == [
        ("Default", True, True, True),
        ("Spline out", False, True, True),
        ("Old", False, False, False),
    ]
    old = make_in(client, chief, servo, "Old")
    assert (old.status_code, old.json()["error"]) == (422, "configuration_not_saved")
    assert old.json()["message"].startswith(
        "Servo/9347.SLDASM v1: SolidWorks marked its Old configuration as needing a rebuild when it saved it"
    )
    assert make_in(client, chief, servo, "Spline out").json()["configuration"] == "Spline out"


def make_in(client, who, file: dict, configuration: str, version: int = 1):
    body = {"version": version, "configuration": configuration}
    return client.post(f"/api/files/{file['id']}/caliper/make", json=body, headers=who)


def stream_of(data: bytes, name: str) -> bytes:
    """A stream of a SolidWorks file, unpacked: the copy whose CRC checks."""
    marker = b"\x14\x00\x06\x00\x08\x00"
    at = data.find(marker)
    while at >= 0:
        head = at + len(marker)
        _tag, crc, packed, size, length = struct.unpack_from("<5I", data, head)
        start = head + 20 + length
        if data[head + 20 : start] == swapped(name.encode()):
            try:
                found = zlib.decompressobj(-15).decompress(data[start : start + packed])
            except zlib.error:
                found = b""
            if len(found) == size and zlib.crc32(found) == crc:
                return found
        at = data.find(marker, at + 1)
    raise KeyError(name)


def case_in_configurations() -> bytes:
    """The servo's case as a part of three configurations: Default, the one SolidWorks saved it in, with its 3D view;
    Spline, up to date when it was saved, so SolidWorks kept its solid (the spline's, here, with its appearance); and
    Old, marked as needing a rebuild, whose solid is from before the part last changed."""
    spline = contents("Embout.SLDPRT")
    more = (
        b'<swConfiguration id="7" swName="Spline" swID="1" swMostRecentConfiguration="NO" '
        b'swConfigurationNeedsUpdate="NO" swModelRef="2"/>'
        b'<swConfiguration id="8" swName="Old" swID="2" swMostRecentConfiguration="NO" '
        b'swConfigurationNeedsUpdate="YES" swModelRef="2"/>'
    )
    case = repacked(
        contents("Servomoteur.SLDPRT"),
        "swXmlContents/Features",
        lambda xml: xml.replace(b"</swConfigurationList>", more + b"</swConfigurationList>"),
    )
    solid = stream_of(spline, "Contents/Config-0-Partition")
    case = keeping(case, "Contents/Config-1-Partition", solid)
    case = keeping(case, "Contents/Config-1", stream_of(spline, "Contents/Config-0"))
    return keeping(case, "Contents/Config-2-Partition", solid)


def test_each_configuration_a_part_keeps_is_shown(team, client):
    """A part's file lists its configurations, and keeps the shape of each that was up to date when SolidWorks saved it:
    of the one it had open, its 3D view; of another, its solid (vault/solidworks.py). Caliper offers them all, and the
    server reads each one asked for that the file keeps. One marked as needing a rebuild isn't read, though it has a
    solid: that's from before the part last changed."""
    chief = team.member("chief@x.test", admin=True)
    checked = files(
        team.checkin(
            chief,
            {
                "Servo/Servomoteur.SLDPRT": case_in_configurations(),
                "Bare/Embout.SLDPRT": without_3d_view(contents("Embout.SLDPRT")),
            },
        )
    )
    case = checked["Servomoteur.SLDPRT"]

    def configurations() -> list[tuple[str, bool, bool, bool]]:
        listed = client.get(f"/api/files/{case['id']}/caliper/configurations", params={"version": 1}, headers=chief)
        assert listed.status_code == 200, listed.text
        assert (listed.json()["version"], listed.json()["unreadable"]) == (1, None)
        return [(c["name"], c["active"], c["saved"], c["model"]) for c in listed.json()["configurations"]]

    assert configurations() == [
        ("Default", True, True, False),
        ("Spline", False, True, False),
        ("Old", False, False, False),
    ]
    spline = make_in(client, chief, case, "Spline")
    assert spline.status_code == 200, spline.text
    assert (spline.json()["configuration"], spline.json()["kind"], spline.json()["units"]) == ("Spline", "part", "mm")
    # The one it was saved in is read too, first, as it's the one shown when none is asked for.
    models = client.get(f"/api/files/{case['id']}/caliper", headers=chief).json()["models"]
    assert [model["configuration"] for model in models] == ["Default", "Spline"]
    assert make(client, chief, case).json()["configuration"] == "Default"
    assert configurations() == [
        ("Default", True, True, True),
        ("Spline", False, True, True),
        ("Old", False, False, False),
    ]

    def mesh_of(file: dict, configuration: str):
        params = {"version": 1, "configuration": configuration}
        shape = client.get(f"/api/files/{file['id']}/caliper/mesh", params=params, headers=chief)
        assert shape.status_code == 200, shape.text
        return shape

    # Spline's is the spline's solid, as the spline's own file reads without its 3D view: the very same mesh.
    assert make(client, chief, checked["Embout.SLDPRT"]).status_code == 200
    ours, theirs = mesh_of(case, "Spline"), mesh_of(checked["Embout.SLDPRT"], "Default")
    assert ours.headers["etag"] == theirs.headers["etag"]
    assert [(b["name"], len(b["faces"])) for b in unpack(ours.content)[0]["bodies"]] == [("Body 1", 3), ("Body 2", 78)]
    assert [b["name"] for b in unpack(mesh_of(case, "Default").content)[0]["bodies"]] == ["Boss-Extrude1"]
    # Asked for by name, the one it was saved in is the one it has.
    assert make_in(client, chief, case, "Default").json()["configuration"] == "Default"

    old = make_in(client, chief, case, "Old")
    assert (old.status_code, old.json()["error"]) == (422, "configuration_not_saved")
    message = old.json()["message"]
    assert message.startswith(
        "Servo/Servomoteur.SLDPRT v1: SolidWorks marked its Old configuration as needing a rebuild"
    )
    assert "show Old (or right-click it in the ConfigurationManager and click Add Rebuild/Save Mark" in message
    missing = make_in(client, chief, case, "Long")
    assert (missing.status_code, missing.json()["error"]) == (404, "no_configuration")
    assert missing.json()["message"] == "Servo/Servomoteur.SLDPRT v1: It has no configuration named Long"
    # What was refused stays refused, and nothing was made of it.
    assert make_in(client, chief, case, "Old").json()["error"] == "configuration_not_saved"
    models = client.get(f"/api/files/{case['id']}/caliper", headers=chief).json()["models"]
    assert [model["configuration"] for model in models] == ["Default", "Spline"]


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


def appearance(rgb: tuple[int, int, int], first: str, second: str) -> bytes:
    """An appearance in an MFC archive, of the class's fifth object (0x8005): its color, a second color, 4 bytes, two
    strings, and its ambient, diffuse, specular, shininess, transparency, and emission."""

    def text(value: str) -> bytes:
        return b"\xff\xfe\xff" + bytes([len(value)]) + value.encode("utf-16-le")

    color = bytes(rgb) + b"\x00"
    return (
        struct.pack("<H", 0x8005)
        + color
        + color
        + bytes(4)
        + text(first)
        + text(second)
        + struct.pack("<6d", 1, 1, 0.5, 0.4, 0, 0)
    )


def test_a_part_read_from_its_solid_has_its_configurations_appearance(team, client):
    """A part read from its solid has the appearance its configuration keeps, where it keeps just one: the part's,
    which SolidWorks shows over the colors Parasolid keeps of its faces, often older ones. A table there that looks
    like an appearance (the units', whose strings are Hz and Pa) isn't one; and where it keeps another appearance too
    (a face's), the solid's own colors stand, as the servo case's do."""
    chief = team.member("chief@x.test", admin=True)

    def recolored(stream: bytes) -> bytes:  # aluminium's appearance, in place of the spline's own
        at = stream.index(b"moVisualProperties_c") + len(b"moVisualProperties_c")
        return stream[:at] + bytes((229, 234, 237)) + stream[at + 3 :]

    aluminium = repacked(without_3d_view(contents("Embout.SLDPRT")), "Contents/Config-0", recolored)
    checked = files(
        team.checkin(
            chief,
            {
                "Aluminium.SLDPRT": aluminium,
                "Tabled.SLDPRT": repacked(
                    aluminium, "Contents/Config-0", lambda s: s + appearance((255, 2, 110), "Hz", "Pa")
                ),
                "Faced.SLDPRT": repacked(
                    aluminium, "Contents/Config-0", lambda s: s + appearance((64, 64, 64), "", "")
                ),
            },
        )
    )

    def looks(name: str) -> list[tuple[list[float], float, list]]:
        assert make(client, chief, checked[name]).status_code == 200
        shape = client.get(
            f"/api/files/{checked[name]['id']}/caliper/mesh",
            params={"version": 1, "configuration": "Default"},
            headers=chief,
        )
        bodies = unpack(shape.content)[0]["bodies"]
        return [
            (b["color"], b.get("opacity", 1), [f.get("color") for f in b["faces"] if f.get("color")]) for b in bodies
        ]

    assert looks("Aluminium.SLDPRT") == looks("Tabled.SLDPRT") == [([0.898, 0.9176, 0.9294], 1, [])] * 2
    assert looks("Faced.SLDPRT") == [([0.7922, 0.8196, 0.9333], 1, [])] * 2  # SolidWorks' default, as Parasolid has it


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


NULL = -3.14158e13  # Parasolid's null double


def transmit_file(nodes: dict[int, tuple[str, dict]]) -> bytes:
    """A Parasolid transmit file of these nodes, by index: each its type's name and its fields (those left out are
    none, or null), in neutral binary against the base schema, as SolidWorks writes them (vault/parasolid.py)."""
    types = {name: (number, fields) for number, (name, fields) in parasolid._BASE.items()}
    title, schema = b": TRANSMIT FILE (partition) created by modeller version 3401247", b"SCH_3401247_34101_13006"
    out = bytearray(b"PS\x00\x00" + struct.pack(">H", len(title)) + title + struct.pack(">I", len(schema)) + schema)
    out += struct.pack(">hI", 200, 0)  # the most node types; no user fields
    seen = set()
    for index, (name, values) in nodes.items():
        number, fields = types[name]
        out += struct.pack(">h", number)
        if number not in seen:
            seen.add(number)
            out.append(0xFF)  # its fields are the base schema's
        varying = [values[field] for field, _, count in fields if count == 1]
        if varying:
            out += struct.pack(">i", len(varying[0]))
        out += struct.pack(">h", index + 1)
        for field, kind, count in fields:
            value = values.get(field)
            for one in value if count == 1 else [value]:
                if kind == "p":
                    out += struct.pack(">h", (one or 0) + 1)
                elif kind == "f":
                    out += struct.pack(">d", NULL if one is None else one)
                elif kind == "v":
                    out += struct.pack(">3d", *(one or (NULL, NULL, NULL)))
                elif kind == "c":
                    out += (one or "?").encode()
                elif kind in "ul":
                    out.append(one or 0)
                elif kind == "n":
                    out += struct.pack(">h", one or 0)
                elif kind == "d":
                    out += struct.pack(">i", one or 0)
    return bytes(out + struct.pack(">hh", 1, 1))  # the terminator, at index 0


def part_of(solid: dict[int, tuple[str, dict]]) -> bytes:
    """A part, without a 3D view, whose solid is these nodes'."""
    bare = without_3d_view(contents("Servomoteur.SLDPRT"))
    return repacked(bare, "Contents/Config-0-Partition", lambda s: transmitted(s, lambda _: transmit_file(solid)))


def body(*faces: dict[int, tuple[str, dict]]) -> dict[int, tuple[str, dict]]:
    """A solid body of these faces (nodes 1 to 3 are its own)."""
    nodes = {
        1: ("BODY", {"body_type": 1, "nom_geom_state": 1, "region": 2, "shell": 3}),
        2: ("REGION", {"body": 1, "shell": 3, "type": "S"}),
        3: ("SHELL", {"body": 1, "region": 2}),
    }
    for one in faces:
        nodes |= one
    return nodes


def face(index: int, surface: int, sense: str, loops: dict[int, int]) -> dict[int, tuple[str, dict]]:
    """A face, and its loops: by index, each its one fin."""
    chain = list(loops)
    nodes = {index: ("FACE", {"loop": chain[0], "shell": 3, "surface": surface, "sense": sense})}
    for i, loop in enumerate(chain):
        nodes[loop] = ("LOOP", {"fin": loops[loop], "face": index, "next": chain[i + 1] if i + 1 < len(chain) else 0})
    return nodes


def fin(index: int, loop: int, edge: int, other: int, sense: str, curve: int = 0) -> dict[int, tuple[str, dict]]:
    """A fin alone in its loop, of a ring edge (one without vertices): along the edge's curve (sense "+") or against
    it, or where the edge is tolerant, along its own curve."""
    fields = {"loop": loop, "forward": index, "backward": index, "other": other, "edge": edge, "sense": sense}
    return {index: ("FIN", fields | {"curve": curve})}


def spline(
    index: int, points: list[float], knots: list[float], mults: list[int], degree: int = 1, dim: int = 2
) -> dict[int, tuple[str, dict]]:
    """A B-spline curve's nodes, from index on: of points in a surface's (u, v), or with dim 4, rational ones in space
    (each multiplied through by its weight, which comes last)."""
    nurbs = {"degree": degree, "n_vertices": len(points) // dim, "vertex_dim": dim, "n_knots": len(knots),
             "rational": dim == 4, "bspline_vertices": index + 2, "knot_mult": index + 3,
             "knots": index + 4}  # fmt: skip
    return {
        index: ("B_CURVE", {"nurbs": index + 1, "sense": "+"}),
        index + 1: ("NURBS_CURVE", nurbs),
        index + 2: ("BSPLINE_VERTICES", {"vertices": points}),
        index + 3: ("KNOT_MULT", {"mult": mults}),
        index + 4: ("KNOT_SET", {"knots": knots}),
    }


def test_a_dome_of_a_lemon_shaped_torus_is_read(team, client):
    """A torus whose major radius is less than its minor one crosses its axis, and Parasolid keeps one part of it: an
    apple (the outer part), or with the major radius below 0, a lemon (the inner). Each ends in a pole at either end,
    as a sphere does, rather than going round. A dome of a lemon, closed by a disc, is read as it is."""
    a, b, z0 = -0.010, 0.030, -0.020  # the lemon's radii, and the height of the disc (meters)
    v0, end = math.asin(z0 / b), math.acos(-a / b)
    rim = a + b * math.cos(v0)
    up = {"normal": (0, 0, 1), "x_axis": (1, 0, 0), "sense": "+"}
    nodes = body(face(10, 40, "+", {20: 30}), face(11, 41, "+", {21: 31})) | {
        **fin(30, 20, 50, 31, "-"),
        **fin(31, 21, 50, 30, "+"),
        40: ("TORUS", {"centre": (0, 0, 0), "axis": (0, 0, 1), "major_radius": a, "minor_radius": b,
                       "x_axis": (1, 0, 0), "sense": "+"}),
        41: ("PLANE", {"pvec": (0, 0, z0)} | up),
        50: ("EDGE", {"fin": 30, "curve": 60}),
        60: ("CIRCLE", {"centre": (0, 0, z0), "radius": rim} | up),
    }  # fmt: skip
    chief = team.member("chief@x.test", admin=True)
    dome = files(team.checkin(chief, {"Dome.SLDPRT": part_of(nodes)}))["Dome.SLDPRT"]
    assert make(client, chief, dome).status_code == 200
    area, volume, box_, _ = measured(client, chief, dome)

    # Its area and volume, of the lemon's arc (radius a + b cos v, height b sin v) turned round, in mm2 and mm3.
    steps = 20000
    dv = (v0 + end) / steps
    rs = [(a + b * math.cos(v), b * math.cos(v)) for v in (-end + dv * (i + 0.5) for i in range(steps))]
    want_area = (sum(2 * math.pi * r * b * dv for r, _ in rs) + math.pi * rim**2) * 1e6
    want_volume = sum(math.pi * r * r * dz * dv for r, dz in rs) * 1e9
    assert abs(area - want_area) < want_area / 200  # within 0.5%
    assert abs(volume - want_volume) < want_volume / 100  # within 1%: chords cut in, and it's small and thin
    assert (box_[2], box_[5]) == (round(-b * math.sin(end) * 1000, 3), round(z0 * 1000, 3))  # the pole, the disc


def test_a_tube_with_an_offset_wall_is_read(team, client):
    """A thin feature's other wall is its first's surface offset (Parasolid's offset surface), and its edges there are
    curves in that surface's (u, v), going once round it: their ends meet, as a periodic curve's do, though in (u, v)
    they're a period apart, and a tolerant edge's stretch of one can run on past its end. A tube of them is read as it
    is, without vertices to measure its size by, so it's only as fine as its circles need."""
    r, t, h = 0.005, 0.0005, 0.020  # the tube's outer radius, its wall, and its length (meters)
    up = {"normal": (0, 0, 1), "x_axis": (1, 0, 0), "sense": "+"}
    nodes = body(
        face(10, 40, "+", {20: 30, 21: 31}),  # outside
        face(11, 41, "-", {22: 32, 23: 33}),  # inside: facing the axis
        face(12, 42, "+", {24: 34, 25: 35}),  # the bottom
        face(13, 43, "+", {26: 36, 27: 37}),  # the top
    ) | {
        **fin(30, 20, 50, 34, "+"), **fin(34, 24, 50, 30, "-"),
        **fin(31, 21, 51, 36, "-"), **fin(36, 26, 51, 31, "+"),
        **fin(32, 22, 52, 35, "-"), **fin(35, 25, 52, 32, "+"),
        **fin(33, 23, 53, 37, "+", curve=70), **fin(37, 27, 53, 33, "-", curve=71),
        40: ("CYLINDER", {"pvec": (0, 0, 0), "axis": (0, 0, 1), "radius": r, "x_axis": (1, 0, 0), "sense": "+"}),
        41: ("OFFSET_SURF", {"surface": 40, "offset": -t, "check": "V", "sense": "+"}),
        42: ("PLANE", {"pvec": (0, 0, 0), "normal": (0, 0, -1), "x_axis": (1, 0, 0), "sense": "+"}),
        43: ("PLANE", {"pvec": (0, 0, h)} | up),
        50: ("EDGE", {"fin": 30, "curve": 60}),
        51: ("EDGE", {"fin": 31, "curve": 61}),
        52: ("EDGE", {"fin": 32, "curve": 62}),
        53: ("EDGE", {"fin": 33, "tolerance": 1e-6}),  # tolerant: its fins have their own curves
        60: ("CIRCLE", {"centre": (0, 0, 0), "radius": r} | up),
        61: ("CIRCLE", {"centre": (0, 0, h), "radius": r} | up),
        62: ("SP_CURVE", {"surface": 41, "b_curve": 80, "sense": "+"}),  # once round the inside, at the bottom
        63: ("SP_CURVE", {"surface": 41, "b_curve": 85, "sense": "-"}),  # and at the top, the other way
        64: ("CIRCLE", {"centre": (0, 0, h), "radius": r - t} | up | {"sense": "-"}),
        70: ("TRIMMED_CURVE", {"basis_curve": 63, "point_1": (r - t, 0, h), "point_2": (r - t, 0, h), "parm_1": 0.0,
                               "parm_2": -1.0, "sense": "+"}),
        71: ("TRIMMED_CURVE", {"basis_curve": 64, "point_1": (r - t, 0, h), "point_2": (r - t, 0, h), "parm_1": 0.0,
                               "parm_2": -2 * math.pi, "sense": "+"}),
        **spline(80, [0, 0, 2 * math.pi, 0], [0, 1], [2, 2]),
        # Speeding up along it, so that run on past its ends it would turn back, not go on round.
        **spline(85, [2 * math.pi, h, 1.8 * math.pi, h, 0, h], [0, 1], [3, 3], degree=2),
    }  # fmt: skip
    chief = team.member("chief@x.test", admin=True)
    tube = files(team.checkin(chief, {"Tube.SLDPRT": part_of(nodes)}))["Tube.SLDPRT"]
    made = make(client, chief, tube)
    assert made.status_code == 200, made.text
    area, volume, box_, _ = measured(client, chief, tube)
    want_area = (2 * math.pi * (r + r - t) * h + 2 * math.pi * (r * r - (r - t) ** 2)) * 1e6
    want_volume = math.pi * h * (r * r - (r - t) ** 2) * 1e9
    assert abs(area - want_area) < want_area / 200  # within 0.5%
    # A thin wall's volume is what's between two near walls, so their chords' errors are a larger share of it.
    assert abs(volume - want_volume) < want_volume / 50
    assert (box_[2], box_[5]) == (0.0, 20.0) and all(4.95 < abs(v) <= 5 for v in box_[:2] + box_[3:5])
    shape = client.get(
        f"/api/files/{tube['id']}/caliper/mesh", params={"version": 1, "configuration": "Default"}, headers=chief
    )
    triangles = unpack(shape.content)[0]["triangles"]
    assert triangles < 1000, triangles


def sheet(*faces: dict[int, tuple[str, dict]]) -> dict[int, tuple[str, dict]]:
    """A sheet body (one of faces that enclose nothing) of these faces."""
    nodes = body(*faces)
    nodes[1] = ("BODY", nodes[1][1] | {"body_type": 3})
    return nodes


def test_splines_are_read_as_their_shapes_need(team, client):
    """A disc whose edge is a circle as a rational spline, which closes without being periodic, is read whole. A
    square on a flat spline surface whose parameters speed up across it is only as fine as its shape needs: flat, so
    two triangles, though its points aren't evenly spread in its parameters."""
    r = 0.005
    up = {"normal": (0, 0, 1), "x_axis": (1, 0, 0), "sense": "+"}
    w = math.sqrt(0.5)
    corners = [(1, 0, 1), (1, 1, w), (0, 1, 1), (-1, 1, w), (-1, 0, 1), (-1, -1, w), (0, -1, 1), (1, -1, w), (1, 0, 1)]
    circle = [c for x, y, weight in corners for c in (x * r * weight, y * r * weight, 0, weight)]
    disc = sheet(face(10, 40, "+", {20: 30})) | {
        **fin(30, 20, 50, 31, "+"),
        31: ("FIN", {"other": 30, "edge": 50, "sense": "-"}),  # the edge's other side, on no face
        40: ("PLANE", {"pvec": (0, 0, 0)} | up),
        50: ("EDGE", {"fin": 30, "curve": 60}),
        **spline(60, circle, [0, 0.25, 0.5, 0.75, 1], [3, 2, 2, 2, 3], degree=2, dim=4),
    }

    side = 0.010
    corner = [(0, 0, 0), (side, 0, 0), (side, side, 0), (0, side, 0)]
    spread = [0, 0.001, side]  # the surface's points along each way: its parameters speed up across it
    square = sheet(face(10, 40, "+", {20: 30})) | {
        40: ("B_SURFACE", {"nurbs": 41, "sense": "+"}),
        41: ("NURBS_SURF", {"u_degree": 2, "v_degree": 2, "n_u_vertices": 3, "n_v_vertices": 3, "n_u_knots": 2,
                            "n_v_knots": 2, "vertex_dim": 3, "bspline_vertices": 42, "u_knot_mult": 43,
                            "v_knot_mult": 43, "u_knots": 44, "v_knots": 44}),
        42: ("BSPLINE_VERTICES", {"vertices": [c for x in spread for y in spread for c in (x, y, 0)]}),
        43: ("KNOT_MULT", {"mult": [3, 3]}),
        44: ("KNOT_SET", {"knots": [0, 1]}),
    }  # fmt: skip
    for i in range(4):  # the square's sides, each from a corner to the next: a fin on the face, and one on none
        a, b = corner[i], corner[(i + 1) % 4]
        square |= {
            30 + i: ("FIN", {"loop": 20, "forward": 30 + (i + 1) % 4, "backward": 30 + (i - 1) % 4,
                             "vertex": 70 + (i + 1) % 4, "other": 35 + i, "edge": 50 + i, "sense": "+"}),
            35 + i: ("FIN", {"vertex": 70 + i, "other": 30 + i, "edge": 50 + i, "sense": "-"}),
            50 + i: ("EDGE", {"fin": 30 + i, "curve": 60 + i}),
            60 + i: ("LINE", {"pvec": a, "direction": tuple(q - p for p, q in zip(a, b, strict=True)), "sense": "+"}),
            70 + i: ("VERTEX", {"point": 80 + i}),
            80 + i: ("POINT", {"pvec": a}),
        }  # fmt: skip

    chief = team.member("chief@x.test", admin=True)
    checked = files(team.checkin(chief, {"Disc.SLDPRT": part_of(disc), "Square.SLDPRT": part_of(square)}))
    for file in checked.values():
        made = make(client, chief, file)
        assert made.status_code == 200, made.text
    area, _, box_, _ = measured(client, chief, checked["Disc.SLDPRT"])
    assert abs(area - math.pi * 25) < math.pi * 25 / 200  # within 0.5%
    assert all(4.95 < abs(v) <= 5 for v in box_[:2] + box_[3:5])
    area, _, box_, _ = measured(client, chief, checked["Square.SLDPRT"])
    assert (round(area, 3), box_) == (100.0, [0.0, 0.0, 0.0, 10.0, 10.0, 0.0])
    shape = client.get(
        f"/api/files/{checked['Square.SLDPRT']['id']}/caliper/mesh",
        params={"version": 1, "configuration": "Default"},
        headers=chief,
    )
    assert unpack(shape.content)[0]["triangles"] == 2


def readers(team, file: dict) -> dict[str, int | None]:
    """What made each of a file's models (version 1), by configuration (CaliperModel.reader)."""
    with team.app.state.sessionmaker() as db:
        found = db.scalars(select(CaliperModel).join(Version).where(Version.file_id == file["id"], Version.number == 1))
        return {model.configuration: model.reader for model in found}


def made_by(team, file: dict, reader: int | None, **changes) -> None:
    """A file's models (version 1) as another reader would have left them: as an older release of the server, which
    measured in inches, say; or as one before the server noted which reader made each (None)."""
    with team.app.state.sessionmaker() as db:
        for model in db.scalars(select(CaliperModel).join(Version).where(Version.file_id == file["id"])):
            model.reader = reader
            for name, value in changes.items():
                setattr(model, name, value)
        db.commit()


# A reader of each kind of model whose models no longer stand: an older release of the server's.
OLDER = {kind: stands - 1 for kind, stands in solidworks.STANDS.items()}


def listed(client, who, file: dict) -> list[tuple[str, str]]:
    """A file's models, as Caliper lists them: each one's configuration and units."""
    response = client.get(f"/api/files/{file['id']}/caliper", headers=who)
    assert response.status_code == 200, response.text
    return [(model["configuration"], model["units"]) for model in response.json()["models"]]


def test_models_an_older_reader_made_are_read_again(team, client):
    """The server notes which release of its reader made each model it reads from a file. Once a newer one is out, the
    older one's models are read again when they're next wanted: they aren't listed, nor counted as a part's own model in
    an assembly, so Caliper has the server make them, which replaces them. Models Vault for SolidWorks made stay."""
    chief = team.member("chief@x.test", admin=True)
    checked = files(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": contents("9347.SLDASM"),
                "Servo/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Servo/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT"),
            },
            refs={"Servo/9347.SLDASM": ["Servo/Embout.SLDPRT", "Servo/Servomoteur.SLDPRT"]},
        )
    )
    servo, spline, case = checked["9347.SLDASM"], checked["Embout.SLDPRT"], checked["Servomoteur.SLDPRT"]
    for file in (servo, spline, case):
        assert make(client, chief, file).status_code == 200
    assert readers(team, case) == {"Default": solidworks.READER}
    # Vault for SolidWorks' model of another configuration of the assembly.
    added = put_model(team, chief, servo, configuration="Spline out", components=[model_component("Embout-1", spline)])
    assert added.status_code == 200, added.text
    made_by(team, case, OLDER["part"], units="in")
    with team.app.state.sessionmaker() as db:  # the assembly's Default, but not Vault for SolidWorks' Spline out
        for model in db.scalars(select(CaliperModel).join(Version).where(Version.file_id == servo["id"])):
            if model.configuration == "Default":
                model.reader, model.units = OLDER["assembly"], "in"
        db.commit()

    assert listed(client, chief, case) == []  # so Caliper asks for it again
    assert listed(client, chief, servo) == []  # a version's are left out while any of them is the older reader's
    assert listed(client, chief, spline) == [("Default", "mm")]
    shown = client.get(
        f"/api/files/{servo['id']}/caliper/assembly", params={"version": 1, "configuration": "Default"}, headers=chief
    ).json()
    assert {c["name"]: c["model"] for c in shown["components"]} == {"Embout-1": True, "Servomoteur-1": False}

    for file in (case, servo):
        remade = make(client, chief, file)
        assert (remade.status_code, remade.json()["configuration"], remade.json()["units"]) == (200, "Default", "mm")
    assert readers(team, case) == {"Default": solidworks.READER}
    assert readers(team, servo) == {"Default": solidworks.READER, "Spline out": 0}
    assert listed(client, chief, servo) == [("Spline out", "mm"), ("Default", "mm")]


def dotnet(data: bytes) -> bytes:
    """A mesh as Vault for SolidWorks writes it: .NET's gzip names the operating system it ran on in its header, where
    Python's names none (255)."""
    return data[:9] + bytes([19]) + data[10:]


def test_models_from_before_the_server_noted_their_reader_are_told_apart(team, client):
    """Models made before the server noted which reader made them are its first reader's if the server wrote what they
    carry, and are read again: a part's mesh gzipped by Python, an assembly whose components have no color of their own.
    Vault for SolidWorks' stay: a mesh gzipped by .NET, or components with colors."""
    chief = team.member("chief@x.test", admin=True)
    checked = files(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": contents("9347.SLDASM"),
                "Servo/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Servo/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT"),
                "Bay/Tab.SLDPRT": b"tab",
                "Bay/Bay.SLDASM": b"bay",
            },
            refs={"Servo/9347.SLDASM": ["Servo/Embout.SLDPRT", "Servo/Servomoteur.SLDPRT"]},
        )
    )
    servo, case, tab, bay = (checked[n] for n in ("9347.SLDASM", "Servomoteur.SLDPRT", "Tab.SLDPRT", "Bay.SLDASM"))
    for file in (servo, case):
        assert make(client, chief, file).status_code == 200
    assert put_model(team, chief, tab, mesh=team.upload(chief, dotnet(mesh()))).status_code == 200
    red = model_component("Tab-1", tab, color=[1, 0, 0])
    assert put_model(team, chief, bay, components=[red]).status_code == 200
    for file in (servo, case, tab, bay):
        made_by(team, file, None)

    assert listed(client, chief, case) == listed(client, chief, servo) == []  # the server's: read again
    assert listed(client, chief, tab) == listed(client, chief, bay) == [("Default", "mm")]  # Vault for SolidWorks'
    for file in (servo, case, tab, bay):
        assert make(client, chief, file).status_code == 200
    assert [readers(team, file) for file in (servo, case, tab, bay)] == [
        {"Default": solidworks.READER},
        {"Default": solidworks.READER},
        {"Default": None},
        {"Default": None},
    ]


def test_an_older_readers_model_stands_while_its_file_cant_be_read(team, client):
    """Where this reader can't read a file that an older one read (a layout it refuses), the older one's model stays,
    and comes back when Caliper asks for one, rather than nothing."""
    chief = team.member("chief@x.test", admin=True)
    odd = files(team.checkin(chief, {"Odd.SLDPRT": b"not a SolidWorks file"}))["Odd.SLDPRT"]
    assert put_model(team, chief, odd, mesh=team.upload(chief, mesh()), units="in").status_code == 200
    made_by(team, odd, OLDER["part"])
    assert listed(client, chief, odd) == []
    kept = make(client, chief, odd)
    assert (kept.status_code, kept.json()["units"]) == (200, "in")
    assert readers(team, odd) == {"Default": OLDER["part"]}


def test_a_reader_that_reads_only_assemblies_anew_leaves_parts_models(team, client):
    """What changes how assemblies are read needn't have every part read again: each kind's models stand from the
    reader that last changed them (solidworks.STANDS)."""
    assert solidworks.STANDS["part"] <= solidworks.STANDS["assembly"] <= solidworks.READER
    chief = team.member("chief@x.test", admin=True)
    case = files(team.checkin(chief, {"Servo/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT")}))[
        "Servomoteur.SLDPRT"
    ]
    assert make(client, chief, case).status_code == 200
    made_by(team, case, solidworks.STANDS["part"], units="in")  # the oldest that stands: not read again
    assert listed(client, chief, case) == [("Default", "in")]
    assert make(client, chief, case).json()["units"] == "in"


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


def test_a_part_renamed_since_is_found_by_the_name_it_had(team, client):
    """An assembly keeps the paths its parts had when it was saved. A part renamed since (given its part number, say)
    is still found, by the name it had there."""
    chief = team.member("chief@x.test", admin=True)
    folder = "Servo/Servomoteur SM-S4303R"
    checked = by_path(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": without_3d_view(contents("9347.SLDASM")),
                f"{folder}/Embout.SLDPRT": contents("Embout.SLDPRT"),
                f"{folder}/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT"),
            },
        )
    )
    spline = checked[f"{folder}/Embout.SLDPRT"]
    [number] = client.post("/api/numbers", json={"kind": "001"}, headers=chief).json()["numbers"]
    renamed = client.post(
        "/api/rename", json={"file": spline["id"], "name": f"{number['number']}.SLDPRT"}, headers=chief
    )
    assert renamed.status_code == 200, renamed.text

    found = shown(client, chief, checked["Servo/9347.SLDASM"])
    assert found["Embout-1"]["file_id"] == spline["id"]


def test_parts_in_a_folder_renamed_since_are_found_where_they_were(team, client):
    """The folders an assembly saved for its parts are the ones they were in: a part's name alone could be any file's,
    so a folder renamed since is found by the name it had."""
    chief = team.member("chief@x.test", admin=True)
    folder = "Servo/Servomoteur SM-S4303R"
    checked = by_path(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": without_3d_view(contents("9347.SLDASM")),
                f"{folder}/Embout.SLDPRT": contents("Embout.SLDPRT"),
                f"{folder}/Servomoteur.SLDPRT": contents("Servomoteur.SLDPRT"),
            },
        )
    )
    renamed = client.post("/api/rename", json={"folder": folder, "name": "Servo motor"}, headers=chief)
    assert renamed.status_code == 200, renamed.text

    found = shown(client, chief, checked["Servo/9347.SLDASM"])
    assert (found["Embout-1"]["file_id"], found["Servomoteur-1"]["file_id"]) == (
        checked[f"{folder}/Embout.SLDPRT"]["id"],
        checked[f"{folder}/Servomoteur.SLDPRT"]["id"],
    )


def placed_with_3d_interconnect(tree: bytes) -> bytes:
    """The servo's XML with its case a STEP file placed with 3D Interconnect, as SolidWorks keeps one: the document it
    made of it in its temporary folder (never on disk), and the path of the STEP file it was made from."""
    return tree.replace(
        b'swPath="C:\\Users\\elizabeth.robert\\Desktop\\Servomoteur SM-S4303R\\Servomoteur.SLDPRT"',
        b'swPath="C:\\Users\\adity\\AppData\\Local\\Temp\\swx19380\\IC~~\\Servo Case.step.SLDPRT" '
        b'swImportedPath="K:\\Project CAD\\Servo\\Servo Case.step"',
        1,
    )


def test_a_step_file_placed_with_3d_interconnect_is_the_file_it_was_made_from(team, client):
    """Caliper finds such a component's file by the STEP file's path, and reads it in the browser, as it does one on
    its own; the document SolidWorks made of it names nothing in the vault."""
    chief = team.member("chief@x.test", admin=True)
    servo = repacked(
        without_3d_view(contents("9347.SLDASM")), "swXmlContents/COMPINSTANCETREE", placed_with_3d_interconnect
    )
    checked = by_path(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": servo,
                "Servomoteur SM-S4303R/Embout.SLDPRT": contents("Embout.SLDPRT"),
                "Servo/Servo Case.step": b"ISO-10303-21;",
                "Elsewhere/Servo Case.step": b"ISO-10303-21;",
            },
        )
    )
    found = shown(client, chief, checked["Servo/9347.SLDASM"])
    case = found["Servomoteur-1"]
    assert (case["file_id"], case["format"], case["kind"], case["children"]) == (
        checked["Servo/Servo Case.step"]["id"],
        "step",
        None,
        [],
    )
    assert found["Embout-1"]["file_id"] == checked["Servomoteur SM-S4303R/Embout.SLDPRT"]["id"]


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
    # The one it can't tell is listed all the same, by its file's name and without a file, so nothing goes missing
    # unsaid; where SolidWorks kept it (a path on someone's computer) stays on the server.
    spline, case = assembly["components"]
    assert (spline["name"], spline["file_id"], spline["version"], spline["file"]) == (
        "Embout-1",
        None,
        None,
        "Embout.SLDPRT",
    )
    assert (spline["model"], spline["children"], "path" in spline) == (False, [], False)
    assert (case["name"], case["file"]) == ("Servomoteur-1", None)
    assert case["file_id"] == checked["Servomoteur SM-S4303R/Servomoteur.SLDPRT"]["id"]


def test_an_assembly_none_of_whose_parts_are_in_the_vault_lists_them(team, client):
    """No 3D view of its own, and none of its parts in the vault: its model lists every component, each without a
    file, so Caliper says which files to check in. Files with the parts' names, in folders of other names, aren't
    taken for them: a name alone could be any file's."""
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
    assert make(client, chief, servo).status_code == 200
    params = {"version": 1, "configuration": "Default"}
    assembly = client.get(f"/api/files/{servo['id']}/caliper/assembly", params=params, headers=chief).json()
    assert [(c["name"], c["file_id"], c["file"]) for c in assembly["components"]] == [
        ("Embout-1", None, "Embout.SLDPRT"),
        ("Servomoteur-1", None, "Servomoteur.SLDPRT"),
    ]


def test_a_part_checked_in_after_its_assemblys_model_was_made_shows(team, client):
    """A model lists the components whose files weren't in the vault when it was made, and each is looked for again
    whenever the assembly is shown: one checked in since is found, where SolidWorks kept it, at its first version as
    the assembly was checked in, and at its latest as it is now."""
    chief = team.member("chief@x.test", admin=True)
    servo = files(team.checkin(chief, {"Servo/9347.SLDASM": without_3d_view(contents("9347.SLDASM"))}))["9347.SLDASM"]
    assert make(client, chief, servo).status_code == 200
    params = {"version": 1, "configuration": "Default"}
    url = f"/api/files/{servo['id']}/caliper/assembly"
    before = client.get(url, params=params, headers=chief).json()
    assert [c["file_id"] for c in before["components"]] == [None, None]

    added = {"Servomoteur SM-S4303R/Embout.SLDPRT": contents("Embout.SLDPRT")}
    spline = files(team.checkin(chief, added))["Embout.SLDPRT"]
    assert team.checkout(chief, spline["path"]).status_code == 200
    again = {path: data + b"\0" for path, data in added.items()}
    assert team.checkin(chief, again).status_code == 200  # its second version
    as_checked_in = client.get(url, params=params, headers=chief).json()["components"][0]
    assert (as_checked_in["file_id"], as_checked_in["version"], as_checked_in["pinned"]) == (spline["id"], 1, 1)
    now = client.get(url, params={**params, "latest": True}, headers=chief).json()["components"][0]
    assert (now["file_id"], now["version"], now["pinned"], now["file"]) == (spline["id"], 2, 1, None)


def test_a_model_read_from_a_file_says_what_of_it_was_read(team, client):
    """A part's model is the 3D view SolidWorks saved in its file (the triangles SolidWorks drew), or made from the
    solid the file keeps (the server's own triangles of it, close to SolidWorks'), and says which; an assembly's is
    its file's list of components, and each of them says where its own part's is from."""
    chief = team.member("chief@x.test", admin=True)
    checked = files(
        team.checkin(
            chief,
            {
                "Servo/9347.SLDASM": without_3d_view(contents("9347.SLDASM")),
                "Servo/Embout.SLDPRT": without_3d_view(contents("Embout.SLDPRT")),
                "Servo/Servomoteur.SLDPRT": case_in_configurations(),
            },
            refs={"Servo/9347.SLDASM": ["Servo/Embout.SLDPRT", "Servo/Servomoteur.SLDPRT"]},
        )
    )
    servo, spline, case = checked["9347.SLDASM"], checked["Embout.SLDPRT"], checked["Servomoteur.SLDPRT"]
    assert make(client, chief, case).json()["source"] == "view"
    assert make_in(client, chief, case, "Spline").json()["source"] == "solid"  # a configuration it wasn't saved in
    assert make(client, chief, spline).json()["source"] == "solid"  # saved without its 3D view
    assert make(client, chief, servo).json()["source"] == "file"
    listed = client.get(f"/api/files/{case['id']}/caliper", headers=chief).json()["models"]
    assert [(model["configuration"], model["source"]) for model in listed] == [("Default", "view"), ("Spline", "solid")]
    params = {"version": 1, "configuration": "Default"}
    assembly = client.get(f"/api/files/{servo['id']}/caliper/assembly", params=params, headers=chief).json()
    assert {c["name"]: c["source"] for c in assembly["components"]} == {"Embout-1": "solid", "Servomoteur-1": "view"}


def best(client, who, file: dict, **body):
    return client.post(f"/api/files/{file['id']}/caliper/best", json=body, headers=who)


def test_a_part_shows_in_an_assembly_as_the_nearest_model_it_has(team, client):
    """An assembly shows each part at a version, in the configuration it uses. Where the part has no model of that,
    and its file keeps none to read, the nearest it has shows instead, so no part is missing where one can stand in,
    and Caliper says which it shows and why not the one wanted: first the version the assembly was checked in with, in
    that configuration; then the configuration the part was saved in."""
    chief = team.member("chief@x.test", admin=True)
    case = files(team.checkin(chief, {"Servo/Servomoteur.SLDPRT": case_in_configurations()}))["Servomoteur.SLDPRT"]

    # The one wanted, made from the file: nothing was missed.
    wanted = best(client, chief, case, version=1, configuration="Spline")
    assert wanted.status_code == 200, wanted.text
    assert (wanted.json()["model"]["version"], wanted.json()["model"]["configuration"]) == (1, "Spline")
    assert wanted.json()["missed"] == []

    # A configuration its file keeps no shape of: the one it was saved in stands in, and why says what to do.
    old = best(client, chief, case, version=1, configuration="Old").json()
    assert (old["model"]["version"], old["model"]["configuration"]) == (1, "Default")
    [missed] = old["missed"]
    assert (missed["version"], missed["configuration"]) == (1, "Old")
    assert "needing a rebuild" in missed["message"]

    # A newer version that can't be read: the one the assembly was checked in with stands in, in its configuration.
    assert team.checkout(chief, case["path"]).status_code == 200
    assert team.checkin(chief, {case["path"]: b"not a SolidWorks file"}).status_code == 200
    newer = best(client, chief, case, version=2, configuration="Spline", pinned=1).json()
    assert (newer["model"]["version"], newer["model"]["configuration"]) == (1, "Spline")
    assert [(m["version"], m["configuration"]) for m in newer["missed"]] == [(2, "Spline")]
    # Neither version in that configuration: the newer one as it was saved, were it readable; so the older, as saved.
    neither = best(client, chief, case, version=2, configuration="Old", pinned=1).json()
    assert (neither["model"]["version"], neither["model"]["configuration"]) == (1, "Default")
    assert [(m["version"], m["configuration"]) for m in neither["missed"]] == [(2, "Old"), (1, "Old"), (2, "")]

    # No model at all: refused for the reason the one wanted was.
    odd = files(team.checkin(chief, {"Odd.SLDPRT": b"not a SolidWorks file"}))["Odd.SLDPRT"]
    refused = best(client, chief, odd, version=1, configuration="Default")
    assert (refused.status_code, refused.json()["error"]) == (422, "unreadable_file")
    # An assembly that doesn't say which configuration it uses shows the one the part was saved in.
    unsaid = best(client, chief, case, version=1).json()
    assert (unsaid["model"]["configuration"], unsaid["missed"]) == ("Default", [])
    # Like any look at a file, it's for those who can see it.
    eve = team.member("eve@x.test")
    assert best(client, eve, case, version=1, configuration="Default").status_code == 404


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

    # Someone who can only view may: the model comes from the file. Who can't see the file can't, nor see what
    # configurations it has.
    assert make(client, eve, servo).status_code == 404
    listing = f"/api/files/{servo['id']}/caliper/configurations"
    assert client.get(listing, params={"version": 1}, headers=eve).status_code == 404
    assert make(client, bob, servo).status_code == 200
    assert client.get(listing, params={"version": 1}, headers=bob).json()["configurations"] == [
        {"name": "Default", "active": True, "saved": True, "model": True}
    ]
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
    assert make_in(client, chief, tab, "Long").json() == made.json()
    # Its file lists no configurations the server can read: the one it has a model of is offered, and others can't be
    # made.
    listed = client.get(f"/api/files/{tab['id']}/caliper/configurations", params={"version": 1}, headers=chief).json()
    assert listed["configurations"] == [{"name": "Long", "active": False, "saved": False, "model": True}]
    assert listed["unreadable"].startswith("Tab.SLDPRT v1: It isn't a SolidWorks part whose configurations")
    short = make_in(client, chief, tab, "Short")
    assert (short.status_code, short.json()["error"]) == (422, "unreadable_file")


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
