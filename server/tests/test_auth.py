"""Accounts, the whitelist, approval, browser sessions, and the CLI/add-in sign-in handshake."""

import html
import re
import secrets
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from yjsp_server import auth
from yjsp_server.app import create_app
from yjsp_server.config import Settings, refuse_old_settings
from yjsp_server.db import utcnow
from yjsp_server.models import Token, User, UserStatus

from .conftest import BOOTSTRAP_ADMIN


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_anyone_can_join_while_the_whitelist_is_off(client):
    newbie = client.post("/auth/dev-token", json={"email": "Newbie@X.test"}).json()
    assert (newbie["user"]["email"], newbie["user"]["status"]) == ("newbie@x.test", "active")
    assert client.get("/api/folders", headers=bearer(newbie["token"])).status_code == 200

    # Someone an admin disabled stays out: signing in again doesn't let them back in.
    chief = bearer(client.post("/auth/dev-token", json={"email": BOOTSTRAP_ADMIN}).json()["token"])
    client.patch(f"/api/users/{newbie['user']['id']}", json={"status": "disabled"}, headers=chief)
    again = client.post("/auth/dev-token", json={"email": "newbie@x.test"}).json()
    assert again["user"]["status"] == "disabled"
    assert client.get("/api/folders", headers=bearer(again["token"])).json()["error"] == "disabled"


def test_with_the_whitelist_on_only_emails_on_it_and_invited_people_join(client, team):
    chief = bearer(client.post("/auth/dev-token", json={"email": BOOTSTRAP_ADMIN}).json()["token"])
    me = client.get("/api/me", headers=chief).json()
    assert (me["status"], me["is_admin"]) == ("active", True)
    team.whitelist(chief, True)

    # Turned away, told what to do, with no account made to wait for an admin.
    refused = client.post("/auth/dev-token", json={"email": "Newbie3@gatech.edu"})
    assert (refused.status_code, refused.json()["error"]) == (403, "not_whitelisted")
    assert refused.json()["message"] == (
        "newbie3@gatech.edu isn't on YJSP's whitelist: ask an admin to add it, then sign in again"
    )
    assert [u["email"] for u in client.get("/api/users", headers=chief).json()] == [BOOTSTRAP_ADMIN]

    client.post("/api/whitelist", json={"emails": ["newbie3@gatech.edu"]}, headers=chief)
    newbie = client.post("/auth/dev-token", json={"email": "Newbie3@gatech.edu"}).json()
    assert (newbie["user"]["email"], newbie["user"]["status"]) == ("newbie3@gatech.edu", "active")
    assert client.get("/api/folders", headers=bearer(newbie["token"])).status_code == 200


def test_admins_approve_people_left_waiting_from_before(client, team):
    # Before October 2026, signing in with the whitelist on made an account that waited for an admin.
    chief = team.member("lead@x.test", admin=True)
    waiting = team.member("waiting@x.test", status=UserStatus.PENDING)
    assert client.get("/api/me", headers=waiting).json()["status"] == "pending"
    assert client.get("/api/folders", headers=waiting).json()["error"] == "pending_approval"
    pending = [u["email"] for u in client.get("/api/users", headers=chief).json() if u["status"] == "pending"]
    assert pending == ["waiting@x.test"]

    client.patch(f"/api/users/{team.ids['waiting@x.test']}", json={"status": "active"}, headers=chief)
    assert client.get("/api/folders", headers=waiting).status_code == 200


def test_turning_the_whitelist_off_approves_everyone_waiting(client, team):
    chief = bearer(client.post("/auth/dev-token", json={"email": BOOTSTRAP_ADMIN}).json()["token"])
    team.whitelist(chief, True)
    waiting = team.member("waiting@x.test", status=UserStatus.PENDING)
    team.member("blocked@x.test", status=UserStatus.DISABLED)

    team.whitelist(chief, False)
    statuses = {u["email"]: u["status"] for u in client.get("/api/users", headers=chief).json()}
    assert (statuses["waiting@x.test"], statuses["blocked@x.test"]) == ("active", "disabled")
    assert client.get("/api/folders", headers=waiting).status_code == 200
    log = [(e["action"], e["detail"]) for e in client.get("/api/activity", headers=chief).json()]
    assert log[:2] == [
        ("update_user", {"email": "waiting@x.test", "status": "active"}),
        ("update_settings", {"whitelist": False}),
    ]


