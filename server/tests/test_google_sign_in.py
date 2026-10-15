"""Signing in with Google: to accounts that are there already. Since October 2026 it makes none: new people join
with their Georgia Tech account (test_georgia_tech_sign_in.py).

Google's half (its login page, and trading the code for a signed ID token, which authlib checks) can't run offline:
the `google` fixture stands in for it with the claims a checked ID token would have.
"""

import html

import pytest
from fastapi.testclient import TestClient

ALUM = {"sub": "alum-sub", "email": "Alum@gmail.com", "email_verified": True, "name": "Al Umni"}


@pytest.fixture
def settings(settings):
    settings.google_client_id, settings.google_client_secret = "id.apps.googleusercontent.com", "secret"
    return settings


@pytest.fixture
def google(app, monkeypatch) -> dict[str, object]:
    """What Google says about whoever signs in next: set its claims."""
    says: dict[str, object] = {}

    async def trade_the_code(request, **kwargs):
        return {"access_token": "...", "id_token": "...", "userinfo": dict(says)}

    monkeypatch.setattr(app.state.oauth.create_client("google"), "authorize_access_token", trade_the_code)
    return says


def sign_in(client: TestClient, google: dict[str, object], claims: dict[str, object], next_path: str = "/"):
    """Click "Sign in with Google", sign in on Google's page, and come back with these claims."""
    client.get("/auth/login", params={"next": next_path}, follow_redirects=False)
    google.clear()
    google.update(claims)
    return client.get("/auth/callback", params={"code": "c0de", "state": "st4te"}, follow_redirects=False)


def test_google_signs_in_to_an_account_that_is_there_already(client, team, google):
    team.member("alum@gmail.com")  # made with Google before
    back = sign_in(client, google, ALUM, "/yorg")
    assert (back.status_code, back.headers["location"]) == (303, "/yorg")
    me = client.get("/api/me").json()
    assert (me["id"], me["status"]) == (team.ids["alum@gmail.com"], "active")


def test_google_makes_no_new_accounts_even_with_the_whitelist_off(client, team, google):
    chief = team.member("lead@x.test", admin=True)
    refused = sign_in(client, google, ALUM)
    assert refused.status_code == 403
    assert (
        "alum@gmail.com has no YJSP account, and Google doesn't make new ones: sign in with your Georgia Tech account, "
        "or ask an admin to invite this email." in html.unescape(refused.text)
    )
    assert client.get("/api/me").status_code == 401
    assert [u["email"] for u in client.get("/api/users", headers=chief).json()] == ["lead@x.test"]

    # An admin's invite is an account already: Google signs in to it.
    client.post("/api/users", json={"email": "alum@gmail.com", "name": "Al"}, headers=chief)
    sign_in(client, google, ALUM)
    me = client.get("/api/me").json()
    assert (me["email"], me["name"], me["status"]) == ("alum@gmail.com", "Al", "active")


def test_admins_named_in_the_settings_get_in_with_google(settings, client, google):
    settings.bootstrap_admins = "alum@gmail.com"
    sign_in(client, google, ALUM)
    me = client.get("/api/me").json()
    assert (me["email"], me["status"], me["is_admin"]) == ("alum@gmail.com", "active", True)


def test_google_accounts_must_have_a_verified_email(client, team, google):
    team.member("alum@gmail.com")
    refused = sign_in(client, google, ALUM | {"email_verified": False})
    assert refused.status_code == 403
    assert "Your Google account's email address isn't verified." in html.unescape(refused.text)
    assert client.get("/api/me").status_code == 401
