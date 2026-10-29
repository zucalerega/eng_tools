"""Sign-in pages: Georgia Tech accounts (through Microsoft) and Google for people, a browser handshake for the
CLI/add-in, dev shortcuts.

The home page is where people sign in; once they're signed in and approved, it's the web app.
"""

import re
from datetime import timedelta
from typing import Annotated, Any, Literal, NamedTuple
from urllib.parse import urlencode

from authlib.integrations.starlette_client import OAuth, OAuthError, StarletteOAuth2App
from fastapi import APIRouter, Form, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy.orm import Session

from .. import auth
from ..config import Settings
from ..errors import ApiError, Forbidden, NotFound
from ..models import User, UserStatus
from . import web
from .deps import DB, OLD_SESSION_COOKIE, SESSION_COOKIE, Config, session_user
from .pages import FAVICON, NAME, PALETTE, SITE, THEME, esc
from .schemas import ClientTokenIn, DevTokenIn, TokenIssuedOut, UserOut

router = APIRouter(tags=["sign-in"])
_CHALLENGE = re.compile(r"[A-Za-z0-9_-]{43}")
NextPath = Annotated[str, Query(alias="next")]
Provider = Literal["google", "microsoft"]


class _SignIn(NamedTuple):
    label: str  # "Sign in with ..."
    start: str
    callback: str  # as registered with the provider: {public_url}{callback}


# The ways to sign in, in the order the sign-in page offers them.
_SIGN_INS: dict[Provider, _SignIn] = {
    "microsoft": _SignIn("Georgia Tech", "/auth/microsoft/login", "/auth/microsoft/callback"),
    "google": _SignIn("Google", "/auth/login", "/auth/callback"),
}


def make_oauth(settings: Settings) -> OAuth | None:
    """The ways to sign in this server has set up: Google, Georgia Tech accounts (through Microsoft), or both."""
    if not (settings.google_client_id or settings.microsoft_client_id):
        return None
    oauth = OAuth()
    if settings.google_client_id:
        oauth.register(
            "google",
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile"},
        )
    if settings.microsoft_client_id:
        # GT's tenant's own endpoints: only its accounts can sign in there, and each ID token's issuer must be GT's
        # (authlib checks it against this one). auth.sign_in_microsoft checks the rest.
        gt = f"https://login.microsoftonline.com/{auth.GT_TENANT}"
        oauth.register(
            "microsoft",
            client_id=settings.microsoft_client_id,
            client_secret=settings.microsoft_client_secret,
            authorize_url=f"{gt}/oauth2/v2.0/authorize",
            # Straight on to GT's login page, without Microsoft first asking which account.
            authorize_params={"domain_hint": auth.GT_DOMAIN},
            access_token_url=f"{gt}/oauth2/v2.0/token",
            issuer=f"{gt}/v2.0",
            jwks_uri=f"{gt}/discovery/v2.0/keys",
            client_kwargs={
                "scope": "openid email profile",
                "code_challenge_method": "S256",
                "token_endpoint_auth_method": "client_secret_post",
            },
        )
    return oauth


def _provider(request: Request, name: Provider) -> StarletteOAuth2App | None:
    """That way to sign in, if this server has it set up."""
    oauth: OAuth | None = request.app.state.oauth
    return None if oauth is None else oauth.create_client(name)


# The team's logo beside the site's name, as the web app's home page has them (pages.LOGO_CSS).
_LOCKUP = (
    f'<div class="lockup"><span class="logo" role="img" aria-label="{SITE}"></span><span class="rule"></span>'
    f'<span class="words">{" ".join(f"<span>{esc(word)}</span>" for word in NAME.split())}</span></div>'
)
_STYLE = f"""{PALETTE}  body {{ margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
    justify-content: center; padding: 2rem 1rem; background: var(--bg); color: var(--text);
    border-top: 3px solid #e0a500; }}
  .card {{ width: min(25rem, 100%); padding: 2.25rem 2rem 2rem; background: var(--surface);
    border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow); }}
  .brand {{ display: flex; flex-direction: column; align-items: center; gap: .9rem; margin-bottom: 1.75rem; }}
  h1 {{ font-family: Bahnschrift, "DIN Alternate", Rubik, "Segoe UI", sans-serif; }}
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


def _page(title: str, body: str, status_code: int = 200) -> HTMLResponse:
    """A sign-in page: a card with the team's logo and the site's name. The title "YJSP" is just the brand."""
    heading = "" if title == SITE else f"<h1>{esc(title)}</h1>"
    tab_title = title if title == SITE else f"{title} · {SITE}"
    return HTMLResponse(
        f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>{esc(tab_title)}</title>
<link rel="icon" href="{esc(FAVICON)}">{THEME}<style>{_STYLE}</style></head>
<body><main class="card"><div class="brand">{_LOCKUP}<p class="org">Yellow Jacket Space Program</p></div>
{heading}{body}</main>
<p class="foot">Access is managed by the team's admins and subteam leads.</p></body></html>""",
        status_code=status_code,
    )


