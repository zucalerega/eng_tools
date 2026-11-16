"""Sign-in for another school than Georgia Tech (YJSP_SCHOOL_NAME, YJSP_SCHOOL_DOMAINS, YJSP_MICROSOFT_TENANT,
YJSP_GOOGLE_MAKES_ACCOUNTS): its accounts, through Microsoft or Google, make accounts, and no one else's do. Georgia
Tech's are the defaults, which test_georgia_tech_sign_in.py and test_google_sign_in.py hold YJSP to.

Microsoft's and Google's halves can't run offline: `says` stands in for both, with the claims a checked ID token would
have, as those tests' fixtures do."""

import html
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from yjsp_server import config
from yjsp_server.app import create_app
from yjsp_server.config import Settings

from .conftest import BOOTSTRAP_ADMIN

PURDUE = "11111111-2222-3333-4444-555555555555"
PETE = {"tid": PURDUE, "oid": "pete-oid", "preferred_username": "pete@purdue.edu", "name": "Purdue Pete"}


@pytest.fixture
def settings(settings):
    settings.school_name, settings.school_domains, settings.microsoft_tenant = "Purdue", "purdue.edu", PURDUE
    return settings


def with_sign_ins(settings: Settings, *, microsoft: bool = False, google: bool = False, makes: bool = False):
    changed = {"google_makes_accounts": makes}
    if microsoft:
        changed |= {"microsoft_client_id": "app-id", "microsoft_client_secret": "app-secret"}
    if google:
        changed |= {"google_client_id": "id.apps.googleusercontent.com", "google_client_secret": "secret"}
    return create_app(settings.model_copy(update=changed))


def says(app, monkeypatch, provider: str) -> dict[str, object]:
    """What Microsoft or Google says about whoever signs in next: set its claims."""
    claims: dict[str, object] = {}

    async def trade_the_code(request, **kwargs):
        return {"access_token": "...", "id_token": "...", "userinfo": dict(claims)}

    monkeypatch.setattr(app.state.oauth.create_client(provider), "authorize_access_token", trade_the_code)
    return claims


def sign_in(client: TestClient, claims: dict[str, object], said: dict[str, object], provider: str):
    start, back = (
        ("/auth/microsoft/login", "/auth/microsoft/callback")
        if provider == "microsoft"
        else ("/auth/login", "/auth/callback")
    )
    client.get(start, follow_redirects=False)
    claims.clear()
    claims.update(said)
    return client.get(back, params={"code": "c0de", "state": "st4te"}, follow_redirects=False)


def test_another_schools_microsoft_accounts_join(settings, monkeypatch):
    app = with_sign_ins(settings, microsoft=True)
    with TestClient(app) as client:
        page = html.unescape(client.get("/").text)
        assert "Sign in with Purdue" in page and "Georgia Tech" not in page
        assert "First time here? Sign in with your Purdue account to join." in page
        started = urlsplit(client.get("/auth/microsoft/login", follow_redirects=False).headers["location"])
        assert started.path == f"/{PURDUE}/oauth2/v2.0/authorize"
        assert parse_qs(started.query)["domain_hint"] == ["purdue.edu"]

        microsoft = says(app, monkeypatch, "microsoft")
        assert sign_in(client, microsoft, PETE, "microsoft").status_code == 303
        me = client.get("/api/me").json()
        assert (me["email"], me["name"], me["status"]) == ("pete@purdue.edu", "Purdue Pete", "active")


def test_no_other_schools_accounts_do(settings, monkeypatch):
    app = with_sign_ins(settings, microsoft=True)
    with TestClient(app) as client:
        microsoft = says(app, monkeypatch, "microsoft")
        for claims in (
            PETE | {"tid": config.GT_TENANT},  # another school's directory
            PETE | {"preferred_username": "pete@gatech.edu"},  # an address that isn't the school's
            PETE | {"preferred_username": "pete@purdue.edu.evil.test"},
        ):
            refused = sign_in(client, microsoft, claims, "microsoft")
            assert refused.status_code == 403, claims
            assert (
                "Only Purdue accounts sign in this way: sign in with your Purdue account (an address at purdue.edu)"
                in html.unescape(refused.text)
            )


