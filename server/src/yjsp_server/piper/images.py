"""Pictures on drawings: a PNG or a JPEG, uploaded once and named by its SHA-256, which a drawing's picture part names.

Everyone signed in sees every diagram, so every picture. A picture never changes: the same bytes uploaded again are the
same picture, and one a drawing no longer shows is kept, as its revisions may still show it. Its type and size come from
its own header (pictures.py), not from what it's called, so what's kept is a picture a browser and a PDF can show.
"""

import hashlib

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..errors import NotFound, TooLarge
from ..models import User
from ..pictures import measure
from .models import Image

MAX_IMAGE_BYTES = 5 * 1024 * 1024


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
