"""Whether YJSP's data is copied off the server, for Admin > People: what the off-site backup (deploy/yjsp-offsite,
docs/deploying.md "Backups") last wrote about itself. The site only reads it: the backup runs as root, with keys the
site can't read, so that whoever took over the site couldn't erase the copies too.
"""

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass
class BackupStatus:
    backed_up_at: datetime | None  # the last copy that worked
    snapshot: str | None  # its name in the repository (restic's snapshot ID)
    backup_failed_at: datetime | None  # the last that didn't, if it's since that one
    backup_error: str | None  # what failed, and what restic said
    verified_at: datetime | None  # the last restore that checked out
    verify_failed_at: datetime | None
    verify_error: str | None


def status(path: Path) -> BackupStatus | None:
    """The off-site backup's last report, or None where there's none: no off-site backup on this server."""
    try:
        report = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        report = {"backup_error": f"Its report ({path}) can't be read: {error}"}
    if not isinstance(report, dict):
        report = {"backup_error": f"Its report ({path}) isn't what yjsp-offsite writes"}
    return BackupStatus(
        backed_up_at=_time(report.get("backed_up_at")),
        snapshot=_text(report.get("snapshot")),
        backup_failed_at=_time(report.get("backup_failed_at")),
        backup_error=_text(report.get("backup_error")),
        verified_at=_time(report.get("verified_at")),
        verify_failed_at=_time(report.get("verify_failed_at")),
        verify_error=_text(report.get("verify_error")),
    )


def _time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _text(value: object) -> str | None:
    return value[:500] if isinstance(value, str) and value else None
