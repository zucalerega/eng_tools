"""The web app: one page (index.html of web/dist) that routes in the browser, and its built assets.

Sign-in stays on the server: anyone not signed in and approved is sent to the home page first.
"""

import html
from pathlib import Path
from urllib.parse import urlencode

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from ..config import Settings
from ..errors import NotFound
from ..models import UserStatus
from .deps import DB, Config, session_user

router = APIRouter(include_in_schema=False)
# First path segments the web app never owns: an unknown path under them is a 404, not an app page. /demo is the
# demo's, which the site passes on to it (demo.py), or nothing.
_NOT_APP = {"api", "auth", "assets", "brand", "demo", "healthz", "help"}
# Where the build names its scripts and styles: beside the page (web/vite.config.ts, base "./"), so one build works
# wherever the site is (YJSP_ROOT_PATH). The page itself is at whatever path the browser asked for, so index_response
# makes them the site's own.
_BUILT = '"./assets/'
# The team's logo, white letters for dark backgrounds and navy for light, with its gold swoosh: for the site's own pages
# (pages.py) and the web app's top bar and home page alike.
BRAND = Path(__file__).resolve().parent.parent / "brand"
_LOGOS = {"logo-on-light.png", "logo-on-dark.png"}


def app_index(settings: Settings) -> Path | None:
    index = settings.web_dir / "index.html"
    return index if index.is_file() else None


def logos(settings: Settings) -> dict[str, Path]:
    """The team's logo, by the names the pages ask for it by. YJSP's, where YJSP_BRAND_DIR is unset (YJSP's own site),
    except in the demo, a made-up team's (demo/__init__.py), which has none; else only the team's own: either one for
    both themes where it has only one, and none where it has neither. Where there's none, the pages show the site's
    name instead (pages.mark)."""
    if settings.brand_dir is None:
        return {} if settings.demo else {name: BRAND / name for name in _LOGOS}
    own = {name: settings.brand_dir / name for name in _LOGOS if (settings.brand_dir / name).is_file()}
    if len(own) == 1:
        (only,) = own.values()
        return dict.fromkeys(_LOGOS, only)
    return own


def index_response(index: Path, settings: Settings) -> HTMLResponse:
    """The web app's page, for a site at its root (Settings.root_path, "" at the root of its address): its scripts and
    styles at the site's /assets; and in meta tags, the root, for the app to start its addresses with (web/src/root.ts),
    and whose site it is, for the app to say (web/src/site.ts), with whether it has a logo to show."""
    root = settings.root_path
    page = index.read_text(encoding="utf-8").replace(_BUILT, f'"{root}/assets/')
    said = {
        "yjsp-root": root,
        "yjsp-site": settings.site_name,
        "yjsp-team": settings.team_name,
        "yjsp-logo": "yes" if logos(settings) else "none",
    }
    metas = "".join(f'\n<meta name="{name}" content="{html.escape(value)}">' for name, value in said.items())
    page = page.replace("<head>", "<head>" + metas, 1)
    # The page names its scripts by content hash; caching it would hide a new release.
    return HTMLResponse(page, headers={"Cache-Control": "no-cache"})


def mount_assets(app: FastAPI, settings: Settings) -> None:
    """Serve the build's scripts and styles; a build made while the server runs is picked up too."""
    app.mount("/assets", StaticFiles(directory=settings.web_dir / "assets", check_dir=False), name="assets")


@router.get("/brand/{name}")
def brand(name: str, settings: Config) -> FileResponse:
    """The team's logo, for anyone: the sign-in page shows it before anyone's signed in (logos says whose)."""
    found = logos(settings).get(name)
    if found is None:
        raise NotFound("Not found")
    return FileResponse(found, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/{path:path}")
def app_page(path: str, request: Request, db: DB, settings: Config) -> Response:
    """Every other page belongs to the web app, which works out what to show from the path."""
    if path.split("/", 1)[0] in _NOT_APP:
        raise NotFound("Not found")
    user = session_user(request, db)
    if user is None or user.status != UserStatus.ACTIVE:
        # Back here after signing in, with the query: a link can hold what it opens there (Yorg's plots, say).
        here = "/" + path + (f"?{request.url.query}" if request.url.query else "")
        return RedirectResponse(f"{settings.root_path}/?" + urlencode({"next": here}), status_code=303)
    index = app_index(settings)
    if index is None:
        raise NotFound("The web app isn't built on this server")
    return index_response(index, settings)
