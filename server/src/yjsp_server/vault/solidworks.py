"""Reading SolidWorks parts and assemblies without SolidWorks: the 3D view SolidWorks saves in them, for Caliper
(docs/vault.md, "Caliper").

SolidWorks saves in each part and assembly the triangles it draws on screen, which is how eDrawings shows SolidWorks
files without SolidWorks (Document Properties > Image Quality > "Save tessellation with part document", on unless
someone turns it off). Caliper shows them too. SolidWorks documents none of this: it was worked out from files saved by
SolidWorks 2015 to 2019, checked against their STL exports, then from the team's own files saved by SolidWorks 2024 to
2026, checked against the preview SolidWorks saves in each and each part's size. So reading is strict. Whatever doesn't
fit is refused (Unreadable), never guessed at, and Vault for SolidWorks can make the model instead. Only the colors are
read on a best effort, and fall back to SolidWorks' default when they don't add up.

The file. A part or assembly saved by SolidWorks 2015 or later is a run of streams. Each is the bytes 14 00 06 00 08 00;
a tag, the CRC-32 of its contents, its packed size, its size, and its name's length (uint32s, little-endian, as is
everything here); its name, each byte's two halves swapped; and its contents, deflated (raw: no zlib header). Files
from SolidWorks 2014 and before are OLE compound documents (Microsoft's [MS-CFB]) of the same streams, most of them
packed: a stream whose name ends in __ZLB is 16 fixed bytes, its size and its packed size (uint32s), then zlib. Their
3D views are as later ones', but their units aren't in XML (they start in mm). It reads:

- Contents/DisplayLists: what SolidWorks draws (below).
- docProps/ISolidWorksInformation.xml: the document's units (SW_UnitsLinear, a swLengthUnit_e).
- swXmlContents/Features (a part's) or swXmlContents/COMPINSTANCETREE (an assembly's): XML naming the configurations,
  and an assembly's components: each one's file, configuration, place, and whether it's hidden or suppressed, with a
  sub-assembly's components inside its own model.

The display list is an MFC archive (CArchive). Each object starts with a tag (a uint16): 0xFFFF, and then a new class
(a uint16 schema, a uint16 length, and the class's name); or 0x8000 plus the number of a class that came before. A tag
without 0x8000 is an object that came before, by number, and 0 is none. Classes and objects are numbered together, as
they come. An array is a uint32 element size, a uint32 growth step, a uint32 2, a uint32 count, and the elements. A
count is a uint16, or 0xFFFF and a uint32. A string is ff fe ff, its length (a byte, or more as CString writes it),
and UTF-16.

A part's shape is a count of its bodies, then the bodies (uoTempBodyTessData_c). A body is a count of its faces, its
faces (uoTempFaceTessData_c), and its properties (uoBodyPropInfo_c), which name it. A face is a uint32 count of
triangles, a uint32 count of strips, and arrays: the strips' lengths (uint32), their vertices (float32 x, y, z, in
meters), and the vertices' normals. From SolidWorks 2024 on, 32 bytes come between the counts and the arrays: the
uint32s 1, 0, and 0, a number that differs from face to face, and four 0s. Then come its edges; after 01 00 00 00 ff ff
ff ff, which the edges' data can have in it too, the appearance (moVisualProperties_c) it has of its own, if any; and
some numbers and, from SolidWorks 2019 on, the face's id (a string), up to the next face's tag, or for a body's last
face, to 20 bytes before the body's properties. A strip of n vertices makes n - 2 triangles, each wound the other way
from the one before. An appearance starts with its color (bytes red, green, blue, 0), and after two strings come its
ambient, diffuse, specular, shininess, transparency, and emission (doubles). After the bodies comes the part's own
appearance.

An assembly's display list has a node (uoTempAssemblySHDData_c) for each component that's a part, at every level: its
name ("Bracket-1@Rocket": the component, then the assembly it's in), its place (a byte, 1 if it's turned; then
SolidWorks' 13 numbers, a rotation by columns, a translation in meters, and a scale, or for one that isn't turned just
the translation and the scale), its configuration, its part's name and path, and then the part's
shape, as above, in the part's own coordinates. Often there's no shape after a node, and from SolidWorks 2024 on there
never is: only which of the part's faces it shows. Nor has every assembly a display list. Its components are still in
its XML, and their parts' shapes are in their own files (vault.py finds them).

A virtual component, which SolidWorks keeps inside the file of the assembly it's in (as it does Routing's tubes, and
the routes they're in), has its whole file there: the stream VirtualComp/ and its name up to the ^ (SolidWorks names one
"Tube-375X010^Route-1"), with -sldprt or -sldasm after that in some files. A virtual sub-assembly's file keeps its own
virtual components in turn, and a sub-assembly that's a file of its own keeps its own (vault.py reads them there). A
virtual part is read from its solid, never its display list: SolidWorks leaves that as it was when the part was made (a
routed tube's is the library tube's, 12.7 mm long), but builds the solid along the route.

A part without a display list (SolidWorks set not to save one, as vendors' parts often are), or with one Caliper can't
follow, is read from its solid instead: the Parasolid bodies SolidWorks keeps of each configuration (parasolid.py),
turned into triangles (brep.py), for the configuration SolidWorks had open (N, its swID). It reads:

- Contents/Config-N-Partition: the part's bodies, as the configuration last built them.
- Config-N-FeatureBodies/LocalBodies: the bodies its imports brought in. Where the partition has none, as in a part
  that's an import and nothing else, these are the part's own, but only then: so they're read only if
  Contents/Config-N-ResolvedFeatures has no class (a feature's, and what features keep) but those such parts have, which
  don't make or change bodies (the import, folders, planes and axes, sketches, dimensions, references).

A part read from its solid takes the appearance its configuration keeps (Contents/Config-N), where it keeps just one:
the part's, which SolidWorks shows over the colors Parasolid keeps of faces, often older ones (a grey from before the
part's steel). Faces of a color other than most of their body's keep theirs (an O-ring's black). Where the
configuration keeps more appearances (its faces' too), the solid's colors stand.

Configurations. The XML lists a file's configurations (swConfiguration): each one's name, its swID (the N of its
streams), whether SolidWorks had it open when it saved the file (swMostRecentConfiguration), and whether it marked it as
needing a rebuild then (swConfigurationNeedsUpdate). The display list is of the one it had open, and only of that one.
But SolidWorks keeps the solid of every configuration that was up to date when it saved the file: one shown since the
part last changed, or one with a Rebuild/Save Mark, which SolidWorks rebuilds at every save. In the 311 parts with more
than one configuration that SolidWorks installs as samples, every one of the 447 configurations up to date kept its
solid, and no display list had more than one configuration's triangles. So another configuration of a part is read
from its solid (read_part). One marked as needing a rebuild is refused (NotSaved): any solid it has is from before the
part last changed (8 of those samples' were). An assembly's XML has each configuration's components.

Some programs that write SolidWorks files leave every stream's CRC field the same, uncomputed. There the solid's own
checks stand in: it must unpack to exactly the size it says, and its transmit files end exactly where their nodes do.

A drawing keeps no lines or text the server could draw: SolidWorks draws its views from its models' 3D bodies
(Contents/VBLists keeps them), and its annotations are in its feature tree. What it does keep is a picture of each
sheet, for Windows' Explorer and SolidWorks' Open dialog, which Caliper shows where it has nothing better (read_sheets):

- SheetPreviews/SheetNames: the sheets' names, in order: their count (a uint16), then each name (a CString) and four
  bytes, as drawings of one sheet have it.
- Images/Sheet_N: sheet N's picture (from 0), a PNG of 640 x 480: the whole sheet, too small to read its dimensions.
- PreviewPNG: the file's own preview, of the sheet SolidWorks had open, for a drawing that keeps no pictures of sheets.
"""

import re
import struct
import sys
import unicodedata
import zlib
from array import array
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Literal
from xml.etree import ElementTree

from ..errors import ApiError
from . import brep, parasolid
from .caliper import MeshBody, MeshFace, Rgb

