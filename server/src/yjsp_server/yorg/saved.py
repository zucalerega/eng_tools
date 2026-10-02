"""What Yorg keeps as files rather than rows (system models, scripts): a JSON file each in a folder of YJSP_YORG_DIR,
so they need no tables of their own (and leave nothing behind in the database if they go)."""

import json
import os
import re
import secrets
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..errors import NotFound
from ..models import User

_ID = re.compile(r"^[0-9a-f]{12}$")


class Saved:
    def __init__(self, root: Path, kind: str, body: str):
        """kind: what one is called (model, script), and so its folder (models, scripts); body: the field a listing
        leaves out (a model's drawing, a script's code)."""
        self.kind, self.body = kind, body
        self.root = Path(root) / f"{kind}s"
        self.root.mkdir(parents=True, exist_ok=True)

    def all(self) -> list[dict[str, Any]]:
        """Every one saved (without its body), the latest changed first."""
        found = []
        for path in self.root.glob("*.json"):
            saved = _read(path)
            if saved is not None:
                found.append({key: value for key, value in saved.items() if key != self.body})
        return sorted(found, key=lambda saved: saved["updated_at"], reverse=True)

    def get(self, item_id: str) -> dict[str, Any]:
        saved = _read(self._path(item_id)) if _ID.match(item_id) else None
        if saved is None:
            raise NotFound(f"There's no such {self.kind}: someone may have deleted it")
        return saved

    def add(self, user: User, **fields: Any) -> dict[str, Any]:
        now = _now()
        saved = {
            "id": secrets.token_hex(6),
            **fields,
            "created_at": now,
            "created_by": user.name,
            "created_by_id": user.id,  # whose it is, to change (those saved before it was kept have none)
            "updated_at": now,
            "updated_by": user.name,
        }
        self._write(saved)
        return saved

    def change(self, user: User, item_id: str, **fields: Any) -> dict[str, Any]:
        saved = {**self.get(item_id), **fields, "updated_at": _now(), "updated_by": user.name}
        self._write(saved)
        return saved

    def remove(self, item_id: str) -> None:
        self.get(item_id)
        self._path(item_id).unlink()

    def _path(self, item_id: str) -> Path:
        return self.root / f"{item_id}.json"

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
