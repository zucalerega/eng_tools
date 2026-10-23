"""Who has Vault's SolidWorks add-in, for admins (clients.py): who's signed in with it, on which computers and versions,
who downloaded its installer, and how many people have it."""

from datetime import timedelta

from sqlalchemy import update

from yjsp_server import auth
from yjsp_server.db import utcnow
from yjsp_server.models import Token, User

from .test_trash import program

ADD_IN = {"User-Agent": "vault-client/0.5.2.0"}  # as the add-in's requests say who they're from


def signed_in_with(app, team, email: str, name: str) -> dict[str, str]:
    """A client's sign-in for them, named as the add-in or the CLI names its own (VaultPane.cs, Program.cs)."""
    with app.state.sessionmaker() as db:
        secret = auth.issue_token(db, db.get_one(User, team.ids[email]), kind=auth.CLIENT, name=name)
    return {"Authorization": f"Bearer {secret}"}


def test_admins_see_who_has_the_add_in_on_which_computers_and_versions(app, client, team):
    chief = team.member("chief@x.test", admin=True)
    team.member("alice@x.test")
    team.member("bob@x.test")
    team.member("carol@x.test")
    alice_laptop = signed_in_with(app, team, "alice@x.test", "SolidWorks add-in on ALICE-LAPTOP")
    alice_lab = signed_in_with(app, team, "alice@x.test", "SolidWorks add-in on LAB-PC-3")
    bob_cli = signed_in_with(app, team, "bob@x.test", "vault CLI on BOB-PC")  # the CLI isn't the add-in
    carol_old = signed_in_with(app, team, "carol@x.test", "SolidWorks add-in on CAROL-PC")
    for headers in (alice_laptop, alice_lab, bob_cli, carol_old):
        assert client.get("/api/me", headers=headers | ADD_IN).status_code == 200
    with app.state.sessionmaker() as db:  # Carol put her laptop away a semester ago
        then = utcnow() - timedelta(days=120)
        db.execute(update(Token).where(Token.name == "SolidWorks add-in on CAROL-PC").values(last_used_at=then))
        db.commit()

    seen = client.get("/api/add-in", headers=chief).json()
    assert (seen["have_it"], seen["this_week"], seen["downloaded"]) == (1, 1, 0)
    assert (seen["newest"], seen["on_newest"]) == (None, 0)  # no installer offered to compare with
    people = {p["user"]["email"]: p for p in seen["people"]}
    assert set(people) == {"alice@x.test", "carol@x.test"}
    assert sorted((c["name"], c["version"], c["in_use"]) for c in people["alice@x.test"]["computers"]) == [
        ("ALICE-LAPTOP", "0.5.2", True),
        ("LAB-PC-3", "0.5.2", True),
    ]
    assert [c["in_use"] for c in people["carol@x.test"]["computers"]] == [False]  # listed, but not counted
    assert seen["people"][0]["user"]["email"] == "alice@x.test"  # the most recently on first

    # Signed out there (its token revoked), it isn't there.
    with app.state.sessionmaker() as db:
        db.execute(update(Token).where(Token.name == "SolidWorks add-in on LAB-PC-3").values(revoked_at=utcnow()))
        db.commit()
    people = {p["user"]["email"]: p for p in client.get("/api/add-in", headers=chief).json()["people"]}
    assert [c["name"] for c in people["alice@x.test"]["computers"]] == ["ALICE-LAPTOP"]

    # Only admins see it.
    refused = client.get("/api/add-in", headers=team.member("dave@x.test"))
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")


def test_versions_are_compared_with_the_installer_offered_now(app, settings, client, team, tmp_path):
    settings.downloads_dir = tmp_path / "downloads"
    settings.downloads_dir.mkdir()
    (settings.downloads_dir / "Vault-Setup.exe").write_bytes(program((0, 5, 3)))
    chief = team.member("chief@x.test", admin=True)
    running = {
        "alice@x.test": "0.5.3.0",
        "bob@x.test": "0.5.2.0",
        "carol@x.test": "0.6.0.0",  # a build newer than the one offered
        "dan@x.test": None,  # signed in, but hasn't talked to the server since: its version isn't known yet
        "erin@x.test": "0.5.3.0",
    }
    for email, version in running.items():
        team.member(email)
        headers = signed_in_with(app, team, email, f"SolidWorks add-in on {email.split('@')[0].upper()}-PC")
        if version is not None:
            assert client.get("/api/me", headers=headers | {"User-Agent": f"vault-client/{version}"}).status_code == 200
    with app.state.sessionmaker() as db:  # Erin is on the newest, on a laptop put away a semester ago
        then = utcnow() - timedelta(days=120)
        db.execute(update(Token).where(Token.name == "SolidWorks add-in on ERIN-PC").values(last_used_at=then))
        db.commit()

    seen = client.get("/api/add-in", headers=chief).json()
    assert seen["newest"] == "0.5.3"
    versions = {p["user"]["email"]: (c["version"], c["outdated"]) for p in seen["people"] for c in p["computers"]}
    assert versions == {
        "alice@x.test": ("0.5.3", False),
        "bob@x.test": ("0.5.2", True),  # it offers itself the update
        "carol@x.test": ("0.6.0", False),
        "dan@x.test": (None, False),  # not known, so not called old
        "erin@x.test": ("0.5.3", False),
    }
    # Of the four who have it (Erin doesn't, any more), Alice and Carol are on the newest.
    assert (seen["have_it"], seen["on_newest"]) == (4, 2)


def test_downloading_the_installer_counts_once_a_person(settings, client, team, tmp_path):
    settings.downloads_dir = tmp_path / "downloads"
    settings.downloads_dir.mkdir()
    (settings.downloads_dir / "Vault-Setup.exe").write_bytes(b"MZ installer")
    (settings.downloads_dir / "vault.exe").write_bytes(b"MZ cli")
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    assert client.get("/api/add-in", headers=chief).json()["counting_since"] is None

    assert client.get("/api/downloads/Vault-Setup.exe", headers=alice).status_code == 200
    assert client.get("/api/downloads/Vault-Setup.exe", headers=alice | ADD_IN).status_code == 200  # an update
    assert client.get("/api/downloads/vault.exe", headers=chief).status_code == 200  # the CLI, not the add-in

    seen = client.get("/api/add-in", headers=chief).json()
    assert seen["downloaded"] == 1 and seen["counting_since"] is not None
    [alice_row] = seen["people"]
    assert (alice_row["user"]["email"], alice_row["downloads"], alice_row["computers"]) == ("alice@x.test", 2, [])
    assert alice_row["downloaded_at"] is not None


def test_a_clients_version_comes_from_what_it_says_it_is():
    assert auth.client_version("vault-client/0.5.2.0") == "0.5.2"
    assert auth.client_version("vault-client/0.6.0.1") == "0.6.0.1"
    assert auth.client_version("vault-client/1.2.3") == "1.2.3"
    assert auth.client_version("cvc-client/0.3.0.0") == "0.3.0"  # CVC's, before 0.4.0
    assert auth.client_version("Mozilla/5.0 (Macintosh)") is None
    assert auth.client_version("") is None
