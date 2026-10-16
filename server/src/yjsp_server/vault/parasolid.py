"""Parasolid transmit files: the solids SolidWorks keeps in each part, which Caliper turns into triangles (brep.py)
where a part has no 3D view of its own to read (docs/vault.md, "Caliper").

Parasolid is the geometry kernel SolidWorks is built on, and its file format is published: the "Parasolid XT Format
Reference" (UGS, October 2006). SolidWorks keeps a part's bodies, as its configuration N last built them, in
Contents/Config-N-Partition (N is the configuration's swID), and the bodies its imported features brought in, in
Config-N-FeatureBodies/LocalBodies. Each stream packs transmit files: a uint32, the length of what follows; the 16
bytes OLE files' packed streams start with; then chunks, each a uint32 size, a uint32 packed size, and zlib, until a
size of 0 or the end. A partition is followed by its deltas (Parasolid's undo), which Caliper has no use for.

A transmit file is in Parasolid's "neutral binary": big-endian; "PS\\0\\0"; the modeller's version (a uint16 length,
then ": TRANSMIT FILE (partition) created by modeller version 3401247"); the schema's name (a uint32 length, then
"SCH_3401247_34101_13006"); the most node types there are (a uint16); and the size of user fields (a uint32, 0 here).
Then the nodes, each: its type (an int16); on a type's first node, how its fields differ from the base schema's
(below); its length, an int32, if its last field varies in length; its index, as pointers are written; its fields. A
node of type 1 ends the file. Pointers are indices, 0 for none: up to 32766 an int16, the index plus 1; beyond, two,
-(index % 32767 + 1) and then index / 32767.

Files from Parasolid 14 on name a base schema, 13006, and carry their own schema as edits of it: on each type's first
node, 0xFF where its fields are the base's; for a type the base lacks, its fields in full (their count, the type's
name and description, then each field); else the count of its fields and an edit of the base's, one letter at a
time: C copies the next base field, D drops it, I inserts a field and A appends one, and Z ends (base fields left over
once the type's own fields run out are dropped). A field: its name (a byte length, then text), its class (an int16,
not 0 for a pointer), its count (written as an index is: 0 for one value, 1 for the node's length, n for an array of
n), its type (a byte length, then text) unless it's a pointer, and, where its count is 1, one more byte. Types: u, c,
l a byte; n, w an int16; d, t an int32; f a double; i 2, v and h 3 (an hvec's position), b 6 doubles; p a pointer.

The base schema below is the reference's, with two corrections the files show: BODY has nom_geom_state (a byte)
after body_type, as the reference's table of BODY's fields has, though not its listing of them; and node type 163 is
HELIX_SU_FORM and 184 HELIX_CU_FORM, the other way round from the reference's table of node types. Files whose schema
isn't written as edits of 13006 (Parasolid 13 and older, and some files SolidWorks 2010 left) are refused: their
fields are their version's, which Caliper doesn't have.
"""

import struct
import zlib
from dataclasses import dataclass, field
from typing import Any

PACKED = bytes.fromhex("231dd571da8148a2a85898b21b89ef99")  # what a packed stream starts with
MAX_SIZE = 1 << 29  # a stream unpacks to at most this
MAX_NODES = 3_000_000


class XtError(ValueError):
    """A transmit file Caliper can't read, and why."""


_COMMON_CURVE = (("node_id", "d", 0), ("attributes_groups", "p", 0), ("owner", "p", 0), ("next", "p", 0),
                 ("previous", "p", 0), ("geometric_owner", "p", 0), ("sense", "c", 0))  # fmt: skip
_COMMON_SURFACE = _COMMON_CURVE