# Where to come back to goes through Google's or Microsoft's round trip in the session cookie, which browsers cap at
# 4 KB with the sign-in's own state in it too: a longer one (a link with many of Yorg's plots in its query) comes back
# to its page.
MOST_NEXT = 2000


def _safe_next(target: str | None) -> str:
    """Only paths on this site, so sign-in can't be abused to redirect somewhere else, and short enough to keep."""
    if not target or not target.startswith("/") or target.startswith(("//", "/\\")):
        return "/"
    if len(target) > MOST_NEXT:
        page = target.split("?", 1)[0]
        return page if len(page) <= MOST_NEXT else "/"
    return target


def _turned_away(error: ApiError) -> HTMLResponse:
    """A sign-in that didn't let someone in, as a page that says why and what to do, not the API's JSON: they came
    from Google's or GT's login page in their browser."""
    return _page(
        "Can't sign you in",
        f'<p class="lead">{esc(error.message)}.</p><a class="button secondary" href="/">Back to sign-in</a>',
        error.status,
    )


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
            '<p class="lead">The team\'s engineering tools: Vault, every part, assembly, and drawing with its whole '
            "history; Yorg, the test data, plotted; and Piper, the fluid systems, drawn.</p>"
        ]
        offered = [_SIGN_INS[name] for name in _SIGN_INS if _provider(request, name) is not None]
        if offered:
            query = urlencode({"next": _safe_next(next_path)})
            buttons = "".join(
                f'<a class="button{" secondary" if i else ""}" href="{way.start}?{query}">Sign in with {way.label}</a>'
                for i, way in enumerate(offered)
            )
            parts.append(f'<div class="choices">{buttons}</div>')
            # Only Georgia Tech accounts make new accounts (auth._sign_in): Google is for accounts already there.
            if _provider(request, "microsoft") is None:
                first = "First time here? An admin needs to invite you first."
            elif auth.whitelist_on(db):
                first = (
                    "First time here? Sign in with Georgia Tech. If your GT email isn't on the team's whitelist yet, "
                    "ask an admin to add it."
                )
            else:
                first = "First time here? Sign in with your Georgia Tech account to join."
            if _provider(request, "google") is not None:
                first += " Google is for accounts made with it before."
            parts.append(f'<p class="fine">{first}</p>')
        if settings.dev_auth and not settings.production:
            parts.append(
                '<form class="dev" method="get" action="/auth/dev-login"><p>Development sign-in, with any email</p>'
                '<div class="row"><input name="email" type="email" placeholder="you@example.com" required '
                'aria-label="Email">'
                f'<input type="hidden" name="next" value="{esc(_safe_next(next_path))}"><button>Sign in</button>'
                "</div></form>"
            )
        if len(parts) == 1:
            parts.append('<p class="fine">Sign-in isn\'t set up on this server yet.</p>')
        return _page("Sign in", "".join(parts))

    body = f'<p class="lead">Signed in as <strong>{esc(user.display_name)}</strong><br>{esc(user.email)}</p>'
    if user.status == UserStatus.PENDING:
        body += (
            "<p>An admin needs to approve your account before you can use Vault, Yorg, and Piper. Check back soon.</p>"
        )
    elif user.status == UserStatus.DISABLED:
        body += "<p>This account is disabled. If that's a mistake, ask an admin.</p>"
    else:
        body += (
            "<p>The web app isn't built on this server (<code>npm run build</code> in <code>web/</code>). "
            'Meanwhile you can try the API at <a href="/docs">/docs</a>.</p>'
        )
    body += '<form method="post" action="/auth/logout"><button class="secondary">Sign out</button></form>'
    return _page("Waiting for approval" if user.status == UserStatus.PENDING else SITE, body)


async def _start_sign_in(request: Request, settings: Settings, name: Provider, next_path: str) -> Response:
    """Off to Google or Microsoft, to come back to the callback, and then to next_path."""
    provider = _provider(request, name)
    if provider is None:
        if settings.dev_auth and not settings.production:
            return RedirectResponse("/?" + urlencode({"next": _safe_next(next_path)}), status_code=303)
        raise ApiError(f"{_SIGN_INS[name].label} sign-in isn't set up on this server", code="signin_unavailable")
    request.session["next"] = _safe_next(next_path)
    return await provider.authorize_redirect(request, settings.public_url.rstrip("/") + _SIGN_INS[name].callback)


async def _signed_in_as(request: Request, name: Provider) -> dict[str, Any]:
    """The claims of the ID token Google or Microsoft sent back, once authlib has checked its signature, issuer,
    audience, and nonce."""
    provider = _provider(request, name)
    if provider is None:
        raise NotFound("Not found")
    try:
        token = await provider.authorize_access_token(request)
    except OAuthError as exc:
        message = f"{_SIGN_INS[name].label} sign-in failed: {exc.description or exc.error}"
        raise Forbidden(message, code="signin_failed") from exc
    return dict(token.get("userinfo") or {})