MAX_STREAM = 1 << 29  # a stream unpacks to at most this: a big assembly's display list is a hundred MB or two
# This reader's version, which the models it makes keep (CaliperModel.reader): when what it reads from a file changes,
# a newer one is out, and the server reads the models an older one made again, as they're next wanted. STANDS has the
# oldest reader whose models of each kind still stand: what changed an assembly's reading needn't have every part read
# again. (4: an assembly's model lists the components whose files weren't in the vault, and where SolidWorks kept
# them; a part's says whether it's its 3D view or its solid, which changes no part's model.)
READER = 4
STANDS: dict[str, int] = {"part": 3, "assembly": 4}
_MARKER = b"\x14\x00\x06\x00\x08\x00"
_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_ZLB = bytes.fromhex("231dd571da8148a2a85898b21b89ef99")  # what a packed stream of an OLE file starts with
_NO_SECTOR = 0xFFFFFFFA  # sector numbers from here up mean a chain's end, or none
_DISPLAY = "Contents/DisplayLists"
_INFO = "docProps/ISolidWorksInformation.xml"
_FEATURES = "swXmlContents/Features"
_TREE = "swXmlContents/COMPINSTANCETREE"
_PARTITION = "Contents/Config-{}-Partition"
_LOCAL = "Config-{}-FeatureBodies/LocalBodies"
_RESOLVED = "Contents/Config-{}-ResolvedFeatures"
_CONFIGURATION = "Contents/Config-{}"
_NS = "{http://www.solidworks.com/sw2003/schema}"

_BODY = b"uoTempBodyTessData_c"
_FACE = b"uoTempFaceTessData_c"
_PROPERTIES = b"uoBodyPropInfo_c"
_APPEARANCE = b"moVisualProperties_c"
_STRIPS = struct.pack("<3I", 4, 8, 2)  # how a face's array of strip lengths starts
_OWN_APPEARANCE = struct.pack("<Ii", 1, -1)  # what comes before a face's own appearance
_STRING = b"\xff\xfe\xff"
_ARRAY = struct.Struct("<4I")

# SolidWorks' default color for parts with none of their own.
DEFAULT_COLOR: Rgb = (202 / 255, 209 / 255, 238 / 255)

# swLengthUnit_e as Caliper's units, as Vault for SolidWorks has them (CaliperUnits): mm for the rest.
_UNITS = {1: "cm", 2: "m", 3: "in", 4: "ft", 5: "in", 9: "in", 10: "in"}


class Unreadable(ApiError):
    status = 422
    code = "unreadable_file"


class NotSaved(Unreadable):
    """A configuration SolidWorks kept no shape of that's up to date when it saved the file: it needed a rebuild then."""

    code = "configuration_not_saved"


class NoConfiguration(ApiError):
    status = 404
    code = "no_configuration"


@dataclass
class Configuration:
    """A configuration, as the file lists it."""

    name: str
    active: bool  # the one SolidWorks had open when it saved the file: its 3D view's
    # Up to date when SolidWorks saved the file (not marked as needing a rebuild), so the file keeps its shape: a part's
    # solid, an assembly's components where they are.
    saved: bool


@dataclass
class Part:
    configuration: str  # the one asked for; else the one SolidWorks had open when it saved the file
    units: str
    bodies: list[MeshBody]
    # Where its shape is from: the 3D view SolidWorks saved (the triangles it drew), or the solid it kept, which the
    # server turned into triangles of its own.
    source: Literal["view", "solid"]


@dataclass
class Component:
    name: str  # SolidWorks' name for it in the assembly: "Bracket-2"
    # its file's path when the assembly was saved: C:\VLT\Rocket\Bracket.SLDPRT (a STEP file placed with 3D
    # Interconnect: the one it was made from)
    path: str
    configuration: str
    transform: list[float]  # the rows of a 3 x 4 matrix to the top assembly's coordinates, in mm
    hidden: bool
    virtual: bool  # kept inside the assembly it's in
    shape: list[MeshBody] | None  # a part's bodies, as the assembly shows them; a virtual part's, as its solid has them
    children: list["Component"] = field(default_factory=list)  # a sub-assembly's


@dataclass
class Assembly:
    configuration: str
    units: str
    components: list[Component]


# --- the file ---------------------------------------------------------------------------------


def _streams(data: bytes, wanted: set[str], checked: bool = True) -> dict[str, bytes]:
    """The streams of a SolidWorks 2015+ file that are wanted, by name, each checked against its CRC (unless
    checked is False: see _unchecked)."""
    found: dict[str, bytes] = {}
    at = data.find(_MARKER)
    while at >= 0 and len(found) < len(wanted):
        head = at + len(_MARKER)
        if head + 20 <= len(data):
            _tag, crc, packed, size, length = struct.unpack_from("<5I", data, head)
            start = head + 20 + length
            if 0 < length <= 1024 and start + packed <= len(data):
                name = bytes(((b << 4) | (b >> 4)) & 0xFF for b in data[head + 20 : start]).decode("latin-1")
                if name in wanted and name not in found:
                    if size > MAX_STREAM:
                        raise Unreadable(f"Its {name} unpacks to over {MAX_STREAM >> 20} MB, more than Caliper reads")
                    inflater = zlib.decompressobj(-15)
                    try:
                        contents = inflater.decompress(data[start : start + packed], size + 1)
                    except zlib.error:
                        contents = b""
                    if len(contents) == size and (zlib.crc32(contents) == crc or not checked):
                        found[name] = contents
        at = data.find(_MARKER, at + 1)
    return found


def _unchecked(data: bytes) -> bool:
    """Whether a file's streams all have one CRC field, never computed (as some programs that write SolidWorks files
    leave them): then nothing that relies on its streams' CRCs reads it, but a solid can, by its own checks."""
    crcs = set()
    at = data.find(_MARKER)
    while at >= 0 and len(crcs) < 2:
        if at + len(_MARKER) + 20 <= len(data):
            _tag, crc, _packed, _size, length = struct.unpack_from("<5I", data, at + len(_MARKER))
            if 0 < length <= 1024:
                crcs.add(crc)
        at = data.find(_MARKER, at + 1)
    return len(crcs) == 1


def _found(data: bytes, wanted: set[str]) -> dict[str, bytes]:
    """The wanted streams of a file of either kind."""
    if data.startswith(_OLE):
        return _compound(data, wanted)
    found = _streams(data, wanted)
    if not found and _unchecked(data):
        found = _streams(data, wanted, checked=False)
    return found


def _xml(contents: bytes | None) -> ElementTree.Element | None:
    """SolidWorks' XML, which never declares entities: refuse any that does, rather than expand them."""
    if contents is None:
        return None
    if b"<!DOCTYPE" in contents or b"<!ENTITY" in contents:
        raise Unreadable("Its XML declares entities, which SolidWorks' never does")
    try:
        return ElementTree.fromstring(contents)
    except ElementTree.ParseError as e:
        raise Unreadable(f"Its XML doesn't parse: {e}") from e


def _units(info: bytes | None) -> str:
    found = re.search(rb'name="SW_UnitsLinear"[^>]*>\s*<vt:i4>(\d+)<', info or b"")
    return _UNITS.get(int(found.group(1)), "mm") if found else "mm"


