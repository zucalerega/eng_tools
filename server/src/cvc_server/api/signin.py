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


# Vault's mark, as the web app draws it (VaultMark in web/src/components.tsx): a vault door, and a gold orbit
# with a sliver of whatever's behind it around it. {door} and {gap} are colors.
_DOOR = (
    '<g fill="none" stroke="{door}"><polygon points="54.2,41.2 41.2,54.2 22.8,54.2 9.8,41.2 9.8,22.8 22.8,9.8 '
    '41.2,9.8 54.2,22.8" stroke-width="5"/><circle cx="32" cy="32" r="12.5" stroke-width="3"/>'
    '<path d="M32 32V14.5M32 32L16.8 40.8M32 32l15.2 8.8" stroke-width="3"/></g><g fill="{door}">'
    '<circle cx="32" cy="32" r="4.5"/><circle cx="32" cy="14.5" r="2.8"/><circle cx="16.8" cy="40.8" r="2.8"/>'
    '<circle cx="47.2" cy="40.8" r="2.8"/></g>'
    '<path d="M4 57Q42 52 60 5Q36 45 4 57Z" fill="#e0a500" style="stroke:{gap}" stroke-width="2.5" paint-order="stroke"/>'
)
_MARK = (
    '<svg width="56" height="56" viewBox="0 0 64 64" aria-hidden="true">'
    + _DOOR.format(door="currentColor", gap="var(--surface)")
    + "</svg>"
)
_FAVICON = "data:image/svg+xml," + quote(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b1b33"/>'
    + _DOOR.format(door="#fff", gap="#0b1b33")
    + "</svg>"
)
# Light, or dark like the computer (or as chosen in the web app's account menu, which keeps it in localStorage).
_DARK = """color-scheme: dark; --bg: #070b12; --surface: #0e1522; --text: #e5ebf4; --muted: #95a1b5;
    --border: #1d2940; --accent: #7aa7ee; --primary: #2a5fb0; --primary-hover: #3469bd; --door: #fff;
    --field: #111a29; --shadow: 0 18px 48px rgb(0 0 0 / 55%);"""
_STYLE = f"""
  :root {{ color-scheme: light; --bg: #eef1f6; --surface: #fff; --text: #0f1b2d; --muted: #5b677a;
    --border: #dfe4ec; --accent: #1d4d94; --primary: #1c4b8f; --primary-hover: #163d75; --door: #0b1b33;
    --field: #fff; --shadow: 0 18px 48px rgb(15 27 45 / 12%);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.5; }}
  @media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ {_DARK} }} }}
  :root[data-theme="dark"] {{ {_DARK} }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
    justify-content: center; padding: 2rem 1rem; background: var(--bg); color: var(--text);
    border-top: 3px solid #e0a500; }}
  .card {{ width: min(25rem, 100%); padding: 2.25rem 2rem 2rem; background: var(--surface);
    border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow); }}
  .brand {{ display: flex; flex-direction: column; align-items: center; gap: .55rem; margin-bottom: 1.75rem; }}
  .brand svg {{ color: var(--door); }}
  .wordmark, h1 {{ font-family: Bahnschrift, "DIN Alternate", Rubik, "Segoe UI", sans-serif; }}
  .wordmark {{ font-size: 1.8rem; font-weight: 700; letter-spacing: .28em; margin-right: -.28em;
    text-transform: uppercase; line-height: 1.1; }}
  .org {{ margin: 0; font-size: .7rem; font-weight: 600; letter-spacing: .18em; text-transform: uppercase;
    color: var(--muted); }}
  h1 {{ font-size: 1.2rem; font-weight: 600; text-align: center; margin: 0 0 .75rem; }}
  p {{ margin: .65rem 0; }}
  .lead, .fine {{ text-align: center; color: var(--muted); }}
  .lead {{ font-size: .92rem; margin-bottom: 1.4rem; }}
  .fine {{ font-size: .8rem; }}
  a {{ color: var(--accent); }}
  .button, button {{ display: inline-flex; align-items: center; justify-content: center; width: 100%;
    height: 2.7rem; padding: 0 1.1rem; font: inherit; font-weight: 600; border-radius: 8px;
    border: 1px solid var(--primary); background: var(--primary); color: #fff; text-decoration: none;
    cursor: pointer; white-space: nowrap; }}
  .button:hover, button:hover {{ background: var(--primary-hover); }}
  .secondary {{ background: transparent; color: var(--text); border-color: var(--border); }}
  .secondary:hover {{ background: var(--bg); }}
  .choices {{ display: flex; flex-direction: column; gap: .6rem; margin-top: 1.25rem; }}
  input {{ font: inherit; width: 100%; height: 2.7rem; padding: 0 .8rem; border-radius: 8px;
    border: 1px solid var(--border); background: var(--field); color: var(--text); }}
  .dev {{ margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px dashed var(--border); }}
  .dev p {{ font-size: .8rem; color: var(--muted); margin-top: 0; }}
  .dev .row {{ display: flex; gap: .5rem; }}
  .dev button {{ width: auto; flex: none; }}
  .foot {{ margin: 1.5rem 0 0; font-size: .78rem; color: var(--muted); text-align: center; }}
"""
_THEME = (
    "<script>try{var t=localStorage.getItem('vault.theme');"
    "if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>"
)


