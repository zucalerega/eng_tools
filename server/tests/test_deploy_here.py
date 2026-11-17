"""yjsp-deploy (deploy/deploy-here.sh), as yjsp-deploy.service runs it on the server, and as deploy.sh has the server's
bash run its switch-over: in folders of the test's own, with GitHub a repository here and a stand-in for its API
(fake_github.py), and systemctl, journalctl, curl, uv, and npm stand-ins that keep what they were asked. The rehearsal is
real: this code's migrations, on a copy of a database of the site's."""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import pytest

from yjsp_server.db import make_engine, migrate

from .fake_github import REPOSITORY, FakeGitHub, passed, run

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "deploy-here.sh"

pytestmark = pytest.mark.skipif(
    sys.platform == "win32" or not all(shutil.which(tool) for tool in ("bash", "git", "sqlite3", "flock", "python3")),
    reason="runs as on the server: needs Linux, with bash, git, sqlite3, flock, and python3",
)

# The stand-ins, each noting what it was asked in STUB_LOG. Units "run" while their file is in STUB_UNITS.
STUBS = {
    "systemctl": """
installed = os.environ["STUB_INSTALLED"].split()
verb, unit = args[0], args[-1]
if unit not in installed:
    sys.exit(f"Unit {unit} could not be found.")
if verb == "stop":
    (units / unit).unlink(missing_ok=True)
elif verb in ("start", "restart"):
    (units / unit).write_text("running")
""",
    "journalctl": """
print("the server's last words: ModuleNotFoundError: No module named 'yjsp_server.nothing'")
""",
    # The site answers once it's running, unless its code says it's broken; the demo, once it's running.
    "curl": """
url, site, demo = args[-1], os.environ["YJSP_DEPLOY_SITE"], os.environ["YJSP_DEPLOY_DEMO"]
broken = (Path(os.environ["YJSP_DEPLOY_APP"]) / "server" / "BROKEN").exists()
if url in (f"{site}/healthz", f"{site}/help"):
    up = (units / "yjsp.service").exists() and not broken
    if up and url.endswith("/help"):
        print('<main id="guide">')
elif url == f"{demo}/healthz":
    up = (units / "yjsp-demo.service").exists()
else:
    up = False
sys.exit(0 if up else 7)
""",
    # An environment whose Python is this test's, which has the site's code: so the rehearsal runs its migrations.
    "uv": """
project = Path(args[args.index("--project") + 1])
python = project / ".venv" / "bin" / "python"
python.parent.mkdir(parents=True, exist_ok=True)
python.write_text(f'#!/bin/sh\\nexec {PYTHON} "$@"\\n')
python.chmod(0o755)
""",
    # A build, unless the commit's web app says it breaks, or makes a link.
    "npm": """
if args[0] == "ci":
    Path("node_modules").mkdir(exist_ok=True)
elif args[:2] == ["run", "build"]:
    if Path("BREAK").exists():
        sys.exit("src/App.tsx(3,1): error TS1005: ';' expected.")
    Path("dist").mkdir(exist_ok=True)
    Path("dist/index.html").write_text("<title>the new build</title>")
    if Path("LINK").exists():
        Path("dist/assets.js").symlink_to("/srv/yjsp/.env")
""",
}


@pytest.fixture(scope="module")
def database(tmp_path_factory) -> Path:
    """A database of the site's, one migration behind this code's, made once."""
    path = tmp_path_factory.mktemp("database") / "yjsp.db"
    engine = make_engine(f"sqlite:///{path}")
    migrate(engine, "0035")
    engine.dispose()
    return path


@pytest.fixture
def github():
    fake = FakeGitHub()
    yield fake
    fake.close()


