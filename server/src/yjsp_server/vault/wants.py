"""What Vault wants found (the site's deals/): vendors' parts, by their part numbers, in folders everyone can see, so a
deal shown to everyone never names a file someone couldn't open. Those lately checked in first; McMaster-Carr's (cheap
hardware, rarely on eBay by its number) last."""

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..deals.wants import Want, part_numbers
from ..models import User, UserStatus
from . import numbers, paths
from .access import Access, Tree
from .models import File, Folder, Grant, Role, Version

MOST = 40  # vendors' parts wanted, the latest first
RECENT = timedelta(days=60)


def wants(db: Session) -> list[Want]:
    tree = Tree(db.scalars(select(Folder)))
    # What everyone can see: grants to everyone, and no one's own (an account that's no one, and no admin).
    everyone = Access(
        User(id=-1, is_admin=False, status=UserStatus.ACTIVE),
        tree,
        db.scalars(select(Grant).where(Grant.user_id.is_(None))),
    )
    latest = select(Version.file_id, func.max(Version.created_at).label("at")).group_by(Version.file_id).subquery()
    found = []
    now = utcnow()
    rows = db.execute(
        select(File, latest.c.at)
        .join(latest, latest.c.file_id == File.id)
        .where(File.deleted_at.is_(None), File.vendor.is_(True))
        .order_by(latest.c.at.desc())
        .limit(MOST * 4)
    )
    for file, changed in rows:
        folder = tree.by_id.get(file.folder_id)
        if folder is None or folder.deleted_at is not None or not everyone.can(file.folder_id, Role.VIEWER):
            continue
        stem = paths.stem(file.name)
        found_numbers = part_numbers(stem)
        if not found_numbers:
            continue
        words = " ".join(stem.replace("_", " ").split()[1:]) or file.title
        weight = 0.2 if numbers.vendors(file.name) else 0.6
        if changed is not None and now - changed < RECENT:
            weight *= 2
        found.append(
            Want(
                key=f"vault:file:{file.id}",
                title=(file.title if file.title and file.title != stem else stem).replace("_", " "),
                where=f"Vault, {tree.label(file.folder_id)}",
                href=f"/vault/file/{file.id}",
                searches=(found_numbers[0],),
                numbers=found_numbers,
                needs=f"The vendor's part {stem} ({words}), as its CAD in Vault names it".strip(),
                weight=weight,
            )
        )
        if len(found) >= MOST:
            break
    return found
