"""Sign-in pages: Google for people, a browser handshake for the CLI/add-in, dev shortcuts.

The home page is where people sign in; once they're signed in and approved, it's the web app.
"""

import html
import re
from datetime import timedelta
from typing import Annotated
from urllib.parse import quote, urlencode

from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, Form, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy.orm import Session

from .. import auth
from ..config import Settings
from ..errors import CvcError, Forbidden, NotFound
from ..models import User, UserStatus
from . import web
from .deps import DB, SESSION_COOKIE, Config, session_user
from .schemas import ClientTokenIn, DevTokenIn, TokenIssuedOut, UserOut

router = APIRouter(tags=["sign-in"])
_CHALLENGE = re.compile(r"[A-Za-z0-9_-]{43}")
NextPath = Annotated[str, Query(alias="next")]


def make_oauth(settings: Settings) -> OAuth | None:
    if not settings.google_client_id:
        return None
    oauth = OAuth()
    oauth.register(
        "google",
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )
    return oauth


def _esc(value: object) -> str:
    return html.escape(str(value), quote=True)


# Vault's mark, as the web app draws it (VaultMark in web/src/components.tsx), and its favicon (web/index.html).
_MARK = (
    '<svg class="mark" width="44" height="44" viewBox="0 0 64 64" aria-hidden="true"><g fill="none" stroke="#fff">'
    '<polygon points="54.2,41.2 41.2,54.2 22.8,54.2 9.8,41.2 9.8,22.8 22.8,9.8 41.2,9.8 54.2,22.8" stroke-width="5"/>'
    '<circle cx="32" cy="32" r="12.5" stroke-width="3"/><path d="M32 32V14.5M32 32L16.8 40.8M32 32l15.2 8.8" '
    'stroke-width="3"/></g><g fill="#fff"><circle cx="32" cy="32" r="4.5"/><circle cx="32" cy="14.5" r="2.8"/>'
    '<circle cx="16.8" cy="40.8" r="2.8"/><circle cx="47.2" cy="40.8" r="2.8"/></g>'
    '<path d="M4 57Q42 52 60 5Q36 45 4 57Z" fill="#e0a500" stroke="#05080f" stroke-width="2.5" paint-order="stroke"/>'
    "</svg>"
)
_FAVICON = "data:image/svg+xml," + quote(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b1b33"/>'
    + _MARK.split(">", 1)[1].replace("#05080f", "#0b1b33")
)


def _page(title: str, body: str, status_code: int = 200) -> HTMLResponse:
    """A sign-in page, branded like the web app's top bar. The title "Vault" is just the brand."""
    heading = "" if title == "Vault" else f"<h1>{_esc(title)}</h1>"
    tab_title = title if title == "Vault" else f"{title} · Vault"
    return HTMLResponse(
        f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_esc(tab_title)}</title><link rel="icon" href="{_esc(_FAVICON)}">
