"""Signing in with a Georgia Tech account, through Microsoft: only GT's accounts, and then the usual approval rules.

Microsoft's half (its login page, and trading the code for a signed ID token, which authlib checks) can't run
offline: the `microsoft` fixture stands in for it with the claims a checked ID token would have.
"""

from urllib.parse import parse_qs, urlsplit

import pytest
from authlib.integrations.starlette_client import OAuthError
from fastapi.testclient import TestClient

from yjsp_server import auth
from yjsp_server.app import create_app

from .conftest import BOOTSTRAP_ADMIN

GEORGE = {
    "tid": auth.GT_TENANT,
    "oid": "george-oid",
    "preferred_username": "gburdell3@gatech.edu",
    "email": "gburdell3@gatech.edu",
    "name": "George P. Burdell",
}


@pytest.fixture
def settings(settings):
    settings.microsoft_client_id, settings.microsoft_client_secret = "yjsp-app-id", "yjsp-app-secret"
    return settings


@pytest.fixture
def microsoft(app, monkeypatch) -> dict[str, object]:
    """What Microsoft says about whoever signs in next: set its claims."""
    says: dict[str, object] = {}

    async def trade_the_code(request, **kwargs):
        return {"access_token": "...", "id_token": "...", "userinfo": dict(says)}

    monkeypatch.setattr(app.state.oauth.create_client("microsoft"), "authorize_access_token", trade_the_code)
    return says


def sign_in(client: TestClient, microsoft: dict[str, object], claims: dict[str, object], next_path: str = "/"):
    """Click "Sign in with Georgia Tech", sign in on GT's page, and come back with these claims."""
    client.get("/auth/microsoft/login", params={"next": next_path}, follow_redirects=False)
    microsoft.clear()
    microsoft.update(claims)
    return client.get("/auth/microsoft/callback", params={"code": "c0de", "state": "st4te"}, follow_redirects=False)


def test_the_sign_in_page_offers_georgia_tech_first(settings, client):
    page = client.get("/").text
    assert 'href="/auth/microsoft/login?next=%2F">Sign in with Georgia Tech</a>' in page
    assert "Sign in with Google" not in page  # not set up here
    assert "Sign in with your Georgia Tech account to join" in page

    settings.google_client_id, settings.google_client_secret = "id.apps.googleusercontent.com", "secret"
    with TestClient(create_app(settings)) as both:
        page = both.get("/").text
        assert (
            page.index("Sign in with Georgia Tech")
            < page.index('class="button secondary"')
            < page.index("Sign in with Google")
        )
        assert "Sign in with your Georgia Tech or Google account to join" in page


def test_signing_in_goes_to_georgia_techs_own_login(client):
    started = client.get("/auth/microsoft/login", params={"next": "/yorg"}, follow_redirects=False)
    assert started.status_code == 302
    url = urlsplit(started.headers["location"])
    assert (url.scheme, url.netloc, url.path) == (
        "https",
        "login.microsoftonline.com",
        f"/{auth.GT_TENANT}/oauth2/v2.0/authorize",
    )
    query = {key: value for key, [value] in parse_qs(url.query).items()}
    assert query["client_id"] == "yjsp-app-id"
    assert query["redirect_uri"] == "http://localhost:8000/auth/microsoft/callback"
    assert query["scope"] == "openid email profile"
    assert query["domain_hint"] == "gatech.edu"
    assert query["code_challenge_method"] == "S256"
    assert query["state"] and query["nonce"]


def test_a_georgia_tech_account_signs_in_and_comes_back(client, microsoft):
    back = sign_in(client, microsoft, GEORGE, "/yorg?view=3")
    assert (back.status_code, back.headers["location"]) == (303, "/yorg?view=3")
    me = client.get("/api/me").json()
    assert (me["email"], me["name"], me["status"]) == ("gburdell3@gatech.edu", "George P. Burdell", "active")

    # Signing in again is the same account, even after GT changes the addresses it gives.
    client.post("/auth/logout")
    sign_in(client, microsoft, GEORGE | {"preferred_username": "gburdell4@gatech.edu", "email": "gp@gatech.edu"})
    assert client.get("/api/me").json()["id"] == me["id"]


