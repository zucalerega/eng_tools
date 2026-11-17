"""Deploying main from the site (deploy.py): Admin > People's Deploy card, for the site's owner alone. GitHub is a
stand-in (fake_github.py), and so is systemctl (fake_systemctl.py), which begins a deploy's record as yjsp-deploy does;
the deploy itself (deploy/deploy-here.sh) has a test of its own, test_deploy_here.py."""

import json
import os
import re
import sys
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import pytest

from yjsp_server import deploy

from .conftest import BOOTSTRAP_ADMIN
from .fake_github import MIGRATIONS, REPOSITORY, FakeGitHub, passed, run

REPO = Path(__file__).resolve().parents[2]
SYSTEMCTL = Path(__file__).with_name("fake_systemctl.py")
OWNER = "owner@rocketry.test"


@pytest.fixture
def github():
    fake = FakeGitHub()
    yield fake
    fake.close()


@pytest.fixture
def settings(settings, tmp_path, github):
    """A site set up to deploy from: its owner, yjsp-deploy's folder, and stand-ins for GitHub and systemctl."""
    folder = tmp_path / "deploy"
    folder.mkdir()
    return settings.model_copy(
        update={
            "deployer": OWNER,
            "deploy_dir": folder,
            "deploy_repository": REPOSITORY,
            "github_base_url": github.url,
            "deploy_systemctl": [sys.executable, str(SYSTEMCTL), str(tmp_path / "calls"), str(folder), "start"],
        }
    )


