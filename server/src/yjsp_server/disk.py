"""How full the server's disk is, and how much of it Vault's files, Yorg's, Piper's, and the database take: for admins,
at the top of Admin > People in the web app, and for everyone on the site's home page (recent); and whether an upload
leaves the server room to work (make_room).

It reads the folders the settings name, so it needs none of the apps: the live server keeps all three on one disk
(docs/deploying.md), and the disk measured is the one Vault's files are on. Piper keeps everything in the database,
so what it takes is Piper's to say (piper/diagrams.stored), which app.py hands to the routes that ask.
"""

import os
import shutil
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import Settings
from .errors import ApiError

# What an upload must leave free: the database needs room to write (and SQLite fails badly without it), the nightly
# backups need room, and so does the system.
FLOOR = 2 << 30  # bytes


class DiskFull(ApiError):
    status = 507
    code = "disk_full"


def make_room(folder: Path, size: int) -> None:
    """Refuse (DiskFull) an upload of this many bytes into the folder that would leave its disk under FLOOR free."""
    free = shutil.disk_usage(_nearest_folder(folder)).free
    if free - size < FLOOR:
        raise DiskFull(
            f"The server's disk is nearly full ({free >> 20} MB free): ask an admin to make room (Admin > People shows "
            "what's using it)"
        )


@dataclass(frozen=True)
class DiskUsage:
    total: int  # the disk's size, in bytes
    free: int  # what the server can still write: not the space the system keeps for itself
    vault: int  # Vault's files (YJSP_VAULT_DIR): every version of every file
    yorg: int  # Yorg's (YJSP_YORG_DIR): datasets' uploads and arrays, scripts, and models
    database: int  # accounts and the apps' tables: all of Piper's diagrams are in it
    piper: int  # Piper's drawings and pictures, a part of the database


# What an app keeps in the database, in bytes: Piper's, from app.py.
Stored = Callable[[Session], int]


def measure(db: Session, settings: Settings, piper: Stored | None = None) -> DiskUsage:
    disk = shutil.disk_usage(_nearest_folder(settings.vault_dir))
    return DiskUsage(
        total=disk.total,
        free=disk.free,
        vault=_folder_size(settings.vault_dir),
        yorg=_folder_size(settings.yorg_dir),
        database=_database_size(db),
        piper=piper(db) if piper else 0,
    )


RECENT = 60.0  # seconds: how old the home page's measurement may be
_recent: dict[tuple[str, ...], tuple[float, DiskUsage]] = {}  # by what's measured: a test's server is its own
_recent_lock = threading.Lock()


def recent(db: Session, settings: Settings, piper: Stored | None = None) -> DiskUsage:
    """measure's, at most a minute old: the home page asks on every visit, and measuring walks every file Vault has."""
    key = (str(settings.vault_dir), str(settings.yorg_dir), str(db.get_bind().url))
    with _recent_lock:
        found = _recent.get(key)
        if found is None or time.monotonic() - found[0] > RECENT:
            found = (time.monotonic(), measure(db, settings, piper))
            _recent[key] = found
        return found[1]


def _nearest_folder(path: Path) -> Path:
    """The folder itself, or the closest one above it that exists (a new server makes its folders as it needs them)."""
    path = path.resolve()
    while not path.is_dir() and path != path.parent:
        path = path.parent
    return path


def _folder_size(folder: Path) -> int:
    """The bytes in the folder's files, all the way down. Links aren't followed, so nothing is counted twice."""
    total = 0
    pending = [folder]
    while pending:
        try:
            entries = list(os.scandir(pending.pop()))
        except (FileNotFoundError, NotADirectoryError):
            continue  # not made yet, or gone since: nothing to count
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
            except FileNotFoundError:
                continue  # a temporary file that finished while this looked
    return total


def _database_size(db: Session) -> int:
    url = db.get_bind().url
    if url.get_backend_name() == "postgresql":
        return int(db.scalar(text("SELECT pg_database_size(current_database())")) or 0)
    if url.get_backend_name() == "sqlite" and url.database and url.database != ":memory:":
        # The database, and its write-ahead log while one is open.
        files = [Path(url.database + suffix) for suffix in ("", "-wal", "-shm")]
        return sum(file.stat().st_size for file in files if file.is_file())
    return 0
