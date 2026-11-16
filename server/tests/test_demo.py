"""The demo (docs/design.md, "The demo"): a server of its own, with made-up data, that anyone can read as its guest and
no one can change; and the site, which passes /demo to it without saying who's asking."""

import asyncio

import httpx2
import pytest
from fastapi.testclient import TestClient

from yjsp_server import demo
from yjsp_server.api import demo as demo_api
from yjsp_server.app import create_app
from yjsp_server.config import Settings
from yjsp_server.db import make_engine, migrate
from yjsp_server.models import User, UserStatus
from yjsp_server.vault.models import Grant, Role

from .conftest import BOOTSTRAP_ADMIN

PAGE = """<!doctype html>
<html><head><title>Vault</title>
<script type="module" crossorigin src="./assets/index-1a2b3c.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-4d5e6f.css">
</head><body><div id="root"></div></body></html>"""


def demo_settings(settings: Settings) -> Settings:
    """The demo's settings, beside the tests' usual ones (conftest.py): no sign-in of any kind."""
    return settings.model_copy(update={"demo": True, "dev_auth": False, "root_path": "/demo"})


def guest_database(settings: Settings) -> None:
    """A database as the demo's seed leaves it, in brief: its guest, who can see the vault, and a member."""
    engine = make_engine(settings.database_url)
    migrate(engine)
    from sqlalchemy.orm import Session

    with Session(engine) as db:
        db.add(User(email=demo.GUEST_EMAIL, name=demo.GUEST_NAME, status=UserStatus.ACTIVE))
        db.add(User(email="ada@kestrel.test", name="Ada Okafor", status=UserStatus.ACTIVE))
        db.commit()
    engine.dispose()


@pytest.fixture
def built(settings):
    """A stand-in for the web app's build (web/dist), naming its scripts beside the page, as Vite's base "./" does."""
    (settings.web_dir / "assets").mkdir(parents=True)
    (settings.web_dir / "index.html").write_text(PAGE)
    (settings.web_dir / "assets" / "index-1a2b3c.js").write_text("console.log('yjsp')")
    return settings.web_dir


@pytest.fixture
def demo_app(settings, built):
    guest_database(settings)
    return create_app(demo_settings(settings))


@pytest.fixture
def visitor(demo_app):
    with TestClient(demo_app) as client:
        yield client


def test_the_demo_wont_have_sign_in_or_anything_that_costs(settings):
    for unwanted in (
        {"dev_auth": True},
        {"google_client_id": "x", "google_client_secret": "y"},
        {"microsoft_client_id": "x"},
        {"anthropic_api_key": "sk-ant-x", "assistant_monthly_budget": 5},
        {"ebay_client_id": "x", "ebay_client_secret": "y"},
        {"feedback_routine_url": "https://api.anthropic.com/x", "feedback_routine_token": "t"},
        {"demo_url": "http://127.0.0.1:8200"},
    ):
        wrong = demo_settings(settings).model_copy(update=unwanted)
        with pytest.raises(RuntimeError, match="Can't start the demo: unset YJSP_"):
            wrong.check()


def test_the_demo_runs_in_production_without_a_sign_in(settings):
    production = demo_settings(settings).model_copy(
        update={"env": "production", "secret_key": "s" * 40, "public_url": "https://tools.example.org/demo"}
    )
    production.check()  # no sign-in needed: the demo has none
    with pytest.raises(RuntimeError, match="set up a sign-in"):
        production.model_copy(update={"demo": False, "root_path": ""}).check()


def test_where_the_site_is_is_a_path(settings):
    for good in ("", "/demo", "/team/tools"):
        assert Settings(_env_file=None, root_path=good).root_path == good
    for bad in ("demo", "/demo/", "//demo", "/de mo", '/"x'):
        with pytest.raises(ValueError):
            Settings(_env_file=None, root_path=bad)
    for bad in ("127.0.0.1:8200", "http://127.0.0.1:8200/path", "ftp://x"):
        with pytest.raises(ValueError):
            Settings(_env_file=None, demo_url=bad)


def test_only_the_demo_is_away_from_the_root_for_now(settings):
    with pytest.raises(RuntimeError, match="YJSP_ROOT_PATH is only for the demo"):
        settings.model_copy(update={"root_path": "/tools"}).check()