# The base schema, SCH_13006: each node type's name and fields, as (name, type, count): count 0 is one value, 1 as
# many as the node's length (its last field), and more an array of that many.
_BASE: dict[int, tuple[str, tuple[tuple[str, str, int], ...]]] = {
    10: ("ASSEMBLY", (("highest_node_id", "d", 0), ("attributes_groups", "p", 0), ("attribute_chains", "p", 0),
                      ("list", "p", 0), ("surface", "p", 0), ("curve", "p", 0), ("point", "p", 0), ("key", "p", 0),
                      ("res_size", "f", 0), ("res_linear", "f", 0), ("ref_instance", "p", 0), ("next", "p", 0),
                      ("previous", "p", 0), ("state", "u", 0), ("owner", "p", 0), ("type", "u", 0),
                      ("sub_instance", "p", 0))),
    11: ("INSTANCE", (("node_id", "d", 0), ("attributes_groups", "p", 0), ("type", "u", 0), ("part", "p", 0),
                      ("transform", "p", 0), ("assembly", "p", 0), ("next_in_part", "p", 0), ("prev_in_part", "p", 0),
                      ("next_of_part", "p", 0), ("prev_of_part", "p", 0))),
    12: ("BODY", (("highest_node_id", "d", 0), ("attributes_groups", "p", 0), ("attribute_chains", "p", 0),
                  ("surface", "p", 0), ("curve", "p", 0), ("point", "p", 0), ("key", "p", 0), ("res_size", "f", 0),
                  ("res_linear", "f", 0), ("ref_instance", "p", 0), ("next", "p", 0), ("previous", "p", 0),
                  ("state", "u", 0), ("owner", "p", 0), ("body_type", "u", 0), ("nom_geom_state", "u", 0),
                  ("shell", "p", 0), ("boundary_surface", "p", 0), ("boundary_curve", "p", 0),
                  ("boundary_point", "p", 0), ("region", "p", 0), ("edge", "p", 0), ("vertex", "p", 0))),
    13: ("SHELL", (("node_id", "d", 0), ("attributes_groups", "p", 0), ("body", "p", 0), ("next", "p", 0),
                   ("face", "p", 0), ("edge", "p", 0), ("vertex", "p", 0), ("region", "p", 0),
                   ("front_face", "p", 0))),
    14: ("FACE", (("node_id", "d", 0), ("attributes_groups", "p", 0), ("tolerance", "f", 0), ("next", "p", 0),
                  ("previous", "p", 0), ("loop", "p", 0), ("shell", "p", 0), ("surface", "p", 0), ("sense", "c", 0),
                  ("next_on_surface", "p", 0), ("previous_on_surface", "p", 0), ("next_front", "p", 0),
                  ("previous_front", "p", 0), ("front_shell", "p", 0))),
    15: ("LOOP", (("node_id", "d", 0), ("attributes_groups", "p", 0), ("fin", "p", 0), ("face", "p", 0),
                  ("next", "p", 0))),
    16: ("EDGE", (("node_id", "d", 0), ("attributes_groups", "p", 0), ("tolerance", "f", 0), ("fin", "p", 0),
                  ("previous", "p", 0), ("next", "p", 0), ("curve", "p", 0), ("next_on_curve", "p", 0),
                  ("previous_on_curve", "p", 0), ("owner", "p", 0))),
    17: ("FIN", (("attributes_groups", "p", 0), ("loop", "p", 0), ("forward", "p", 0), ("backward", "p", 0),
                 ("vertex", "p", 0), ("other", "p", 0), ("edge", "p", 0), ("curve", "p", 0), ("next_at_vx", "p", 0),
                 ("sense", "c", 0))),
    18: ("VERTEX", (("node_id", "d", 0), ("attributes_groups", "p", 0), ("fin", "p", 0), ("previous", "p", 0),
                    ("next", "p", 0), ("point", "p", 0), ("tolerance", "f", 0), ("owner", "p", 0))),
    19: ("REGION", (("node_id", "d", 0), ("attributes_groups", "p", 0), ("body", "p", 0), ("next", "p", 0),
                    ("previous", "p", 0), ("shell", "p", 0), ("type", "c", 0))),
    29: ("POINT", (("node_id", "d", 0), ("attributes_groups", "p", 0), ("owner", "p", 0), ("next", "p", 0),
                   ("previous", "p", 0), ("pvec", "v", 0))),
    30: ("LINE", _COMMON_CURVE + (("pvec", "v", 0), ("direction", "v", 0))),
    31: ("CIRCLE", _COMMON_CURVE + (("centre", "v", 0), ("normal", "v", 0), ("x_axis", "v", 0), ("radius", "f", 0))),
    32: ("ELLIPSE", _COMMON_CURVE + (("centre", "v", 0), ("normal", "v", 0), ("x_axis", "v", 0),
                                    ("major_radius", "f", 0), ("minor_radius", "f", 0))),
    38: ("INTERSECTION", _COMMON_CURVE + (("surface", "p", 2), ("chart", "p", 0), ("start", "p", 0), ("end", "p", 0))),
    40: ("CHART", (("base_parameter", "f", 0), ("base_scale", "f", 0), ("chart_count", "d", 0),
                   ("chordal_error", "f", 0), ("angular_error", "f", 0), ("parameter_error", "f", 2),
                   ("hvec", "h", 1))),
    41: ("LIMIT", (("type", "c", 0), ("hvec", "h", 1))),
    45: ("BSPLINE_VERTICES", (("vertices", "f", 1),)),
    50: ("PLANE", _COMMON_SURFACE + (("pvec", "v", 0), ("normal", "v", 0), ("x_axis", "v", 0))),
    51: ("CYLINDER", _COMMON_SURFACE + (("pvec", "v", 0), ("axis", "v", 0), ("radius", "f", 0), ("x_axis", "v", 0))),
    52: ("CONE", _COMMON_SURFACE + (("pvec", "v", 0), ("axis", "v", 0), ("radius", "f", 0),
                                   ("sin_half_angle", "f", 0), ("cos_half_angle", "f", 0), ("x_axis", "v", 0))),
    53: ("SPHERE", _COMMON_SURFACE + (("centre", "v", 0), ("radius", "f", 0), ("axis", "v", 0), ("x_axis", "v", 0))),
    54: ("TORUS", _COMMON_SURFACE + (("centre", "v", 0), ("axis", "v", 0), ("major_radius", "f", 0),
                                    ("minor_radius", "f", 0), ("x_axis", "v", 0))),
    56: ("BLENDED_EDGE", _COMMON_SURFACE + (("blend_type", "c", 0), ("surface", "p", 2), ("spine", "p", 0),
                                           ("range", "f", 2), ("thumb_weight", "f", 2), ("boundary", "p", 2),
                                           ("start", "p", 0), ("end", "p", 0))),
    59: ("BLEND_BOUND", _COMMON_SURFACE + (("boundary", "n", 0), ("blend", "p", 0))),
    60: ("OFFSET_SURF", _COMMON_SURFACE + (("check", "c", 0), ("true_offset", "l", 0), ("surface", "p", 0),
                                          ("offset", "f", 0), ("scale", "f", 0))),
    67: ("SWEPT_SURF", _COMMON_SURFACE + (("section", "p", 0), ("sweep", "v", 0), ("scale", "f", 0))),
    68: ("SPUN_SURF", _COMMON_SURFACE + (("profile", "p", 0), ("base", "v", 0), ("axis", "v", 0), ("start", "v", 0),
                                        ("end", "v", 0), ("start_param", "f", 0), ("end_param", "f", 0),
                                        ("x_axis", "v", 0), ("scale", "f", 0))),
    70: ("LIST", (("node_id", "d", 0), ("owner", "p", 0), ("next", "p", 0), ("previous", "p", 0),
                  ("list_type", "d", 0), ("list_length", "d", 0), ("block_length", "d", 0), ("size_of_entry", "d", 0),
                  ("list_block", "p", 0), ("finger_block", "p", 0), ("finger_index", "d", 0),
                  ("notransmit", "l", 0))),
    74: ("POINTER_LIS_BLOCK", (("n_entries", "d", 0), ("next_block", "p", 0), ("entries", "p", 1))),
    79: ("ATT_DEF_ID", (("string", "c", 1),)),
    80: ("ATTRIB_DEF", (("next", "p", 0), ("identifier", "p", 0), ("type_id", "d", 0), ("actions", "u", 8),
                        ("field_names", "p", 0), ("legal_owners", "l", 14), ("fields", "u", 1))),
    81: ("ATTRIBUTE", (("node_id", "d", 0), ("definition", "p", 0), ("owner", "p", 0), ("next", "p", 0),
                       ("previous", "p", 0), ("next_of_type", "p", 0), ("previous_of_type", "p", 0),
                       ("fields", "p", 1))),
    82: ("INT_VALUES", (("values", "d", 1),)),
    83: ("REAL_VALUES", (("values", "f", 1),)),
    84: ("CHAR_VALUES", (("values", "c", 1),)),
    85: ("POINT_VALUES", (("values", "v", 1),)),
    86: ("VECTOR_VALUES", (("values", "v", 1),)),
    87: ("AXIS_VALUES", (("values", "v", 1),)),
    88: ("TAG_VALUES", (("values", "t", 1),)),
    89: ("DIRECTION_VALUES", (("values", "v", 1),)),
    90: ("GROUP", (("node_id", "d", 0), ("attributes_groups", "p", 0), ("owner", "p", 0), ("next", "p", 0),
                   ("previous", "p", 0), ("type", "u", 0), ("first_member", "p", 0))),
    91: ("MEMBER_OF_GROUP", (("dummy_node_id", "d", 0), ("owning_group", "p", 0), ("owner", "p", 0),
                             ("next", "p", 0), ("previous", "p", 0), ("next_member", "p", 0),
                             ("previous_member", "p", 0))),
    98: ("UNICODE_VALUES", (("values", "w", 1),)),
    99: ("FIELD_NAMES", (("names", "p", 1),)),
    100: ("TRANSFORM", (("node_id", "d", 0), ("owner", "p", 0), ("next", "p", 0), ("previous", "p", 0),
                        ("rotation_matrix", "f", 9), ("translation_vector", "v", 0), ("scale", "f", 0),
                        ("flag", "d", 0), ("perspective_vector", "v", 0))),
    101: ("WORLD", (("assembly", "p", 0), ("attribute", "p", 0), ("body", "p", 0), ("transform", "p", 0),
                    ("surface", "p", 0), ("curve", "p", 0), ("point", "p", 0), ("alive", "l", 0),
                    ("attrib_def", "p", 0), ("highest_id", "d", 0), ("current_id", "d", 0))),
    102: ("KEY", (("string", "c", 1),)),
    120: ("PE_SURF", _COMMON_SURFACE + (("type", "c", 0), ("data", "p", 0), ("tf", "p", 0),
                                       ("internal_geom", "p", 1))),
    121: ("INT_PE_DATA", (("geom_type", "d", 0), ("real_array", "p", 0), ("int_array", "p", 0))),
    122: ("EXT_PE_DATA", (("key", "p", 0), ("real_array", "p", 0), ("int_array", "p", 0))),
    124: ("B_SURFACE", _COMMON_SURFACE + (("nurbs", "p", 0), ("data", "p", 0))),
    125: ("SURFACE_DATA", (("original_uint", "i", 0), ("original_vint", "i", 0), ("extended_uint", "i", 0),
                          ("extended_vint", "i", 0), ("self_int", "u", 0), ("original_u_start", "c", 0),
                          ("original_u_end", "c", 0), ("original_v_start", "c", 0), ("original_v_end", "c", 0),
                          ("extended_u_start", "c", 0), ("extended_u_end", "c", 0), ("extended_v_start", "c", 0),
                          ("extended_v_end", "c", 0), ("analytic_form_type", "c", 0), ("swept_form_type", "c", 0),
                          ("spun_form_type", "c", 0), ("blend_form_type", "c", 0), ("analytic_form", "p", 0),
                          ("swept_form", "p", 0), ("spun_form", "p", 0), ("blend_form", "p", 0))),
    126: ("NURBS_SURF", (("u_periodic", "l", 0), ("v_periodic", "l", 0), ("u_degree", "n", 0), ("v_degree", "n", 0),
                         ("n_u_vertices", "d", 0), ("n_v_vertices", "d", 0), ("u_knot_type", "u", 0),
                         ("v_knot_type", "u", 0), ("n_u_knots", "d", 0), ("n_v_knots", "d", 0), ("rational", "l", 0),
                         ("u_closed", "l", 0), ("v_closed", "l", 0), ("surface_form", "u", 0),
                         ("vertex_dim", "n", 0), ("bspline_vertices", "p", 0), ("u_knot_mult", "p", 0),
                         ("v_knot_mult", "p", 0), ("u_knots", "p", 0), ("v_knots", "p", 0))),
    127: ("KNOT_MULT", (("mult", "n", 1),)),
    128: ("KNOT_SET", (("knots", "f", 1),)),
    130: ("PE_CURVE", _COMMON_CURVE + (("type", "c", 0), ("data", "p", 0), ("tf", "p", 0),
                                      ("internal_geom", "p", 1))),
    133: ("TRIMMED_CURVE", _COMMON_CURVE + (("basis_curve", "p", 0), ("point_1", "v", 0), ("point_2", "v", 0),
                                           ("parm_1", "f", 0), ("parm_2", "f", 0))),
    134: ("B_CURVE", _COMMON_CURVE + (("nurbs", "p", 0), ("data", "p", 0))),
    135: ("CURVE_DATA", (("self_int", "u", 0), ("analytic_form", "p", 0))),
    136: ("NURBS_CURVE", (("degree", "n", 0), ("n_vertices", "d", 0), ("vertex_dim", "n", 0), ("n_knots", "d", 0),
                          ("knot_type", "u", 0), ("periodic", "l", 0), ("closed", "l", 0), ("rational", "l", 0),
                          ("curve_form", "u", 0), ("bspline_vertices", "p", 0), ("knot_mult", "p", 0),
                          ("knots", "p", 0))),
    137: ("SP_CURVE", _COMMON_CURVE + (("surface", "p", 0), ("b_curve", "p", 0), ("original", "p", 0),
                                      ("tolerance_to_original", "f", 0))),
    141: ("GEOMETRIC_OWNER", (("owner", "p", 0), ("next", "p", 0), ("previous", "p", 0),
                              ("shared_geometry", "p", 0))),
    163: ("HELIX_SU_FORM", (("axis_pt", "v", 0), ("axis_dir", "v", 0), ("hand", "c", 0), ("turns", "i", 0),
                            ("pitch", "f", 0), ("gap", "f", 0), ("tol", "f", 0))),
    184: ("HELIX_CU_FORM", (("axis_pt", "v", 0), ("axis_dir", "v", 0), ("point", "v", 0), ("hand", "c", 0),
                            ("turns", "i", 0), ("pitch", "f", 0), ("tol", "f", 0))),
}  # fmt: skip
_TERMINATOR = 1
_DOUBLES = {"f": 1, "i": 2, "v": 3, "h": 3, "b": 6}


