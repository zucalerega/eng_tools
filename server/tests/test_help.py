"""The help: the guide, the add-in's, and troubleshooting for anyone, and how it all works for members, from the
repository's own docs: as a page (/help), as Markdown for AI tools (/help.md), and pointed to by /llms.txt."""

import posixpath
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from yjsp_server import help
from yjsp_server.app import create_app

from .conftest import BOOTSTRAP_ADMIN

REPO = Path(__file__).resolve().parents[2]
SERVER = REPO / "server" / "src" / "yjsp_server"

# Docs laid out as the repository's, small enough to see what the help makes of each line.
DOCS = {
    "README.md": """# YJSP Eng Tools

Read [the design](docs/design.md#api), [how we work](CLAUDE.md), [what errors mean](docs/troubleshooting.md#errors),
and [signing in](#signing-in), with `[not a link](docs/design.md)` in code.

## Signing in

The add-in signs in as "SolidWorks add-in on <computer>".

## Run the server locally

uv run yjsp-server

## Tests

npm test
""",
    "client/src/Vault.SolidWorks/README.md": """# Vault add-in for SolidWorks 2026

## Install

Run it.

```
## Testing against a development server
```

## Testing against a development server

YJSP_DEV_AUTH=1, on your own network.

## When something goes wrong

The log.
""",
    "docs/troubleshooting.md": """# Troubleshooting

## Errors

| Code | What it means |
|---|---|
| `checked_out` | someone else has it |
""",
    "docs/design.md": """# YJSP design

## API

[Vault's](vault.md#api) and [deploying](deploying.md).
""",
    "docs/vault.md": "# Vault design\n\n## API\n\nCheck-outs and check-ins.\n",
    "docs/yorg.md": "# Yorg design\n\nPlots.\n",
}


@pytest.fixture
def docs(tmp_path) -> Path:
    root = tmp_path / "repo"
    for name, text in DOCS.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(text.encode())
    return root


@pytest.fixture
def site(settings, docs):
    settings.help_dir = docs
    with TestClient(create_app(settings)) as client:
        yield client


def sign_in(client: TestClient) -> None:
    client.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN}, follow_redirects=False)


def test_anyone_can_read_the_guide_and_troubleshooting(site):
    page = site.get("/help")
    assert page.status_code == 200
    assert '<h1 id="guide">YJSP Eng Tools</h1>' in page.text
    assert '<h2 id="guide-signing-in">Signing in</h2>' in page.text
    assert '<h1 id="solidworks">Vault add-in for SolidWorks 2026</h1>' in page.text
    assert '<h1 id="troubleshooting">Troubleshooting</h1>' in page.text
    assert "<td><code>checked_out</code></td>" in page.text
    # How it works inside is for members.
    assert "YJSP design" not in page.text and "Vault design" not in page.text
    assert 'href="/?next=/help"' in page.text
    # A name in angle brackets is words, not HTML.
    assert "SolidWorks add-in on &lt;computer&gt;" in page.text


def test_members_see_how_it_works_inside_too(site):
    sign_in(site)
    page = site.get("/help").text
    for title in ("YJSP design", "Vault design", "Yorg design"):
        assert title in page
    assert '<a href="#design-api">the design</a>' in page
    assert '<a href="#vault-api">Vault\'s</a>' in page
    assert 'href="/?next=/help"' not in page


def test_what_is_for_developers_is_left_out(site):
    page = site.get("/help").text
    for gone in ("Run the server locally", "npm test", "YJSP_DEV_AUTH=1", "on your own network"):
        assert gone not in page
    # A heading in a code block is code: what's under it stays, up to the section that goes.
    assert "<code>## Testing against a development server\n</code>" in page
    assert '<h2 id="solidworks-when-something-goes-wrong">When something goes wrong</h2>' in page


def test_links_between_the_docs_go_to_their_place_on_the_page(site):
    page = site.get("/help").text
    assert '<a href="#troubleshooting-errors">what errors mean</a>' in page
    assert '<a href="#guide-signing-in">signing in</a>' in page
    # The design isn't shown to everyone, and CLAUDE.md isn't in the help at all: their words stay, without a link.
    assert "Read the design, how we work, " in page.replace("\n", " ")
    assert "CLAUDE.md" not in page
    assert "<code>[not a link](docs/design.md)</code>" in page


def test_ai_tools_get_the_help_as_one_markdown_document(site):
    found = site.get("/help.md")
    assert found.status_code == 200
    assert found.headers["content-type"] == "text/markdown; charset=utf-8"
    text = found.text
    assert text.startswith("# YJSP help\n\n> For an AI assistant helping someone with YJSP")
    assert "# YJSP Eng Tools {#guide}" in text
    assert "## Signing in {#guide-signing-in}" in text
    assert "[what errors mean](http://localhost:8000/help#troubleshooting-errors)" in text
    assert "Read the design, [how we work]" not in text and "Read the design, how we work," in text
    assert "`[not a link](docs/design.md)`" in text
    assert "Vault design" not in text and "Run the server locally" not in text
    sign_in(site)
    assert "# Vault design {#vault}" in site.get("/help.md").text

    llms = site.get("/llms.txt")
    assert llms.headers["content-type"] == "text/plain; charset=utf-8"
    assert "[YJSP help](http://localhost:8000/help.md)" in llms.text


def test_the_help_is_one_page(site):
    assert site.get("/help/vault").status_code == 404


def test_a_server_without_the_docs_says_so(settings, tmp_path):
    settings.help_dir = tmp_path / "nothing"
    with TestClient(create_app(settings)) as client:
        assert "The help isn't on this server." in client.get("/help").text


# The repository's own docs, as the live site shows them.


def _links(doc: help.Doc) -> list[str]:
    """Every link in a doc's Markdown, outside code."""
    found, fenced = [], False
    for line in doc.source.split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
        elif not fenced:
            prose = re.sub(r"`+[^`]*`+", "", line)
            found += re.findall(r"\[[^\]\n]+\]\(([^)\s]+)\)", prose)
    return found


def test_every_link_between_the_docs_lands_on_a_heading():
    found = help.load(REPO)
    assert [doc.part.key for doc in found.docs] == [part.key for part in help.PARTS]
    by_path = {doc.part.path: doc for doc in found.docs}
    broken = []
    for doc in found.docs:
        for href in _links(doc):
            path, _, fragment = href.partition("#")
            if re.match(r"^(https?:|mailto:|/)", href) or not (path or fragment):
                continue
            target = (
                by_path.get(posixpath.normpath(posixpath.join(posixpath.dirname(doc.part.path), path))) if path else doc
            )
            if target is not None and fragment and f"{target.part.key}-{fragment}" not in target.anchors:
                broken.append(f"{doc.part.path}: {href}")
    assert broken == []


def test_what_is_left_out_for_developers_is_still_in_the_docs():
    # A renamed section would otherwise be shown to everyone, unnoticed.
    for part in help.PARTS:
        headings = re.findall(r"^## (.+?)\s*$", (REPO / part.path).read_text(encoding="utf-8"), re.MULTILINE)
        assert set(part.skip) <= set(headings), part.path


def test_troubleshooting_says_what_every_error_means():
    codes = set()
    for source in SERVER.rglob("*.py"):
        codes |= set(re.findall(r'\bcode\s*=\s*"([a-z_]+)"', source.read_text(encoding="utf-8")))
    troubleshooting = (REPO / "docs" / "troubleshooting.md").read_text(encoding="utf-8")
    assert len(codes) > 60
    assert sorted(code for code in codes if f"`{code}`" not in troubleshooting) == []