def test_the_demo_wont_start_on_a_database_its_seed_didnt_make(settings):
    with pytest.raises(RuntimeError, match="isn't the demo's"), TestClient(create_app(demo_settings(settings))):
        pass


def test_everyone_is_the_demos_guest(visitor, team):
    me = visitor.get("/api/me").json()
    assert (me["email"], me["name"], me["status"], me["is_admin"], me["demo"]) == (
        demo.GUEST_EMAIL,
        demo.GUEST_NAME,
        "active",
        False,
        True,
    )
    # Whatever they send: the demo has no sign-in, so no one's anyone else.
    assert visitor.get("/api/me", headers={"Authorization": "Bearer yjsp_whatever"}).json()["email"] == demo.GUEST_EMAIL
    visitor.cookies.set("yjsp_session", "yjsp_a-members-session")
    assert visitor.get("/api/me").json()["email"] == demo.GUEST_EMAIL
    # A guest, not an admin.
    assert visitor.get("/api/usage").json()["error"] == "admin_only"


def test_nothing_in_the_demo_can_be_changed(visitor):
    for method, path in (
        ("PATCH", "/api/me"),
        ("POST", "/api/folders"),
        ("PUT", "/api/blobs/" + "0" * 64),
        ("POST", "/api/checkout"),
        ("POST", "/api/yorg/datasets"),
        ("POST", "/api/piper/diagrams"),
        ("PUT", "/api/buildflow/components/1/progress/1"),
        ("POST", "/api/feedback"),
        ("POST", "/api/assistant/ask"),
        ("DELETE", "/api/tokens/1"),
        ("POST", "/no/such/thing"),
    ):
        refused = visitor.request(method, path, json={}, headers={"X-YJSP-Request": "1"})
        assert (refused.status_code, refused.json()["error"]) == (403, "demo_read_only"), (method, path)
        assert "nothing in it can be changed" in refused.json()["message"]
        assert refused.headers["x-frame-options"] == "DENY"  # with the site's headers, as every answer


def test_the_demo_has_no_sign_in(visitor):
    for path in ("/auth/login", "/auth/microsoft/login", "/auth/client", "/auth/dev-login"):
        assert visitor.get(path, follow_redirects=False).status_code == 404, path


def test_the_demo_shows_the_web_app_to_anyone_at_its_root(visitor):
    for path in ("/", "/vault/files/Kestrel", "/piper/diagrams/3", "/buildflow"):
        page = visitor.get(path)
        assert page.status_code == 200, path
        assert '<meta name="yjsp-root" content="/demo">' in page.text
        assert 'src="/demo/assets/index-1a2b3c.js"' in page.text
        assert 'href="/demo/assets/index-4d5e6f.css"' in page.text
        assert "./assets/" not in page.text
    # Already "signed in" as the guest, a link back through sign-in goes on, under the root.
    onward = visitor.get("/", params={"next": "/piper"}, follow_redirects=False)
    assert (onward.status_code, onward.headers["location"]) == (303, "/demo/piper")


def test_the_site_at_its_root_shows_its_scripts_at_the_root(built, client):
    client.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN}, follow_redirects=False)
    page = client.get("/vault").text
    assert '<meta name="yjsp-root" content="">' in page
    assert 'src="/assets/index-1a2b3c.js"' in page


def test_the_demos_help_is_the_publics_under_its_root(visitor):
    page = visitor.get("/help").text
    assert 'href="/demo/help.md"' in page
    assert 'url("/demo/brand/logo-on-light.png")' in page
    assert 'fetch("/demo/help.md"' in page
    assert '<a class="action primary" href="/demo/">Open the demo</a>' in page
    assert "?next=/help" not in page  # nowhere to sign in
    assert 'class="tag">members' not in page  # the guest isn't a member: how it works inside stays the team's


def test_the_demos_guest_sees_what_the_vault_grants_everyone(visitor, demo_app):
    with demo_app.state.sessionmaker() as db:
        db.add(Grant(folder_id=1, user_id=None, role=Role.VIEWER))
        db.commit()
    listing = visitor.get("/api/folders", params={"path": ""}).json()
    assert listing["folder"]["role"] == "viewer"


# --- the site passes /demo to it -----------------------------------------------------------------------------------


