"""Pictures on drawings: a PNG or a JPEG, uploaded once and named by its SHA-256, which a drawing's picture part names.

Everyone signed in sees every diagram, so every picture. A picture never changes: the same bytes uploaded again are the
same picture, and one a drawing no longer shows is kept, as its revisions may still show it. Its type and size come from
its own header, not from what it's called, so what's kept is a picture a browser and a PDF can show.
"""

import hashlib
import struct

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..errors import ApiError, NotFound, TooLarge
from ..models import User
from .models import Image

MAX_IMAGE_BYTES = 5 * 1024 * 1024
# Pixels, which a PDF of it decodes in the browser, four bytes each: about a 5000 by 5000 photo.
MAX_PIXELS = 25_000_000
MAX_SIDE = 10_000

PNG = b"\x89PNG\r\n\x1a\n"


class NotAnImage(ApiError):
    status = 415
    code = "not_an_image"


def measure(data: bytes) -> tuple[str, int, int]:
    """A picture's type, and its width and height in pixels, from its header; NotAnImage if it's not a PNG or a JPEG."""
    if data.startswith(PNG) and len(data) >= 24 and data[12:16] == b"IHDR":
        width, height = struct.unpack(">II", data[16:24])
        return _checked("image/png", width, height)
    if data.startswith(b"\xff\xd8"):
        at = 2
        while at + 4 <= len(data) and data[at] == 0xFF:
            marker = data[at + 1]
            if marker == 0xFF:  # a fill byte before the marker
                at += 1
                continue
            if marker == 0x01 or 0xD0 <= marker <= 0xD7:  # markers without a length
                at += 2
                continue
            (length,) = struct.unpack(">H", data[at + 2 : at + 4])
            # A frame's header (SOF0 to SOF15, but for the tables that share their numbers): its size.
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC) and at + 9 <= len(data):
                height, width = struct.unpack(">HH", data[at + 5 : at + 9])
                return _checked("image/jpeg", width, height)
            if marker == 0xDA:  # its picture began before it said its size
                break
            at += 2 + length
    raise NotAnImage(
        "That isn't a PNG or a JPEG picture: save it as one (File > Export, in most programs), then add it"
    )


def _checked(content_type: str, width: int, height: int) -> tuple[str, int, int]:
    if width < 1 or height < 1:
        raise NotAnImage("That picture has no pixels: save it again, then add it")
    if width > MAX_SIDE or height > MAX_SIDE or width * height > MAX_PIXELS:
        raise TooLarge(
            f"That picture is {width} by {height} pixels: a picture can be up to {MAX_PIXELS // 1_000_000} megapixels"
            f" and {MAX_SIDE} on a side. Make it smaller, then add it"
        )
    return content_type, width, height


def add(db: Session, user: User, data: bytes) -> Image:
    """A picture uploaded: kept, or, if the same bytes were uploaded before, that picture."""
    if len(data) > MAX_IMAGE_BYTES:
        raise TooLarge(f"A picture can be up to {MAX_IMAGE_BYTES >> 20} MB")
    content_type, width, height = measure(data)
    sha256 = hashlib.sha256(data).hexdigest()
    found = db.scalar(select(Image).where(Image.sha256 == sha256))
    if found is not None:
        return found
    made = Image(
        sha256=sha256,
        content_type=content_type,
        width=width,
        height=height,
        size=len(data),
        data=data,
        uploader=user,
    )
    db.add(made)
    try:
        db.commit()
    except IntegrityError:  # the same picture, uploaded at the same moment by someone else: theirs is it
        db.rollback()
        return db.scalars(select(Image).where(Image.sha256 == sha256)).one()
    return made


def image(db: Session, sha256: str) -> Image:
    found = db.scalar(select(Image).where(Image.sha256 == sha256))
    if found is None:
        raise NotFound(f"There's no picture {sha256[:12]}: it may have been on another server")
    return found