def test_google_makes_the_schools_accounts_where_they_are_googles(settings, monkeypatch, team):
    app = with_sign_ins(settings, google=True, makes=True)
    with TestClient(app) as client:
        page = html.unescape(client.get("/").text)
        assert "First time here? Sign in with Google, with your Purdue address to join." in page
        assert "Google is for accounts made with it before" not in page

        google = says(app, monkeypatch, "google")
        student = {"sub": "s-1", "email": "Student@CS.Purdue.edu", "email_verified": True, "name": "A Student"}
        assert sign_in(client, google, student, "google").status_code == 303
        assert client.get("/api/me").json()["email"] == "student@cs.purdue.edu"  # a department's address too
        client.cookies.clear()

        outsider = {"sub": "o-1", "email": "someone@gmail.com", "email_verified": True, "name": "Someone"}
        refused = sign_in(client, google, outsider, "google")
        assert refused.status_code == 403
        assert (
            "someone@gmail.com has no YJSP account, and only Purdue addresses make one: sign in with yours, or ask an "
            "admin to invite this email" in html.unescape(refused.text)
        )


def test_without_googles_making_them_google_makes_none(settings, monkeypatch):
    app = with_sign_ins(settings, google=True)
    with TestClient(app) as client:
        google = says(app, monkeypatch, "google")
        student = {"sub": "s-1", "email": "student@purdue.edu", "email_verified": True, "name": "A Student"}
        refused = sign_in(client, google, student, "google")
        assert refused.status_code == 403
        assert "Google doesn't make new ones: sign in with your Purdue account" in html.unescape(refused.text)
        assert "An admin needs to invite you first." in client.get("/").text


def test_the_whitelist_takes_the_schools_addresses(settings, client, team):
    chief = team.member("chief@purdue.edu", admin=True)
    added = client.post(
        "/api/whitelist", json={"emails": ["a1@purdue.edu", "b2@ecn.purdue.edu", "c3@gatech.edu"]}, headers=chief
    ).json()
    assert added == {
        "added": ["a1@purdue.edu", "b2@ecn.purdue.edu"],
        "already": [],
        "not_georgia_tech": ["c3@gatech.edu"],
    }
    site = client.get("/api/settings", headers=chief).json()
    assert (site["school_name"], site["school_domains"]) == ("Purdue", ["purdue.edu"])


def test_with_no_domains_people_join_only_by_invite(settings, monkeypatch):
    settings.school_domains = ""
    app = with_sign_ins(settings, microsoft=True, google=True, makes=True)
    with TestClient(app) as client:
        microsoft = says(app, monkeypatch, "microsoft")
        assert sign_in(client, microsoft, PETE, "microsoft").status_code == 403
        # The bootstrap admin still gets in, with Google, to invite everyone else.
        google = says(app, monkeypatch, "google")
        chief = {"sub": "chief-sub", "email": BOOTSTRAP_ADMIN, "email_verified": True, "name": "Chief"}
        assert sign_in(client, google, chief, "google").status_code == 303
        assert client.get("/api/me").json()["is_admin"] is True


def test_another_schools_site_needs_its_own_directory_for_microsoft(settings):
    production = settings.model_copy(
        update={
            "env": "production",
            "dev_auth": False,
            "secret_key": "s" * 40,
            "public_url": "https://tools.example.edu",
            "microsoft_client_id": "app-id",
            "microsoft_client_secret": "app-secret",
        }
    )
    production.check()  # Purdue's directory, for Purdue's addresses
    with pytest.raises(RuntimeError, match="set YJSP_MICROSOFT_TENANT to the Directory"):
        production.model_copy(update={"microsoft_tenant": config.GT_TENANT}).check()  # left as Georgia Tech's
    # Georgia Tech's own, as YJSP's is; and Google's alone needs no directory.
    production.model_copy(update={"microsoft_tenant": config.GT_TENANT, "school_domains": "gatech.edu"}).check()
    production.model_copy(
        update={
            "microsoft_tenant": config.GT_TENANT,
            "microsoft_client_id": "",
            "microsoft_client_secret": "",
            "google_client_id": "id.apps.googleusercontent.com",
            "google_client_secret": "secret",
        }
    ).check()


def test_the_schools_settings_are_checked():
    for bad in ({"microsoft_tenant": "purdue.edu"}, {"school_domains": "purdue"}, {"school_domains": "@purdue.edu"}):
        with pytest.raises(ValueError):
            Settings(_env_file=None, **bad)
    both = Settings(_env_file=None, school_domains="purdue.edu, pnw.edu")
    assert both.school_domain_list == ["purdue.edu", "pnw.edu"]
    assert Settings(_env_file=None, school_domains="").school_domain_list == []
