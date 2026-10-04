"""Software the web app offers members: the files in YJSP_DOWNLOADS_DIR, like the add-in's installer."""

from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..errors import NotFound
from .deps import ActiveUser, Config

router = APIRouter(prefix="/api/downloads", tags=["downloads"])


class DownloadOut(BaseModel):
    name: str
    size: int
    modified_at: datetime


def _files(folder: Path | None) -> dict[str, Path]:
    """The files directly in the folder, by name: only these are served, so no name reaches outside it."""
    if folder is None or not folder.is_dir():
        return {}
    found = (p for p in folder.iterdir() if p.is_file() and not p.name.startswith("."))
    return {p.name: p for p in sorted(found, key=lambda p: p.name.lower())}


@router.get("")
def get_downloads(user: ActiveUser, settings: Config) -> list[DownloadOut]:
    """What there is to download (Vault-Setup.exe installs the SolidWorks add-in)."""
    downloads = []
    for name, path in _files(settings.downloads_dir).items():
        stat = path.stat()
        downloads.append(
            DownloadOut(name=name, size=stat.st_size, modified_at=datetime.fromtimestamp(stat.st_mtime, UTC))
        )
    return downloads


@router.get("/{name}", response_class=FileResponse)
def get_download(name: str, user: ActiveUser, settings: Config) -> FileResponse:
    path = _files(settings.downloads_dir).get(name)
    if path is None:
        raise NotFound(f"There's no download called {name}")
    return FileResponse(path, filename=name, media_type="application/octet-stream")
