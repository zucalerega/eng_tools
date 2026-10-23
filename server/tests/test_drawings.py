"""Drawings in Caliper: the pictures of its sheets SolidWorks saves in a drawing (vault/solidworks.py), and the PDF of
each version Vault for SolidWorks makes, who may add one, and who sees it.

The drawings here are made as SolidWorks 2015 and later save files, of the streams Caliper reads; the reader was worked
out from the drawings SolidWorks 2020 to 2025 install as samples, which can't be copied here."""

import struct
import zlib

from .test_caliper import files

MARKER = b"\x14\x00\x06\x00\x08\x00"
PDF = b"%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"


def png(width: int, height: int, shade: int = 0) -> bytes:
    """A gray PNG of this size."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\x00" + bytes([shade]) * width for _ in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def cstring(text: str) -> bytes:
    """A string as SolidWorks keeps them: ff fe ff, its length, and UTF-16."""
    return b"\xff\xfe\xff" + bytes([len(text)]) + text.encode("utf-16-le")


def sheet_names(*names: str, each: bool = True) -> bytes:
    """SheetPreviews/SheetNames: the count, then each name and four bytes (or, with each=False, four bytes at the end)."""
    after = b"\x00\x00\x00\x00"
    return (
        struct.pack("<H", len(names))
        + b"".join(cstring(n) + (after if each else b"") for n in names)
        + (b"" if each else after)
    )


def solidworks_file(streams: dict[str, bytes]) -> bytes:
    """A file as SolidWorks 2015 and later save them: each stream after a marker, with its CRC, sizes, and name (each
    byte's halves swapped), deflated."""
    out = b"\x00" * 16  # what comes before the first stream
    for tag, (name, contents) in enumerate(streams.items()):
        packed = zlib.compressobj(wbits=-15)
        body = packed.compress(contents) + packed.flush()
        swapped = bytes(((b << 4) | (b >> 4)) & 0xFF for b in name.encode("latin-1"))
        header = struct.pack("<5I", tag, zlib.crc32(contents), len(body), len(contents), len(swapped))
        out += MARKER + header + swapped + body
    return out


def drawing(*sheets: tuple[str, bytes | None], each: bool = True) -> bytes:
    """A drawing of these sheets, each with its picture, if it has one, and a preview of the first."""
    streams = {"SheetPreviews/SheetNames": sheet_names(*(name for name, _ in sheets), each=each)}
    streams |= {f"Images/Sheet_{n}": picture for n, (_, picture) in enumerate(sheets) if picture is not None}
    if sheets and sheets[0][1] is not None:
        streams["PreviewPNG"] = sheets[0][1]
    return solidworks_file(streams)


def checked_in(team, who, drawing_contents: bytes, folder: str = "Fins") -> tuple[dict, dict]:
    """A part and its drawing, checked in together: the drawing shows the part."""
    made = files(
        team.checkin(
            who,
            {f"{folder}/Fin.SLDPRT": b"fin", f"{folder}/Fin.SLDDRW": drawing_contents},
            refs={f"{folder}/Fin.SLDDRW": [f"{folder}/Fin.SLDPRT"]},
        )
    )
    return made["Fin.SLDPRT"], made["Fin.SLDDRW"]


def shown(client, who, file: dict, version: int = 1) -> dict:
    response = client.get(f"/api/files/{file['id']}/drawing", params={"version": version}, headers=who)
    assert response.status_code == 200, response.text
    return response.json()


def picture(client, who, file: dict, sheet: int, version: int = 1, **headers):
    return client.get(
        f"/api/files/{file['id']}/drawing/sheet", params={"version": version, "sheet": sheet}, headers=who | headers
    )


def put_pdf(team, who, file: dict, pdf: str, version: int = 1):
    return team.client.put(f"/api/files/{file['id']}/drawing/pdf", json={"version": version, "pdf": pdf}, headers=who)


def test_a_drawings_sheets_come_with_the_pictures_solidworks_saved_of_them(team, client):
    chief = team.member("chief@x.test", admin=True)
    general, detail = png(64, 48, 200), png(64, 48, 100)
    _, fin = checked_in(team, chief, drawing(("Sheet1", general), ("Detail", detail)))

    assert shown(client, chief, fin) == {
        "version": 1,
        "pdf": None,
        "sheets": [{"name": "Sheet1", "picture": True}, {"name": "Detail", "picture": True}],
        "unreadable": None,
    }
    first = picture(client, chief, fin, 1)
    assert (first.status_code, first.headers["content-type"], first.content) == (200, "image/png", general)
    assert first.headers["x-content-type-options"] == "nosniff"
    assert picture(client, chief, fin, 2).content == detail
    again = picture(client, chief, fin, 2, **{"If-None-Match": picture(client, chief, fin, 2).headers["etag"]})
    assert again.status_code == 304
    for missing in (0, 3):
        response = picture(client, chief, fin, missing)
        assert (response.status_code, response.json()["error"]) == (404, "no_picture")


def test_sheets_are_named_however_their_names_end(team, client):
    chief = team.member("chief@x.test", admin=True)
    # Names whose four bytes come once, at the end; and a sheet SolidWorks saved no picture of.
    _, fin = checked_in(team, chief, drawing(("Sheet1", png(8, 6)), ("Flat pattern", None), each=False))
    assert shown(client, chief, fin)["sheets"] == [
        {"name": "Sheet1", "picture": True},
        {"name": "Flat pattern", "picture": False},
    ]
    assert picture(client, chief, fin, 2).status_code == 404


def test_a_drawing_without_pictures_of_its_sheets_shows_its_preview(team, client):
    chief = team.member("chief@x.test", admin=True)
    preview = png(32, 24)
    _, fin = checked_in(team, chief, solidworks_file({"PreviewPNG": preview}))
    assert shown(client, chief, fin)["sheets"] == [{"name": "", "picture": True}]
    assert picture(client, chief, fin, 1).content == preview


def test_sheets_that_cant_be_read_say_why(team, client):
    chief = team.member("chief@x.test", admin=True)
    part, fin = checked_in(team, chief, b"not a SolidWorks file")
    seen = shown(client, chief, fin)
    assert (seen["sheets"], seen["pdf"]) == ([], None)
    assert seen["unreadable"].startswith("Fins/Fin.SLDDRW v1: It isn't a SolidWorks drawing")
    refused = picture(client, chief, fin, 1)
    assert (refused.status_code, refused.json()["error"]) == (422, "unreadable_file")
    # Only drawings have sheets.
    not_one = client.get(f"/api/files/{part['id']}/drawing", params={"version": 1}, headers=chief)
    assert (not_one.status_code, not_one.json()["error"]) == (400, "not_a_drawing")
    no_version = client.get(f"/api/files/{fin['id']}/drawing", params={"version": 2}, headers=chief)
    assert no_version.status_code == 404


def test_a_drawings_pdf_is_shown_in_the_sites_own_pages(team, client):
    chief = team.member("chief@x.test", admin=True)
    _, fin = checked_in(team, chief, drawing(("Sheet1", png(8, 6))))
    none = client.get(f"/api/files/{fin['id']}/drawing/pdf", params={"version": 1}, headers=chief)
    assert (none.status_code, none.json()["error"]) == (404, "no_pdf")

    saved = put_pdf(team, chief, fin, team.upload(chief, PDF))
    assert saved.status_code == 200, saved.text
    assert saved.json()["size"] == len(PDF)
    assert saved.json()["created_by"]["email"] == "chief@x.test"
    assert shown(client, chief, fin)["pdf"] == saved.json()

    pdf = client.get(f"/api/files/{fin['id']}/drawing/pdf", params={"version": 1}, headers=chief)
    assert (pdf.status_code, pdf.content, pdf.headers["content-type"]) == (200, PDF, "application/pdf")
    assert pdf.headers["content-disposition"] == "inline; filename*=utf-8''Fin%20v1.pdf"
    # Framed by the site's own pages only, and in the browser's PDF viewer, which the site's own policy would stop.
    assert (pdf.headers["content-security-policy"], pdf.headers["x-frame-options"]) == (
        "frame-ancestors 'self'",
        "SAMEORIGIN",
    )
    assert pdf.headers["x-content-type-options"] == "nosniff"
    again = client.get(
        f"/api/files/{fin['id']}/drawing/pdf",
        params={"version": 1},
        headers=chief | {"If-None-Match": pdf.headers["etag"]},
    )
    assert again.status_code == 304
    # The rest of the site still can't be framed.
    page = client.get(f"/api/files/{fin['id']}/drawing", params={"version": 1}, headers=chief)
    assert page.headers["x-frame-options"] == "DENY"


def test_pdfs_are_checked(team, client):
    chief = team.member("chief@x.test", admin=True)
    part, fin = checked_in(team, chief, drawing(("Sheet1", png(8, 6))))
    pdf = team.upload(chief, PDF)

    def refused(file: dict, sha: str, version: int = 1) -> tuple[int, str]:
        response = put_pdf(team, chief, file, sha, version)
        return response.status_code, response.json()["error"]

    assert refused(fin, "0" * 64) == (400, "blob_missing")
    assert refused(fin, team.upload(chief, b"<html><script>alert(1)</script>")) == (400, "bad_pdf")
    assert refused(part, pdf) == (400, "not_a_drawing")
    assert refused(fin, pdf, version=2) == (404, "not_found")
    assert shown(client, chief, fin)["pdf"] is None


def test_who_can_add_and_make_pdfs_again(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")  # edits Propulsion
    bob = team.member("bob@x.test")  # edits Structures, and sees Propulsion
    viewer = team.member("viewer@x.test")  # sees Propulsion, and edits nothing
    outsider = team.member("outsider@x.test")  # sees nothing
    _, injector = checked_in(team, chief, drawing(("Sheet1", png(8, 6))), folder="Propulsion")
    assert client.post("/api/folders", json={"path": "Structures"}, headers=chief).status_code == 201
    team.grant(chief, "Propulsion", "alice@x.test", "editor")
    team.grant(chief, "Propulsion", "bob@x.test", "viewer")
    team.grant(chief, "Propulsion", "viewer@x.test", "viewer")
    team.grant(chief, "Structures", "bob@x.test", "editor")
    first, second = team.upload(chief, PDF), team.upload(chief, PDF + b"% again\n")

    assert put_pdf(team, viewer, injector, first).status_code == 403  # uploads nothing anywhere
    assert put_pdf(team, bob, injector, first).status_code == 200  # a PDF that was missing
    again = put_pdf(team, bob, injector, second)  # but not in place of one, outside the folder Bob edits
    assert again.status_code == 403
    assert "editor access to Propulsion" in again.json()["message"]
    assert put_pdf(team, alice, injector, second).status_code == 200
    assert shown(client, viewer, injector)["pdf"]["created_by"]["email"] == "alice@x.test"
    seen = client.get(f"/api/files/{injector['id']}/drawing/pdf", params={"version": 1}, headers=viewer)
    assert seen.content == PDF + b"% again\n"
    hidden = client.get(f"/api/files/{injector['id']}/drawing", params={"version": 1}, headers=outsider)
    assert hidden.status_code == 404


def test_which_drawings_have_no_pdf_yet(team, client):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    part, fin = checked_in(team, chief, drawing(("Sheet1", png(8, 6))), folder="Rocket")
    _, grain = checked_in(team, chief, drawing(("Sheet1", png(8, 6))), folder="Secret")
    team.grant(chief, "Rocket", "alice@x.test", "editor")
    assert put_pdf(team, chief, fin, team.upload(chief, PDF)).status_code == 200
    team.checkout(chief, "Rocket/Fin.SLDDRW")
    second = drawing(("Sheet1", png(8, 6, 50)))
    assert team.checkin(
        chief, {"Rocket/Fin.SLDDRW": second}, refs={"Rocket/Fin.SLDDRW": ["Rocket/Fin.SLDPRT"]}
    ).is_success

    def missing(who: dict[str, str], *drawings: tuple[dict, int]) -> list[tuple[int, int]]:
        body = {"drawings": [{"file_id": f["id"], "version": v} for f, v in drawings]}
        response = client.post("/api/drawings/missing", json=body, headers=who)
        assert response.status_code == 200, response.text
        return [(d["file_id"], d["version"]) for d in response.json()["missing"]]

    asked = [(fin, 1), (fin, 2), (fin, 3), (part, 1), (grain, 1), (fin, 2)]
    assert missing(chief, *asked) == [(fin["id"], 2), (grain["id"], 1)]  # not parts, or versions there aren't
    assert missing(alice, *asked) == [(fin["id"], 2)]  # not the grain's, which she can't see