@dataclass
class Node:
    type: int
    name: str
    fields: dict[str, Any] = field(default_factory=dict)


def transmit_files(stream: bytes) -> list[bytes]:
    """The transmit files packed in one of SolidWorks' streams, unpacked; any that don't unpack whole are refused."""
    out = []
    at = stream.find(PACKED)
    while at >= 0:
        length = struct.unpack_from("<I", stream, at - 4)[0] if at >= 4 else 0
        end = min(len(stream), at + length) if length else len(stream)
        pieces, total = [], 0
        place = at + len(PACKED)
        while place + 8 <= end:
            size, packed = struct.unpack_from("<II", stream, place)
            if size == 0:
                break
            total += size
            if total > MAX_SIZE:
                raise XtError(f"Its solid unpacks to over {MAX_SIZE >> 20} MB, more than Caliper reads")
            try:
                piece = zlib.decompressobj().decompress(stream[place + 8 : place + 8 + packed], size + 1)
            except zlib.error as e:
                raise XtError("Its solid doesn't unpack") from e
            if len(piece) != size:
                raise XtError("Its solid doesn't unpack to the size it says")
            pieces.append(piece)
            place += 8 + packed
        if pieces:
            out.append(b"".join(pieces))
        at = stream.find(PACKED, max(place, at + 1))
    return out


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.at = 0

    def take(self, n: int) -> bytes:
        if n < 0 or self.at + n > len(self.data):
            raise XtError("It ends early")
        out = self.data[self.at : self.at + n]
        self.at += n
        return out

    def byte(self) -> int:
        return self.take(1)[0]

    def short(self) -> int:
        return struct.unpack(">h", self.take(2))[0]

    def int(self) -> int:
        return struct.unpack(">i", self.take(4))[0]

    def index(self) -> int:
        low = self.short()
        if low >= 0:
            return low - 1
        return self.short() * 32767 - low - 1

    def text(self) -> str:
        return self.take(self.byte()).decode("latin-1")

    def values(self, kind: str, count: int) -> Any:
        if kind == "p":
            return [self.index() for _ in range(count)]
        if kind in _DOUBLES:
            per = _DOUBLES[kind]
            flat = struct.unpack(f">{per * count}d", self.take(8 * per * count))
            return flat if per == 1 else [flat[i : i + per] for i in range(0, len(flat), per)]
        if kind in "ul":
            return list(self.take(count))
        if kind == "c":
            return self.take(count).decode("latin-1")
        if kind in "nw":
            return list(struct.unpack(f">{count}h", self.take(2 * count)))
        if kind in "dt":
            return list(struct.unpack(f">{count}i", self.take(4 * count)))
        raise XtError(f"Its fields are of a type Caliper doesn't know ({kind!r})")