def test_the_sign_in_page_says_what_happens_the_first_time(settings):
    # Google sign-in set up alone: nothing asks Google anything until someone clicks the button, and Google makes no
    # accounts, so new people need an invite. (With Georgia Tech's too: test_georgia_tech_sign_in.py.)
    settings.google_client_id, settings.google_client_secret = "id.apps.googleusercontent.com", "secret"
    with TestClient(create_app(settings)) as client:
        page = html.unescape(client.get("/").text)
        assert "<title>Sign in · YJSP</title>" in page
        assert (
            "First time here? An admin needs to invite you first. Google is for accounts made with it before." in page
        )


def test_invited_people_are_active_from_their_first_sign_in(client, team):
    chief = bearer(client.post("/auth/dev-token", json={"email": BOOTSTRAP_ADMIN}).json()["token"])
    team.whitelist(chief, True)
    assert (
        client.post("/api/users", json={"email": "carol@x.test", "name": "Carol"}, headers=chief).json()["status"]
        == "invited"
    )
    carol = client.post("/auth/dev-token", json={"email": "carol@x.test"}).json()["user"]
    assert (carol["status"], carol["name"]) == ("active", "Carol")


def test_admins_keep_a_whitelist_of_georgia_tech_emails(client, team):
    chief = team.member("lead@x.test", admin=True)
    alice = team.member("alice@x.test")

    # A roster as it comes: once each, in lower case, and only GT's addresses, since only GT accounts make accounts.
    roster = ["gburdell3@gatech.edu", " JDoe7@GATECH.edu ", "gburdell3@gatech.edu", "ta@cc.gatech.edu", "mom@gmail.com"]
    added = client.post("/api/whitelist", json={"emails": roster}, headers=chief).json()
    assert added == {
        "added": ["gburdell3@gatech.edu", "jdoe7@gatech.edu", "ta@cc.gatech.edu"],
        "already": [],
        "not_georgia_tech": ["mom@gmail.com"],
    }
    again = client.post("/api/whitelist", json={"emails": ["jdoe7@gatech.edu", "new1@gatech.edu"]}, headers=chief)
    assert again.json() == {"added": ["new1@gatech.edu"], "already": ["jdoe7@gatech.edu"], "not_georgia_tech": []}
    typo = client.post("/api/whitelist", json={"emails": ["new2@gatech.edu", "gburdell3"]}, headers=chief)
    assert (typo.status_code, typo.json()["error"]) == (400, "bad_email")  # and new2 isn't added either

    # Each email with its account once it has one: an invite under it, say.
    client.post("/api/users", json={"email": "new1@gatech.edu", "name": "New One"}, headers=chief)
    listed = {e["email"]: e for e in client.get("/api/whitelist", headers=chief).json()}
    assert list(listed) == ["gburdell3@gatech.edu", "jdoe7@gatech.edu", "new1@gatech.edu", "ta@cc.gatech.edu"]
    assert listed["new1@gatech.edu"]["account"]["status"] == "invited"
    assert listed["jdoe7@gatech.edu"]["account"] is None

    gone = listed["gburdell3@gatech.edu"]["id"]
    assert client.delete(f"/api/whitelist/{gone}", headers=chief).status_code == 204
    missing = client.delete(f"/api/whitelist/{gone}", headers=chief)
    assert (missing.status_code, missing.json()["error"]) == (404, "not_on_whitelist")
    assert "gburdell3@gatech.edu" not in [e["email"] for e in client.get("/api/whitelist", headers=chief).json()]

    # Members neither see it nor change it.
    for attempt in (
        client.get("/api/whitelist", headers=alice),
        client.post("/api/whitelist", json={"emails": ["alice9@gatech.edu"]}, headers=alice),
        client.delete(f"/api/whitelist/{listed['jdoe7@gatech.edu']['id']}", headers=alice),
    ):
        assert (attempt.status_code, attempt.json()["error"]) == (403, "admin_only")

    log = [(e["action"], e["detail"]) for e in client.get("/api/activity", headers=chief).json()]
    assert log[:3] == [
        ("remove_from_whitelist", {"email": "gburdell3@gatech.edu"}),
        ("invite_user", {"email": "new1@gatech.edu"}),
        ("add_to_whitelist", {"emails": ["new1@gatech.edu"]}),
    ]