@router.get("/auth/login", include_in_schema=False)
async def login(request: Request, settings: Config, next_path: NextPath = "/") -> Response:
    return await _start_sign_in(request, settings, "google", next_path)


@router.get("/auth/callback", include_in_schema=False)
async def callback(request: Request, db: DB, settings: Config) -> Response:
    try:
        info = await _signed_in_as(request, "google")
        user = auth.sign_in(
            db,
            settings,
            subject=info["sub"],
            email=info["email"],
            name=info.get("name", ""),
            email_verified=bool(info.get("email_verified")),
        )
    except ApiError as error:
        return _turned_away(error)
    return _start_session(request, db, settings, user, request.session.pop("next", "/"))


@router.get("/auth/microsoft/login", include_in_schema=False)
async def microsoft_login(request: Request, settings: Config, next_path: NextPath = "/") -> Response:
    return await _start_sign_in(request, settings, "microsoft", next_path)


@router.get("/auth/microsoft/callback", include_in_schema=False)
async def microsoft_callback(request: Request, db: DB, settings: Config) -> Response:
    try:
        user = auth.sign_in_microsoft(db, settings, await _signed_in_as(request, "microsoft"))
    except ApiError as error:
        return _turned_away(error)
    return _start_session(request, db, settings, user, request.session.pop("next", "/"))


@router.post("/auth/logout", include_in_schema=False)
def logout(request: Request, db: DB) -> RedirectResponse:
    response = RedirectResponse("/", status_code=303)
    for cookie in (SESSION_COOKIE, OLD_SESSION_COOKIE):
        if secret := request.cookies.get(cookie):
            auth.revoke_secret(db, secret)
            response.delete_cookie(cookie)
    return response


# --- CLI / add-in sign-in (see auth.py) ------------------------------------------------------


def _approval_signer(settings: Settings) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.secret_key, salt="yjsp-client-approval")


def _check_client_request(port: int, state: str, challenge: str) -> None:
    if not 1024 <= port <= 65535 or not _CHALLENGE.fullmatch(challenge) or not 0 < len(state) <= 200:
        raise ApiError("This sign-in request from the Vault client is malformed", code="bad_client_request")


def _client_callback(port: int, **params: str) -> str:
    return f"http://127.0.0.1:{port}/callback?{urlencode(params)}"


@router.get("/auth/client", include_in_schema=False)
def client_start(
    request: Request, db: DB, settings: Config, port: int, state: str, challenge: str, name: str = "Vault client"
):
    """The page a client opens in the browser: sign in if needed, then confirm."""
    _check_client_request(port, state, challenge)
    user = session_user(request, db)
    if user is None:  # to the sign-in page, which offers each way to sign in, and back here
        here = f"{request.url.path}?{request.url.query}"
        return RedirectResponse("/?" + urlencode({"next": here}), status_code=303)
    if user.status != UserStatus.ACTIVE:
        return _page(
            "Waiting for approval",
            f"<p>Signed in as {esc(user.email)}. An admin needs to approve your account first.</p>",
        )
    name = name.strip()[:100] or "Vault client"
    approval = _approval_signer(settings).dumps({"u": user.id, "p": port, "s": state, "c": challenge})
    cancel = _client_callback(port, error="access_denied", state=state)
    fields = {"port": port, "state": state, "challenge": challenge, "name": name, "approval": approval}
    hidden = "".join(f'<input type="hidden" name="{k}" value="{esc(v)}">' for k, v in fields.items())
    return _page(
        "Sign in to Vault",
        f"""<p class="lead"><strong>{esc(name)}</strong> wants to use Vault as <strong>{esc(user.email)}</strong>.
It will be able to check files in and out with your permissions until you sign it out.</p>
<form class="choices" method="post" action="/auth/client/approve">{hidden}
<button type="submit">Allow</button><a class="button secondary" href="{esc(cancel)}">Cancel</a></form>""",
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


@router.get("/auth/dev-login", include_in_schema=False)
def dev_login(request: Request, db: DB, settings: Config, email: str, name: str = "", next_path: NextPath = "/"):
    _require_dev(settings)
    try:
        user = auth.sign_in_dev(db, settings, email, name)
    except ApiError as error:
        return _turned_away(error)
    return _start_session(request, db, settings, user, next_path)


@router.post("/auth/dev-token")
def dev_token(body: DevTokenIn, db: DB, settings: Config) -> TokenIssuedOut:
    """Development only (YJSP_DEV_AUTH): a client token for any email, as if Georgia Tech vouched for it."""
    _require_dev(settings)
    user = auth.sign_in_dev(db, settings, body.email, body.name)
    token = auth.issue_token(db, user, kind=auth.CLIENT, name=body.client or "dev token")
    return TokenIssuedOut(token=token, user=UserOut.of(user))
