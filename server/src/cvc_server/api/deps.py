"""Request dependencies: database session, settings, blob store, and the signed-in user."""

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from .. import auth
from ..config import Settings
from ..errors import Forbidden, Unauthorized
from ..models import User, UserStatus
from ..storage import BlobStore

SESSION_COOKIE = "cvc_session"
# Browsers can't add custom headers to cross-site requests without CORS (which CVC
# doesn't allow), so requiring one on cookie-authenticated writes stops CSRF.
CSRF_HEADER = "x-cvc-request"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_store(request: Request) -> BlobStore:
    return request.app.state.store


def get_db(request: Request) -> Iterator[Session]:
    with request.app.state.sessionmaker() as db:
        yield db


DB = Annotated[Session, Depends(get_db)]
Config = Annotated[Settings, Depends(get_settings)]
Store = Annotated[BlobStore, Depends(get_store)]


def any_user(request: Request, db: DB) -> User:
    """The signed-in user, whether or not an admin has approved them yet."""
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        secret, from_cookie = header[7:].strip(), False
    else:
        secret, from_cookie = request.cookies.get(SESSION_COOKIE, ""), True
    user = auth.authenticate(db, secret) if secret else None
    if user is None:
        raise Unauthorized("Sign in to CVC")
    if from_cookie and request.method not in _SAFE_METHODS and CSRF_HEADER not in request.headers:
        raise Forbidden("Requests from the browser need an X-CVC-Request header", code="csrf")
    if user.status == UserStatus.DISABLED:
        raise Forbidden("This account is disabled", code="disabled")
    return user


def active_user(user: Annotated[User, Depends(any_user)]) -> User:
    if user.status != UserStatus.ACTIVE:
        raise Forbidden("An admin needs to approve your account first", code="pending_approval")
    return user


AnyUser = Annotated[User, Depends(any_user)]
ActiveUser = Annotated[User, Depends(active_user)]