def _page(title: str, body: str, status_code: int = 200) -> HTMLResponse:
    """A sign-in page: a card with Vault's mark, like the web app's. The title "Vault" is just the brand."""
    heading = "" if title == "Vault" else f"<h1>{_esc(title)}</h1>"
    tab_title = title if title == "Vault" else f"{title} · Vault"
    return HTMLResponse(
        f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>{_esc(tab_title)}</title>
<link rel="icon" href="{_esc(_FAVICON)}">{_THEME}<style>{_STYLE}</style></head>
<body><main class="card"><div class="brand">{_MARK}<span class="wordmark">Vault</span>
<p class="org">Yellow Jacket Space Program</p></div>{heading}{body}</main>
<p class="foot">Access is managed by the team's admins and subteam leads.</p></body></html>""",
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
        parts = [
            '<p class="lead">The team\'s CAD vault: every part, assembly, and drawing, with its whole history.</p>'
        ]
        if request.app.state.oauth is not None:
            query = urlencode({"next": _safe_next(next_path)})
            parts.append(f'<a class="button" href="/auth/login?{query}">Sign in with Google</a>')
            parts.append('<p class="fine">First time here? Sign in, and an admin will approve your account.</p>')
        if settings.dev_auth and not settings.production:
            parts.append(
                '<form class="dev" method="get" action="/auth/dev-login"><p>Development sign-in, with any email</p>'
                '<div class="row"><input name="email" type="email" placeholder="you@example.com" required '
                'aria-label="Email">'
                f'<input type="hidden" name="next" value="{_esc(_safe_next(next_path))}"><button>Sign in</button>'
                "</div></form>"
            )
        if len(parts) == 1:
            parts.append('<p class="fine">Sign-in isn\'t set up on this server yet.</p>')
        return _page("Sign in", "".join(parts))

    body = f'<p class="lead">Signed in as <strong>{_esc(user.display_name)}</strong><br>{_esc(user.email)}</p>'
    if user.status == UserStatus.PENDING:
        body += "<p>An admin needs to approve your account before you can use Vault. Check back soon.</p>"
    elif user.status == UserStatus.DISABLED:
        body += "<p>This account is disabled. If that's a mistake, ask an admin.</p>"
    else:
        body += (
            "<p>The web app isn't built on this server (<code>npm run build</code> in <code>web/</code>). "
            'Meanwhile you can try the API at <a href="/docs">/docs</a>.</p>'
        )
    body += '<form method="post" action="/auth/logout"><button class="secondary">Sign out</button></form>'
    return _page("Waiting for approval" if user.status == UserStatus.PENDING else "Vault", body)


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
        f"""<p class="lead"><strong>{_esc(name)}</strong> wants to use Vault as <strong>{_esc(user.email)}</strong>.
It will be able to check files in and out with your permissions until you sign it out.</p>
<form class="choices" method="post" action="/auth/client/approve">{hidden}
<button type="submit">Allow</button><a class="button secondary" href="{_esc(cancel)}">Cancel</a></form>""",
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
