"""Whose site it is (YJSP_SITE_NAME, YJSP_TEAM_NAME, YJSP_BRAND_DIR): the names and the logo the pages show, for a team
that runs the site for itself. YJSP's are the defaults, which the rest of the tests see."""

import pytest
from fastapi.testclient import TestClient

from yjsp_server.app import create_app
from yjsp_server.config import Settings

from .conftest import BOOTSTRAP_ADMIN
from .fake_claude import FakeClaude
from .test_assistant import QUESTION, ask

PAGE = (
    '<!doctype html>\n<html><head><title>Vault</title>\n<script src="./assets/index-1a2b3c.js"></script></head></html>'
)


@pytest.fixture
def theirs(settings, tmp_path) -> Settings:
    """Another team's site: its names, and its logo in a folder of its own."""
    brand = tmp_path / "brand"
    brand.mkdir()
    (brand / "logo-on-light.png").write_bytes(b"\x89PNG their light logo")
    (settings.web_dir).mkdir(parents=True)
    (settings.web_dir / "index.html").write_text(PAGE)
    return settings.model_copy(update={"site_name": "RPL", "team_name": "Rocket Propulsion Lab", "brand_dir": brand})


@pytest.fixture
def their_site(theirs):
    with TestClient(create_app(theirs)) as client:
        yield client


def test_the_sign_in_pages_name_the_team(their_site):
    page = their_site.get("/").text
    assert "<title>Sign in · RPL</title>" in page
    assert '<p class="org">Rocket Propulsion Lab</p>' in page
    assert 'aria-label="RPL"' in page
    assert "YJSP" not in page and "Yellow Jacket" not in page


def test_the_help_names_the_team(their_site):
    page = their_site.get("/help").text
    assert "<title>Help · RPL</title>" in page
    assert "RPL is the Rocket Propulsion Lab's engineering tools" in page
    markdown = their_site.get("/help.md").text
    assert markdown.startswith("# RPL help\n")
    assert "RPL is the Rocket Propulsion Lab's engineering tools" in " ".join(markdown.split())
    llms = their_site.get("/llms.txt").text
    assert llms.startswith("# RPL\n") and "The Rocket Propulsion Lab's engineering tools" in llms


def test_the_web_app_is_told_whose_site_it_is(their_site):
    their_site.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN}, follow_redirects=False)
    page = their_site.get("/vault").text
    assert '<meta name="yjsp-site" content="RPL">' in page
    assert '<meta name="yjsp-team" content="Rocket Propulsion Lab">' in page
    assert '<meta name="yjsp-logo" content="yes">' in page


def test_the_teams_own_logo_and_only_its_own(their_site):
    assert their_site.get("/brand/logo-on-light.png").content == b"\x89PNG their light logo"
    # It has only the one, so the dark theme has it too, never YJSP's.
    assert their_site.get("/brand/logo-on-dark.png").content == b"\x89PNG their light logo"
    assert their_site.get("/brand/other.png").status_code == 404


def test_a_team_without_a_logo_shows_its_name(theirs):
    (theirs.brand_dir / "logo-on-light.png").unlink()
    with TestClient(create_app(theirs)) as their_site:
        assert their_site.get("/brand/logo-on-light.png").status_code == 404
        assert their_site.get("/brand/logo-on-dark.png").status_code == 404
        for page in (their_site.get("/").text, their_site.get("/help").text):
            assert '<span class="mark">RPL</span>' in page
            assert 'class="logo"' not in page
        their_site.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN}, follow_redirects=False)
        assert '<meta name="yjsp-logo" content="none">' in their_site.get("/vault").text


def test_yjsps_own_site_has_yjsps_logo(client):
    # Without YJSP_BRAND_DIR, as on YJSP's own site.
    for name in ("logo-on-light.png", "logo-on-dark.png"):
        assert client.get(f"/brand/{name}").content.startswith(b"\x89PNG\r\n")
    page = client.get("/").text
    assert '<span class="logo" role="img" aria-label="YJSP"></span>' in page and 'class="mark"' not in page


def test_claude_knows_whose_site_it_is(theirs):
    claude = FakeClaude()
    try:
        settings = theirs.model_copy(
            update={"anthropic_api_key": "test-key", "anthropic_base_url": claude.url, "assistant_budget": 5.0}
        )
        with TestClient(create_app(settings)) as client:
            member = client.post("/auth/dev-token", json={"email": BOOTSTRAP_ADMIN}).json()["token"]
            response, _ = ask(client, {"Authorization": f"Bearer {member}"}, QUESTION)
            assert response.status_code == 200
        instructions = claude.requests[-1]["system"][0]["text"]
        assert instructions.startswith("You're the help assistant in RPL, the Rocket Propulsion Lab's site")
        assert "YJSP" not in instructions.split("<help>")[0]
    finally:
        claude.close()


def test_names_are_plain_words():
    for bad in ("", "<b>RPL</b>", 'R"PL', "R&D", "x" * 41):
        with pytest.raises(ValueError):
            Settings(_env_file=None, site_name=bad)
    assert Settings(_env_file=None, team_name="Rocket Propulsion Lab, Purdue").team_name.endswith("Purdue")