def test_unknown_or_revoked_tokens_are_rejected(client):
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/me", headers=bearer("yjsp_nope")).status_code == 401
    token = client.post("/auth/dev-token", json={"email": BOOTSTRAP_ADMIN}).json()["token"]
    [mine] = client.get("/api/tokens", headers=bearer(token)).json()
    assert client.delete(f"/api/tokens/{mine['id']}", headers=bearer(token)).status_code == 204
    assert client.get("/api/me", headers=bearer(token)).status_code == 401


def test_browser_session_needs_the_csrf_header_to_change_things(client):
    signed_in = client.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN, "next": "/"}, follow_redirects=False)
    assert signed_in.status_code == 303
    assert client.get("/api/me").json()["email"] == BOOTSTRAP_ADMIN  # the cookie works for reads
    blocked = client.post("/api/folders", json={"path": "Payload"})
    assert (blocked.status_code, blocked.json()["error"]) == (403, "csrf")
    assert client.post("/api/folders", json={"path": "Payload"}, headers={"X-YJSP-Request": "1"}).status_code == 201

    client.post("/auth/logout", follow_redirects=False)
    assert client.get("/api/me").status_code == 401


def test_browsers_signed_in_before_yjsp_stay_signed_in(client):
    # A browser signed in when the site was CVC has its session under the old cookie, and a tab open since then sends
    # the old header: both still work until the session runs out, and signing out ends it.
    client.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN}, follow_redirects=False)
    secret = client.cookies["yjsp_session"]
    client.cookies.clear()
    client.cookies.set("cvc_session", secret)
    assert client.get("/api/me").json()["email"] == BOOTSTRAP_ADMIN
    assert client.post("/api/folders", json={"path": "Old tab"}, headers={"X-CVC-Request": "1"}).status_code == 201

    signed_out = client.post("/auth/logout", follow_redirects=False)
    assert 'cvc_session=""' in signed_out.headers["set-cookie"]
    client.cookies.set("cvc_session", secret)  # kept anyway: it's revoked
    assert client.get("/api/me").status_code == 401


def test_sign_in_never_redirects_off_site(client):
    for target in ("https://evil.test/", "//evil.test/", "/\\evil.test"):
        response = client.get("/auth/dev-login", params={"email": "a@x.test", "next": target}, follow_redirects=False)
        assert response.headers["location"] == "/"


def _client_request(verifier: str) -> dict[str, str | int]:
    return {"port": 51234, "state": "st4te", "challenge": auth.pkce_challenge(verifier), "name": "vault CLI on LAB-PC"}


def _approve(client: TestClient, params) -> dict[str, list[str]]:
    page = client.get("/auth/client", params=params)
    assert page.status_code == 200, page.text
    assert "vault CLI on LAB-PC" in page.text
    approval = re.search(r'name="approval" value="([^"]+)"', page.text).group(1)
    form = {**params, "approval": approval}
    redirect = client.post("/auth/client/approve", data=form, follow_redirects=False)
    assert redirect.status_code == 303
    location = urlsplit(redirect.headers["location"])
    assert (location.scheme, location.netloc, location.path) == ("http", "127.0.0.1:51234", "/callback")
    return parse_qs(location.query)


