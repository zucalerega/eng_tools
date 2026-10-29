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
_NOT_APP = {"api", "auth", "assets", "brand", "healthz", "help"}
# The team's logo, white letters for dark backgrounds and navy for light, with its gold swoosh: for the site's own pages
# (pages.py) and the web app's top bar and home page alike.
BRAND = Path(__file__).resolve().parent.parent / "brand"
_LOGOS = {"logo-on-light.png", "logo-on-dark.png"}


def app_index(settings: Settings) -> Path | None:
    index = settings.web_dir / "index.html"
    return index if index.is_file() else None


def index_response(index: Path) -> FileResponse:
    # The page names its scripts by content hash; caching it would hide a new release.
    return FileResponse(index, media_type="text/html", headers={"Cache-Control": "no-cache"})


def mount_assets(app: FastAPI, settings: Settings) -> None:
    """Serve the build's scripts and styles; a build made while the server runs is picked up too."""
    app.mount("/assets", StaticFiles(directory=settings.web_dir / "assets", check_dir=False), name="assets")


@router.get("/brand/{name}")
def brand(name: str) -> FileResponse:
    """The team's logo, for anyone: the sign-in page shows it before anyone's signed in."""
    if name not in _LOGOS:
        raise NotFound("Not found")
    return FileResponse(BRAND / name, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/{path:path}")
def app_page(path: str, request: Request, db: DB, settings: Config) -> Response:
    """Every other page belongs to the web app, which works out what to show from the path."""
    if path.split("/", 1)[0] in _NOT_APP:
        raise NotFound("Not found")
    user = session_user(request, db)
    if user is None or user.status != UserStatus.ACTIVE:
        # Back here after signing in, with the query: a link can hold what it opens there (Yorg's plots, say).
        here = "/" + path + (f"?{request.url.query}" if request.url.query else "")
        return RedirectResponse("/?" + urlencode({"next": here}), status_code=303)
    index = app_index(settings)
    if index is None:
        raise NotFound("The web app isn't built on this server")
    return index_response(index)
