"""Deploying main from the site: Admin > People's Deploy card, for the site's owner alone (YJSP_DEPLOYER).
docs/deploying.md, "Deploying from the site", says how a server is set up for it; docs/design.md, "Deploying", why it
works as it does.

The site never deploys itself. It runs as yjsp, which can't change the site's code, and a deploy stops it. So it asks
systemd to start yjsp-deploy.service (a polkit rule lets yjsp start that unit, and do nothing else), which runs
deploy/deploy-here.sh as root, with no arguments: it deploys main's newest commit, once every job of CI has passed on it,
and nothing else. The script writes how each deploy goes in YJSP_DEPLOY_DIR, which the site only reads: deploys/<id>.json
and <id>.log, a deploy's record and everything it said (its id is when it started), and live.json, what's live.

What the card shows of GitHub (main's newest commit, CI's check runs on it, the migrations it would run, the commits
since what's live) comes from GitHub's API, without a token, as the repository is public. Without one, GitHub answers a
server 60 requests an hour, so what can't change (what a commit holds, how two compare) is kept, and what can (main,
and CI on it) for a few seconds.
"""

import ast
import contextlib
import json
import logging
import os
import re
import subprocess
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx2

from .config import Settings
from .errors import ApiError, Conflict, Forbidden, NotFound
from .models import User

log = logging.getLogger(__name__)

UNIT = "yjsp-deploy.service"
# CI's jobs (.github/workflows/ci.yml), every one of which must pass on a commit before it's deployed: deploy-here.sh
# checks the same ones, and a test holds both to CI's.
CHECKS = ("server", "client", "web", "image")
GITHUB = "https://api.github.com"
WAIT = 20.0  # seconds, for one of GitHub's answers
MAIN_KEPT = 15.0  # seconds main, and CI on it, are kept: Check again, on the card, asks GitHub anew
FOREVER = float("inf")
KEPT = 200  # answers kept from GitHub, at most
STALE = 60.0  # seconds a deploy's record can go untouched while it runs (it's touched every 10)
SHOWN = 10  # deploys the card lists
STARTING = 15.0  # seconds a deploy has to start its record, once systemd is asked to start it
MOST_LOG = 256 * 1024  # bytes of a deploy's log in one answer
MIGRATIONS = "server/src/yjsp_server/migrations/versions"
MIGRATION = re.compile(r"^\d{4}_\w+\.py$")
DEPLOY_ID = re.compile(r"^\d{8}-\d{6}$")  # when it started, in UTC, to the second: no two deploys start in one
_MERGE = re.compile(r"^Merge pull request #(\d+) ")
# How a deploy ended, as yjsp-deploy says it: live now; stopped before anything changed; the new version didn't answer,
# and the old one is back; or the site may be down. Besides these, one that's running, and one that stopped without
# saying (interrupted).
RESULTS = ("deployed", "stopped", "rolled-back", "failed")


class DeployOff(ApiError):
    """Deploying from the site isn't set up on this server."""

    status = 503
    code = "deploy_off"


class GitHubFailed(ApiError):
    """GitHub's API didn't say what the card needs."""

    status = 502
    code = "deploy_github_failed"


class StartFailed(ApiError):
    """systemd didn't start yjsp-deploy.service, or it didn't start deploying."""

    status = 502
    code = "deploy_start_failed"


@dataclass(frozen=True)
class Commit:
    sha: str
    title: str  # its subject, or for a pull request's merge, the pull request's title
    pull: int | None  # the pull request it merged
    author: str | None
    at: datetime | None


@dataclass(frozen=True)
class Check:
    """One of CI's jobs on a commit, as GitHub says it: its latest run."""

    name: str
    status: str  # queued, in_progress, completed; or missing, when CI hasn't started it
    conclusion: str | None  # once it's completed: success, failure, cancelled, ...
    url: str | None  # its page on GitHub

    @property
    def passed(self) -> bool:
        return self.status == "completed" and self.conclusion == "success"

    def said(self) -> str:
        """How it's going, in words."""
        if self.status == "missing":
            return f"{self.name} hasn't run"
        if self.status != "completed":
            return f"{self.name} is {'running' if self.status == 'in_progress' else 'waiting'}"
        ended = {"failure": "failed", "cancelled": "was cancelled", "timed_out": "timed out", "skipped": "was skipped"}
        return f"{self.name} {ended.get(self.conclusion or '', self.conclusion)}"


