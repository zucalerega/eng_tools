"""Content-addressed blob store: file contents, stored once under their SHA-256."""

import os
import re
import tempfile
from pathlib import Path

SHA256 = re.compile(r"^[0-9a-f]{64}$")


class BlobStore:
    """Blobs on local disk at root/ab/cd/abcd.... An S3/R2 store will share this interface."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self._tmp = self.root / "tmp"
        self._tmp.mkdir(parents=True, exist_ok=True)

    def path(self, sha256: str) -> Path:
        return self.root / sha256[:2] / sha256[2:4] / sha256

    def exists(self, sha256: str) -> bool:
        return self.path(sha256).is_file()

    def temp_path(self) -> Path:
        """A new empty file for an upload in progress, on the same filesystem as the blobs."""
        fd, name = tempfile.mkstemp(dir=self._tmp, suffix=".part")
        os.close(fd)
        return Path(name)

    def commit(self, sha256: str, temp: Path) -> None:
        """Move a verified upload into place (an atomic rename)."""
        dest = self.path(sha256)
        dest.parent.mkdir(parents=True, exist_ok=True)
        os.replace(temp, dest)
