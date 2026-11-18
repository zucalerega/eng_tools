"""The demo's seed (demo/seed.py, `yjsp-demo seed`): made-up data, made from nothing through the site's API, as over a
semester, in a folder of the demo's own, which it replaces only when it's made another, and only if a seed made it."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from yjsp_server import demo
from yjsp_server.app import create_app
from yjsp_server.config import Settings
from yjsp_server.demo import __main__ as cli
from yjsp_server.demo import seed as seeding


def demo_settings(folder) -> Settings:
    return Settings(
        _env_file=None,
        demo=True,
        root_path="/demo",
        database_url=f"sqlite:///{folder / 'yjsp.db'}",
        vault_dir=folder / "vault",
        yorg_dir=folder / "yorg",
        web_dir=folder.parent / "web",
        assistant_keep_warm=False,
        caliper_read_ahead=False,
        deals_schedule=False,
    )


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    """The demo, seeded once for this module's tests, which only read it."""
    folder = tmp_path_factory.mktemp("demo") / "data"
    seeding.seed(demo_settings(folder))
    with TestClient(create_app(demo_settings(folder))) as client:
        yield folder, client


def test_the_seed_makes_a_demo_the_demo_serves(seeded):
    folder, client = seeded
    assert (folder / seeding.MARK).is_file()
    assert client.get("/api/me").json()["email"] == demo.GUEST_EMAIL
    names = {person["name"] for person in client.get("/api/users").json()}
    assert {"Ada Okafor", "Ben Hartley", "Chloe Nakamura", demo.GUEST_NAME} <= names

    tests = {each["name"]: each for each in client.get("/api/yorg/datasets").json()}
    assert set(tests) == {
        "PT-TK2 LOX tank proof",
        "CF-1 fuel side water flow",
        "CF-2 LOX side water flow",
        "HF-1 3 s hot fire",
        "HF-2 5 s hot fire",
    }
    assert {each["status"] for each in tests.values()} == {"ready"}
    hot_fire = client.get(f"/api/yorg/datasets/{tests['HF-2 5 s hot fire']['id']}").json()
    channels = {channel["name"] for channel in hot_fire["channels"]}
    # Named after the feed system's tags, so Piper shows them on its drawing.
    assert {"PT-1", "PT-2", "PT-3", "PT-4", "PV-1", "PV-2", "BV-1", "LC-1", "FM-OX", "FM-FU"} <= channels

    diagrams = {each["name"]: each for each in client.get("/api/piper/diagrams").json()}
    assert set(diagrams) == {"Kestrel feed system", "Fuel side cold flow", "Pressurized run tank"}
    feed = diagrams["Kestrel feed system"]
    assert (feed["revision"], feed["released"]) == (3, "A")  # released, and changed since
    assert feed["editing"] is None

    programs = {each["name"]: each for each in client.get("/api/buildflow/programs").json()}
    assert set(programs) == {"Kestrel", "Kestrel test stand"}
    kestrel = client.get(f"/api/buildflow/programs/{programs['Kestrel']['id']}").json()
    chamber = next(c for c in kestrel["components"] if c["name"] == "Thrust chamber")
    assert chamber["lead"]["name"] == "Ben Hartley"
    assert {link["url"].split("/")[1] for link in chamber["links"]} == {"yorg"}
    # Its reviews: the feed system's PDR, held with its notes, and a CDR to come.
    reviews = {each["name"]: each for each in kestrel["reviews"]}
    assert set(reviews) == {"Feed system PDR", "Structures and recovery CDR"}
    assert "RFA 1" in reviews["Feed system PDR"]["notes"]
    coming = reviews["Structures and recovery CDR"]
    assert coming["held_on"] > datetime.now(UTC).date().isoformat() and coming["component_ids"]
    # Its build plan: each part's lead time and ready-by day, and what the structures need first.
    regulator = next(c for c in kestrel["components"] if c["name"] == "Pressure regulator")
    assert regulator["lead_days"] == 84 and regulator["need_by"] > datetime.now(UTC).date().isoformat()
    intertank = next(c for c in kestrel["components"] if c["name"] == "Intertank")
    assert len(intertank["needs"]) == 2
    # Its BOM, read in from the team's spreadsheet.
    bom = client.get(f"/api/buildflow/programs/{programs['Kestrel']['id']}/bom").json()
    assert len(bom) == 12 and {line["status"] for line in bom} == {"to_order", "ordered", "received"}

    servo = client.get("/api/folders", params={"path": "Kestrel/Avionics/Airbrake actuator"}).json()
    assert sorted(f["name"] for f in servo["files"]) == ["9347.SLDASM", "Embout.SLDPRT", "Servomoteur.SLDPRT"]
    assembly = next(f for f in servo["files"] if f["name"] == "9347.SLDASM")
    assert len(assembly["uses"]) == 2 and assembly["vendor"]  # its parts; and a vendor's, as SparkFun's
    assert servo["folder"]["role"] == "viewer"  # the guest sees it all, and changes none of it
    checked_out = {f["name"]: f["checked_out"] for f in servo["files"] if f["checked_out"]}
    assert [(name, lock["user"]["name"], lock["host"]) for name, lock in checked_out.items()] == [
        ("Servomoteur.SLDPRT", "Elena Petrova", "ELENA-PC")
    ]