class Recorder:
    """The demo, as the site's requests reach it: the path and headers of each, and a cookie it tries to set on each."""

    def __init__(self, app) -> None:
        self.app, self.seen = app, []

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http":
            self.seen.append((scope["path"], {name.decode(): value.decode() for name, value in scope["headers"]}))

        async def with_cookie(message) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = [*message.get("headers", []), (b"set-cookie", b"demo_cookie=x; Path=/")]
            await send(message)

        await self.app(scope, receive, with_cookie)


@pytest.fixture
def demo_server(demo_app):
    return Recorder(demo_app)


@pytest.fixture
def site(settings, demo_app, demo_server, tmp_path):
    """The site, passing /demo to the demo, which a stand-in transport reaches in the same process."""
    with TestClient(demo_app):  # the demo's own lifespan: its database checked, its threads started
        main = create_app(
            settings.model_copy(
                update={"demo_url": "http://demo.internal", "database_url": f"sqlite:///{tmp_path}/m.db"}
            )
        )
        main.state.demo = demo_api.Passer("http://demo.internal", transport=httpx2.ASGITransport(app=demo_server))
        with TestClient(main) as client:
            yield client


def test_the_site_passes_the_demo_on(site):
    me = site.get("/demo/api/me")
    assert (me.status_code, me.json()["email"], me.json()["demo"]) == (200, demo.GUEST_EMAIL, True)
    page = site.get("/demo/vault/files/Kestrel")
    assert 'src="/demo/assets/index-1a2b3c.js"' in page.text
    assert site.get("/demo/assets/index-1a2b3c.js").text == "console.log('yjsp')"
    assert site.get("/demo").status_code == 200
    assert site.get("/demo/help").status_code == 200
    refused = site.post("/demo/api/folders", json={"path": "X"}, headers={"X-YJSP-Request": "1"})
    assert (refused.status_code, refused.json()["error"]) == (403, "demo_read_only")


def test_the_site_never_tells_the_demo_who_is_asking(site, demo_server):
    site.cookies.set("yjsp_session", "yjsp_a-members-session")
    answer = site.get("/demo/api/me?x=1", headers={"Authorization": "Bearer yjsp_secret", "Accept-Language": "fr"})
    assert answer.status_code == 200
    path, headers = demo_server.seen[-1]
    assert path == "/api/me"  # /demo taken off
    assert "cookie" not in headers and "authorization" not in headers
    assert (headers["accept-language"], headers["x-forwarded-prefix"]) == ("fr", "/demo")
    assert "set-cookie" not in answer.headers  # nor does the demo set one on the site


def test_the_site_passes_the_demos_paths_as_they_were_sent(site, demo_server):
    site.get("/demo/vault/files/Kestrel%20Hopper/Tank%2FDome?path=a%26b")
    path, _ = demo_server.seen[-1]
    assert path == "/vault/files/Kestrel Hopper/Tank/Dome"  # as the demo reads it: its own %-decoding
    assert site.get("/demo/").status_code == 200
    assert demo_server.seen[-1][0] == "/"


def test_without_a_demo_there_is_nothing_at_demo(built, client):
    client.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN}, follow_redirects=False)
    for path in ("/demo", "/demo/vault"):
        missing = client.get(path)
        assert (missing.status_code, missing.json()["error"]) == (404, "not_found"), path


def test_a_demo_thats_down_says_so(settings):
    class Down(httpx2.AsyncBaseTransport):
        async def handle_async_request(self, request):
            raise httpx2.ConnectError("refused")

    app = create_app(settings.model_copy(update={"demo_url": "http://demo.internal"}))
    app.state.demo = demo_api.Passer("http://demo.internal", transport=Down())
    with TestClient(app) as client:
        down = client.get("/demo/")
    assert (down.status_code, down.json()["error"]) == (502, "demo_down")


def test_a_busy_demo_turns_the_rest_away(settings, monkeypatch):
    monkeypatch.setattr(demo_api, "MOST_AT_ONCE", 1)
    monkeypatch.setattr(demo_api, "TURN_WAIT", 0.1)
    passer = demo_api.Passer("http://demo.internal")

    async def busy():
        await passer._turns.acquire()  # someone else's request, still going
        app = create_app(settings.model_copy(update={"demo_url": "http://demo.internal"}))
        app.state.demo = passer
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url="http://site") as client:
            return await client.get("/demo/")

    turned_away = asyncio.run(busy())
    assert (turned_away.status_code, turned_away.json()["error"]) == (503, "demo_busy")
