"""Request dependencies: database session, settings, and the signed-in user."""

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from .. import auth
from ..config import Settings
from ..errors import Forbidden, Unauthorized
from ..models import User, UserStatus

SESSION_COOKIE = "yjsp_session"
# Browsers can't add custom headers to cross-site requests without CORS (which the server
# doesn't allow), so requiring one on cookie-authenticated writes stops CSRF.
CSRF_HEADER = "x-yjsp-request"
# What a client says its person is doing, for Admin > People's time on the site: the add-in sends "solidworks"
# (auth.IN_SOLIDWORKS) while someone works in SolidWorks.
ACTIVITY_HEADER = "x-yjsp-activity"
# The names from before the site was YJSP (0.3.0), still accepted so browsers signed in then stay signed in and tabs
# opened then can still save. Sessions last 30 days (Settings.session_days), so those from before 0.4.0 (live on
# 2026-10-04) have run out by 2026-11-03: drop these in 0.6.0.
OLD_SESSION_COOKIE = "cvc_session"
OLD_CSRF_HEADER = "x-cvc-request"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Iterator[Session]:
    with request.app.state.sessionmaker() as db:
        yield db


DB = Annotated[Session, Depends(get_db)]
Config = Annotated[Settings, Depends(get_settings)]


def session_secret(request: Request) -> str:
    """The browser's session cookie, or an empty string."""
    return request.cookies.get(SESSION_COOKIE) or request.cookies.get(OLD_SESSION_COOKIE) or ""


def session_user(request: Request, db: Session) -> User | None:
    """Who the browser's session cookie belongs to, if anyone: for pages, which redirect instead of failing."""
    secret = session_secret(request)
    return _authenticate(request, db, secret) if secret else None


def any_user(request: Request, db: DB) -> User:
    """The signed-in user, whether or not an admin has approved them yet."""
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        secret, from_cookie = header[7:].strip(), False
    else:
        secret, from_cookie = session_secret(request), True
    user = _authenticate(request, db, secret) if secret else None
    if user is None:
        raise Unauthorized("Sign in first")
    csrf = CSRF_HEADER in request.headers or OLD_CSRF_HEADER in request.headers
    if from_cookie and request.method not in _SAFE_METHODS and not csrf:
        raise Forbidden("Requests from the browser need an X-YJSP-Request header", code="csrf")
    if user.status == UserStatus.DISABLED:
        raise Forbidden("This account is disabled", code="disabled")
    return user


def _authenticate(request: Request, db: Session, secret: str) -> User | None:
    headers = request.headers
    return auth.authenticate(db, secret, headers.get("user-agent", ""), headers.get(ACTIVITY_HEADER, ""))


def active_user(user: Annotated[User, Depends(any_user)]) -> User:
    if user.status != UserStatus.ACTIVE:
        raise Forbidden("An admin needs to approve your account first", code="pending_approval")
    return user


AnyUser = Annotated[User, Depends(any_user)]
ActiveUser = Annotated[User, Depends(active_user)]