def _compound(data: bytes, wanted: set[str]) -> dict[str, bytes]:
    """The streams of an OLE compound file (a SolidWorks 2014 or older file) that are wanted, by name, each as it is
    or unpacked from its __ZLB stream. Anything that doesn't fit the format is refused."""
    odd = Unreadable("It's an OLE file, as SolidWorks 2014 and older saved them, that doesn't read as one")
    if len(data) < 512 or data[28:30] != b"\xfe\xff":
        raise odd
    shift, mini_shift = struct.unpack_from("<HH", data, 30)
    if (shift, mini_shift) not in ((9, 6), (12, 6)):
        raise odd
    size, mini = 1 << shift, 1 << mini_shift
    fat_sectors, first_directory, _, cutoff, first_mini_fat, _, first_difat, difat_sectors = struct.unpack_from(
        "<8I", data, 44
    )
    sectors = (len(data) - size) // size  # how many sectors the file has, after its header
    if fat_sectors > sectors or difat_sectors > sectors:
        raise odd

    def at(sector: int) -> int:
        if sector >= sectors:
            raise odd
        return (sector + 1) * size

    difat = list(struct.unpack_from("<109I", data, 76))
    sector = first_difat
    for _ in range(difat_sectors):
        entries = struct.unpack_from(f"<{size // 4}I", data, at(sector))
        difat += entries[:-1]
        sector = entries[-1]
    fat: list[int] = []
    for sector in difat[:fat_sectors]:
        fat += struct.unpack_from(f"<{size // 4}I", data, at(sector))

    def chain(first: int, table: list[int], limit: int) -> list[int]:
        """A chain of sectors, which must end, and not come back on itself."""
        found, seen = [], set()
        sector = first
        while sector < _NO_SECTOR:
            if sector in seen or sector >= len(table) or len(found) > limit:
                raise odd
            seen.add(sector)
            found.append(sector)
            sector = table[sector]
        return found

    def read(first: int, length: int) -> bytes:
        return b"".join(data[at(s) : at(s) + size] for s in chain(first, fat, length // size + 1))[:length]

    directory = read(first_directory, size * len(chain(first_directory, fat, sectors)))
    entries = [directory[i : i + 128] for i in range(0, len(directory) - 127, 128)]
    if not entries or entries[0][66] != 5:  # the root
        raise odd
    root_start, root_size = struct.unpack_from("<IQ", entries[0], 116)
    mini_stream = read(root_start, root_size & 0xFFFFFFFF) if root_start < _NO_SECTOR else b""
    mini_fat: list[int] = []
    for sector in chain(first_mini_fat, fat, sectors):
        mini_fat += struct.unpack_from(f"<{size // 4}I", data, at(sector))

    def stream(entry: bytes) -> bytes:
        first, length = struct.unpack_from("<IQ", entry, 116)
        length &= 0xFFFFFFFF if size == 512 else (1 << 64) - 1  # version 3 files have only 32 bits of it
        if length > MAX_STREAM:
            raise Unreadable(f"A stream of it is over {MAX_STREAM >> 20} MB, more than Caliper reads")
        if length >= cutoff:
            return read(first, length)
        pieces = chain(first, mini_fat, length // mini + 1)
        return b"".join(mini_stream[p * mini : (p + 1) * mini] for p in pieces)[:length]

    # The directory is a tree of storages (folders) and streams, each storage's children a binary tree of siblings.
    found: dict[str, bytes] = {}
    pending, seen = [(entries[0], "")], set()
    while pending:
        entry, folder = pending.pop()
        child = struct.unpack_from("<I", entry, 76)[0]
        siblings = [child]
        while siblings:
            index = siblings.pop()
            if index >= _NO_SECTOR:
                continue
            if index in seen or index >= len(entries):
                raise odd
            seen.add(index)
            item = entries[index]
            left, right = struct.unpack_from("<II", item, 68)
            siblings += [left, right]
            length = struct.unpack_from("<H", item, 64)[0]
            name = item[: max(0, min(length, 64) - 2)].decode("utf-16-le", "replace")
            if item[66] == 1:  # a storage
                pending.append((item, folder + name + "/"))
            elif item[66] == 2:
                path = folder + name
                plain = path.removesuffix("__ZLB")
                if plain in wanted and plain not in found:
                    contents = stream(item)
                    if path.endswith("__ZLB"):
                        contents = _unpack_zlb(contents, odd)
                    found[plain] = contents
    return found


def _unpack_zlb(packed: bytes, odd: Unreadable) -> bytes:
    if len(packed) < 24 or packed[:16] != _ZLB:
        raise odd
    size, length = struct.unpack_from("<II", packed, 16)
    if size > MAX_STREAM:
        raise Unreadable(f"A stream of it unpacks to over {MAX_STREAM >> 20} MB, more than Caliper reads")
    if length == 0:
        return b""
    inflater = zlib.decompressobj()
    contents = inflater.decompress(packed[24 : 24 + length], size + 1)
    if len(contents) != size:
        raise odd
    return contents


def _open(data: bytes, kind: Literal["part", "assembly"]) -> dict[str, bytes]:
    """The streams a part or assembly is read from: a part's display list, if it has one; an assembly's XML. Without
    any of them, a part may still have a solid (_solid)."""
    wanted = {_DISPLAY, _INFO, _FEATURES if kind == "part" else _TREE}
    found = _compound(data, wanted) if data.startswith(_OLE) else _streams(data, wanted)
    if not found and kind == "assembly":
        raise Unreadable(f"It isn't a SolidWorks {kind} that Caliper can read")
    return found


_NO_VIEW = (
    "SolidWorks saved no 3D view in it: it may be empty, or SolidWorks may be set not to (Document Properties > "
    "Image Quality > Save tessellation with part document). Make its 3D view in SolidWorks instead (Make 3D view, on "
    "the Vault tab)"
)


# --- the display list ---------------------------------------------------------------------------


def _u16(data: bytes, at: int) -> int:
    return int.from_bytes(data[at : at + 2], "little") if 0 <= at <= len(data) - 2 else -1


def _string(data: bytes, at: int) -> tuple[str, int] | None:
    """A CString, ff fe ff and UTF-16, at `at`: it and where it ends."""
    if data[at : at + 3] != _STRING:
        return None
    at += 3
    length, at = data[at] if at < len(data) else -1, at + 1
    if length == 0xFF:
        length, at = _u16(data, at), at + 2
        if length == 0xFFFF:
            length, at = int.from_bytes(data[at : at + 4], "little"), at + 4
    end = at + 2 * length
    if length < 0 or end > len(data):
        return None
    return data[at:end].decode("utf-16-le", "replace"), end


def _strings(data: bytes, start: int, end: int) -> list[tuple[int, str]]:
    """The CStrings between start and end, each with where it starts."""
    found = []
    at = data.find(_STRING, start, end)
    while at >= 0:
        read = _string(data, at)
        if read is None:
            at = data.find(_STRING, at + 1, end)
            continue
        found.append((at, read[0]))
        at = data.find(_STRING, read[1], end)
    return found


@dataclass
class _Face:
    start: int  # where its record starts: its count of triangles
    end: int  # just past its normals
    lengths: tuple[int, ...]  # its strips'
    vertices: memoryview  # float32 x, y, z, in meters
    normals: memoryview


# What a face's counts and its arrays have between them: nothing before SolidWorks 2024, these 32 bytes since.
_GAPS = (0, 32)


def _face_at(data: bytes, at: int, gap: int = 0) -> _Face | None:
    if at < 0 or at + 24 + gap > len(data):
        return None
    triangles, strips = struct.unpack_from("<2I", data, at)
    if gap:
        block = struct.unpack_from("<8I", data, at + 8)
        if block[:3] != (1, 0, 0) or block[4:] != (0, 0, 0, 0):
            return None
    size, _grow, two, count = _ARRAY.unpack_from(data, at + 8 + gap)
    if not (size == 4 and two == 2 and 0 < strips == count <= 1 << 24 and triangles > 0):
        return None
    lengths_at = at + 24 + gap
    if lengths_at + 4 * strips > len(data):
        return None
    lengths = struct.unpack_from(f"<{strips}I", data, lengths_at)
    n = sum(lengths)
    if min(lengths) < 3 or n - 2 * strips != triangles:
        return None
    vertices_at = lengths_at + 4 * strips
    normals_at = vertices_at + 16 + 12 * n
    end = normals_at + 16 + 12 * n
    if end > len(data):
        return None
    for header in (vertices_at, normals_at):
        size, _grow, two, count = _ARRAY.unpack_from(data, header)
        if (size, two, count) != (12, 2, n):
            return None
    view = memoryview(data)
    return _Face(at, end, lengths, view[vertices_at + 16 : normals_at], view[normals_at + 16 : end])


def _faces(data: bytes) -> list[_Face]:
    """Every face in a display list, in order."""
    found = []
    hit = data.find(_STRIPS)
    while hit >= 0:
        face = None
        for gap in _GAPS:
            face = _face_at(data, hit - 8 - gap, gap)
            if face is not None:
                break
        if face is None:
            hit = data.find(_STRIPS, hit + 1)
        else:
            found.append(face)
            hit = data.find(_STRIPS, face.end)
    return found


def _new_class(data: bytes, end: int, name: bytes) -> int | None:
    """Where the tag of a new class named `name`, which ends at `end`, starts."""
    start = end - len(name) - 6
    if (
        data[end - len(name) : end] == name
        and _u16(data, start) == 0xFFFF
        and _u16(data, end - len(name) - 2) == len(name)
    ):
        return start
    return None


def _tag_before(data: bytes, end: int, name: bytes, number: int | None) -> int | None:
    """Where an object's tag, which ends at `end`, starts: a new class named `name`, or that class's number."""
    new = _new_class(data, end, name)
    if new is not None:
        return new
    if number is not None and _u16(data, end - 2) == 0x8000 | number:
        return end - 2
    return None


def _count_before(data: bytes, end: int) -> tuple[int, int] | None:
    """A count that ends at `end`: (it, where it starts)."""
    small = _u16(data, end - 2)
    if 0 <= small < 0xFFFF:
        return small, end - 2
    return None


def _count_before_big(data: bytes, end: int) -> tuple[int, int] | None:
    if end >= 6 and _u16(data, end - 6) == 0xFFFF:
        big = int.from_bytes(data[end - 4 : end], "little")
        if big >= 0xFFFF:
            return big, end - 6
    return None


@dataclass
class _Body:
    start: int  # where its tag starts
    faces: list[_Face]
    expected: int  # how many faces it says it has


@dataclass
class _Shape:
    start: int  # where its count of bodies starts
    bodies: list[_Body]


def _shapes(data: bytes, faces: list[_Face]) -> list[_Shape]:
    """The faces, as the shapes and bodies they're in: each body says how many faces it has, and each shape how many
    bodies. Anything that doesn't add up is refused."""
    if not faces:
        return []
    # A face's class is new at the first face; after it, every face's tag is 0x8000 and its number.
    numbers = {_u16(data, face.start - 2) for face in faces[1:]}
    if len(numbers) > 1 or (numbers and not next(iter(numbers)) & 0x8000):
        raise Unreadable(_ODD)
    face_class = (next(iter(numbers)) & 0x7FFF) if numbers else None
    # A body's class comes just before a face's: the first body, then the first face.
    body_class = face_class - 2 if face_class is not None else None

    def body_before(face: _Face) -> tuple[int, int, int] | None:
        """If a body starts just before this face: (its tag's start, its count of faces, where that count starts)."""
        tag = _tag_before(data, face.start, _FACE, face_class)
        if tag is None:
            return None
        for read in (_count_before(data, tag), _count_before_big(data, tag)):
            if read is not None and read[0] > 0:
                start = _tag_before(data, read[1], _BODY, body_class)
                if start is not None:
                    return start, read[0], read[1]
        return None

    shapes: list[_Shape] = []
    bodies_left = 0
    body: _Body | None = None
    for face in faces:
        if body is not None and len(body.faces) < body.expected:
            body.faces.append(face)
            continue
        started = body_before(face)
        if started is None:
            raise Unreadable(_ODD)
        tag, expected, _ = started
        body = _Body(tag, [face], expected)
        if bodies_left == 0:
            read = _count_before(data, tag) or _count_before_big(data, tag)
            if read is None or read[0] == 0:
                raise Unreadable(_ODD)
            bodies_left = read[0]
            shapes.append(_Shape(read[1], []))
        shapes[-1].bodies.append(body)
        bodies_left -= 1
    if bodies_left or (body is not None and len(body.faces) != body.expected):
        raise Unreadable(_ODD)
    return shapes


_ODD = (
    "Caliper can't make sense of the 3D view SolidWorks saved in it, perhaps because a newer SolidWorks saved it "
    "differently. Make its 3D view in SolidWorks instead (Make 3D view, on the Vault tab)"
)


# --- faces' triangles, and colors ---------------------------------------------------------------


def _floats(view: memoryview) -> array:
    values = array("f")
    values.frombytes(view)
    if sys.byteorder == "big":
        values.byteswap()
    return values


def _triangles(face: _Face) -> tuple[array, array]:
    """A face's vertices in mm, and its triangles: its strips', each wound as its vertices' normals say."""
    meters = _floats(face.vertices)
    normals = _floats(face.normals)
    positions = array("f", (v * 1000 for v in meters))
    triangles = array("I")
    first = 0
    for n in face.lengths:
        # Strips alternate their winding. Which way the first triangle faces is checked against the normals: a strip
        # that faces in is turned around (none of SolidWorks' has yet).
        flip = _facing(meters, normals, first) < 0
        for i in range(n - 2):
            a, b, c = first + i, first + i + 1, first + i + 2
            if (i % 2 == 1) != flip:
                a, b = b, a
            triangles.extend((a, b, c))
        first += n
    return positions, triangles


def _facing(points: array, normals: array, first: int) -> float:
    """How far a strip's first triangle faces along its first vertex's normal."""
    ax, ay, az = points[3 * first : 3 * first + 3]
    bx, by, bz = points[3 * first + 3 : 3 * first + 6]
    cx, cy, cz = points[3 * first + 6 : 3 * first + 9]
    ux, uy, uz, vx, vy, vz = bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    return nx * normals[3 * first] + ny * normals[3 * first + 1] + nz * normals[3 * first + 2]


@dataclass
class _Look:
    color: Rgb
    opacity: float


def _appearance(data: bytes, at: int) -> tuple[_Look, int] | None:
    """An appearance's color and opacity, if the object's data that starts at `at` looks like one's: its color, 4
    bytes, a second color, two strings, then its properties. With where its properties end."""
    if at < 0 or at + 12 > len(data) or data[at + 3] != 0 or data[at + 11] != 0:
        return None
    color = (data[at] / 255, data[at + 1] / 255, data[at + 2] / 255)
    first = _string(data, at + 12)
    second = _string(data, first[1]) if first else None
    if second is None or second[1] + 48 > len(data):
        return None
    _ambient, _diffuse, _specular, _shininess, transparency, _emission = struct.unpack_from("<6d", data, second[1])
    if not 0 <= transparency <= 1:
        return None
    return _Look(color, 1 - transparency), second[1] + 48


def _object(data: bytes, at: int) -> tuple[str, int, int] | None:
    """The object tag at `at`: what it is ("none", "new" class, "class", or "object"), its number (a class's or an
    object's), and where the object's data starts."""
    tag = _u16(data, at)
    if tag < 0:
        return None
    if tag == 0:
        return "none", 0, at + 2
    if tag == 0xFFFF:
        length = _u16(data, at + 4)
        return ("new", 0, at + 6 + length) if 0 < length <= 64 else None
    if tag == 0x7FFF:
        big = int.from_bytes(data[at + 2 : at + 6], "little")
        return ("class", big & 0x7FFFFFFF, at + 6) if big & 0x80000000 else ("object", big, at + 6)
    return ("class", tag & 0x7FFF, at + 2) if tag & 0x8000 else ("object", tag, at + 2)


@dataclass
class _Own:
    """A face's own appearance, after its edges: none, a new one, or one before it, by number."""

    kind: Literal["none", "new", "new class", "earlier"]
    number: int  # an earlier one's
    look: _Look | None  # a new one's
    end: int  # where what comes after it starts, as far as it's read


def _own(data: bytes, face: _Face, end: int) -> _Own | None:
    """A face's own appearance, after an anchor that follows its edges, in its record, which ends at `end`. The edges'
    data can have the anchor's bytes in it too, and so can the rest of the record, so the anchor is the one followed by
    an appearance, which nothing else passes for, or by none or an earlier one's number and then exactly the rest of the
    record."""
    anchor = data.find(_OWN_APPEARANCE, face.end, end)
    while anchor >= 0:
        own = _own_at(data, anchor + len(_OWN_APPEARANCE))
        if own is not None and (own.look is not None or _rest(data, own.end, end)):
            return own
        anchor = data.find(_OWN_APPEARANCE, anchor + 1, end)
    return None


def _rest(data: bytes, at: int, end: int) -> bool:
    """Whether what's from `at` to `end` is the rest of a face's record, after its own appearance: two uint32s, a count
    of 8-byte entries and the entries, and then, as the SolidWorks that wrote the display list had it, nothing (2012), a
    uint32 (2014 to 2017), or 8 bytes, the face's id (a string: "moSimpleSurfIdRep_c,18,44, "), and 0 bytes (2019 and
    2020), 4 (2021), or 8 (2022 on)."""
    if at + 12 > end:
        return False
    entries = at + 12 + 8 * int.from_bytes(data[at + 8 : at + 12], "little")
    if entries in (end, end - 4):
        return True
    read = _string(data, entries + 8) if entries + 8 < end else None
    return read is not None and end - read[1] in (0, 4, 8)


def _own_at(data: bytes, at: int) -> _Own | None:
    """The own appearance whose tag is at `at`: none, an earlier one's number, or a new one, if it reads as one."""
    read = _object(data, at)
    if read is None:
        return None
    kind, number, start = read
    if kind == "none":
        return _Own("none", 0, None, start)
    if kind == "object":
        return _Own("earlier", number, None, start)
    if kind == "new" and data[start - len(_APPEARANCE) : start] != _APPEARANCE:
        return None
    look = _appearance(data, start)
    if look is None:
        return None
    return _Own("new class" if kind == "new" else "new", 0, look[0], look[1])


def _face_colors(bodies: list[_Body], owns: list[list[_Own]], first: int | None) -> list[list[Rgb | None]]:
    """Each face's own color, where it has one: its own appearance, or an earlier one it refers to by number.

    Objects are numbered as they come, so in a body each face's and appearance's number is the body's first face's
    plus a count. That first number is known for a part file's first body (first). For other bodies it's found from
    the faces that refer back to the body's own appearances. If the numbers don't add up, no face gets a color."""
    plain: list[list[Rgb | None]] = [[None] * len(body.faces) for body in bodies]
    colors: list[list[Rgb | None]] = [[None] * len(body.faces) for body in bodies]
    known: dict[int, Rgb] = {}  # appearances by number, in bodies whose numbers are known
    for b in range(len(bodies)):
        count = -1
        news: list[tuple[int, Rgb, int]] = []  # (number from the body's first face, color, face)
        earlier: list[tuple[int, int]] = []  # (face, number)
        for f, own in enumerate(owns[b]):
            count += 1  # the face
            if own.look is not None:
                count += 2 if own.kind == "new class" else 1
                news.append((count, own.look.color, f))
                colors[b][f] = own.look.color
            elif own.kind == "earlier":
                earlier.append((f, own.number))
        base = first if b == 0 else None
        unknown = [(f, n) for f, n in earlier if n not in known]
        if unknown and base is None:
            fits: set[int] | None = None
            for f, n in unknown:
                options = {n - count for count, _, g in news if g < f}
                fits = options if fits is None else fits & options
            if not fits or len(fits) != 1:
                return plain
            base = fits.pop()
        mine = {base + count: color for count, color, _ in news} if base is not None else {}
        for f, n in earlier:
            color = known.get(n) or mine.get(n)
            if color is None:
                return plain
            colors[b][f] = color
        known.update(mine)
    return colors


def _next_appearance(data: bytes, start: int, end: int) -> tuple[_Look, int] | None:
    """The first appearance between start and end, by how its data looks, after its tag (a class's number, or a new
    class): with where its tag starts."""
    hit = data.find(_STRING, start, end)
    while hit >= 0:
        at = hit - 12  # its data: two colors and 4 bytes, before its first string
        if at - 2 >= start:
            look = _appearance(data, at)
            if look is not None and data[at - 1] & 0x80 and data[at - 1] != 0xFF:
                return look[0], at - 2
            new = _new_class(data, at, _APPEARANCE)
            if look is not None and new is not None and new >= start:
                return look[0], new
        hit = data.find(_STRING, hit + 1, end)
    return None


_ID = re.compile(r"_c,\d")  # the ids SolidWorks keeps of faces: "moFromSktEntSurfIdRep_c,85,9, "
# A body's properties, after its faces: a class that came before (0x8000 and its number), a uint16, then 1 and 6.
_PROPERTIES_AGAIN = re.compile(rb"[\x00-\xff][\x80-\xfe][\x00-\xff]{2}\x01\x00\x00\x00\x06\x00\x00\x00", re.DOTALL)


def _properties(data: bytes, start: int, end: int) -> int | None:
    """Where a body's properties (uoBodyPropInfo_c) start, after its last face: the class, new or not."""
    found = []
    named = data.find(_PROPERTIES, start, end)
    new = _new_class(data, named + len(_PROPERTIES), _PROPERTIES) if named >= 0 else None
    if new is not None and new >= start:
        found.append(new)
    again = _PROPERTIES_AGAIN.search(data, start, end)
    if again:
        found.append(again.start())
    return min(found) if found else None


def _name_between(data: bytes, start: int, end: int, last: bool) -> str:
    """A body's name, from the strings its properties have: the first or last name-like one between start and end."""
    names = [text.strip() for _, text in _strings(data, start, end) if text.strip() and not _ID.search(text)]
    return (names[-1] if last else names[0])[:255] if names else ""


def _mesh(data: bytes, shape: _Shape, end: int, first_face: int | None) -> list[MeshBody]:
    """A shape's bodies for Caliper's mesh: their faces' triangles in mm, their names, and their colors."""
    stops = [body.start for body in shape.bodies[1:]] + [end]  # where what comes after each body starts
    properties = [_properties(data, body.faces[-1].end, stop) for body, stop in zip(shape.bodies, stops, strict=True)]
    owns: list[list[_Own]] = []
    for body, after in zip(shape.bodies, properties, strict=True):
        # A face's own appearance is in its record, which ends at the next face's tag, or for a body's last face, 20
        # bytes before the body's properties: if they aren't found, nor is that face's appearance.
        ends = [face.start - 2 for face in body.faces[1:]] + [after - 20 if after is not None else None]
        mine = []
        for face, record_end in zip(body.faces, ends, strict=True):
            own = _own(data, face, record_end) if record_end is not None else None
            mine.append(own if own is not None else _Own("none", 0, None, face.end))
        owns.append(mine)
    # Every face says what appearance it has of its own (SolidWorks 2015 to 2017, and some later files), or none
    # gets a color of its own.
    found = all(
        own.end > face.end
        for body, mine in zip(shape.bodies, owns, strict=True)
        for face, own in zip(body.faces, mine, strict=True)
    )
    face_colors = (
        _face_colors(shape.bodies, owns, first_face) if found else [[None] * len(b.faces) for b in shape.bodies]
    )
    # The part's own appearance comes after its last body's properties.
    after = properties[-1] if properties[-1] is not None else owns[-1][-1].end
    part = _next_appearance(data, after, min(end, after + 65536))
    look = part[0] if part else _Look(DEFAULT_COLOR, 1)
    bodies = []
    for i, body in enumerate(shape.bodies):
        faces = []
        for face, color in zip(body.faces, face_colors[i], strict=True):
            positions, triangles = _triangles(face)
            faces.append(MeshFace(positions, triangles, color))
        if i + 1 < len(shape.bodies):  # its name is the last string before the next body
            name = _name_between(data, properties[i] or owns[i][-1].end, stops[i], last=True)
        elif properties[i] is not None:  # the first after its properties, before the part's appearance
            name = _name_between(data, properties[i], part[1] if part else min(end, properties[i] + 512), last=False)
        else:
            name = ""
        bodies.append(MeshBody(name=name or f"Body {i + 1}", color=look.color, opacity=look.opacity, faces=faces))
    return bodies


# --- parts ---------------------------------------------------------------------------------------


def _configurations(xml: ElementTree.Element | None) -> list[ElementTree.Element]:
    return list(xml.iter(f"{_NS}swConfiguration")) if xml is not None else []


def _active(configurations: list[ElementTree.Element]) -> ElementTree.Element | None:
    """The configuration SolidWorks had open when it saved the file, or else the first."""
    return next(
        (c for c in configurations if c.get("swMostRecentConfiguration") == "YES"),
        configurations[0] if configurations else None,
    )


def _not_saved(name: str, kind: Literal["part", "assembly"], marked: bool = True) -> NotSaved:
    """Why a configuration has no shape here to read, and how to have SolidWorks keep it: marked as needing a rebuild,
    or else with no solid at all."""
    if not marked:
        why = f"SolidWorks kept no solid of its {name} configuration in it"
    elif kind == "part":
        why = (
            f"SolidWorks marked its {name} configuration as needing a rebuild when it saved it, as it does one not "
            "shown since the part last changed, so it kept no shape of it that's up to date"
        )
    else:
        why = (
            f"SolidWorks marked its {name} configuration as needing a rebuild when it saved it, as it does one not "
            "shown since the assembly last changed, so where its components are may be old"
        )
    return NotSaved(
        f"{why}. To see it here, check the {kind} out in SolidWorks, show {name} (or right-click it in the "
        "ConfigurationManager and click Add Rebuild/Save Mark, so every save keeps it), save, and check it in"
    )


def _asked(
    configurations: list[ElementTree.Element], name: str, kind: Literal["part", "assembly"]
) -> ElementTree.Element:
    """The configuration of that name, if the file keeps its shape: one that was up to date when it was saved, or the
    one SolidWorks had open. Refused otherwise: NotSaved, or NoConfiguration."""
    chosen = next((c for c in configurations if c.get("swName") == name), None)
    if chosen is None:
        raise NoConfiguration(f"It has no configuration named {name}")
    if chosen is not _active(configurations) and chosen.get("swConfigurationNeedsUpdate") == "YES":
        raise _not_saved(name, kind)
    return chosen


def read_configurations(data: bytes, kind: Literal["part", "assembly"]) -> list[Configuration]:
    """A part's or assembly's configurations, as its XML lists them: which SolidWorks had open when it saved the file,
    and which were up to date then, so the file keeps their shapes. Unreadable where it lists none."""
    return _strict(lambda d: _read_configurations(d, kind), data)


def _read_configurations(data: bytes, kind: Literal["part", "assembly"]) -> list[Configuration]:
    stream = _FEATURES if kind == "part" else _TREE
    listed = _configurations(_xml(_found(data, {stream}).get(stream)))
    if not listed:
        raise Unreadable(f"It isn't a SolidWorks {kind} whose configurations Caliper can read")
    active = _active(listed)
    out: list[Configuration] = []
    for c in listed:
        name = c.get("swName") or ""
        if name and all(name != other.name for other in out):
            saved = c is active or c.get("swConfigurationNeedsUpdate") != "YES"
            out.append(Configuration(name=name[:255], active=c is active, saved=saved))
    return out


def _part_configuration(features: ElementTree.Element | None, tail: list[str]) -> str:
    """The configuration a part's display list is of: named after its bodies (SolidWorks 2018 on), else the one
    SolidWorks had open last."""
    names = [c.get("swName") or "" for c in (features.iter(f"{_NS}swConfiguration") if features is not None else [])]
    for text in tail:
        if text in names and text:
            return text
    recent = [
        c.get("swName") or ""
        for c in (features.iter(f"{_NS}swConfiguration") if features is not None else [])
        if c.get("swMostRecentConfiguration") == "YES"
    ]
    return next((name for name in recent + names if name), "Default")


def _strict[T](read: Callable[[bytes], T], data: bytes) -> T:
    """Read a file, refusing it (Unreadable) wherever it doesn't fit what's expected, however it doesn't."""
    try:
        return read(data)
    except (struct.error, IndexError, ValueError, OverflowError, zlib.error) as e:
        raise Unreadable(_ODD) from e


def read_part(data: bytes, configuration: str | None = None) -> Part:
    """A part's 3D view, as SolidWorks saved it: its bodies, in its own coordinates, in the configuration SolidWorks had
    open when it saved the file. Or in another configuration, read from the solid SolidWorks kept of it, as it does of
    each one up to date then: one that wasn't is refused (NotSaved), as is a name the file has none of
    (NoConfiguration)."""
    return _strict(lambda d: _read_part(d, configuration), data)


def read_assembly(data: bytes, configuration: str | None = None) -> list[Assembly]:
    """An assembly's 3D views, as SolidWorks saved them: in each configuration, its components, with each part's shape
    as the assembly shows it. Components SolidWorks suppressed are left out. The configuration SolidWorks had open
    comes first; then each other one whose places are up to date (one SolidWorks says needs rebuilding isn't). A
    configuration asked for is among them, or it's refused: NotSaved, or NoConfiguration."""
    return _strict(lambda d: _read_assembly(d, configuration), data)


def _read_part(data: bytes, configuration: str | None) -> Part:
    found = _open(data, "part")
    chosen = None
    if configuration is not None:
        listed = _configurations(_xml(found.get(_FEATURES)))
        if listed:
            chosen = _asked(listed, configuration, "part")
            if chosen is not _active(listed):
                return _solid(data, found, None, chosen)
    display = found.get(_DISPLAY)
    if display is None:
        part = _solid(data, found, None)
    else:
        try:
            part = _viewed(found, display)
        except (Unreadable, struct.error, IndexError, ValueError, OverflowError, zlib.error) as e:
            # A 3D view Caliper can't follow: the solid, if it can follow that. Else the 3D view's reason stands.
            refused = e if isinstance(e, Unreadable) else Unreadable(_ODD)
            part = _solid(data, found, refused)
    if configuration is not None and part.configuration != configuration:
        # The display list names another configuration than the one SolidWorks says it had open: that one's solid.
        if chosen is None:
            raise NoConfiguration(f"It has no configuration named {configuration}")
        return _solid(data, found, None, chosen)
    return part


def _viewed(found: dict[str, bytes], display: bytes) -> Part:
    """A part read from its display list."""
    faces = _faces(display)
    shapes = _shapes(display, faces)
    if not shapes:
        # Faces it can't find, in a view that has them, are a layout it doesn't know: not an empty view.
        raise Unreadable(_ODD if _FACE in display else _NO_VIEW)
    if len(shapes) > 1:
        raise Unreadable(_ODD)
    shape = shapes[0]
    # A part file's first face comes just after its class, which has the number its later faces' tags carry.
    numbers = {_u16(display, face.start - 2) & 0x7FFF for face in faces[1:]}
    first_face = next(iter(numbers)) + 1 if len(numbers) == 1 else None
    bodies = _mesh(display, shape, len(display), first_face)
    tail = [text for _, text in _strings(display, faces[-1].end, len(display))]
    configuration = _part_configuration(_xml(found.get(_FEATURES)), tail)
    return Part(configuration=configuration, units=_units(found.get(_INFO)), bodies=bodies, source="view")


# --- parts' solids --------------------------------------------------------------------------------

# The classes in the features of parts that are an import and nothing else (in the team's library: vendors' fittings,
# 80/20 extrusions): the import itself, and what changes no body. Any other is a feature that may make or change one.
_IMPORTS = {"moBaseBody_c", "moMBimport_c"}
_QUIET = _IMPORTS | {
    "mbBodyImportIDMaps_c", "moCStringHandle_c", "moCommentsFolder_c", "moCompEdge_c", "moCompFace_c",
    "moCompFeature_c", "moCompRefAxis_c", "moCompRefPlane_c", "moCompSketchEntHandle_c", "moConnectionPoint_c",
    "moCurveFtrFolder_c", "moDefaultRefPlnData_c", "moDetailCabinet_c", "moDisplayDistanceDim_c",
    "moDisplayRadialDim_c", "moDocsFolder_c", "moDoubleDim_c", "moEdgeRef_c", "moEqnFolder_c", "moExtObject_c",
    "moFR_c", "moFavoriteFolder_c", "moFavoriteHandle_c", "moFeatGraphicsBodyFolder_c", "moFeatSolidBodyFolder_c",
    "moFeatSurfaceBodyFolder_c", "moFeatureDimHandle_c", "moFtrFolder_c", "moHistoryFeatItemData_c",
    "moHistoryFolder_c", "moInkMarkupFolder_c", "moLengthParameter_c", "moLineAxisData_c", "moLineBackedUpData_c",
    "moLineRef_w", "moMaterialFolder_c", "moNodeName_c", "moNotesAreaFtrFolder_c", "moOriginProfileFeature_c",
    "moPMarkRecord_c", "moPointBackedUpData_c", "moPointRef_w", "moProfileFeature_c", "moProfileFtrFolder_c",
    "moRefAxisFtrFolder_c", "moRefAxis_c", "moRefPlaneFtrFolder_c", "moRefPlane_c", "moRoutePoint_c",
    "moScalerParameter_c", "moSelectionSetFolder_c", "moSensorFolder_c", "moSimpleSurfIdRep_c", "moSketchExtRef_w",
    "moSolidBodyFolder_c", "moSurfaceBodyFolder_c", "moUnitComponent_c", "sgExtEnt_c", "sgLineHandle",
    "sgPntPntDist", "sgPointHandle", "sgSketch", "ThreeDRadialOrDiameterDim_c",
}  # fmt: skip
_CLASS = re.compile(rb"\xff\xff[\x00-\xff]{2}([\x01-\x40])\x00", re.DOTALL)


def _classes(archive: bytes) -> set[str]:
    """The classes an MFC archive names (each new one: 0xFFFF, a uint16 schema, a uint16 length, the name)."""
    names = set()
    for found in _CLASS.finditer(archive):
        name = archive[found.end() : found.end() + found.group(1)[0]]
        if re.fullmatch(rb"[A-Za-z_][A-Za-z0-9_]*", name):
            names.add(name.decode())
    return names


def _only_imported(resolved: bytes | None) -> bool:
    """Whether a part is an import and nothing else, by its features' classes."""
    names = _classes(resolved or b"")
    return bool(names & _IMPORTS) and names <= _QUIET


def _bodies(stream: bytes | None) -> list[brep.Solid]:
    """The solids in one of SolidWorks' streams of them: each transmit file's bodies (a partition's deltas, its undo,
    left out)."""
    out = []
    for transmit in parasolid.transmit_files(stream or b""):
        if "(deltas)" not in parasolid.header(transmit):
            out += brep.solids(parasolid.read(transmit)[1])
    return out


def _solid(
    data: bytes, found: dict[str, bytes], refused: Unreadable | None, chosen: ElementTree.Element | None = None
) -> Part:
    """A part read from its solid: in the configuration SolidWorks had open, when its display list is missing, or
    refused; or in another one (chosen), which has none. Where that can't be read either, the display list's reason
    for refusing it stands; or why the solid can't be read; or that there's no 3D view."""
    active = chosen
    if chosen is None:
        active = next(
            (c for c in _configurations(_xml(found.get(_FEATURES))) if c.get("swMostRecentConfiguration") == "YES"),
            None,
        )
    number = active.get("swID") if active is not None else None
    if chosen is not None and not (number and number.isdigit()):
        raise Unreadable(_ODD)  # where its solid is kept isn't known
    number = number if number and number.isdigit() else "0"
    configuration = (active.get("swName") if active is not None else None) or "Default"
    names = (_PARTITION.format(number), _LOCAL.format(number), _RESOLVED.format(number), _CONFIGURATION.format(number))
    streams = _found(data, set(names))
    if not found and not streams:
        raise refused or Unreadable("It isn't a SolidWorks part that Caliper can read")
    if chosen is not None and names[0] not in streams and names[1] not in streams:
        raise _not_saved(configuration, "part", marked=False)
    try:
        solids = _bodies(streams.get(names[0]))
        if not any(s.faces for s in solids) and _only_imported(streams.get(names[2])):
            solids = _bodies(streams.get(names[1]))
    except parasolid.XtError as e:
        if chosen is not None:
            raise Unreadable(
                f"Caliper can't follow the solid SolidWorks kept of its {configuration} configuration ({e}). Make its "
                f"3D view in SolidWorks instead: check it out, show {configuration}, save, and check it in"
            ) from e
        raise refused or Unreadable(
            f"SolidWorks saved no 3D view in it, and Caliper can't follow its solid ({e}). Make its 3D view in "
            "SolidWorks instead (Make 3D view, on the Vault tab)"
        ) from e
    solids = [s for s in solids if s.faces]
    if not solids:
        if chosen is not None:
            raise Unreadable(f"SolidWorks kept no bodies of its {configuration} configuration: it may be empty")
        raise refused or Unreadable(_NO_VIEW)
    bodies = _meshed(solids, _configuration_look(streams.get(names[3])))
    return Part(configuration=configuration, units=_units(found.get(_INFO)), bodies=bodies, source="solid")


def _configuration_look(stream: bytes | None) -> _Look | None:
    """The appearance a configuration keeps, where it keeps just one: the part's. Where it keeps more (its faces' or
    features' too), which is the part's isn't known. An appearance's first string is empty, which tells them from the
    units' and fonts' tables there that can look like one."""
    found: list[_Look] = []
    at = 0
    while stream and (next_one := _next_appearance(stream, at, len(stream))) is not None:
        look, tag = next_one
        start = tag + 6 + len(_APPEARANCE) if stream[tag : tag + 2] == b"\xff\xff" else tag + 2
        first = _string(stream, start + 12)
        if first is not None and first[0] == "":
            found.append(look)
        at = tag + 1
    return found[0] if len(found) == 1 else None


def _meshed(solids: list[brep.Solid], look: _Look | None = None) -> list[MeshBody]:
    """Solids as Caliper's mesh bodies, in mm: each body the part's appearance (look), where it's known, or else the
    color most of its faces have (SolidWorks' default if none); and faces of a color other than most of their body's,
    their own."""
    out = []
    for i, solid in enumerate(solids):
        colors = [face.color for face in solid.faces if face.color is not None]
        most = max(set(colors), key=colors.count) if colors else DEFAULT_COLOR
        faces = []
        for face in solid.faces:
            positions = array("f", (c * 1000 for p in face.positions for c in p))
            triangles = array("I", (k for t in face.triangles for k in t))
            faces.append(MeshFace(positions, triangles, face.color if face.color not in (None, most) else None))
        name = "Body" if len(solids) == 1 else f"Body {i + 1}"
        color, opacity = (look.color, look.opacity) if look is not None else (most, 1.0)
        out.append(MeshBody(name=name, color=color, opacity=opacity, faces=faces, solid=solid.solid))
    return out


# --- assemblies ----------------------------------------------------------------------------------


@dataclass
class _Node:
    """A component's node in an assembly's display list."""

    start: int
    name: str  # "Bracket-1@Rocket"
    transform: list[float]  # rows, mm
    configuration: str
    path: str


def _rows(numbers: tuple[float, ...] | list[float]) -> list[float]:
    """SolidWorks' transform (a rotation by columns, a translation in meters, a scale) as Caliper's rows, in mm."""
    scale = numbers[12] or 1
    rows = []
    for i in range(3):
        rows += [numbers[3 * j + i] * scale for j in range(3)] + [numbers[9 + i] * 1000]
    return rows


def _rigid(rows: list[float]) -> bool:
    """A turn and a move, which is all an assembly does to its components."""
    columns = [[rows[4 * i + j] for i in range(3)] for j in range(3)]
    for j in range(3):
        for k in range(3):
            dot = sum(columns[j][i] * columns[k][i] for i in range(3))
            if abs(dot - (1 if j == k else 0)) > 1e-6:
                return False
    return all(abs(v) < 1e9 for v in rows)


def _nodes(data: bytes) -> list[_Node]:
    """The display list's nodes: a name with an @; its place, which is a byte that says whether it's turned, then
    SolidWorks' 13 numbers for a turn and a move if it is, or just a move and a scale (4) if it isn't; a byte, 10 more
    numbers, then the configuration, the part's name, and its path."""
    found = []
    for at, name in _strings(data, 0, len(data)):
        read = _string(data, at)
        if "@" not in name or read is None or read[1] >= len(data):
            continue
        turned, place = data[read[1]], read[1] + 1
        if turned not in (0, 1):
            continue
        length = 104 if turned else 32
        if place + length + 1 + 80 > len(data):
            continue
        if turned:
            rows = _rows(struct.unpack_from("<13d", data, place))
        else:
            x, y, z, scale = struct.unpack_from("<4d", data, place)
            rows = _rows((1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z, scale))
        if not _rigid(rows):
            continue
        texts = [text for _, text in _strings(data, place + length + 1 + 80, min(len(data), place + 4096))][:6]
        path = next((t for t in texts if t.lower().endswith((".sldprt", ".sldasm"))), None)
        if not texts or path is None:
            continue
        found.append(_Node(at, name, rows, texts[0], path))
    return found


def compose(parent: list[float], child: list[float]) -> list[float]:
    """Where a component of a sub-assembly is in the top assembly: the sub-assembly's place, then the component's."""
    rows = []
    for i in range(3):
        for j in range(4):
            value = sum(parent[4 * i + k] * child[4 * k + j] for k in range(3))
            rows.append(value + (parent[4 * i + 3] if j == 3 else 0))
    return rows


def _xml_rows(text: str) -> list[float]:
    """swTransform: a 4 x 4 matrix in meters, by rows, that points multiply from the left."""
    try:
        numbers = [float(v) for v in text.split()]
    except ValueError as e:
        raise Unreadable(f"A component's place isn't numbers: {text[:80]}") from e
    if len(numbers) != 16:
        raise Unreadable(f"A component's place has {len(numbers)} numbers, not 16")
    rows = []
    for i in range(3):
        rows += [numbers[4 * j + i] for j in range(3)] + [numbers[12 + i] * 1000]
    if not _rigid(rows):
        raise Unreadable("A component's place isn't a turn and a move")
    return rows


def _key(path: str, configuration: str) -> tuple[str, str]:
    return unicodedata.normalize("NFC", path.replace("/", "\\")).casefold(), configuration


def _same_place(a: list[float], b: list[float]) -> bool:
    return all(abs(x - y) <= (1e-3 if i % 4 == 3 else 1e-6) for i, (x, y) in enumerate(zip(a, b, strict=True)))


def _drawn(component: Component) -> bool:
    """Whether the display list draws any of a component."""
    return component.shape is not None or any(_drawn(child) for child in component.children)


def _kept_names(ref: ElementTree.Element, assembly: bool) -> list[str]:
    """The streams a file may keep a virtual component's own file in."""
    base = (ref.get("swName") or "").split("^", 1)[0]
    return [f"VirtualComp/{base}", f"VirtualComp/{base}-{'sldasm' if assembly else 'sldprt'}"]


def _kept_part(data: bytes) -> list[MeshBody] | None:
    """A virtual part's bodies, from its solid; none where they can't be read (the part shows nothing, and says why)."""
    try:
        return _solid(data, _open(data, "part"), None).bodies
    except (Unreadable, struct.error, IndexError, ValueError, OverflowError, zlib.error):
        return None


def _read_assembly(data: bytes, configuration: str | None) -> list[Assembly]:
    found = _open(data, "assembly")
    tree = _xml(found.get(_TREE))
    if tree is None:
        raise Unreadable(_ODD)
    files = {f.get("id"): f for f in tree.iter(f"{_NS}swFile")}
    models = {m.get("id"): m for m in tree.iter(f"{_NS}swModel")}
    configurations = _configurations(tree)
    active = _active(configurations)
    if active is None:
        raise Unreadable(_ODD)
    if configuration is not None:
        _asked(configurations, configuration, "assembly")  # before the work of reading the rest
    top = models.get(active.get("swModelRef"))
    if top is None:
        raise Unreadable(_ODD)

    display = found.get(_DISPLAY, b"")  # none: no shapes or places of SolidWorks' own, only the XML's
    faces = _faces(display)
    shapes = _shapes(display, faces)
    nodes = _nodes(display)
    # Each part's shape, by its file and configuration: the faces after its node, up to the next node.
    shape_of: dict[tuple[str, str], list[MeshBody]] = {}
    place_of: dict[str, list[list[float]]] = {}  # SolidWorks' places of components, by "Name-1@Assembly"
    starts = [node.start for node in nodes] + [len(display)]
    for i, node in enumerate(nodes):
        place_of.setdefault(node.name.casefold(), []).append(node.transform)
        mine = [s for s in shapes if starts[i] < s.start < starts[i + 1]]
        if len(mine) > 1:
            raise Unreadable(_ODD)
        if mine and _key(node.path, node.configuration) not in shape_of:
            shape_of[_key(node.path, node.configuration)] = _mesh(display, mine[0], starts[i + 1], None)
    # A shape after no node of its own (a node without its name, say) is nobody's that Caliper can tell: it isn't used,
    # and its part shows its own file's shape, as parts of assemblies without a display list do.
    # The display list can be older than the XML: where it puts a component of the top assembly somewhere else, the
    # XML is right (placed by it, the parts fill the box SolidWorks keeps for the assembly), and the display list's
    # shapes, from the same old moment, aren't used either. The parts show their own files' shapes.
    for ref in top.findall(f"{_NS}swReference"):
        name = f"{ref.get('swName') or ''}-{ref.get('swReferenceNumber') or '1'}@{top.get('swName') or ''}"
        seen = place_of.get(name.casefold(), [])
        moved = seen and not any(_same_place(_xml_rows(ref.get("swTransform") or ""), s) for s in seen)
        if ref.get("swSuppressed") != "YES" and moved:
            shape_of.clear()
            break

    # Virtual components' files, by the file that keeps them (the assembly's, or a virtual sub-assembly's) and their
    # streams' names; and virtual parts' bodies, by their files: each read once, however many configurations use it.
    kept: dict[int, dict[str, bytes | None]] = {}
    kept_bodies: dict[int, list[MeshBody] | None] = {}

    def components(
        model: ElementTree.Element, place: list[float] | None, depth: int, keeper: bytes | None, imported: bool = False
    ) -> list[Component]:
        if depth > 32:
            raise Unreadable("Its components nest more than 32 deep")
        refs = []
        for ref in model.findall(f"{_NS}swReference"):
            if ref.get("swSuppressed") == "YES":
                continue
            used = models.get(ref.get("swModelRef"))
            file = files.get(used.get("swFileRef")) if used is not None else None
            if used is None or file is None:
                raise Unreadable(_ODD)
            assembly, virtual = file.get("swDocType") == "ASSEMBLY", ref.get("swIsVirtualComponent") == "YES"
            refs.append((ref, used, file, assembly, virtual))
        streams: dict[str, bytes | None] = {}
        if keeper is not None:
            streams = kept.setdefault(id(keeper), {})
            wanted = {name for ref, _, _, assembly, virtual in refs if virtual for name in _kept_names(ref, assembly)}
            if missing := wanted - streams.keys():
                got = _found(keeper, missing)
                streams.update((name, got.get(name)) for name in missing)
        out = []
        for ref, used, file, assembly, virtual in refs:
            name = f"{ref.get('swName') or ''}-{ref.get('swReferenceNumber') or '1'}"
            own = _xml_rows(ref.get("swTransform") or "")
            rows = own if place is None else compose(place, own)
            path = file.get("swPath") or ""
            configuration = used.get("swConfigurationName") or ref.get("swConfigurationName") or ""
            inside = next((f for n in _kept_names(ref, assembly) if (f := streams.get(n))), None) if virtual else None
            shape = None
            if virtual and inside is not None and not assembly:
                if id(inside) not in kept_bodies:
                    kept_bodies[id(inside)] = _kept_part(inside)
                shape = kept_bodies[id(inside)]
            elif not virtual and not assembly:
                shape = shape_of.get(_key(path, configuration))
            # A STEP file (or another CAD file) placed with 3D Interconnect is kept as the document SolidWorks made of
            # it, in its temporary folder (...\IC~~\Board.step.SLDASM, never on disk), and the path of the file it was
            # made from. That file is the component, read whole as it is on its own, where the display list doesn't draw
            # it: the documents made of its parts (each keeping the same path) are in it.
            source = None if imported else file.get("swImportedPath")
            component = Component(
                name=name,
                path=path,
                configuration=configuration,
                transform=rows,
                hidden=ref.get("swHidden") == "YES",
                virtual=virtual,
                shape=shape,
                children=(
                    components(used, rows, depth + 1, inside if virtual else None, imported or bool(source))
                    if assembly
                    else []
                ),
            )
            if source and not _drawn(component):
                component = replace(component, path=source, children=[])
            out.append(component)
        return out

    units = _units(found.get(_INFO))
    top_components = components(top, None, 1, data)
    made = [Assembly(configuration=active.get("swName") or "Default", units=units, components=top_components)]
    for other in configurations:
        model = models.get(other.get("swModelRef"))
        name = other.get("swName") or ""
        if other is active or model is None or not name or other.get("swConfigurationNeedsUpdate") == "YES":
            continue
        if name not in (assembly.configuration for assembly in made):
            made.append(Assembly(configuration=name, units=units, components=components(model, None, 1, data)))
    if configuration is not None and all(assembly.configuration != configuration for assembly in made):
        raise Unreadable(_ODD)  # listed, and up to date, but with no components of its own in the XML
    return made


# --- drawings ------------------------------------------------------------------------------------

_SHEET_NAMES = "SheetPreviews/SheetNames"
_SHEET_PICTURE = "Images/Sheet_{}"
_PREVIEW = "PreviewPNG"
_PNG = b"\x89PNG\r\n\x1a\n"
MAX_SHEETS = 100  # a drawing has a handful of sheets: Caliper shows this many at most


@dataclass
class Sheet:
    name: str  # SolidWorks' name for it ("Sheet1"), or "" where the file doesn't say
    picture: bytes | None  # the picture of it SolidWorks saved (a PNG), or None where it saved none


def read_sheets(data: bytes) -> list[Sheet]:
    """A drawing's sheets, in order, each with the picture of it SolidWorks saved in the file: 640 x 480, to see what's
    on it, not to read it. A drawing that keeps no pictures of its sheets has one sheet here, its file's preview (the
    sheet SolidWorks had open). Unreadable where there's neither, or the file doesn't read as SolidWorks' do."""
    try:
        return _read_sheets(data)
    except (struct.error, IndexError, ValueError, OverflowError, zlib.error) as e:
        raise Unreadable("Caliper can't make sense of the pictures of its sheets SolidWorks saved in it") from e


def _read_sheets(data: bytes) -> list[Sheet]:
    pictures = [_SHEET_PICTURE.format(n) for n in range(MAX_SHEETS)]
    found = _found(data, {_SHEET_NAMES, _PREVIEW, *pictures})
    names = _sheet_names(found.get(_SHEET_NAMES)) or []
    count = max(len(names), max((n + 1 for n, name in enumerate(pictures) if name in found), default=0))
    sheets = [Sheet(names[n] if n < len(names) else "", _png(found.get(pictures[n]))) for n in range(count)]
    if not any(sheet.picture for sheet in sheets) and (preview := _png(found.get(_PREVIEW))) is not None:
        return [Sheet(names[0] if len(names) == 1 else "", preview)]
    if not sheets:
        raise Unreadable("It isn't a SolidWorks drawing with pictures of its sheets that Caliper can read")
    return sheets


def _sheet_names(stream: bytes | None) -> list[str] | None:
    """The sheets' names (SheetPreviews/SheetNames), or None where they don't read as expected: they're only names, so
    the sheets are numbered instead. Each name's four bytes are skipped unless another name follows at once, so
    the names read as well if those bytes come once, after the last."""
    if stream is None or len(stream) < 2:
        return None
    count, at, names = _u16(stream, 0), 2, []
    for _ in range(min(count, MAX_SHEETS)):
        found = _string(stream, at)
        if found is None:
            return None
        name, at = found
        names.append(name)
        if stream[at : at + 3] != _STRING:
            at += 4
    return names if at <= len(stream) else None


def _png(contents: bytes | None) -> bytes | None:
    return contents if contents is not None and contents.startswith(_PNG) else None