@pytest.mark.parametrize(
    "claims",
    [
        GEORGE | {"tid": "72f988bf-86f1-41af-91ab-2d7cd011db47"},  # another organization's account
        GEORGE | {"preferred_username": "alum@gmail.com", "email": "alum@gmail.com"},  # a guest GT invited
        GEORGE | {"preferred_username": "gburdell3@gatech.edu.evil.test", "email": None},
        {key: value for key, value in GEORGE.items() if key != "oid"},
    ],
)
def test_only_georgia_tech_accounts_get_in(client, microsoft, claims):
    refused = sign_in(client, microsoft, {key: value for key, value in claims.items() if value is not None})
    assert (refused.status_code, refused.json()["error"]) == (403, "not_georgia_tech")
    assert "gburdell3@gatech.edu" in refused.json()["message"]  # what to sign in with instead
    assert client.get("/api/me").status_code == 401
    chief = client.post("/auth/dev-token", json={"email": BOOTSTRAP_ADMIN}).json()["token"]
    emails = [u["email"] for u in client.get("/api/users", headers={"Authorization": f"Bearer {chief}"}).json()]
    assert emails == [BOOTSTRAP_ADMIN]  # nobody else got an account


def test_with_the_whitelist_on_only_invited_georgia_tech_people_join(client, team, microsoft):
    chief = team.member("lead@x.test", admin=True)
    team.whitelist(chief, True)
    # Invited by an alias: the sign-in has the username's address first, and the alias too.
    client.post("/api/users", json={"email": "george.burdell@gatech.edu", "name": "George"}, headers=chief)
    sign_in(client, microsoft, GEORGE | {"email": "george.burdell@gatech.edu"})
    me = client.get("/api/me").json()
    assert (me["email"], me["name"], me["status"]) == ("george.burdell@gatech.edu", "George", "active")

    client.post("/auth/logout")
    jane = {"oid": "jane-oid", "preferred_username": "jdoe7@gatech.edu", "email": "", "name": "Jane Doe"}
    sign_in(client, microsoft, GEORGE | jane)
    newcomer = client.get("/api/me").json()
    assert (newcomer["email"], newcomer["name"], newcomer["status"]) == ("jdoe7@gatech.edu", "Jane Doe", "pending")
    assert client.get("/api/folders").json()["error"] == "pending_approval"


def test_members_keep_their_accounts_when_they_first_sign_in_with_georgia_tech(client, team, microsoft):
    # An account from before, under the member's GT address: its check-outs, permissions, and history come along.
    alice = team.member("alice3@gatech.edu", admin=True)
    team.checkin(alice, {"Fin.SLDPRT": b"fin"}, keep=True)
    sign_in(client, microsoft, GEORGE | {"oid": "alice-oid", "preferred_username": "alice3@gatech.edu", "email": ""})
    assert client.get("/api/me").json()["id"] == team.ids["alice3@gatech.edu"]
    [mine] = client.get("/api/checkouts", params={"mine": True}).json()["files"]
    assert mine["path"] == "Fin.SLDPRT"

    # Someone else's GT account with that address (GT gave it to another person, say) doesn't get in to hers.
    client.post("/auth/logout")
    taken = sign_in(client, microsoft, GEORGE | {"oid": "other-oid", "preferred_username": "alice3@gatech.edu"})
    assert (taken.status_code, taken.json()["error"]) == (403, "identity_mismatch")


def test_admins_named_in_the_settings_by_their_georgia_tech_address_are_admins(settings, client, microsoft):
    settings.bootstrap_admins = f"{BOOTSTRAP_ADMIN},gburdell3@gatech.edu"
    sign_in(client, microsoft, GEORGE)
    me = client.get("/api/me").json()
    assert (me["status"], me["is_admin"]) == ("active", True)


def test_a_failed_microsoft_sign_in_says_why(client, monkeypatch, app):
    async def declined(request, **kwargs):
        raise OAuthError(error="access_denied", description="The user declined to consent")

    monkeypatch.setattr(app.state.oauth.create_client("microsoft"), "authorize_access_token", declined)
    failed = client.get("/auth/microsoft/callback", params={"error": "access_denied"}, follow_redirects=False)
    assert (failed.status_code, failed.json()["error"]) == (403, "signin_failed")
    assert failed.json()["message"] == "Georgia Tech sign-in failed: The user declined to consent"
