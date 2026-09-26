"""The web app's page and assets: served to people who are signed in and approved."""

import pytest

from .conftest import BOOTSTRAP_ADMIN


@pytest.fixture
def built(settings):
    """A stand-in for the web app's build (web/dist)."""
    (settings.web_dir / "assets").mkdir(parents=True)
    (settings.web_dir / "index.html").write_text("<!doctype html><title>CVC web app</title>")
    (settings.web_dir / "assets" / "index-1a2b3c.js").write_text("console.log('cvc')")
    return settings.web_dir


def sign_in(client, email: str) -> None:
    client.get("/auth/dev-login", params={"email": email}, follow_redirects=False)


def test_signed_in_people_get_the_web_app(built, client):
    sign_in(client, BOOTSTRAP_ADMIN)
    for page in ("/", "/files/Structures/Fins", "/file/12", "/admin/users"):
        response = client.get(page)
        assert (response.status_code, response.text) == (200, "<!doctype html><title>CVC web app</title>"), page
        assert response.headers["cache-control"] == "no-cache"
    assert client.get("/assets/index-1a2b3c.js").text == "console.log('cvc')"


def test_pages_ask_for_sign_in_first_and_come_back(built, client):
    first = client.get("/file/12", follow_redirects=False)
    assert (first.status_code, first.headers["location"]) == (303, "/?next=%2Ffile%2F12")
    assert "Development sign-in" in client.get(first.headers["location"]).text

    signed_in = client.get(
        "/auth/dev-login", params={"email": BOOTSTRAP_ADMIN, "next": "/file/12"}, follow_redirects=False
    )
    assert signed_in.headers["location"] == "/file/12"
    # Already signed in, the home page carries on to where you were going.
    onward = client.get("/", params={"next": "/file/12"}, follow_redirects=False)
    assert (onward.status_code, onward.headers["location"]) == (303, "/file/12")


def test_people_waiting_for_approval_see_the_home_page(built, client):
    sign_in(client, "newbie@x.test")
    assert client.get("/activity", follow_redirects=False).status_code == 303
    assert "An admin needs to approve your account" in client.get("/").text


def test_unknown_api_paths_are_errors_not_pages(built, client):
    sign_in(client, BOOTSTRAP_ADMIN)
    for path in ("/api/nope", "/auth/nope", "/assets/missing.js"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert "CVC web app" not in response.text


def test_without_a_build_the_home_page_says_so(client):
    sign_in(client, BOOTSTRAP_ADMIN)
    assert "web app isn't built on this server" in client.get("/").text
    assert client.get("/file/12").status_code == 404
