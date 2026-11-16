"""The demo (docs/design.md, "The demo"): a server of its own beside the site, with made-up data, that anyone can look at
without signing in, and no one can change.

Every request is its guest's, whoever sends it (api/deps.py), and anything but a read is refused before it reaches a
route (Guard). Its data is made from nothing by `yjsp-demo seed` (seed.py), which makes the guest too: a server in demo
mode refuses to start on a database without one (ready), so it can't be turned on over the team's own.
"""

from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.responses import JSONResponse

from ..config import Settings
from ..models import User

# Whose site the demo is: a made-up team's, whose rocket, Kestrel, its data is (seed.py), never YJSP's. Its pages say
# these names, and it has no logo (api/web.py, logos), so nothing in it passes for the team's own.
SITE_NAME = "LRT"
TEAM_NAME = "Liquid Rocket Team"

# Who everyone is in the demo. An address at .invalid can never be anyone's.
GUEST_EMAIL = "guest@demo.invalid"
GUEST_NAME = "Guest"
READ_ONLY = "This is the demo, with made-up data: nothing in it can be changed"
_READS = {"GET", "HEAD", "OPTIONS"}

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


def branded(settings: Settings) -> Settings:
    """The demo's settings, named for its made-up team where they don't name a site and team of their own."""
    names = {"site_name": SITE_NAME, "team_name": TEAM_NAME}
    return settings.model_copy(
        update={key: value for key, value in names.items() if key not in settings.model_fields_set}
    )


def guest(db: Session) -> User | None:
    """The demo's guest, as its seed made it: None in a database the seed didn't make."""
    return db.scalar(select(User).where(User.email == GUEST_EMAIL))


def ready(db: Session) -> None:
    """Refuse to serve a database as the demo unless the demo's seed made it: a server turned to demo mode over the
    team's own database would show it all to anyone."""
    if guest(db) is None:
        raise RuntimeError(
            "This database isn't the demo's, which has its guest in it: make the demo's with `yjsp-demo seed`, or turn "
            'off YJSP_DEMO (docs/deploying.md, "The demo")'
        )


class Guard:
    """ASGI middleware for the demo: it can be read, and that's all. Anything but GET, HEAD, and OPTIONS is refused
    (403 `demo_read_only`), and sign-in (/auth/...) isn't there (404), before anything else sees the request."""

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            path = scope["path"]
            if scope["method"] not in _READS:
                await _error(403, READ_ONLY, code="demo_read_only")(scope, receive, send)
                return
            if path == "/auth" or path.startswith("/auth/"):
                await _error(404, "The demo has no sign-in: everyone's its guest", code="not_found")(
                    scope, receive, send
                )
                return
        await self.app(scope, receive, send)


def _error(status: int, message: str, *, code: str) -> JSONResponse:
    """An error as the API sends one (app.py's handler of ApiError)."""
    return JSONResponse({"error": code, "message": message}, status_code=status)