def test_the_demos_color_scheme_is_its_teams(seeded):
    _, client = seeded
    default = client.get("/api/piper/schemes").json()[0]
    assert (default["name"], default["is_default"]) == ("LRT standard", True)  # not the YJSP standard a new site has


def test_the_demo_happened_over_a_semester_up_to_now(seeded):
    _, client = seeded
    now = datetime.now(UTC)
    made = sorted(datetime.fromisoformat(each["created_at"]) for each in client.get("/api/yorg/datasets").json())
    assert now - timedelta(days=70) < made[0] < now - timedelta(days=60)
    assert now - timedelta(days=14) < made[-1] < now - timedelta(days=10)
    activity = client.get("/api/activity", params={"limit": 50}).json()
    assert {event["action"] for event in activity} >= {"add", "checkout"}
    assert all(now - timedelta(days=120) < datetime.fromisoformat(event["at"]) <= now for event in activity)


def test_no_one_is_signed_in_to_the_demo(seeded):
    folder, client = seeded
    from sqlalchemy import create_engine, func, select

    from yjsp_server.models import ClientAuthCode, Token

    engine = create_engine(f"sqlite:///{folder / 'yjsp.db'}")
    with engine.connect() as connection:
        assert connection.scalar(select(func.count()).select_from(Token)) == 0
        assert connection.scalar(select(func.count()).select_from(ClientAuthCode)) == 0
    engine.dispose()


def test_the_seed_only_makes_the_demo(tmp_path):
    folder = tmp_path / "data"
    with pytest.raises(seeding.SeedError, match="YJSP_DEMO=1"):
        seeding.seed(demo_settings(folder).model_copy(update={"demo": False}))
    with pytest.raises(seeding.SeedError, match="SQLite file"):
        seeding.seed(demo_settings(folder).model_copy(update={"database_url": "postgresql://x/y"}))
    with pytest.raises(seeding.SeedError, match="YJSP_VAULT_DIR has to be in"):
        seeding.seed(demo_settings(folder).model_copy(update={"vault_dir": tmp_path / "elsewhere" / "vault"}))


def test_the_seed_never_replaces_what_it_didnt_make(tmp_path):
    folder = tmp_path / "data"
    folder.mkdir()
    (folder / "yjsp.db").write_bytes(b"the team's own")
    with pytest.raises(seeding.SeedError, match="isn't the demo's"):
        seeding.seed(demo_settings(folder))
    assert (folder / "yjsp.db").read_bytes() == b"the team's own"


def test_a_seed_that_fails_leaves_the_last_demo_as_it_was(tmp_path, monkeypatch):
    folder = tmp_path / "data"
    folder.mkdir()
    (folder / seeding.MARK).write_text("made by a seed")
    (folder / "yjsp.db").write_bytes(b"the last demo")

    def broken(self) -> dict:
        raise seeding.SeedError("Yorg broke")

    monkeypatch.setattr(seeding.Seed, "_yorg", broken)
    with pytest.raises(seeding.SeedError, match="Yorg broke"):
        seeding.seed(demo_settings(folder))
    assert (folder / "yjsp.db").read_bytes() == b"the last demo"


def test_yjsp_demo_seed_makes_it_where_the_settings_say(tmp_path, monkeypatch, capsys):
    folder = tmp_path / "data"
    for name, value in {
        "YJSP_DEMO": "1",
        "YJSP_DATABASE_URL": f"sqlite:///{folder / 'yjsp.db'}",
        "YJSP_VAULT_DIR": str(folder / "vault"),
        "YJSP_YORG_DIR": str(folder / "yorg"),
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.chdir(tmp_path)  # no .env here
    assert cli.main(["seed"]) == 0
    assert "The demo's data is made" in capsys.readouterr().out
    assert (folder / seeding.MARK).is_file()
    # Again: the last one replaced.
    assert cli.main(["seed"]) == 0
    assert sorted(p.name for p in tmp_path.iterdir()) == ["data"]

    monkeypatch.setenv("YJSP_DEMO", "0")
    assert cli.main(["seed"]) == 1
    assert "YJSP_DEMO=1" in capsys.readouterr().err