@dataclass(frozen=True)
class Migration:
    name: str  # its file's: 0037_deploys.py
    title: str | None  # the first line of its docstring
    url: str  # on GitHub


@dataclass(frozen=True)
class Main:
    """main's newest commit, as the card shows it: what deploying now would deploy."""

    commit: Commit
    checks: list[Check]
    migrations: list[Migration]  # the migrations it would run: those the site's code doesn't have
    commits: list[Commit] | None  # main's own since what's live (merges, and commits straight to it), newest first
    ahead: int | None  # commits in all since what's live; None: what's live isn't known, or GitHub can't compare


@dataclass(frozen=True)
class Live:
    commit: str
    subject: str | None
    deployed_at: datetime | None
    deploy: str | None  # the deploy that made it live


@dataclass(frozen=True)
class Deploy:
    """A deploy, as yjsp-deploy recorded it."""

    id: str  # when it started: 20261116-193000
    source: str  # "site", or "laptop" (deploy.sh)
    commit: str | None
    subject: str | None
    started_at: datetime | None
    finished_at: datetime | None
    state: str  # running, interrupted, or how it ended (RESULTS)
    step: str | None  # what it's doing, or was when it ended
    message: str | None


def is_owner(settings: Settings, user: User) -> bool:
    """Whether this is the site's owner, who alone deploys it: YJSP_DEPLOYER, an admin."""
    owner = settings.deployer.strip().lower()
    return bool(owner) and user.is_admin and user.email.lower() == owner