def systemctl_calls(tmp_path: Path) -> list[list[str]]:
    calls = tmp_path / "calls"
    return [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []


def record(folder: Path, deploy_id: str, *, log: str = "", age: float = 0, **said: str) -> Path:
    """A deploy's record and log, as yjsp-deploy writes them; `age` seconds since it last touched the record."""
    deploys = folder / "deploys"
    deploys.mkdir(exist_ok=True)
    path = deploys / f"{deploy_id}.json"
    path.write_text(json.dumps(said))
    (deploys / f"{deploy_id}.log").write_bytes(log.encode())
    if age:
        os.utime(path, (time.time() - age, time.time() - age))
    return path


def live(folder: Path, commit: str, subject: str = "Put a dot between the app names in the switcher") -> None:
    said = {"commit": commit, "subject": subject, "deployed_at": "2026-11-16T18:00:00Z", "deploy": "20261116-175900"}
    (folder / "live.json").write_text(json.dumps(said))


def two_pulls_since(github: FakeGitHub) -> tuple[str, str, str]:
    """main, with two pull requests merged since its commit a: b (#142), then c (#143), main's newest."""
    a = github.commit("a", "Put a dot between the app names in the switcher")
    y = github.commit("y", "Show the demo as a made-up team's", a)
    b = github.commit("b", "Merge pull request #142 from rocketry/demo\n\nShow the demo as a made-up team's", a, y)
    x = github.commit("x", "Add the Deploy card", b)
    c = github.commit("c", "Merge pull request #143 from rocketry/deploy\n\nDeploy main from the site", b, x)
    github.main = c
    return a, b, c


def test_only_the_sites_owner_can_deploy_it(client, team, settings, github):
    a, b, c = two_pulls_since(github)
    github.runs[c] = passed()
    owner = team.member(OWNER, admin=True)
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    member = team.member("member@rocketry.test")
    assert client.get("/api/me", headers=owner).json()["can_deploy"] is True
    for someone in (admin, member):
        assert client.get("/api/me", headers=someone).json()["can_deploy"] is False
        for method, path, body in (
            ("GET", "/api/deploys", None),
            ("GET", "/api/deploys/main", None),
            ("POST", "/api/deploys", {"commit": c}),
            ("GET", "/api/deploys/20261116-120000/log", None),
        ):
            response = client.request(method, path, json=body, headers=someone)
            assert (response.status_code, response.json()["error"]) == (403, "deploy_owner_only"), path
    assert systemctl_calls(settings.deploy_dir.parent) == []


def test_the_owner_deploys_only_while_an_admin(client, team, settings):
    owner = team.member(OWNER)  # YJSP_DEPLOYER's, but not an admin
    assert client.get("/api/me", headers=owner).json()["can_deploy"] is False
    assert client.get("/api/deploys", headers=owner).status_code == 403


def test_the_card_says_whats_live_how_deploys_went_and_what_main_would_deploy(client, team, settings, github):
    a, b, c = two_pulls_since(github)
    github.runs[c] = [
        run("server"),
        run("client", id=2),
        run("web", id=3),
        run("image", "failure", id=4),
        run("image", status="in_progress", id=5),  # run again: its latest run is what counts
        run("release", "skipped", id=6),  # not one of the jobs that must pass
    ]
    github.migration(c, "0999_deploys.py", '"""deploys: what yjsp-deploy did\n\nAnd more."""\n\nrevision = "0999"\n')
    folder = settings.deploy_dir
    live(folder, a)
    record(
        folder,
        "20261116-175900",
        source="site",
        commit=a,
        subject="Put a dot between the app names in the switcher",
        started="2026-11-16T17:59:00Z",
        finished="2026-11-16T18:00:00Z",
        step="demo",
        result="deployed",
        message=f"{a[:7]} is live",
    )
    record(
        folder,
        "20261116-180500",
        source="laptop",
        commit=b,
        subject="Show the demo as a made-up team's (#142)",
        started="2026-11-16T18:05:00Z",
        finished="2026-11-16T18:06:00Z",
        step="rollback",
        result="rolled-back",
        message="The new version didn't answer, so the old one is back: the log says why",
    )
    owner = team.member(OWNER, admin=True)

    state = client.get("/api/deploys", headers=owner).json()
    assert (state["available"], state["reason"], state["repository"]) == (True, None, REPOSITORY)
    assert state["live"] == {
        "commit": a,
        "subject": "Put a dot between the app names in the switcher",
        "deployed_at": "2026-11-16T18:00:00Z",
    }
    assert [(d["id"], d["source"], d["state"], d["step"]) for d in state["deploys"]] == [
        ("20261116-180500", "laptop", "rolled-back", "rollback"),  # the newest first
        ("20261116-175900", "site", "deployed", "demo"),
    ]
    assert state["deploys"][1]["started_at"] == "2026-11-16T17:59:00Z"

    main = client.get("/api/deploys/main", headers=owner).json()
    assert main["commit"] == {
        "sha": c,
        "title": "Deploy main from the site",  # its pull request's, as it's a merge
        "pull": 143,
        "author": "chief",
        "at": "2026-11-16T19:05:00Z",
    }
    assert [(check["name"], check["status"], check["conclusion"], check["passed"]) for check in main["checks"]] == [
        ("server", "completed", "success", True),
        ("client", "completed", "success", True),
        ("web", "completed", "success", True),
        ("image", "in_progress", None, False),
    ]
    assert main["checks"][0]["url"] == f"https://github.com/{REPOSITORY}/actions/runs/7/job/1"
    assert main["passed"] is False
    assert main["migrations"] == [
        {
            "name": "0999_deploys.py",
            "title": "deploys: what yjsp-deploy did",
            "url": f"https://github.com/{REPOSITORY}/blob/{c}/{MIGRATIONS}/0999_deploys.py",
        }
    ]
    # main's own commits since what's live, the newest first: the merges, not what was in them.
    assert [(commit["sha"], commit["title"], commit["pull"]) for commit in main["commits"]] == [
        (c, "Deploy main from the site", 143),
        (b, "Show the demo as a made-up team's", 142),
    ]
    assert main["ahead"] == 4


def test_github_is_asked_again_only_for_what_can_change(client, team, settings, github):
    a, b, c = two_pulls_since(github)
    github.runs[c] = passed()
    live(settings.deploy_dir, a)
    owner = team.member(OWNER, admin=True)
    for _ in range(3):
        assert client.get("/api/deploys/main", headers=owner).status_code == 200
    prefix = f"/repos/{REPOSITORY}"
    main, checks = f"{prefix}/commits/main", f"{prefix}/commits/{c}/check-runs"
    compare, migrations = f"{prefix}/compare/{a}...{c}", f"{prefix}/contents/{MIGRATIONS}"
    assert Counter(path.split("?")[0] for path in github.asked) == {main: 1, checks: 1, compare: 1, migrations: 1}

    # Check again, on the card: main and CI on it can have changed; what a commit holds can't.
    assert client.get("/api/deploys/main", params={"fresh": True}, headers=owner).status_code == 200
    assert Counter(path.split("?")[0] for path in github.asked) == {main: 2, checks: 2, compare: 1, migrations: 1}


def test_deploying_starts_yjsp_deploy_and_the_card_follows_it(client, team, settings, github, tmp_path):
    a, b, c = two_pulls_since(github)
    github.runs[c] = passed()
    live(settings.deploy_dir, a)
    owner = team.member(OWNER, admin=True)

    response = client.post("/api/deploys", json={"commit": c}, headers=owner)
    assert response.status_code == 202, response.text
    started = response.json()
    assert (started["source"], started["state"], started["step"]) == ("site", "running", "fetch")
    # systemd is asked to start yjsp-deploy, and told nothing of what to deploy: it deploys main, as it is then.
    assert systemctl_calls(tmp_path) == [["start", "--no-block", "--no-ask-password", "yjsp-deploy.service"]]

    # While it runs, the card shows it, and another click starts nothing.
    assert client.get("/api/deploys", headers=owner).json()["deploys"][0] == started
    again = client.post("/api/deploys", json={"commit": c}, headers=owner)
    assert (again.status_code, again.json()["error"]) == (409, "deploy_running")
    assert len(systemctl_calls(tmp_path)) == 1

    # Its log as it's written: each time from where the last answer ended.
    log = f"/api/deploys/{started['id']}/log"
    first = client.get(log, headers=owner).json()
    assert first == {"text": "==> Fetching main from GitHub\n", "size": 30}
    path = settings.deploy_dir / "deploys" / f"{started['id']}.log"
    with path.open("ab") as file:
        file.write(f"main is {c[:7]}: Deploy main from the site (#143) — “merged”\n".encode())
    more = client.get(log, params={"start": first["size"]}, headers=owner).json()
    assert more == {
        "text": f"main is {c[:7]}: Deploy main from the site (#143) — “merged”\n",
        "size": path.stat().st_size,
    }

    # It ends, deployed, and what's live says so.
    said = path.with_suffix(".json")
    ended = json.loads(said.read_text()) | {"commit": c, "result": "deployed", "finished": "2026-11-16T19:10:00Z"}
    said.write_text(json.dumps(ended))
    live(settings.deploy_dir, c, "Deploy main from the site (#143)")
    state = client.get("/api/deploys", headers=owner).json()
    assert (state["deploys"][0]["state"], state["deploys"][0]["commit"], state["live"]["commit"]) == ("deployed", c, c)
    main = client.get("/api/deploys/main", headers=owner).json()
    assert (main["commits"], main["ahead"]) == ([], 0)  # main is live


def test_a_deploy_needs_main_to_be_what_was_shown_and_ci_to_have_passed_on_it(client, team, settings, github, tmp_path):
    a, b, c = two_pulls_since(github)
    github.runs[c] = [run("server"), run("client", id=2), run("web", "failure", id=3)]  # image hasn't run: web failed
    owner = team.member(OWNER, admin=True)

    moved = client.post("/api/deploys", json={"commit": b}, headers=owner)
    assert (moved.status_code, moved.json()["error"]) == (409, "deploy_main_moved")
    assert moved.json()["message"] == f"main is at {c[:7]} now, not {b[:7]}: look at it before deploying it"

    failing = client.post("/api/deploys", json={"commit": c}, headers=owner)
    assert (failing.status_code, failing.json()["error"]) == (409, "deploy_checks_failed")
    assert failing.json()["message"] == f"CI hasn't passed on {c[:7]}: web failed, image hasn't run"
    assert systemctl_calls(tmp_path) == []

    # With nothing recorded as live, the card can't say what's on main since.
    main = client.get("/api/deploys/main", headers=owner).json()
    assert (main["commits"], main["ahead"]) == (None, None)
    assert client.post("/api/deploys", json={"commit": "main"}, headers=owner).status_code == 422


def test_a_deploy_that_stopped_without_saying_holds_nothing_up(client, team, settings, github, tmp_path):
    a, b, c = two_pulls_since(github)
    github.runs[c] = passed()
    # Its record untouched for five minutes, as when the server restarted under it.
    record(
        settings.deploy_dir,
        "20261116-120000",
        source="site",
        commit=a,
        started="2026-11-16T12:00:00Z",
        step="build",
        age=300,
    )
    owner = team.member(OWNER, admin=True)
    [interrupted] = client.get("/api/deploys", headers=owner).json()["deploys"]
    assert (interrupted["state"], interrupted["step"], interrupted["finished_at"]) == ("interrupted", "build", None)
    assert client.post("/api/deploys", json={"commit": c}, headers=owner).status_code == 202


@pytest.mark.parametrize(
    ("mode", "code", "said"),
    [
        ("denied", "deploy_start_failed", "its polkit rule (deploy/yjsp-deploy.rules) isn't installed"),
        ("missing", "deploy_start_failed", "yjsp-deploy.service isn't installed on this server"),
        ("silent", "deploy_not_started", "journalctl -u yjsp-deploy, on the server, says why"),
    ],
)
def test_when_systemd_doesnt_start_it_the_card_says_why(
    client, app, team, settings, github, tmp_path, monkeypatch, mode, code, said
):
    monkeypatch.setattr(deploy, "STARTING", 0.5)
    a, b, c = two_pulls_since(github)
    github.runs[c] = passed()
    app.state.deploys.settings = settings.model_copy(
        update={"deploy_systemctl": [*settings.deploy_systemctl[:-1], mode]}
    )
    owner = team.member(OWNER, admin=True)
    response = client.post("/api/deploys", json={"commit": c}, headers=owner)
    assert (response.status_code, response.json()["error"]) == (502, code)
    assert said in response.json()["message"]
    assert client.get("/api/deploys", headers=owner).json()["deploys"] == []


def test_without_yjsp_deploy_deploying_from_the_site_is_off(client, team, settings, github):
    a, b, c = two_pulls_since(github)
    github.runs[c] = passed()
    settings.deploy_dir.rmdir()
    owner = team.member(OWNER, admin=True)
    state = client.get("/api/deploys", headers=owner).json()
    assert (state["available"], state["live"], state["deploys"]) == (False, None, [])
    assert state["reason"].endswith('docs/deploying.md, "Deploying from the site", sets it up')
    response = client.post("/api/deploys", json={"commit": c}, headers=owner)
    assert (response.status_code, response.json()["error"]) == (503, "deploy_off")


def test_githubs_hourly_limit_says_when_it_lifts(client, team, settings, github):
    github.limited = True
    owner = team.member(OWNER, admin=True)
    response = client.get("/api/deploys/main", headers=owner)
    assert (response.status_code, response.json()["error"]) == (502, "deploy_github_failed")
    lifts = datetime.fromtimestamp(1795384800, UTC)
    assert response.json()["message"].endswith(f"it answers again at {lifts:%H:%M} UTC")
    assert response.json()["details"] == {"reset_at": lifts.isoformat()}


def test_a_log_is_read_in_whole_characters(client, team, settings, monkeypatch):
    monkeypatch.setattr(deploy, "MOST_LOG", 4)
    record(settings.deploy_dir, "20261116-120000", log="ab→cd", source="site", started="2026-11-16T12:00:00Z")
    owner = team.member(OWNER, admin=True)
    log = "/api/deploys/20261116-120000/log"
    assert client.get(log, headers=owner).json() == {"text": "ab", "size": 2}  # not half of the arrow
    assert client.get(log, params={"start": 2}, headers=owner).json() == {"text": "→c", "size": 6}
    assert client.get(log, params={"start": 6}, headers=owner).json() == {"text": "d", "size": 7}
    assert client.get(log, params={"start": 7}, headers=owner).json() == {"text": "", "size": 7}
    for missing in ("20261116-120001", "live", "20261116"):
        assert client.get(f"/api/deploys/{missing}/log", headers=owner).status_code == 404


def test_what_must_pass_is_every_job_of_ci():
    """The jobs the card and yjsp-deploy wait for are CI's own, but for the one only release tags run."""
    workflow = (REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    jobs = re.findall(r"^  ([a-z][a-z0-9_-]*):$", workflow.split("\njobs:\n", 1)[1], re.MULTILINE)
    assert [job for job in jobs if job != "release"] == list(deploy.CHECKS)
    script = (REPO / "deploy" / "deploy-here.sh").read_text(encoding="utf-8")
    assert f"CHECKS=({' '.join(deploy.CHECKS)})" in script
