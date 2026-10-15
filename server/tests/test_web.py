"""The web app's page and assets: served to people who are signed in and approved."""

import html
from urllib.parse import urlencode

import pytest

from yjsp_server.models import UserStatus

from .conftest import BOOTSTRAP_ADMIN


@pytest.fixture
def built(settings):
    """A stand-in for the web app's build (web/dist)."""
    (settings.web_dir / "assets").mkdir(parents=True)
    (settings.web_dir / "index.html").write_text("<!doctype html><title>YJSP web app</title>")
    (settings.web_dir / "assets" / "index-1a2b3c.js").write_text("console.log('yjsp')")
    return settings.web_dir


def sign_in(client, email: str) -> None:
    client.get("/auth/dev-login", params={"email": email}, follow_redirects=False)


def test_signed_in_people_get_the_web_app(built, client):
    sign_in(client, BOOTSTRAP_ADMIN)
    for page in ("/", "/files/Structures/Fins", "/file/12", "/admin/users"):
        response = client.get(page)
        assert (response.status_code, response.text) == (200, "<!doctype html><title>YJSP web app</title>"), page
        assert response.headers["cache-control"] == "no-cache"
    assert client.get("/assets/index-1a2b3c.js").text == "console.log('yjsp')"


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


def test_signing_in_comes_back_to_the_page_with_its_query(built, client):
    # A link to Yorg's plots holds them in its query: someone not signed in yet still gets them after signing in.
    page = "/yorg/datasets/5?plots=s0pNzMtXqA4tTi2y0jA0sgAA"
    first = client.get(page, follow_redirects=False)
    assert (first.status_code, first.headers["location"]) == (303, "/?" + urlencode({"next": page}))
    assert f'value="{html.escape(page)}"' in client.get(first.headers["location"]).text  # the sign-in form keeps it

    signed_in = client.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN, "next": page}, follow_redirects=False)
    assert signed_in.headers["location"] == page


def test_a_link_too_long_to_keep_through_sign_in_comes_back_to_its_page(built, client):
    # Google's round trip keeps where to come back to in a cookie of 4 KB at most: a link with a big layout in its
    # query comes back to its page, without its plots, rather than break signing in.
    page = "/yorg/datasets/5?plots=" + "A" * 2500
    first = client.get(page, follow_redirects=False)
    sign_in_page = client.get(first.headers["location"]).text
    assert 'value="/yorg/datasets/5"' in sign_in_page
    assert "plots=" not in sign_in_page
    signed_in = client.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN, "next": page}, follow_redirects=False)
    assert signed_in.headers["location"] == "/yorg/datasets/5"


def test_people_waiting_for_approval_see_the_home_page(built, client, team):
    team.whitelist(team.member("chief@x.test", admin=True), True)
    team.member("newbie@x.test", status=UserStatus.PENDING)  # left waiting from before sign-ups were turned away
    sign_in(client, "newbie@x.test")
    assert client.get("/activity", follow_redirects=False).status_code == 303
    assert "An admin needs to approve your account" in client.get("/").text


def test_unknown_api_paths_are_errors_not_pages(built, client):
    sign_in(client, BOOTSTRAP_ADMIN)
    for path in ("/api/nope", "/auth/nope", "/assets/missing.js"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert "YJSP web app" not in response.text


def test_without_a_build_the_home_page_says_so(client):
    sign_in(client, BOOTSTRAP_ADMIN)
    assert "web app isn't built on this server" in client.get("/").text
    assert client.get("/file/12").status_code == 404