class GitHub:
    """GitHub's API for the repository whose main is deployed, without a token: what it says that can't change is kept,
    and what can, for a few seconds."""

    def __init__(self, settings: Settings):
        self.base = (settings.github_base_url or GITHUB).rstrip("/")
        self.repository = settings.deploy_repository
        self._kept: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def _get(self, path: str, *, kept: float, fresh: bool = False, raw: bool = False) -> Any:
        """What GitHub says at the repository's `path`, as JSON (or as it is, raw), kept `kept` seconds; `fresh`: asked
        again, whatever's kept."""
        url = f"{self.base}/repos/{self.repository}/{path}"
        now = time.monotonic()
        with self._lock:
            hit = self._kept.get(url)
            if hit is not None and hit[0] > now and not fresh:
                self._kept.move_to_end(url)
                return hit[1]
        headers = {
            "Accept": "application/vnd.github.raw+json" if raw else "application/vnd.github+json",
            "User-Agent": "yjsp-server",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        try:
            response = httpx2.get(url, headers=headers, timeout=WAIT, follow_redirects=True)
        except httpx2.HTTPError as error:
            log.warning("GitHub didn't answer: %s", type(error).__name__)
            raise GitHubFailed("GitHub didn't answer: try again in a minute") from None
        if response.status_code != 200:
            raise _failed(response, self.repository)
        try:
            value = response.text if raw else response.json()
        except ValueError:
            raise GitHubFailed("GitHub's answer wasn't what its API says it is: try again in a minute") from None
        with self._lock:
            self._kept[url] = (now + kept, value)
            self._kept.move_to_end(url)
            while len(self._kept) > KEPT:
                self._kept.popitem(last=False)
        return value

    def main(self, fresh: bool = False) -> Commit:
        """main's newest commit."""
        found = self._get("commits/main", kept=MAIN_KEPT, fresh=fresh)
        try:
            return _commit(found)
        except (KeyError, TypeError, ValueError):
            raise GitHubFailed("GitHub didn't say what main's newest commit is: try again in a minute") from None

    def checks(self, sha: str, fresh: bool = False) -> list[Check]:
        """CI's jobs on a commit, in CI's order: each one's latest run."""
        found = self._get(f"commits/{sha}/check-runs?per_page=100", kept=MAIN_KEPT, fresh=fresh)
        runs = found.get("check_runs") if isinstance(found, dict) else None
        if not isinstance(runs, list):
            raise GitHubFailed("GitHub didn't say how CI went: try again in a minute")
        latest: dict[str, dict[str, Any]] = {}
        for run in runs:
            name = run.get("name") if isinstance(run, dict) else None
            if name in CHECKS and run.get("id", 0) >= latest.get(name, {}).get("id", 0):
                latest[name] = run
        return [
            Check(name, str(run.get("status")), run.get("conclusion"), run.get("html_url"))
            if (run := latest.get(name))
            else Check(name, "missing", None, None)
            for name in CHECKS
        ]

    def migrations(self, sha: str, have: set[str]) -> list[Migration]:
        """The migrations a commit has that aren't in `have`: what deploying it would run."""
        listing = self._get(f"contents/{MIGRATIONS}?ref={sha}", kept=FOREVER)
        if not isinstance(listing, list):
            raise GitHubFailed("GitHub didn't list the commit's migrations: try again in a minute")
        names = sorted(
            entry["name"]
            for entry in listing
            if isinstance(entry, dict)
            and isinstance(entry.get("name"), str)
            and MIGRATION.match(entry["name"])
            and entry["name"] not in have
        )
        return [
            Migration(
                name,
                _title(self._get(f"contents/{MIGRATIONS}/{name}?ref={sha}", kept=FOREVER, raw=True)),
                f"https://github.com/{self.repository}/blob/{sha}/{MIGRATIONS}/{name}",
            )
            for name in names
        ]

    def since(self, base: str, head: str) -> tuple[list[Commit], int]:
        """main's own commits after `base` up to `head`, newest first (its merges, and any commit straight to it, not
        what the pull requests had in them), and how many commits there are in all."""
        found = self._get(f"compare/{base}...{head}", kept=FOREVER)
        listed = {commit["sha"]: commit for commit in found.get("commits", []) if isinstance(commit, dict)}
        mains: list[Commit] = []
        sha: str | None = head
        while sha in listed:
            commit = listed[sha]
            mains.append(_commit(commit))
            parents = commit.get("parents") or [{}]
            sha = parents[0].get("sha")
        return mains, int(found.get("ahead_by", len(listed)))


class Deploys:
    """Deploying main from the site, as yjsp-deploy does it: what's live, how the last deploys went, and starting one."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.github = GitHub(settings)
        self.folder = settings.deploy_dir
        # The site's own migrations: those main has that it hasn't, the new version would run.
        versions = Path(__file__).parent / "migrations" / "versions"
        self.migrations = {path.name for path in versions.glob("*.py") if MIGRATION.match(path.name)}

    def require_owner(self, user: User) -> None:
        if not is_owner(self.settings, user):
            raise Forbidden("Only the site's owner can deploy it", code="deploy_owner_only")

    def problem(self) -> str | None:
        """Why deploying from the site can't be done on this server, or None if it can."""
        try:
            next(self.folder.iterdir(), None)
        except (FileNotFoundError, NotADirectoryError):
            return (
                f"Deploying from the site isn't set up on this server: there's no {self.folder}. docs/deploying.md, "
                '"Deploying from the site", sets it up'
            )
        except PermissionError:
            return (
                f"The site can't read {self.folder}, where yjsp-deploy says how deploys went: it should be root's, in "
                'the group yjsp (docs/deploying.md, "Deploying from the site")'
            )
        except OSError as error:
            return f"The site can't read {self.folder}: {error}"
        return None

    def live(self) -> Live | None:
        """What's live, as the last deploy that made it live recorded it; None if none has."""
        found = _read(self.folder / "live.json")
        commit = found.get("commit") if found else None
        if not isinstance(commit, str) or not commit:
            return None
        return Live(commit, _text(found.get("subject")), _time(found.get("deployed_at")), _text(found.get("deploy")))

    def deploys(self, limit: int = SHOWN) -> list[Deploy]:
        """The newest deploys, the newest first."""
        return [deploy for name in self._ids()[:limit] if (deploy := self._deploy(name)) is not None]

    def running(self) -> Deploy | None:
        return next((deploy for deploy in self.deploys() if deploy.state == "running"), None)

    def log(self, deploy_id: str, start: int) -> tuple[str, int]:
        """What a deploy said from byte `start` of its log, and where the log ends now (to ask from next)."""
        if not DEPLOY_ID.match(deploy_id):
            raise NotFound(f"There's no deploy {deploy_id}")
        try:
            with (self.folder / "deploys" / f"{deploy_id}.log").open("rb") as file:
                size = os.fstat(file.fileno()).st_size
                start = start if start <= size else 0
                file.seek(start)
                said = _whole(file.read(MOST_LOG))
        except FileNotFoundError:
            raise NotFound(f"There's no deploy {deploy_id}") from None
        return said.decode("utf-8", errors="replace"), start + len(said)

    def main(self, fresh: bool = False) -> Main:
        """What deploying now would deploy: main's newest commit, CI on it, the migrations it would run, and what's on
        main since what's live."""
        commit = self.github.main(fresh)
        checks = self.github.checks(commit.sha, fresh)
        migrations = self.github.migrations(commit.sha, self.migrations)
        live = self.live()
        commits: list[Commit] | None = None
        ahead: int | None = None
        if live is not None and live.commit == commit.sha:
            commits, ahead = [], 0
        elif live is not None:
            # Unless GitHub doesn't have what's live (it was deployed from elsewhere): the rest stands.
            with contextlib.suppress(GitHubFailed):
                commits, ahead = self.github.since(live.commit, commit.sha)
        return Main(commit, checks, migrations, commits, ahead)

    def start(self, user: User, commit: str) -> Deploy:
        """Start deploying main, as the owner asks, once it's what they saw (`commit`) and CI has passed on it."""
        self.require_owner(user)
        if problem := self.problem():
            raise DeployOff(problem)
        if self.running() is not None:
            raise Conflict("A deploy is running: wait for it to finish", code="deploy_running")
        main = self.github.main(fresh=True)
        if main.sha != commit:
            raise Conflict(
                f"main is at {main.sha[:7]} now, not {commit[:7]}: look at it before deploying it",
                code="deploy_main_moved",
            )
        failing = [check for check in self.github.checks(main.sha, fresh=True) if not check.passed]
        if failing:
            raise Conflict(
                f"CI hasn't passed on {main.sha[:7]}: {', '.join(check.said() for check in failing)}",
                code="deploy_checks_failed",
            )
        before = set(self._ids())
        self._start_unit()
        log.info("The owner started a deploy of %s", main.sha[:7])
        deadline = time.monotonic() + STARTING
        while time.monotonic() < deadline:
            started = [name for name in self._ids() if name not in before]
            if started and (deploy := self._deploy(started[0])) is not None:
                return deploy
            time.sleep(0.2)
        raise StartFailed(
            f"systemd started {UNIT}, but it hasn't begun deploying: journalctl -u yjsp-deploy, on the server, says why",
            code="deploy_not_started",
        )

    def _start_unit(self) -> None:
        """Ask systemd to start yjsp-deploy.service, without waiting for it: the deploy stops this server."""
        command = [*self.settings.deploy_systemctl, "start", "--no-block", "--no-ask-password", UNIT]
        try:
            done = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        except (OSError, subprocess.SubprocessError) as error:
            raise StartFailed(f"The site couldn't ask systemd to start {UNIT}: {error}") from None
        if done.returncode == 0:
            return
        said = " ".join((done.stderr or done.stdout or "").split())[:300] or f"it exited with {done.returncode}"
        log.warning("systemd didn't start %s: %s", UNIT, said)
        if "not found" in said.lower() or "not loaded" in said.lower():
            message = (
                f'{UNIT} isn\'t installed on this server: docs/deploying.md, "Deploying from the site", sets it up'
            )
        elif any(word in said.lower() for word in ("access denied", "authentication", "not authorized")):
            message = (
                f"systemd won't let the site start {UNIT}: its polkit rule (deploy/yjsp-deploy.rules) isn't installed. "
                'docs/deploying.md, "Deploying from the site", sets it up'
            )
        else:
            message = f"systemd didn't start {UNIT}: {said}"
        raise StartFailed(message)

    def _ids(self) -> list[str]:
        """The deploys' ids, the newest first."""
        try:
            names = os.listdir(self.folder / "deploys")
        except OSError:
            return []
        return sorted(
            (name[:-5] for name in names if name.endswith(".json") and DEPLOY_ID.match(name[:-5])), reverse=True
        )

    def _deploy(self, deploy_id: str) -> Deploy | None:
        path = self.folder / "deploys" / f"{deploy_id}.json"
        found = _read(path)
        if found is None:
            return None
        result = found.get("result")
        if result in RESULTS:
            state = str(result)
        else:
            try:
                touched = path.stat().st_mtime
            except OSError:
                return None
            state = "running" if time.time() - touched < STALE else "interrupted"
        source = found.get("source")
        return Deploy(
            id=deploy_id,
            source=source if source in ("site", "laptop") else "site",
            commit=_text(found.get("commit")),
            subject=_text(found.get("subject")),
            started_at=_time(found.get("started")),
            finished_at=_time(found.get("finished")),
            state=state,
            step=_text(found.get("step")),
            message=_text(found.get("message")),
        )


def _commit(found: dict[str, Any]) -> Commit:
    """A commit, as GitHub says it, with a pull request's title for its merge."""
    details = found["commit"]
    subject, _, body = str(details["message"]).partition("\n")
    title, pull = subject, None
    if merge := _MERGE.match(subject):
        pull = int(merge.group(1))
        title = next((line.strip() for line in body.splitlines() if line.strip()), subject)
    author = (found.get("author") or {}).get("login") or (details.get("author") or {}).get("name")
    at = (details.get("committer") or {}).get("date") or (details.get("author") or {}).get("date")
    return Commit(str(found["sha"]), title[:300], pull, _text(author), _time(at))


def _title(source: object) -> str | None:
    """A migration's title: its docstring's first line. Read, never run."""
    if not isinstance(source, str):
        return None
    try:
        docstring = ast.get_docstring(ast.parse(source))
    except (SyntaxError, ValueError):
        return None
    lines = (docstring or "").strip().splitlines()
    return lines[0][:300] if lines else None


def _failed(response: httpx2.Response, repository: str) -> GitHubFailed:
    """What GitHub's refusal means, in words."""
    status = response.status_code
    if status == 429 or (status == 403 and response.headers.get("x-ratelimit-remaining") == "0"):
        reset = response.headers.get("x-ratelimit-reset", "")
        when = datetime.fromtimestamp(int(reset), UTC) if reset.isdigit() else None
        log.warning("GitHub's rate limit is reached until %s", when)
        return GitHubFailed(
            "GitHub has answered all it will this hour for this server (60 requests, without a token): it answers "
            + (f"again at {when:%H:%M} UTC" if when else "again within the hour"),
            reset_at=when.isoformat() if when else None,
        )
    log.warning("GitHub said %s", status)
    if status == 404:
        return GitHubFailed(
            f"GitHub has no public repository {repository}, or not what was asked of it: check YJSP_DEPLOY_REPOSITORY"
        )
    if status >= 500:
        return GitHubFailed("GitHub is having trouble just now: try again in a few minutes")
    return GitHubFailed(f"GitHub said {status}: try again in a minute")


def _whole(said: bytes) -> bytes:
    """`said` without a character cut off at its end: the log may be read as it's written."""
    for back in range(1, min(4, len(said)) + 1):
        byte = said[-back]
        if byte < 0x80:
            return said
        if byte >= 0xC0:  # where a character starts: as long as its first byte says, or cut off
            length = 2 if byte < 0xE0 else 3 if byte < 0xF0 else 4
            return said if back >= length else said[:-back]
    return said


def _read(path: Path) -> dict[str, Any] | None:
    try:
        found = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return found if isinstance(found, dict) else None


def _text(value: object) -> str | None:
    return value[:1000] if isinstance(value, str) and value else None


def _time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        at = datetime.fromisoformat(value)
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=UTC)