def test_client_sign_in_handshake(client):
    verifier = secrets.token_urlsafe(48)
    params = _client_request(verifier)

    # Not signed in yet: the browser goes to the sign-in page first, then comes back.
    first = client.get("/auth/client", params=params, follow_redirects=False)
    assert first.headers["location"].startswith("/?next=%2Fauth%2Fclient%3F")

    client.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN}, follow_redirects=False)
    query = _approve(client, params)
    assert query["state"] == ["st4te"]

    wrong = client.post("/auth/client/token", json={"code": query["code"][0], "verifier": "x" * 43})
    assert wrong.status_code == 403
    burned = client.post("/auth/client/token", json={"code": query["code"][0], "verifier": verifier})
    assert burned.status_code == 403  # one attempt per code

    query = _approve(client, params)
    issued = client.post("/auth/client/token", json={"code": query["code"][0], "verifier": verifier})
    assert issued.status_code == 200, issued.text
    client.cookies.clear()
    me = client.get("/api/me", headers=bearer(issued.json()["token"])).json()
    assert me["email"] == BOOTSTRAP_ADMIN
    names = [t["name"] for t in client.get("/api/tokens", headers=bearer(issued.json()["token"])).json()]
    assert "vault CLI on LAB-PC" in names


def test_client_approval_form_cannot_be_forged(client):
    params = _client_request(secrets.token_urlsafe(48))
    client.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN}, follow_redirects=False)
    forged = client.post("/auth/client/approve", data={**params, "approval": "made-up"}, follow_redirects=False)
    assert forged.status_code == 403


def production_settings(tmp_path, **overrides) -> Settings:
    values = {
        "env": "production",
        "database_url": f"sqlite:///{tmp_path / 'prod.db'}",
        "vault_dir": tmp_path / "vault",
        "secret_key": "s" * 40,
        "google_client_id": "id.apps.googleusercontent.com",
        "google_client_secret": "secret",
        "public_url": "https://yjsp.rocketry.test",
    }
    return Settings(_env_file=None, **(values | overrides))


def test_production_has_no_dev_sign_in(tmp_path):
    with TestClient(create_app(production_settings(tmp_path))) as prod:
        assert prod.post("/auth/dev-token", json={"email": "a@x.test"}).status_code == 404
        assert prod.get("/auth/dev-login", params={"email": "a@x.test"}).status_code == 404


@pytest.mark.parametrize(
    "overrides",
    [{"dev_auth": True}, {"secret_key": "short"}, {"google_client_secret": ""}, {"public_url": "http://yjsp.test"}],
)
def test_production_refuses_unsafe_settings(tmp_path, overrides):
    with pytest.raises(RuntimeError):
        create_app(production_settings(tmp_path, **overrides))


def test_production_can_offer_georgia_tech_sign_in_alone(tmp_path):
    gt_only = {"microsoft_client_id": "app-id", "microsoft_client_secret": "secret"}
    no_google = {"google_client_id": "", "google_client_secret": ""}
    with TestClient(create_app(production_settings(tmp_path, **gt_only, **no_google))) as prod:
        page = prod.get("/").text
        assert "Sign in with Georgia Tech" in page and "Sign in with Google" not in page
    with pytest.raises(RuntimeError, match="set both YJSP_MICROSOFT_CLIENT_ID and YJSP_MICROSOFT_CLIENT_SECRET"):
        create_app(production_settings(tmp_path, microsoft_client_id="app-id"))
    with pytest.raises(RuntimeError, match="set up a sign-in"):
        create_app(production_settings(tmp_path, **no_google))


def test_settings_from_before_yjsp_are_refused(tmp_path):
    # Read as YJSP_ settings, a .env of CVC_ ones would start a development server on a new, empty database.
    env_file = tmp_path / ".env"
    env_file.write_text("YJSP_DEV_AUTH=1\n# CVC_ENV=production, as it was\n")
    refuse_old_settings({"PATH": "/usr/bin"}, env_file)  # a comment isn't a setting
    with pytest.raises(RuntimeError, match="rename CVC_PORT"):
        refuse_old_settings({"CVC_PORT": "8100"}, env_file)
    env_file.write_text("export CVC_ENV=production\nCVC_BLOB_DIR=/srv/data/blobs\n")
    with pytest.raises(RuntimeError, match="rename CVC_BLOB_DIR, CVC_ENV .*YJSP_VAULT_DIR"):
        refuse_old_settings({}, env_file)


