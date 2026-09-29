"""Saved system models: a JSON file each in CVC_YORG_DIR/models, so the dev page needs no tables of its own (and
leaves nothing behind in the database if it goes)."""

import json
import os
import re
import secrets
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ...errors import NotFound
from ...models import User

_ID = re.compile(r"^[0-9a-f]{12}$")


class Models:
    def __init__(self, root: Path):
        self.root = Path(root) / "models"
        self.root.mkdir(parents=True, exist_ok=True)

    def all(self) -> list[dict[str, Any]]:
        """Every saved model (without its drawing), the latest changed first."""
        found = []
        for path in self.root.glob("*.json"):
            saved = _read(path)
            if saved is not None:
                found.append({key: value for key, value in saved.items() if key != "model"})
        return sorted(found, key=lambda saved: saved["updated_at"], reverse=True)

    def get(self, model_id: str) -> dict[str, Any]:
        saved = _read(self._path(model_id)) if _ID.match(model_id) else None
        if saved is None:
            raise NotFound("There's no such model: someone may have deleted it")
        return saved

    def add(self, user: User, name: str, model: dict[str, Any]) -> dict[str, Any]:
        now = _now()
        saved = {
            "id": secrets.token_hex(6),
            "name": name,
            "created_at": now,
            "created_by": user.name,
            "updated_at": now,
            "updated_by": user.name,
            "model": model,
        }
        self._write(saved)
        return saved

    def change(self, user: User, model_id: str, name: str, model: dict[str, Any]) -> dict[str, Any]:
        saved = {**self.get(model_id), "name": name, "model": model, "updated_at": _now(), "updated_by": user.name}
        self._write(saved)
        return saved

    def remove(self, model_id: str) -> None:
        self.get(model_id)
        self._path(model_id).unlink()

    def _path(self, model_id: str) -> Path:
        return self.root / f"{model_id}.json"

    def _write(self, saved: dict[str, Any]) -> None:
        fd, name = tempfile.mkstemp(dir=self.root, suffix=".part")
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(saved, file)
        os.replace(name, self._path(saved["id"]))


def _read(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _now() -> str:
    return datetime.now(UTC).isoformat()
