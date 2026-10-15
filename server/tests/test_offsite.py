"""The off-site backup (deploy/yjsp-offsite): what it copies, and what it reports, as the server runs it every night
and every week. restic itself can't run here: a stand-in keeps its "repository" as a copy of what it was given."""

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "yjsp-offsite"

pytestmark = pytest.mark.skipif(shutil.which("sqlite3") is None, reason="needs the sqlite3 command, as the server has")

RESTIC = r'''#!/usr/bin/env python3
"""A stand-in for restic: the "repository" is a copy of what it last backed up, under $STUB_REPO."""
import json, os, shutil, sys
from pathlib import Path

args = sys.argv[1:]
with open(os.environ["STUB_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
if os.environ.get("STUB_FAIL") == args[0]:
    print("Fatal: unable to open config file: Stat: 403 Forbidden", file=sys.stderr)
    sys.exit(1)
positional, excluded, rest = [], [], iter(args[1:])
for arg in rest:
    if arg == "--exclude":
        excluded.append(next(rest))
    elif arg in ("--host", "--tag", "--keep-daily", "--keep-weekly", "--keep-monthly", "--max-unused"):
        next(rest)
    elif not arg.startswith("--"):
        positional.append(arg)
latest = Path(os.environ["STUB_REPO"]) / "latest"
if args[0] == "backup":
    shutil.rmtree(latest, ignore_errors=True)
    for path in map(Path, positional):
        found = [path] if path.is_file() else [p for p in path.rglob("*") if p.is_file()]
        for file in found:
            if not any(str(file).startswith(ex + "/") or str(file) == ex for ex in excluded):
                (latest / str(file).lstrip("/")).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, latest / str(file).lstrip("/"))
    print(json.dumps({"message_type": "summary", "snapshot_id": "0123456789abcdef" * 4}))
elif args[0] == "ls":
    for file in sorted(p for p in latest.rglob("*") if p.is_file()):
        print("/" + str(file.relative_to(latest)))
elif args[0] == "dump":
    sys.stdout.buffer.write((latest / positional[1].lstrip("/")).read_bytes())
'''


@pytest.fixture
def server(tmp_path) -> dict[str, Path]:
    """A server's /srv/yjsp in miniature: a database, a version in Vault, a dataset in Yorg, and their temporary files."""
    home = tmp_path / "srv"
    (home / "backups").mkdir(parents=True)
    (home / "data").mkdir()
    db = sqlite3.connect(home / "data" / "yjsp.db")
    db.execute("CREATE TABLE users (email TEXT)")
    db.execute("INSERT INTO users VALUES ('gburdell3@gatech.edu')")
    db.commit()
    db.close()
    content = b"a fin, as SolidWorks saved it"
    sha = hashlib.sha256(content).hexdigest()
    blob = home / "data" / "vault" / "blobs" / sha[:2] / sha[2:4] / sha
    blob.parent.mkdir(parents=True)
    blob.write_bytes(content)
    for leftover in ("vault/blobs/tmp/upload.part", "yorg/tmp/read.part", "yorg/runs/r1/out.json"):
        (home / "data" / leftover).parent.mkdir(parents=True, exist_ok=True)
        (home / "data" / leftover).write_text("not worth keeping")
    (home / "data" / "yorg" / "datasets" / "1").mkdir(parents=True)
    (home / "data" / "yorg" / "datasets" / "1" / "run.csv").write_text("time,pressure\n0,14.7\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "restic").write_text(RESTIC)
    (bin_dir / "restic").chmod(0o755)
    env_file = tmp_path / "offsite.env"
    env_file.write_text("RESTIC_REPOSITORY=s3:https://example.r2.cloudflarestorage.com/yjsp-backups\n")
    return {
        "home": home,
        "bin": bin_dir,
        "env": env_file,
        "repo": tmp_path / "repo",
        "log": tmp_path / "restic.log",
        "work": tmp_path / "work",
        "blob": blob,
    }


def offsite(server: dict[str, Path], mode: str, fail: str = "") -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "PATH": f"{server['bin']}{os.pathsep}{os.environ['PATH']}",
        "YJSP_HOME": str(server["home"]),
        "OFFSITE_ENV": str(server["env"]),
        "OFFSITE_WORK": str(server["work"]),
        "AS_YJSP": "",
        "STUB_REPO": str(server["repo"]),
        "STUB_LOG": str(server["log"]),
        "STUB_FAIL": fail,
    }
    return subprocess.run(["bash", str(SCRIPT), mode], env=env, capture_output=True, text=True, timeout=60)


