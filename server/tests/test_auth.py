"""Accounts, approval, browser sessions, and the CLI/add-in sign-in handshake."""

import re
import secrets
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from cvc_server import auth
from cvc_server.app import create_app
from cvc_server.config import Settings

from .conftest import BOOTSTRAP_ADMIN


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_new_accounts_wait_for_an_admin(client):
    newbie = client.post("/auth/dev-token", json={"email": "Newbie@X.test"}).json()
    assert (newbie["user"]["email"], newbie["user"]["status"]) == ("newbie@x.test", "pending")
    headers = bearer(newbie["token"])
    assert client.get("/api/me", headers=headers).json()["status"] == "pending"
    assert client.get("/api/folders", headers=headers).json()["error"] == "pending_approval"

    chief = bearer(client.post("/auth/dev-token", json={"email": BOOTSTRAP_ADMIN}).json()["token"])
    me = client.get("/api/me", headers=chief).json()
    assert (me["status"], me["is_admin"]) == ("active", True)
    waiting = [u for u in client.get("/api/users", headers=chief).json() if u["status"] == "pending"]
    assert [u["email"] for u in waiting] == ["newbie@x.test"]

    client.patch(f"/api/users/{newbie['user']['id']}", json={"status": "active"}, headers=chief)
    assert client.get("/api/folders", headers=headers).status_code == 200


def test_invited_people_are_active_from_their_first_sign_in(client):
    chief = bearer(client.post("/auth/dev-token", json={"email": BOOTSTRAP_ADMIN}).json()["token"])
    assert (
        client.post("/api/users", json={"email": "carol@x.test", "name": "Carol"}, headers=chief).json()["status"]
        == "invited"
    )
    carol = client.post("/auth/dev-token", json={"email": "carol@x.test"}).json()["user"]
    assert (carol["status"], carol["name"]) == ("active", "Carol")


def test_unknown_or_revoked_tokens_are_rejected(client):
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/me", headers=bearer("cvc_nope")).status_code == 401
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
    assert client.post("/api/folders", json={"path": "Payload"}, headers={"X-CVC-Request": "1"}).status_code == 201

    client.post("/auth/logout", follow_redirects=False)
    assert client.get("/api/me").status_code == 401


def test_sign_in_never_redirects_off_site(client):
    for target in ("https://evil.test/", "//evil.test/", "/\\evil.test"):
        response = client.get("/auth/dev-login", params={"email": "a@x.test", "next": target}, follow_redirects=False)
        assert response.headers["location"] == "/"


def _client_request(verifier: str) -> dict[str, str | int]:
    return {"port": 51234, "state": "st4te", "challenge": auth.pkce_challenge(verifier), "name": "cvc CLI on LAB-PC"}


def _approve(client: TestClient, params) -> dict[str, list[str]]:
    page = client.get("/auth/client", params=params)
    assert page.status_code == 200, page.text
    assert "cvc CLI on LAB-PC" in page.text
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

    # Not signed in yet: the browser goes to sign-in first, then comes back.
    first = client.get("/auth/client", params=params, follow_redirects=False)
    assert first.headers["location"].startswith("/auth/login?next=%2Fauth%2Fclient%3F")

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
    assert "cvc CLI on LAB-PC" in names


def test_client_approval_form_cannot_be_forged(client):
    params = _client_request(secrets.token_urlsafe(48))
    client.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN}, follow_redirects=False)
    forged = client.post("/auth/client/approve", data={**params, "approval": "made-up"}, follow_redirects=False)
    assert forged.status_code == 403


def production_settings(tmp_path, **overrides) -> Settings:
    values = {
        "env": "production",
        "database_url": f"sqlite:///{tmp_path / 'prod.db'}",
        "blob_dir": tmp_path / "blobs",
        "secret_key": "s" * 40,
        "google_client_id": "id.apps.googleusercontent.com",
        "google_client_secret": "secret",
        "public_url": "https://cvc.rocketry.test",
    }
    return Settings(_env_file=None, **(values | overrides))


def test_production_has_no_dev_sign_in(tmp_path):
    with TestClient(create_app(production_settings(tmp_path))) as prod:
        assert prod.post("/auth/dev-token", json={"email": "a@x.test"}).status_code == 404
        assert prod.get("/auth/dev-login", params={"email": "a@x.test"}).status_code == 404


@pytest.mark.parametrize(
    "overrides",
    [{"dev_auth": True}, {"secret_key": "short"}, {"google_client_secret": ""}, {"public_url": "http://cvc.test"}],
)
def test_production_refuses_unsafe_settings(tmp_path, overrides):
    with pytest.raises(RuntimeError):
        create_app(production_settings(tmp_path, **overrides))