def test_admins_see_when_people_were_last_on_and_who_is_on_now(app, client, team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    team.member("idle@x.test")  # never used Vault
    client.get("/api/folders", headers=alice)

    people = {u["email"]: u for u in client.get("/api/users", headers=chief).json()}
    assert people["alice@x.test"]["active_now"] is True
    assert utcnow() - datetime.fromisoformat(people["alice@x.test"]["last_active_at"]) < timedelta(minutes=1)
    assert (people["idle@x.test"]["last_active_at"], people["idle@x.test"]["active_now"]) == (None, False)

    # Ten minutes on, without using it since: when she was last on, but not on now.
    with app.state.sessionmaker() as db:
        db.execute(
            update(Token)
            .where(Token.user_id == team.ids["alice@x.test"])
            .values(last_used_at=utcnow() - timedelta(minutes=10))
        )
        db.commit()
    later = {u["email"]: u for u in client.get("/api/users", headers=chief).json()}["alice@x.test"]
    assert later["active_now"] is False
    ago = utcnow() - datetime.fromisoformat(later["last_active_at"])
    assert timedelta(minutes=9) < ago < timedelta(minutes=11)

    # Everyone else sees who the members are, not when they're on.
    seen = {u["email"]: u for u in client.get("/api/users", headers=alice).json()}
    assert (seen["chief@x.test"]["last_active_at"], seen["chief@x.test"]["active_now"]) == (None, False)


def test_admins_see_how_long_people_have_had_the_web_app_open(app, client, team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    with app.state.sessionmaker() as db:
        browser = bearer(
            auth.issue_token(db, db.get(User, team.ids["alice@x.test"]), kind=auth.SESSION, name="Firefox")
        )

    def used_ago(minutes: int, kind: str = auth.SESSION) -> None:
        with app.state.sessionmaker() as db:
            db.execute(
                update(Token)
                .where(Token.user_id == team.ids["alice@x.test"], Token.kind == kind)
                .values(last_used_at=utcnow() - timedelta(minutes=minutes))
            )
            db.commit()

    def site_seconds() -> int:
        return {u["email"]: u for u in client.get("/api/users", headers=chief).json()}["alice@x.test"]["site_seconds"]

    # Opening the page starts a visit; nothing to count yet.
    client.get("/api/me", headers=browser)
    assert site_seconds() == 0

    # The page asks again two minutes on: she was here all along.
    used_ago(2)
    client.get("/api/me", headers=browser)
    assert 115 <= site_seconds() <= 125

    # An hour away isn't time on the site, and neither is using the CLI or the add-in.
    used_ago(60)
    client.get("/api/me", headers=browser)
    used_ago(2, kind=auth.CLIENT)
    client.get("/api/folders", headers=alice)
    assert 115 <= site_seconds() <= 125

    # Everyone else doesn't see it.
    seen = {u["email"]: u for u in client.get("/api/users", headers=alice).json()}
    assert seen["chief@x.test"]["site_seconds"] is None


def test_people_change_their_own_name_and_signing_in_with_google_again_keeps_it(app, client, team, settings):
    alice = team.member("alice@x.test")
    changed = client.patch("/api/me", json={"name": "  Ally Smith  "}, headers=alice)
    assert changed.status_code == 200, changed.text
    assert changed.json()["name"] == "Ally Smith"
    assert client.get("/api/me", headers=alice).json()["name"] == "Ally Smith"
    assert client.patch("/api/me", json={"name": "   "}, headers=alice).json()["error"] == "bad_name"
    assert client.patch("/api/me", json={"name": "x" * 201}, headers=alice).status_code == 422

    # Google's name for her doesn't come back when she signs in again.
    with app.state.sessionmaker() as db:
        user = auth.sign_in(
            db, settings, subject="google-alice", email="alice@x.test", name="Alice", email_verified=True
        )
        assert user.name == "Ally Smith"

    # The activity feed says so.
    chief = team.member("chief@x.test", admin=True)
    events = client.get("/api/activity", headers=chief).json()
    renamed = [e for e in events if e["action"] == "update_user" and e["detail"].get("name") == "Ally Smith"]
    assert len(renamed) == 1
