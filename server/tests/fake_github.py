"""A stand-in for GitHub's API, as the Deploy card and yjsp-deploy read it, on a port of its own: main's newest commit,
CI's check runs on a commit, how two commits compare, and the migrations a commit has, each as a test sets them, without
a token, keeping every path it was asked for. The site reaches it through YJSP_GITHUB_BASE_URL, and yjsp-deploy through
YJSP_DEPLOY_GITHUB_API, as they would GitHub."""

import hashlib
import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

REPOSITORY = "rocketry/tools"
MIGRATIONS = "server/src/yjsp_server/migrations/versions"
# The site's own migrations, which a commit has unless a test says otherwise.
OURS = sorted(path.name for path in (Path(__file__).parents[1] / "src/yjsp_server/migrations/versions").glob("0*.py"))


def sha(name: str) -> str:
    """A commit's SHA, made up from a name."""
    return hashlib.sha1(name.encode()).hexdigest()


def run(name: str, conclusion: str | None = "success", *, status: str = "completed", id: int = 1) -> dict[str, Any]:
    """One of CI's jobs on a commit, as GitHub says it."""
    return {
        "id": id,
        "name": name,
        "status": status,
        "conclusion": conclusion if status == "completed" else None,
        "html_url": f"https://github.com/{REPOSITORY}/actions/runs/7/job/{id}",
        "app": {"slug": "github-actions"},
    }


def passed(*names: str) -> list[dict[str, Any]]:
    return [run(name, id=index + 1) for index, name in enumerate(names or ("server", "client", "web", "image"))]


@dataclass
class FakeGitHub:
    main: str | None = None  # main's newest commit's SHA
    commits: dict[str, dict[str, Any]] = field(default_factory=dict)  # by SHA
    runs: dict[str, list[dict[str, Any]]] = field(default_factory=dict)  # CI's check runs, by commit
    migrations: dict[str, list[str]] = field(default_factory=dict)  # a commit's, by SHA: OURS unless it says
    files: dict[tuple[str, str], str] = field(default_factory=dict)  # (SHA, path): what the file says
    limited: bool = False  # it's answered all it will this hour
    asked: list[str] = field(default_factory=list)  # each path asked for, in order

    def commit(self, name: str, message: str, *parents: str, author: str = "chief") -> str:
        """Adds a commit, made up from its name; returns its SHA."""
        made = sha(name)
        self.commits[made] = {
            "sha": made,
            "commit": {
                "message": message,
                "author": {"name": author.title(), "date": "2026-11-16T19:00:00Z"},
                "committer": {"name": "GitHub", "date": "2026-11-16T19:05:00Z"},
            },
            "author": {"login": author},
            "parents": [{"sha": parent} for parent in parents],
            "html_url": f"https://github.com/{REPOSITORY}/commit/{made}",
        }
        return made

    def migration(self, commit: str, name: str, source: str) -> None:
        """A migration the commit has that the site's code doesn't."""
        self.migrations[commit] = sorted([*self.migrations.get(commit, OURS), name])
        self.files[(commit, f"{MIGRATIONS}/{name}")] = source

    def __post_init__(self) -> None:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def _send(self, status: int, body: Any, *, headers: dict[str, str] | None = None) -> None:
                data = (body if isinstance(body, str) else json.dumps(body)).encode()
                self.send_response(status)
                self.send_header("content-type", "text/plain" if isinstance(body, str) else "application/json")
                self.send_header("content-length", str(len(data)))
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                address = urlsplit(self.path)
                fake.asked.append(self.path)
                if fake.limited:
                    limit = {"x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795384800"}
                    return self._send(403, {"message": "API rate limit exceeded for 127.0.0.1."}, headers=limit)
                prefix = f"/repos/{REPOSITORY}/"
                if not self.headers.get("user-agent") or not address.path.startswith(prefix):
                    return self._send(404, {"message": "Not Found"})
                path = unquote(address.path.removeprefix(prefix))
                ref = parse_qs(address.query).get("ref", [""])[0]
                if path == "commits/main" and fake.main in fake.commits:
                    return self._send(200, fake.commits[fake.main])
                if path.startswith("commits/") and path.endswith("/check-runs"):
                    found = fake.runs.get(path.split("/")[1], [])
                    return self._send(200, {"total_count": len(found), "check_runs": found})
                if path.startswith("compare/"):
                    base, _, head = path.removeprefix("compare/").partition("...")
                    if base not in fake.commits or head not in fake.commits:
                        return self._send(404, {"message": "Not Found"})
                    return self._send(200, fake._compare(base, head))
                if path == f"contents/{MIGRATIONS}":
                    names = fake.migrations.get(ref, OURS)
                    listing = [{"name": name, "path": f"{MIGRATIONS}/{name}", "type": "file"} for name in names]
                    return self._send(200, listing + [{"name": "__pycache__", "type": "dir"}])
                if path.startswith("contents/") and (ref, path.removeprefix("contents/")) in fake.files:
                    if "raw" not in (self.headers.get("accept") or ""):
                        return self._send(415, {"message": "Ask for it raw"})
                    return self._send(200, fake.files[(ref, path.removeprefix("contents/"))])
                self._send(404, {"message": "Not Found"})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def _compare(self, base: str, head: str) -> dict[str, Any]:
        """As GitHub compares two commits: those `head` has that `base` hasn't, oldest first."""

        def ancestors(start: str) -> list[str]:
            found, waiting = [], [start]
            while waiting:
                at = waiting.pop()
                if at in found or at not in self.commits:
                    continue
                found.append(at)
                waiting += [parent["sha"] for parent in self.commits[at]["parents"]]
            return found

        had = set(ancestors(base))
        new = [self.commits[at] for at in reversed(ancestors(head)) if at not in had]
        return {"status": "ahead" if new else "identical", "ahead_by": len(new), "behind_by": 0, "commits": new}

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