def report(server: dict[str, Path]) -> dict:
    status = server["home"] / "backups" / "offsite.json"
    assert oct(status.stat().st_mode & 0o777) == "0o644"  # the site, another user, reads it
    return json.loads(status.read_text())


def restic_calls(server: dict[str, Path]) -> list[list[str]]:
    return [json.loads(line) for line in server["log"].read_text().splitlines()]


def test_a_night_copies_the_database_vaults_files_and_yorgs_but_not_whats_temporary(server):
    done = offsite(server, "backup")
    assert done.returncode == 0, done.stderr
    assert "backed up as 01234567" in done.stdout

    status = report(server)
    assert status["snapshot"] == "01234567" and status["backed_up_at"].endswith("Z")
    assert status["backup_error"] is None
    kept = {"/" + str(p.relative_to(server["repo"] / "latest")) for p in (server["repo"] / "latest").rglob("*")}
    home = str(server["home"])
    assert f"{home}/backups/offsite/yjsp.db" in kept  # a consistent copy, not the live file
    assert f"{home}{str(server['blob']).removeprefix(home)}" in kept
    assert f"{home}/data/yorg/datasets/1/run.csv" in kept
    assert not [path for path in kept if "/tmp/" in path or "/runs/" in path]
    with sqlite3.connect(server["repo"] / "latest" / f"{home}/backups/offsite/yjsp.db".lstrip("/")) as db:
        assert db.execute("SELECT email FROM users").fetchall() == [("gburdell3@gatech.edu",)]

    backup, forget = restic_calls(server)
    assert backup[:3] == ["backup", "--host", "yjsp"] and "--one-file-system" in backup
    assert forget[:8] == ["forget", "--host", "yjsp", "--tag", "nightly", "--keep-daily", "14", "--keep-weekly"]


def test_a_failed_night_says_what_failed_and_keeps_the_last_good_copys_date(server):
    assert offsite(server, "backup").returncode == 0
    good = report(server)["backed_up_at"]

    failed = offsite(server, "backup", fail="backup")
    assert failed.returncode != 0
    status = report(server)
    assert status["backup_error"] == "backing up: Fatal: unable to open config file: Stat: 403 Forbidden"
    assert status["backup_failed_at"] and status["backed_up_at"] == good
    assert "Fatal: unable to open config file" in failed.stderr  # and in the journal

    # The next good night clears it.
    assert offsite(server, "backup").returncode == 0
    assert report(server)["backup_error"] is None


def test_a_week_restores_the_database_and_vaults_files_and_checks_them(server):
    assert offsite(server, "backup").returncode == 0
    checked = offsite(server, "verify")
    assert checked.returncode == 0, checked.stderr
    assert "the database and 1 of Vault's files restored and checked" in checked.stdout
    assert report(server)["verified_at"] and report(server)["verify_error"] is None
    assert [call[0] for call in restic_calls(server)][2:] == ["check", "dump", "ls", "dump"]

    # A file that comes back different fails the check, by name.
    stored = server["repo"] / "latest" / str(server["blob"]).lstrip("/")
    stored.write_bytes(b"bit rot")
    broken = offsite(server, "verify")
    assert broken.returncode != 0
    status = report(server)
    assert status["verify_error"].startswith(f"restoring Vault's files: {server['blob']} came back different")
    assert status["verify_failed_at"] and status["backed_up_at"]