<style>
  :root {{ color-scheme: dark; font-family: system-ui, sans-serif; line-height: 1.5;
    background: #05080f; color: #e6ecf5; }}
  body {{ max-width: 36rem; margin: 4rem auto; padding: 0 1rem; }}
  .brand {{ display: flex; align-items: center; gap: .75rem; padding-bottom: 1.25rem; margin-bottom: 1.5rem;
    border-bottom: 3px solid #e0a500; }}
  .brand span, h1 {{ font-family: Bahnschrift, "DIN Alternate", Rubik, "Segoe UI", sans-serif; }}
  .brand span {{ font-size: 1.6rem; font-weight: 700; letter-spacing: .24em; text-transform: uppercase; }}
  h1 {{ font-size: 1.3rem; font-weight: 600; }}
  a {{ color: #6b9ae6; }}
  .button, button {{ display: inline-block; font: inherit; padding: .45rem 1rem; border-radius: .4rem;
    border: 1px solid #1c4b8f; background: #1c4b8f; color: #fff; text-decoration: none; cursor: pointer; }}
  .secondary {{ background: transparent; color: inherit; border-color: #5a667a; }}
  input {{ font: inherit; padding: .4rem; border-radius: .4rem; border: 1px solid #1d2940; background: #0c1422;
    color: inherit; }}
</style></head>
<body><div class="brand">{_MARK}<span>Vault</span></div>{heading}{body}</body></html>""",
        status_code=status_code,
    )


def _safe_next(target: str | None) -> str:
    """Only paths on this site, so sign-in can't be abused to redirect somewhere else."""
    if not target or not target.startswith("/") or target.startswith(("//", "/\\")):
        return "/"
    return target


def _start_session(request: Request, db: Session, settings: Settings, user: User, target: str) -> RedirectResponse:
    agent = request.headers.get("user-agent", "browser")
    secret = auth.issue_token(db, user, kind=auth.SESSION, name=agent, ttl=timedelta(days=settings.session_days))
    response = RedirectResponse(_safe_next(target), status_code=303)
    response.set_cookie(
        SESSION_COOKIE,
        secret,
        max_age=settings.session_days * 86400,
        httponly=True,
        secure=settings.production,
        samesite="lax",
    )
    return response


@router.get("/", response_class=HTMLResponse, include_in_schema=False)
def home(request: Request, db: DB, settings: Config, next_path: NextPath = "/") -> Response:
    user = session_user(request, db)
    if user is not None and user.status == UserStatus.ACTIVE:
        if _safe_next(next_path) != "/":
            return RedirectResponse(_safe_next(next_path), status_code=303)  # signed in already: carry on
        if (index := web.app_index(settings)) is not None:
            return web.index_response(index)
    if user is None:
        parts = []
        if request.app.state.oauth is not None:
            query = urlencode({"next": _safe_next(next_path)})
            parts.append(f'<p><a class="button" href="/auth/login?{query}">Sign in with Google</a></p>')
        if settings.dev_auth and not settings.production:
            parts.append(
                '<form method="get" action="/auth/dev-login"><p>Development sign-in (any email):</p>'
                '<input name="email" type="email" placeholder="you@example.com" required> '
                f'<input type="hidden" name="next" value="{_esc(_safe_next(next_path))}"><button>Sign in</button></form>'
            )
        if not parts:
            parts.append("<p>Sign-in isn't set up on this server yet.</p>")
        return _page("Sign in", "".join(parts))

    body = f"<p>Signed in as <strong>{_esc(user.display_name)}</strong> ({_esc(user.email)}){', admin' if user.is_admin else ''}.</p>"
    if user.status == UserStatus.PENDING:
        body += "<p>An admin needs to approve your account before you can use Vault.</p>"
    elif user.status == UserStatus.DISABLED:
        body += "<p>This account is disabled.</p>"
    else:
        body += (
            "<p>The web app isn't built on this server (<code>npm run build</code> in <code>web/</code>). "
            'Meanwhile you can try the API at <a href="/docs">/docs</a>.</p>'
        )
    body += '<form method="post" action="/auth/logout"><button class="secondary">Sign out</button></form>'
    return _page("Vault", body)


@router.get("/auth/login", include_in_schema=False)
async def login(request: Request, settings: Config, next_path: NextPath = "/"):
    oauth = request.app.state.oauth
    if oauth is None:
        if settings.dev_auth and not settings.production:
            return RedirectResponse("/?" + urlencode({"next": _safe_next(next_path)}), status_code=303)
        raise CvcError("Google sign-in isn't set up on this server", code="signin_unavailable")
    request.session["next"] = _safe_next(next_path)
    return await oauth.google.authorize_redirect(request, f"{settings.public_url.rstrip('/')}/auth/callback")


@router.get("/auth/callback", include_in_schema=False)
async def callback(request: Request, db: DB, settings: Config) -> RedirectResponse:
    oauth = request.app.state.oauth
    if oauth is None:
        raise NotFound("Not found")
    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError as exc:
        raise Forbidden(f"Google sign-in failed: {exc.description or exc.error}", code="signin_failed") from exc
    info = token.get("userinfo") or {}
    user = auth.sign_in(
        db,
        settings,
        subject=info["sub"],
        email=info["email"],
        name=info.get("name", ""),
        email_verified=bool(info.get("email_verified")),
    )
    return _start_session(request, db, settings, user, request.session.pop("next", "/"))


@router.post("/auth/logout", include_in_schema=False)
def logout(request: Request, db: DB) -> RedirectResponse:
    secret = request.cookies.get(SESSION_COOKIE)
    if secret:
        auth.revoke_secret(db, secret)
    response = RedirectResponse("/", status_code=303)
    response.delete_cookie(SESSION_COOKIE)
    return response


# --- CLI / add-in sign-in (see auth.py) ------------------------------------------------------


def _approval_signer(settings: Settings) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.secret_key, salt="cvc-client-approval")


def _check_client_request(port: int, state: str, challenge: str) -> None:
    if not 1024 <= port <= 65535 or not _CHALLENGE.fullmatch(challenge) or not 0 < len(state) <= 200:
        raise CvcError("This sign-in request from the Vault client is malformed", code="bad_client_request")


def _client_callback(port: int, **params: str) -> str:
    return f"http://127.0.0.1:{port}/callback?{urlencode(params)}"


@router.get("/auth/client", include_in_schema=False)
def client_start(
    request: Request, db: DB, settings: Config, port: int, state: str, challenge: str, name: str = "Vault client"
):
    """The page a client opens in the browser: sign in if needed, then confirm."""
    _check_client_request(port, state, challenge)
    user = session_user(request, db)
    if user is None:
        here = f"{request.url.path}?{request.url.query}"
        return RedirectResponse("/auth/login?" + urlencode({"next": here}), status_code=303)
    if user.status != UserStatus.ACTIVE:
        return _page(
            "Waiting for approval",
            f"<p>Signed in as {_esc(user.email)}. An admin needs to approve your account first.</p>",
        )
    name = name.strip()[:100] or "Vault client"
    approval = _approval_signer(settings).dumps({"u": user.id, "p": port, "s": state, "c": challenge})
    cancel = _client_callback(port, error="access_denied", state=state)
    fields = {"port": port, "state": state, "challenge": challenge, "name": name, "approval": approval}
    hidden = "".join(f'<input type="hidden" name="{k}" value="{_esc(v)}">' for k, v in fields.items())
    return _page(
        "Sign in to Vault",
        f"""<p><strong>{_esc(name)}</strong> wants to use Vault as <strong>{_esc(user.email)}</strong>.
It will be able to check files in and out with your permissions until you sign it out.</p>
<form method="post" action="/auth/client/approve">{hidden}
<button type="submit">Allow</button> <a class="button secondary" href="{_esc(cancel)}">Cancel</a></form>""",
    )


@router.post("/auth/client/approve", include_in_schema=False)
def client_approve(
    request: Request,
    db: DB,
    settings: Config,
    port: Annotated[int, Form()],
    state: Annotated[str, Form()],
    challenge: Annotated[str, Form()],
    name: Annotated[str, Form()],
    approval: Annotated[str, Form()],
) -> RedirectResponse:
    _check_client_request(port, state, challenge)
    user = session_user(request, db)
    if user is None or user.status != UserStatus.ACTIVE:
        raise Forbidden("Sign in first", code="unauthorized")
    try:
        approved = _approval_signer(settings).loads(approval, max_age=600)
    except BadSignature as exc:
        raise Forbidden("This page expired; start signing in again from the client", code="expired") from exc
    if approved != {"u": user.id, "p": port, "s": state, "c": challenge}:
        raise Forbidden("This sign-in request doesn't match", code="mismatch")
    code = auth.create_client_code(db, user, challenge=challenge, name=name.strip()[:100] or "Vault client")
    return RedirectResponse(_client_callback(port, code=code, state=state), status_code=303)


@router.post("/auth/client/token")
def client_token(body: ClientTokenIn, db: DB) -> TokenIssuedOut:
    """Step 3 of client sign-in: trade the one-time code and PKCE verifier for a token."""
    secret, user = auth.redeem_client_code(db, body.code, body.verifier)
    return TokenIssuedOut(token=secret, user=UserOut.of(user))


# --- local development only -------------------------------------------------------------------


def _require_dev(settings: Settings) -> None:
    if not settings.dev_auth or settings.production:
        raise NotFound("Not found")


def _dev_identity(db: Session, settings: Settings, email: str, name: str) -> User:
    """Sign in as if Google vouched for this email. The usual approval rules apply."""
    email = email.strip().lower()
    return auth.sign_in(
        db, settings, subject=f"dev:{email}", email=email, name=name or email.split("@")[0], email_verified=True
    )


@router.get("/auth/dev-login", include_in_schema=False)
def dev_login(request: Request, db: DB, settings: Config, email: str, name: str = "", next_path: NextPath = "/"):
    _require_dev(settings)
    return _start_session(request, db, settings, _dev_identity(db, settings, email, name), next_path)


@router.post("/auth/dev-token")
def dev_token(body: DevTokenIn, db: DB, settings: Config) -> TokenIssuedOut:
    """Development only (CVC_DEV_AUTH): a client token for any email, without Google."""
    _require_dev(settings)
    user = _dev_identity(db, settings, body.email, body.name)
    return TokenIssuedOut(token=auth.issue_token(db, user, kind=auth.CLIENT, name="dev token"), user=UserOut.of(user))
