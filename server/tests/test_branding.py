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


def test_the_teams_own_logo_where_it_has_one(their_site):
    assert their_site.get("/brand/logo-on-light.png").content == b"\x89PNG their light logo"
    # One it hasn't put there is YJSP's, so the dark theme still has a logo.
    assert their_site.get("/brand/logo-on-dark.png").content.startswith(b"\x89PNG\r\n")
    assert their_site.get("/brand/other.png").status_code == 404


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
