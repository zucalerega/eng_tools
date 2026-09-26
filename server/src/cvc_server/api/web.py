"""The web app: one page (index.html of web/dist) that routes in the browser, and its built assets.

Sign-in stays on the server: anyone not signed in and approved is sent to the home page first.
"""

from pathlib import Path
from urllib.parse import urlencode

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from ..config import Settings
from ..errors import NotFound
from ..models import UserStatus
from .deps import DB, Config, session_user

router = APIRouter(include_in_schema=False)
# First path segments the web app never owns: an unknown path under them is a 404, not an app page.
_NOT_APP = {"api", "auth", "assets", "healthz"}


def app_index(settings: Settings) -> Path | None:
    index = settings.web_dir / "index.html"
    return index if index.is_file() else None


def index_response(index: Path) -> FileResponse:
    # The page names its scripts by content hash; caching it would hide a new release.
    return FileResponse(index, media_type="text/html", headers={"Cache-Control": "no-cache"})


def mount_assets(app: FastAPI, settings: Settings) -> None:
    """Serve the build's scripts and styles; a build made while the server runs is picked up too."""
    app.mount("/assets", StaticFiles(directory=settings.web_dir / "assets", check_dir=False), name="assets")


@router.get("/{path:path}")
def app_page(path: str, request: Request, db: DB, settings: Config) -> Response:
    """Every other page belongs to the web app, which works out what to show from the path."""
    if path.split("/", 1)[0] in _NOT_APP:
        raise NotFound("Not found")
    user = session_user(request, db)
    if user is None or user.status != UserStatus.ACTIVE:
        return RedirectResponse("/?" + urlencode({"next": "/" + path}), status_code=303)
    index = app_index(settings)
    if index is None:
        raise NotFound("The web app isn't built on this server")
    return index_response(index)
