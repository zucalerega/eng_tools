"""Software the web app offers members: the files in YJSP_DOWNLOADS_DIR, like the add-in's installer."""

import hashlib
import struct
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import clients
from ..errors import NotFound
from .deps import DB, ActiveUser, Config

router = APIRouter(prefix="/api/downloads", tags=["downloads"])

# A Windows program's version resource: the UTF-16 key "VS_VERSION_INFO", then VS_FIXEDFILEINFO, which starts with this.
_VERSION_KEY = "VS_VERSION_INFO".encode("utf-16-le")
_FIXED_INFO = struct.pack("<I", 0xFEEF04BD)


class DownloadOut(BaseModel):
    name: str
    size: int
    modified_at: datetime
    # A Windows program's file version, like "0.5.0", from the program itself: the add-in compares the installer's
    # with its own to offer an update. None for other files.
    version: str | None
    # So a client can check that what it downloaded, and is about to run, is what's offered here.
    sha256: str


def _files(folder: Path | None) -> dict[str, Path]:
    """The files directly in the folder, by name: only these are served, so no name reaches outside it."""
    if folder is None or not folder.is_dir():
        return {}
    found = (p for p in folder.iterdir() if p.is_file() and not p.name.startswith("."))
    return {p.name: p for p in sorted(found, key=lambda p: p.name.lower())}


@lru_cache(maxsize=64)
def _contents(path: str, size: int, modified_ns: int) -> tuple[str | None, str]:
    """A file's version, if it's a program, and its SHA-256: read once for each size and time it has."""
    data = Path(path).read_bytes()
    return (_program_version(data) if path.lower().endswith(".exe") else None), hashlib.sha256(data).hexdigest()


def _program_version(data: bytes) -> str | None:
    """
    "major.minor.build" from a Windows program's version resource, whose VS_FIXEDFILEINFO follows the key within a few
    bytes of padding and holds the version in its third and fourth words. The last key in the file is the program's
    own: resources come after the code, and anything the program carries inside it (Vault-Setup.exe carries the
    add-in) comes before.
    """
    key = data.rfind(_VERSION_KEY)
    info = -1 if key < 0 else data.find(_FIXED_INFO, key + len(_VERSION_KEY), key + len(_VERSION_KEY) + 8)
    if info < 0 or len(data) < info + 16:
        return None
    high, low = struct.unpack_from("<II", data, info + 8)
    return f"{high >> 16}.{high & 0xFFFF}.{low >> 16}"


def _version(path: Path) -> str | None:
    stat = path.stat()
    return _contents(str(path), stat.st_size, stat.st_mtime_ns)[0]


def version_of(folder: Path | None, name: str) -> str | None:
    """The version of a program offered for download, if it's offered: Admin > People compares the add-in's with it."""
    path = _files(folder).get(name)
    return None if path is None else _version(path)


@router.get("")
def get_downloads(user: ActiveUser, settings: Config) -> list[DownloadOut]:
    """What there is to download (Vault-Setup.exe installs the SolidWorks add-in)."""
    downloads = []
    for name, path in _files(settings.downloads_dir).items():
        stat = path.stat()
        version, sha256 = _contents(str(path), stat.st_size, stat.st_mtime_ns)
        downloads.append(
            DownloadOut(
                name=name,
                size=stat.st_size,
                modified_at=datetime.fromtimestamp(stat.st_mtime, UTC),
                version=version,
                sha256=sha256,
            )
        )
    return downloads


@router.get("/{name}", response_class=FileResponse)
def get_download(name: str, request: Request, user: ActiveUser, db: DB, settings: Config) -> FileResponse:
    path = _files(settings.downloads_dir).get(name)
    if path is None:
        raise NotFound(f"There's no download called {name}")
    # Admin > People counts who got the add-in.
    clients.record_download(db, user, name, _version(path), request.headers.get("user-agent", ""))
    return FileResponse(path, filename=name, media_type="application/octet-stream")
