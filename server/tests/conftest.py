import hashlib

import pytest
from fastapi.testclient import TestClient

from cvc_server import auth
from cvc_server.app import create_app
from cvc_server.config import Settings
from cvc_server.models import User, UserStatus

BOOTSTRAP_ADMIN = "chief@rocketry.test"


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None,
        env="development",
        database_url=f"sqlite:///{tmp_path / 'cvc.db'}",
        blob_dir=tmp_path / "blobs",
        dev_auth=True,
        bootstrap_admins=BOOTSTRAP_ADMIN,
        web_dir=tmp_path / "web",  # empty: tests that need the web app build a stand-in
        yorg_dir=tmp_path / "yorg",
    )


@pytest.fixture
def app(settings):
    return create_app(settings)


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c


class Team:
    """Makes members with client tokens and drives the API the way the CLI/add-in will."""

    def __init__(self, app, client: TestClient):
        self.app, self.client = app, client
        self.ids: dict[str, int] = {}

    def member(self, email: str, *, admin: bool = False, status: UserStatus = UserStatus.ACTIVE) -> dict[str, str]:
        with self.app.state.sessionmaker() as db:
            user = User(email=email, name=email.split("@")[0].title(), status=status, is_admin=admin)
            db.add(user)
            db.commit()
            self.ids[email] = user.id
            secret = auth.issue_token(db, user, kind=auth.CLIENT, name="test")
        return {"Authorization": f"Bearer {secret}"}

    def whitelist(self, as_: dict[str, str], on: bool) -> None:
        """Turn the whitelist on or off, as an admin does in the web app (Admin > People)."""
        response = self.client.patch("/api/settings", json={"whitelist": on}, headers=as_)
        assert (response.status_code, response.json()) == (200, {"whitelist": on}), response.text

    def grant(self, as_: dict[str, str], path: str, email: str | None, role: str | None) -> None:
        body = {"path": path, "user_id": self.ids[email] if email else None, "role": role}
        response = self.client.put("/api/grants", json=body, headers=as_)
        assert response.status_code == 200, response.text

    def upload(self, as_: dict[str, str], data: bytes) -> str:
        sha = hashlib.sha256(data).hexdigest()
        response = self.client.put(f"/api/blobs/{sha}", content=data, headers=as_)
        assert response.status_code in (200, 201), response.text
        return sha

    def checkin(
        self,
        as_: dict[str, str],
        files: dict[str, bytes],
        *,
        comment: str = "",
        host: str = "PC-1",
        refs: dict[str, list[str]] | None = None,
        keep: bool = False,
    ):
        items = [
            {
                "path": path,
                "sha256": self.upload(as_, data),
                "size": len(data),
                "references": [{"path": p} for p in (refs or {}).get(path, [])],
            }
            for path, data in files.items()
        ]
        body = {"comment": comment, "host": host, "keep_checked_out": keep, "items": items}
        return self.client.post("/api/checkin", json=body, headers=as_)

    def checkout(self, as_: dict[str, str], *files: str | int, host: str = "PC-1", force: bool = False):
        body = {"files": list(files), "host": host, "force": force}
        return self.client.post("/api/checkout", json=body, headers=as_)

    def undo(self, as_: dict[str, str], *files: str | int):
        return self.client.post("/api/undo-checkout", json={"files": list(files)}, headers=as_)

    def listing(self, as_: dict[str, str], path: str = "", **params) -> dict:
        response = self.client.get("/api/folders", params={"path": path, **params}, headers=as_)
        assert response.status_code == 200, response.text
        return response.json()


@pytest.fixture
def team(app, client) -> Team:
    return Team(app, client)
