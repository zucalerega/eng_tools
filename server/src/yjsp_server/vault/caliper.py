"""Caliper's mesh format: a part's shape, as Vault for SolidWorks makes it and the web app draws it (docs/vault.md,
"Caliper").

A mesh is a gzip file. Inside, all little-endian: the bytes b"CMSH"; the format's version (uint32, 1); the header's
length in bytes (uint32, a multiple of 4); the header, JSON in UTF-8, padded with spaces; the vertices (float32 x, y, z,
in millimeters, in the part's own coordinates); and the triangles (uint32 indices of their vertices, three each). The
header:

    {"vertices": 8, "triangles": 12, "bodies": [{"name": "Boss-Extrude1", "solid": true, "color": [0.79, 0.82, 0.93],
     "opacity": 1, "faces": [{"first": 0, "count": 2}, {"first": 2, "count": 2, "color": [0.8, 0.1, 0.1]}, ...]}]}

Each face is a run of the triangles, one face of the body as SolidWorks has it (a plane, a cylinder): the web app
measures faces, and draws the edges between them. Faces don't share vertices, so each is shaded on its own. Colors are
red, green, and blue from 0 to 1. The web app reads meshes (web/src/vault/caliper/format.ts), and Vault.Client writes
them, and so does the server, from the 3D view SolidWorks saves in a file (vault/solidworks.py). The server reads only
enough to refuse one the web app couldn't draw.
"""

import gzip
import json
import struct
import sys
import threading
import zlib
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, Field, ValidationError

from ..errors import ApiError

MAGIC = b"CMSH"
FORMAT = 1
# A mesh unpacks to at most this much: more is something else (or a gzip bomb). A big part is tens of megabytes, and
# checking one holds it in memory, so this bounds what an upload can take of the server's.
MAX_UNPACKED = 1 << 28
# Meshes checked at once: each can hold MAX_UNPACKED, on a server with 6 GB.
_CHECKING = threading.BoundedSemaphore(2)

Color = Annotated[list[Annotated[float, Field(ge=0, le=1)]], Field(min_length=3, max_length=3)]
Rgb = tuple[float, float, float]  # red, green, and blue, from 0 to 1


class BadMesh(ApiError):
    code = "bad_mesh"


class _Face(BaseModel):
    first: int = Field(ge=0)  # its first triangle
    count: int = Field(ge=1)
    color: Color | None = None  # its own, over its body's


class _Body(BaseModel):
    name: str = Field(max_length=255)
    solid: bool = True  # a closed solid, which a section cuts and fills; else a surface
    color: Color
    opacity: float = Field(default=1, ge=0, le=1)
    faces: list[_Face]


class _Header(BaseModel):
    vertices: int = Field(ge=0)
    triangles: int = Field(ge=0)
    bodies: list[_Body]


def _unpack(path: Path) -> bytearray:
    inflater = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)  # gzip
    out = bytearray()
    try:
        with path.open("rb") as file:
            while chunk := file.read(1 << 20):
                # At most one byte past the limit: enough to know it's too big, without unpacking a gzip bomb.
                out += inflater.decompress(chunk, MAX_UNPACKED + 1 - len(out))
                if len(out) > MAX_UNPACKED:
                    raise BadMesh(f"A mesh unpacks to at most {MAX_UNPACKED >> 20} MB")
        out += inflater.flush()
    except zlib.error as e:
        raise BadMesh(f"A mesh is gzip-compressed, and this isn't: {e}") from e
    if not inflater.eof:
        raise BadMesh("The mesh ends early: it was cut off on the way. Make it again.")
    if inflater.unused_data or len(out) > MAX_UNPACKED:
        raise BadMesh("The mesh goes on after its end")
    return out


def check_mesh(path: Path) -> None:
    """Refuse (BadMesh) a file that isn't a mesh the web app can draw: its header, its sizes, and its triangles."""
    with _CHECKING:
        _check(_unpack(path))


def _check(data: bytearray) -> None:
    if len(data) < 12 or data[:4] != MAGIC:
        raise BadMesh("That isn't a Caliper mesh: it doesn't start with CMSH")
    version, length = struct.unpack_from("<II", data, 4)
    if version != FORMAT:
        raise BadMesh(f"This server reads Caliper meshes of version {FORMAT}, not {version}: update it")
    if length % 4 or 12 + length > len(data):
        raise BadMesh("The mesh's header doesn't fit in it")
    try:
        header = _Header.model_validate(json.loads(data[12 : 12 + length]))
    except (ValueError, ValidationError) as e:  # JSONDecodeError and UnicodeDecodeError are ValueErrors
        raise BadMesh(f"The mesh's header isn't right: {e}") from e
    arrays = memoryview(data)[12 + length :]
    expected = 12 * header.vertices + 12 * header.triangles
    if len(arrays) != expected:
        raise BadMesh(
            f"The mesh says it has {header.vertices} vertices and {header.triangles} triangles, which take "
            f"{expected} bytes, but it has {len(arrays)}"
        )
    indices = array("I")
    indices.frombytes(arrays[12 * header.vertices :])
    if sys.byteorder == "big":
        indices.byteswap()
    if indices and max(indices) >= header.vertices:
        raise BadMesh("A triangle of the mesh uses a vertex it doesn't have")
    for body in header.bodies:
        for face in body.faces:
            if face.first + face.count > header.triangles:
                raise BadMesh(f"A face of {body.name or 'a body'} goes past the mesh's last triangle")


@dataclass
class MeshFace:
    positions: array  # float32 x, y, z, in mm
    triangles: array  # uint32 indices of its positions, three for each triangle
    color: Rgb | None = None  # its own, over its body's


@dataclass
class MeshBody:
    name: str
    color: Rgb
    faces: list[MeshFace]
    opacity: float = 1
    solid: bool = True


def write_mesh(bodies: list[MeshBody]) -> bytes:
    """A mesh of these bodies, gzipped. The same bodies make the same bytes, so the blob store keeps them once."""
    positions, indices = array("f"), array("I")
    header_bodies = []
    for body in bodies:
        faces = []
        for face in body.faces:
            first, base = len(indices) // 3, len(positions) // 3
            positions.extend(face.positions)
            indices.extend(map(base.__add__, face.triangles))
            entry: dict[str, object] = {"first": first, "count": len(face.triangles) // 3}
            if face.color is not None:
                entry["color"] = [round(c, 4) for c in face.color]
            faces.append(entry)
        header_bodies.append(
            {
                "name": body.name,
                "solid": body.solid,
                "color": [round(c, 4) for c in body.color],
                "opacity": round(body.opacity, 4),
                "faces": faces,
            }
        )
    header = json.dumps(
        {"vertices": len(positions) // 3, "triangles": len(indices) // 3, "bodies": header_bodies},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode()
    header += b" " * (-len(header) % 4)
    if sys.byteorder == "big":
        positions.byteswap()
        indices.byteswap()
    data = MAGIC + struct.pack("<II", FORMAT, len(header)) + header + positions.tobytes() + indices.tobytes()
    return gzip.compress(data, mtime=0)


def compose(parent: list[float], child: list[float]) -> list[float]:
    """Where a component of a sub-assembly is in the assembly the sub-assembly is in: the sub-assembly's place, then the
    component's in it. Places are as assemblies' models keep them: the rows of a 3 x 4 matrix, rotation then translation
    in millimeters."""
    rows = []
    for i in range(3):
        for j in range(4):
            value = sum(parent[4 * i + k] * child[4 * k + j] for k in range(3))
            rows.append(value + (parent[4 * i + 3] if j == 3 else 0))
    return rows