def _field(reader: _Reader) -> tuple[str, str, int]:
    name = reader.text()
    pointer = reader.short()
    count = reader.index()
    kind = "p" if pointer else reader.text()
    if count == 1:
        reader.byte()  # whether it's written: a varying field may not be, and is still counted
    if kind not in "pfivhbulcnwdt" or len(kind) != 1 or count < 0:
        raise XtError(f"Its schema has a field Caliper can't read ({name!r}: {kind!r})")
    return name, kind, count


def header(data: bytes) -> str:
    """What a transmit file says it is: ": TRANSMIT FILE (partition) created by modeller version 3401247"."""
    reader = _Reader(data)
    if reader.take(4) != b"PS\x00\x00":
        raise XtError("It isn't a Parasolid transmit file in neutral binary")
    return reader.take(reader.short()).decode("latin-1")


def read(data: bytes) -> tuple[str, dict[int, Node]]:
    """A transmit file's header ("TRANSMIT FILE (partition) created by modeller version ...") and its nodes, by
    index. Whatever doesn't fit the format is refused (XtError): the file must end with its terminator, exactly."""
    reader = _Reader(data)
    if reader.take(4) != b"PS\x00\x00":
        raise XtError("It isn't a Parasolid transmit file in neutral binary")
    title = reader.take(reader.short()).decode("latin-1")
    schema = reader.take(reader.int()).decode("latin-1")
    parts = schema.split("_")
    if len(parts) != 4 or parts[0] != "SCH" or parts[3] != "13006":
        raise XtError(f"It's written to a schema Caliper doesn't have ({schema[:40]})")
    reader.short()  # the most node types
    if reader.int() != 0:
        raise XtError("It has user fields, which SolidWorks doesn't write")
    schemas: dict[int, tuple[str, tuple[tuple[str, str, int], ...]]] = {}
    nodes: dict[int, Node] = {}
    while True:
        kind = reader.short()
        if kind == _TERMINATOR:
            if reader.index() != 0 or reader.at != len(data):
                raise XtError("It doesn't end where its nodes do")
            return title, nodes
        if kind not in schemas:
            schemas[kind] = _schema(reader, kind)
        name, fields = schemas[kind]
        length = reader.int() if any(count == 1 for _, _, count in fields) else 0
        if length < 0 or length > len(data):
            raise XtError(f"A {name} says it's {length} long")
        index = reader.index()
        if index <= 0 or index in nodes:
            raise XtError(f"A {name}'s index ({index}) is taken or none")
        node = Node(kind, name)
        for field_name, field_kind, count in fields:
            many = length if count == 1 else max(count, 1)
            value = reader.values(field_kind, many)
            node.fields[field_name] = value[0] if count == 0 and not isinstance(value, str) else value
        nodes[index] = node
        if len(nodes) > MAX_NODES:
            raise XtError(f"It has over {MAX_NODES:,} nodes, more than Caliper reads")


def _schema(reader: _Reader, kind: int) -> tuple[str, tuple[tuple[str, str, int], ...]]:
    """A node type's fields, from what its first node says of them against the base schema's."""
    flag = reader.byte()
    if kind not in _BASE:
        if flag == 0xFF:
            raise XtError(f"It has node type {kind}, which the base schema hasn't")
        name = reader.text()
        reader.text()  # its description
        return name, tuple(_field(reader) for _ in range(flag))
    name, base = _BASE[kind]
    if flag == 0xFF:
        return name, base
    fields: list[tuple[str, str, int]] = []
    at = 0
    while True:
        op = chr(reader.byte())
        if op == "C":
            if at >= len(base):
                raise XtError(f"Its schema copies more fields of {name} than the base has")
            fields.append(base[at])
            at += 1
        elif op == "D":
            at += 1
        elif op in "IA":
            fields.append(_field(reader))
        elif op == "Z":
            break
        else:
            raise XtError(f"Its schema edits {name} with {op!r}")
    if len(fields) != flag:
        raise XtError(f"Its schema gives {name} {len(fields)} fields, but says {flag}")
    return name, tuple(fields)