class Server:
    """The server in miniature: the site's code, data, and services, GitHub's main, and how deploying went."""

    def __init__(self, root: Path, github: FakeGitHub, database: Path):
        self.root, self.github = root, github
        self.app, self.srv, self.state, self.work = root / "app", root / "srv", root / "state", root / "work"
        self.units, self.log, self.lock = root / "units", root / "stub.log", root / "deploy.lock"
        self.origin = root / "github"
        bin_dir, node = root / "bin", root / "node"
        for folder in (bin_dir, node, self.units, self.state, self.srv / "backups", self.srv / "data"):
            folder.mkdir(parents=True)
        for name, body in STUBS.items():
            stub = (node if name == "npm" else bin_dir) / name
            stub.write_text(
                f"#!{sys.executable}\nimport json, os, sys\nfrom pathlib import Path\nPYTHON = {sys.executable!r}\n"
                f"args = sys.argv[1:]\nunits = Path(os.environ['STUB_UNITS'])\n"
                f"with open(os.environ['STUB_LOG'], 'a') as log:\n    log.write(json.dumps([{name!r}, *args]) + '\\n')\n"
                + body
            )
            stub.chmod(0o755)
        shutil.copyfile(database, self.srv / "data" / "yjsp.db")
        # What's live: version 1, running.
        self.write(self.app, {"server/pyproject.toml": "[project]\n", "server/VERSION": "1", "server/.venv/kept": ""})
        self.write(self.app, {"web/dist/index.html": "<title>the old build</title>", "help/README.md": "the old help"})
        (self.units / "yjsp.service").write_text("running")
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "YJSP_DEPLOY_REPOSITORY": REPOSITORY,
            "YJSP_DEPLOY_GIT_URL": f"file://{self.origin}",
            "YJSP_DEPLOY_GITHUB_API": github.url,
            "YJSP_DEPLOY_APP": str(self.app),
            "YJSP_DEPLOY_SRV": str(self.srv),
            "YJSP_DEPLOY_STATE": str(self.state),
            "YJSP_DEPLOY_WORK": str(self.work),
            "YJSP_DEPLOY_LOCK": str(self.lock),
            "YJSP_DEPLOY_LOCK_WAIT": "1",
            "YJSP_DEPLOY_NODE": str(node),
            "YJSP_DEPLOY_UV": str(bin_dir / "uv"),
            "YJSP_DEPLOY_SITE": "http://127.0.0.1:8100",
            "YJSP_DEPLOY_DEMO": "http://127.0.0.1:8200",
            "YJSP_DEPLOY_WAIT": "2",
            "YJSP_DEPLOY_SITE_USER": "",  # the test's own user, for the site's and the builder's
            "YJSP_DEPLOY_BUILDER": "",
            "STUB_LOG": str(self.log),
            "STUB_UNITS": str(self.units),
            "STUB_INSTALLED": "yjsp.service yjsp-demo.service",
            "GIT_AUTHOR_NAME": "Chief",
            "GIT_AUTHOR_EMAIL": "chief@rocketry.test",
            "GIT_COMMITTER_NAME": "GitHub",
            "GIT_COMMITTER_EMAIL": "noreply@github.test",
        }

    @staticmethod
    def write(root: Path, files: dict[str, str]) -> None:
        for name, text in files.items():
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(text)

    def merge(
        self, message: str = "Merge pull request #143 from rocketry/deploy\n\nDeploy main from the site", **files
    ):
        """A new commit on GitHub's main, version 2 of the site, with `files` besides; returns its SHA."""
        if not self.origin.exists():
            subprocess.run(["git", "init", "--quiet", "-b", "main", str(self.origin)], check=True)
        self.write(
            self.origin,
            {
                "server/pyproject.toml": "[project]\n",
                "server/VERSION": "2",
                "web/package.json": "{}\n",
                "README.md": "the new help",
                "docs/deploying.md": "# Hosting and deploying\n",
                "client/src/Vault.SolidWorks/README.md": "# The add-in\n",
                **files,
            },
        )
        git = ["git", "-C", str(self.origin)]
        subprocess.run([*git, "add", "--all"], check=True, env=self.env)
        subprocess.run([*git, "commit", "--quiet", "-m", message], check=True, env=self.env)
        return subprocess.run([*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()

    def deploy(self, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
        """yjsp-deploy, as its unit runs it; or with `args`, as deploy.sh has the server's bash run it, from stdin."""
        if args:
            with SCRIPT.open() as script:
                return subprocess.run(
                    ["bash", "-s", "--", *args],
                    stdin=script,
                    env=self.env | env,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
        return subprocess.run(["bash", str(SCRIPT)], env=self.env | env, capture_output=True, text=True, timeout=120)

    def calls(self, name: str | None = None) -> list[list[str]]:
        found = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return [call[1:] for call in found if call[0] == name] if name else found

    def record(self) -> tuple[dict, str]:
        """The newest deploy's record and log."""
        [newest, *_] = sorted((self.state / "deploys").glob("*.json"), key=lambda path: path.stem, reverse=True)
        return json.loads(newest.read_text()), newest.with_suffix(".log").read_text()

    def revision(self) -> str:
        with closing(sqlite3.connect(self.srv / "data" / "yjsp.db")) as db:
            return db.execute("SELECT version_num FROM alembic_version").fetchone()[0]

    def unchanged(self) -> None:
        """The site is as it was: version 1, running, never stopped, its database neither backed up nor changed."""
        assert (self.app / "server" / "VERSION").read_text() == "1"
        assert (self.app / "web" / "dist" / "index.html").read_text() == "<title>the old build</title>"
        assert (self.units / "yjsp.service").exists() and ["stop", "yjsp.service"] not in self.calls("systemctl")
        assert sorted(path.name for path in (self.srv / "backups").iterdir()) == []
        assert not (self.state / "live.json").exists()


@pytest.fixture
def server(tmp_path, github, database) -> Server:
    return Server(tmp_path, github, database)


def test_main_is_deployed_once_ci_passed_and_its_migrations_were_rehearsed_on_a_copy(server, github):
    commit = server.merge()
    github.runs[commit] = passed()
    done = server.deploy()
    assert done.returncode == 0, done.stdout + done.stderr

    # The new version is live: its code (in the environment the site's had), the web app as built, and the help.
    app = server.app
    assert (app / "server" / "VERSION").read_text() == "2" and (app / "server" / ".venv" / "kept").exists()
    assert (app / "web" / "dist" / "index.html").read_text() == "<title>the new build</title>"
    assert (app / "help" / "README.md").read_text() == "the new help"
    assert (app / "help" / "client" / "src" / "Vault.SolidWorks" / "README.md").exists()
    assert sorted(path.name for path in app.iterdir()) == ["help", "help.old", "server", "server.old", "web", "web.old"]
    assert (server.units / "yjsp.service").exists() and (server.units / "yjsp-demo.service").exists()
    assert server.calls("systemctl") == [
        ["stop", "yjsp.service"],
        ["start", "yjsp.service"],
        ["cat", "yjsp-demo.service"],
        ["restart", "yjsp-demo.service"],
    ]
    assert [call[0] for call in server.calls("npm")] == ["ci", "run"]

    # Its migrations ran on a copy, which is gone again; the database was backed up before the switch, and the site's
    # own server, a stand-in here, migrates it when it starts.
    assert server.revision() == "0035"
    [backup] = (server.srv / "backups").iterdir()
    assert backup.name.startswith("yjsp-before-deploy-") and backup.name.endswith(".db.gz")
    uv = server.calls("uv")
    assert [call[call.index("--project") + 1] for call in uv] == [str(server.work / "server"), "server"]
    assert "--compile-bytecode" in uv[1] and "--locked" in uv[0]

    # What the card reads: the deploy, with all it said, and what's live.
    record, log = server.record()
    short = commit[:7]
    assert record["source"] == "site" and record["commit"] == commit
    assert record["subject"] == "Deploy main from the site (#143)"  # its pull request's title, as it's a merge
    assert (record["result"], record["message"], record["step"]) == ("deployed", f"{short} is live", "demo")
    assert record["started"] <= record["finished"]
    for said in (
        "==> Fetching main from GitHub",
        f"main is {short}: Deploy main from the site (#143)",
        f"CI passed on {short}: server, client, web, image",
        "==> Rehearsing the migrations on a copy of the database",
        "The copy went from migration 0035 to ",
        "Deployed: YJSP answers.",
        "The demo is made again, and answers.",
    ):
        assert said in log, said
    live = json.loads((server.state / "live.json").read_text())
    assert (live["commit"], live["subject"]) == (commit, "Deploy main from the site (#143)")
    assert live["deploy"] == next((server.state / "deploys").glob("*.json")).stem
    # The build's folders are gone; GitHub's main stays fetched, for the next deploy.
    assert sorted(path.name for path in server.work.iterdir()) == ["npm", "repo.git"]


def test_nothing_changes_unless_every_job_of_ci_passed(server, github):
    commit = server.merge()
    github.runs[commit] = [*passed("server", "client", "web"), run("image", "failure", id=9)]
    done = server.deploy()
    assert done.returncode == 1
    record, log = server.record()
    assert (record["result"], record["step"]) == ("stopped", "checks")
    assert record["message"] == f"CI hasn't passed on {commit[:7]}: image failed"
    assert f"Stopped: CI hasn't passed on {commit[:7]}: image failed" in log
    server.unchanged()
    assert server.calls("npm") == []

    github.runs[commit] = [*passed("server", "client", "web"), run("image", status="in_progress", id=9)]
    assert server.deploy().returncode == 1
    assert server.record()[0]["message"] == f"CI hasn't passed on {commit[:7]}: image is running"


def test_migrations_that_fail_on_the_copy_stop_it_before_anything_changes(server, github):
    with closing(sqlite3.connect(server.srv / "data" / "yjsp.db")) as db, db:
        db.execute("UPDATE alembic_version SET version_num = '9999'")  # a database this code's migrations don't know
    commit = server.merge()
    github.runs[commit] = passed()
    done = server.deploy()
    assert done.returncode == 1
    record, log = server.record()
    assert (record["result"], record["step"]) == ("stopped", "rehearse")
    assert (
        record["message"] == "Its migrations failed on a copy of the database, so nothing has changed: the log says why"
    )
    assert "Can't locate revision identified by '9999'" in log
    server.unchanged()
    assert server.revision() == "9999"


@pytest.mark.parametrize(
    ("files", "said"),
    [
        ({"web/BREAK": ""}, "The web app didn't build: the log says why"),
        ({"web/LINK": ""}, "The web app's build made something that isn't a file or a folder: "),
    ],
)
def test_a_build_that_breaks_or_makes_links_stops_it(server, github, files, said):
    commit = server.merge(**files)
    github.runs[commit] = passed()
    assert server.deploy().returncode == 1
    record, _ = server.record()
    assert (record["result"], record["step"]) == ("stopped", "build") and record["message"].startswith(said)
    server.unchanged()


def test_a_new_version_that_doesnt_answer_is_put_back(server, github):
    commit = server.merge(**{"server/BROKEN": ""})
    github.runs[commit] = passed()
    done = server.deploy()
    assert done.returncode == 1
    app = server.app
    assert (app / "server" / "VERSION").read_text() == "1" and (app / "server" / ".venv" / "kept").exists()
    assert (app / "web" / "dist" / "index.html").read_text() == "<title>the old build</title>"
    assert (app / "help" / "README.md").read_text() == "the old help"
    assert (server.units / "yjsp.service").exists()
    record, log = server.record()
    assert (record["result"], record["step"]) == ("rolled-back", "rollback")
    for said in ("putting the old one back", "the server's last words", "The old version is back."):
        assert said in log
    assert not (server.state / "live.json").exists()
    assert ["restart", "yjsp-demo.service"] not in server.calls("systemctl")


def test_deploy_sh_switches_over_the_same_way(server):
    """deploy.sh copies the version it built beside the site's (*.new), then has the server's bash run this."""
    server.write(server.app, {"server.new/pyproject.toml": "[project]\n", "server.new/VERSION": "2"})
    server.write(server.app, {"web.new/dist/index.html": "<title>built on a laptop</title>", "help.new/README.md": "!"})
    commit = "0123456789abcdef0123456789abcdef01234567"
    done = server.deploy("switch-over", commit, "Release 0.7.0 — “deploys”")
    assert done.returncode == 0, done.stdout + done.stderr
    assert "Deployed: YJSP answers." in done.stdout  # on the laptop, as it was
    assert (server.app / "server" / "VERSION").read_text() == "2"
    assert (server.app / "web" / "dist" / "index.html").read_text() == "<title>built on a laptop</title>"
    record, _ = server.record()
    assert (record["source"], record["commit"], record["result"]) == ("laptop", commit, "deployed")
    assert record["subject"] == "Release 0.7.0 — “deploys”"
    assert json.loads((server.state / "live.json").read_text())["commit"] == commit
    assert server.calls("npm") == [] and len(server.calls("uv")) == 1  # built on the laptop: only synced here


def test_deploy_sh_works_on_a_server_not_set_up_to_deploy_from_the_site(server):
    server.write(server.app, {"server.new/pyproject.toml": "[project]\n", "server.new/VERSION": "2"})
    server.write(server.app, {"web.new/dist/index.html": "<title>built on a laptop</title>", "help.new/README.md": "!"})
    server.state.rmdir()
    done = server.deploy("switch-over", "0123456789abcdef0123456789abcdef01234567")
    assert done.returncode == 0, done.stdout + done.stderr
    assert (server.app / "server" / "VERSION").read_text() == "2"
    assert not server.state.exists()


def test_deploy_sh_stops_before_anything_changes_if_what_it_copied_isnt_whole(server):
    server.write(server.app, {"server.new/pyproject.toml": "[project]\n", "help.new/README.md": "!"})  # no web app
    done = server.deploy("switch-over", "0123456789abcdef0123456789abcdef01234567")
    assert done.returncode == 1
    record, _ = server.record()
    assert record["result"] == "stopped" and record["message"].startswith("web.new isn't whole")
    server.unchanged()


def test_one_deploy_at_a_time(server, github):
    import fcntl  # Linux, as the server: the test is skipped elsewhere

    commit = server.merge()
    github.runs[commit] = passed()
    (server.work / "build").mkdir(parents=True)  # the running deploy's build
    with server.lock.open("w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        assert server.deploy().returncode == 1
    record, _ = server.record()
    assert record["result"] == "stopped"
    assert record["message"] == "Another deploy is running, from the site or deploy.sh: wait for it to finish"
    assert (server.work / "build").exists()  # its build is the other deploy's, which is left alone
    server.unchanged()
