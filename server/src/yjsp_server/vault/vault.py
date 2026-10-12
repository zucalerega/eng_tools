"""Vault operations: folders, check-out/check-in, history, deletion, permissions, sync.

Independent of HTTP so they can be tested and reused directly. Each function
takes the acting user and checks permissions through Access. Every mutating
function starts with begin_write(); read its docstring before adding one.
"""

import hashlib
import re
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, get_args

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import ApiError, Conflict, Forbidden, NotFound
from ..models import User
from . import caliper, paths, solidworks
from .access import Access, Tree
from .models import Blob, CaliperModel, Checkin, Event, File, Folder, Grant, Role, VaultState, Version, VersionRef
from .storage import BlobStore

FileRef = int | str  # a file id, or a vault path


# --- setup and transactions -----------------------------------------------------------


def init_vault(db: Session) -> None:
    """Create the vault_state row and the root folder if they don't exist yet."""
    if db.get(VaultState, 1) is None:
        db.add(VaultState(id=1, seq=0, access_seq=0))
    if db.scalar(select(Folder.id).where(Folder.parent_id.is_(None))) is None:
        db.add(Folder(parent_id=None, name="", name_key="", change_seq=0))
    db.commit()


def begin_write(db: Session) -> int:
    """Start a mutating transaction by bumping vault_state.seq, and return the new seq.

    Call it before reading anything the operation validates. The UPDATE is the
    transaction's first write, so it takes SQLite's write lock (or the row lock
    in Postgres): writers run one at a time, the reads that follow see the
    latest committed state, and seq values commit in increasing order. The sync
    feed relies on that order. Rows the operation changes get change_seq = seq.
    """
    db.execute(update(VaultState).where(VaultState.id == 1).values(seq=VaultState.seq + 1))
    return db.execute(select(VaultState.seq).where(VaultState.id == 1)).scalar_one()


def _bump_access(db: Session, seq: int) -> None:
    """Record a permission change: clients re-sync everything (see sync)."""
    db.execute(update(VaultState).where(VaultState.id == 1).values(access_seq=seq))


def people_changed(db: Session, seq: int) -> None:
    """Accounts changed (people.py): names, approval, admin rights. The index carries people's names and what they may
    see, so every client syncs everything again."""
    _bump_access(db, seq)


def _context(db: Session, user: User) -> tuple[Tree, Access]:
    tree = Tree(db.scalars(select(Folder)))
    grants = db.scalars(select(Grant).where(or_(Grant.user_id == user.id, Grant.user_id.is_(None))))
    return tree, Access(user, tree, grants)


def _event(
    db: Session,
    user: User,
    action: str,
    *,
    file: File | None = None,
    folder_id: int | None = None,
    version: Version | None = None,
    **detail: Any,
) -> None:
    db.add(
        Event(
            at=utcnow(),
            user_id=user.id,
            action=action,
            file_id=file.id if file else None,
            folder_id=file.folder_id if file else folder_id,
            version_id=version.id if version else None,
            detail=detail,
        )
    )


def log(db: Session, user: User, action: str, **detail: Any) -> None:
    """Record something that isn't about a file in the activity log: a change to accounts, say (people.py)."""
    _event(db, user, action, **detail)


# --- what the API gets back -------------------------------------------------------------


@dataclass
class FolderView:
    id: int
    path: str
    name: str
    role: str | None  # the user's effective role; None if the folder is only a way through
    deleted_at: datetime | None = None
    deleted_by: User | None = None  # in the trash listing


@dataclass
class FileView:
    file: File
    path: str
    latest: Version
    modified_by: User
    locked_by: User | None
    # What the latest version uses that the user can see (an assembly's parts): (file id, version used).
    uses: list[tuple[int, int]] = field(default_factory=list)
    deleted_by: User | None = None
    created_by: User | None = None  # who added it: its version 1


@dataclass
class Listing:
    folder: FolderView
    folders: list[FolderView]
    files: list[FileView]


@dataclass
class RefView:
    file_id: int
    path: str
    version: int
    deleted: bool


@dataclass
class VersionView:
    version: Version
    checkin: Checkin
    author: User
    references: list[RefView]


@dataclass
class UsedBy:
    file: FileView
    uses_version: int


@dataclass
class FileDetail:
    file: FileView
    versions: list[VersionView]  # newest first
    used_by: list[UsedBy]  # live files whose latest version references this one


@dataclass
class SyncResult:
    seq: int
    full: bool
    folders: list[FolderView]
    files: list[FileView]


@dataclass
class EventView:
    event: Event
    user: User | None
    checkin: Checkin | None = None  # for events that made a version: the check-in, with its comment


@dataclass
class GrantView:
    folder: str
    user: User | None  # None: everyone
    role: Role


def _folder_view(tree: Tree, access: Access, folder: Folder, deleted_by: User | None = None) -> FolderView:
    return FolderView(
        folder.id, tree.path(folder.id), folder.name, access.role(folder.id), folder.deleted_at, deleted_by
    )


def _users(db: Session, ids: set[int | None]) -> dict[int, User]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    return {u.id: u for u in db.scalars(select(User).where(User.id.in_(wanted)))}


def _with_latest(db: Session, *where: Any) -> list[tuple[File, Version]]:
    stmt = (
        select(File, Version)
        .join(Version, and_(Version.file_id == File.id, Version.number == File.latest_version))
        .where(*where)
        .order_by(File.name_key)
    )
    return [(f, v) for f, v in db.execute(stmt)]


def _file_views(db: Session, tree: Tree, access: Access, rows: list[tuple[File, Version]]) -> list[FileView]:
    people: set[int | None] = {v.created_by for _, v in rows}
    for f, _ in rows:
        people |= {f.created_by, f.checked_out_by, f.deleted_by}
    users = _users(db, people)
    uses = _uses(db, access, [v.id for _, v in rows])
    return [
        FileView(
            f,
            tree.file_path(f),
            v,
            users[v.created_by],
            users.get(f.checked_out_by) if f.checked_out_by else None,
            uses.get(v.id, []),
            users.get(f.deleted_by) if f.deleted_by else None,
            users.get(f.created_by),
        )
        for f, v in rows
    ]


def _views_by_id(db: Session, tree: Tree, access: Access, files: list[File]) -> dict[int, FileView]:
    views = _file_views(db, tree, access, _with_latest(db, File.id.in_([f.id for f in files])))
    return {view.file.id: view for view in views}


_BATCH = 500  # ids per IN (...): SQLite limits how many parameters a statement can have


def _uses(db: Session, access: Access, version_ids: list[int]) -> dict[int, list[tuple[int, int]]]:
    """What each version uses that the user can see, as (file id, version used), by version id.

    Files deleted since are included: the version still uses them.
    """
    uses: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for start in range(0, len(version_ids), _BATCH):
        rows = db.execute(
            select(VersionRef.version_id, VersionRef.child_file_id, VersionRef.child_version, File.folder_id)
            .join(File, File.id == VersionRef.child_file_id)
            .where(VersionRef.version_id.in_(version_ids[start : start + _BATCH]))
            .order_by(VersionRef.version_id, VersionRef.child_file_id)
        )
        for version_id, file_id, number, folder_id in rows:
            if access.can(folder_id, Role.VIEWER):
                uses[version_id].append((file_id, number))
    return uses


# --- finding files ------------------------------------------------------------------------


def _live_file(db: Session, folder: Folder | None, name: str) -> File | None:
    if folder is None:
        return None
    return db.scalar(
        select(File).where(File.folder_id == folder.id, File.name_key == paths.key(name), File.deleted_at.is_(None))
    )


def _resolve(db: Session, tree: Tree, access: Access, ref: FileRef, *, deleted_ok: bool = False) -> File:
    """A file the user can see, by id or path. Files they can't see are 'not found'."""
    if isinstance(ref, int):
        file = db.get(File, ref)
        if file is not None and file.deleted_at is not None and not deleted_ok:
            file = None
    else:
        names = paths.split(ref)
        file = _live_file(db, tree.find(names[:-1]), names[-1]) if names else None
    if file is None or not access.can(file.folder_id, Role.VIEWER):
        raise NotFound(f"{ref} is not in the vault" if isinstance(ref, str) else f"File {ref} not found")
    return file


def _resolve_many(db: Session, tree: Tree, access: Access, refs: list[FileRef]) -> list[File]:
    files: dict[int, File] = {}
    for ref in refs:
        file = _resolve(db, tree, access, ref)
        files.setdefault(file.id, file)
    return list(files.values())


def _version(db: Session, file_id: int, number: int) -> Version:
    return db.execute(select(Version).where(Version.file_id == file_id, Version.number == number)).scalar_one()


def _parents(db: Session, file_id: int) -> list[tuple[File, Version, int]]:
    """Live files whose latest version references file_id, with the version of it they use."""
    stmt = (
        select(File, Version, VersionRef.child_version)
        .join(Version, and_(Version.file_id == File.id, Version.number == File.latest_version))
        .join(VersionRef, VersionRef.version_id == Version.id)
        .where(VersionRef.child_file_id == file_id, File.deleted_at.is_(None))
        .order_by(File.name_key)
    )
    return [(f, v, n) for f, v, n in db.execute(stmt)]


def _host(host: str) -> str:
    host = host.strip()
    if not host or len(host) > 255:
        raise ApiError("Say which computer this is (host)", code="bad_host")
    return host


def _lock_json(db: Session, tree: Tree, file: File) -> dict[str, Any]:
    holder = db.get(User, file.checked_out_by)
    assert holder is not None and file.checked_out_at is not None
    return {
        "path": tree.file_path(file),
        "user": holder.display_name,
        "email": holder.email,
        "host": file.checked_out_host,
        "since": file.checked_out_at.isoformat(),
    }


def _lock_text(lock: dict[str, Any]) -> str:
    return f"{lock['path']} ({lock['user']} on {lock['host']})"


def _clear_lock(file: File) -> None:
    file.checked_out_by = file.checked_out_at = file.checked_out_host = None


# --- reading ----------------------------------------------------------------------------


def list_folder(db: Session, user: User, path: str = "", *, deleted: bool = False) -> Listing:
    """A folder's subfolders and files; with deleted=True, its trash: the folders and files deleted from it."""
    tree, access = _context(db, user)
    folder = tree.find(paths.split(path))
    if folder is None or not access.visible(folder.id):
        raise NotFound(f"{path} not found")
    if deleted:
        inside = [f for f in tree.by_id.values() if f.parent_id == folder.id and f.deleted_at is not None]
    else:
        inside = list(tree.children[folder.id].values())
    subfolders = sorted((f for f in inside if access.visible(f.id)), key=lambda f: f.name_key)
    deleters = _users(db, {f.deleted_by for f in subfolders})
    files: list[FileView] = []
    if access.can(folder.id, Role.VIEWER):
        state = File.deleted_at.is_not(None) if deleted else File.deleted_at.is_(None)
        files = _file_views(db, tree, access, _with_latest(db, File.folder_id == folder.id, state))
    return Listing(
        _folder_view(tree, access, folder),
        [_folder_view(tree, access, f, deleters.get(f.deleted_by) if f.deleted_by else None) for f in subfolders],
        files,
    )


def file_detail(db: Session, user: User, file_id: int) -> FileDetail:
    """A file with its full version history and the files that use it."""
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id, deleted_ok=True)
    rows = db.execute(
        select(Version, Checkin)
        .join(Checkin, Checkin.id == Version.checkin_id)
        .where(Version.file_id == file.id)
        .order_by(Version.number.desc())
    ).all()
    refs: dict[int, list[RefView]] = defaultdict(list)
    ref_rows = db.execute(
        select(VersionRef, File)
        .join(File, File.id == VersionRef.child_file_id)
        .where(VersionRef.version_id.in_([v.id for v, _ in rows]))
    ).all()
    for ref, child in ref_rows:
        if access.can(child.folder_id, Role.VIEWER):
            path = tree.file_path(child)
            refs[ref.version_id].append(RefView(child.id, path, ref.child_version, child.deleted_at is not None))
    authors = _users(db, {v.created_by for v, _ in rows})
    versions = [
        VersionView(v, c, authors[v.created_by], sorted(refs[v.id], key=lambda r: paths.key(r.path))) for v, c in rows
    ]
    latest = next(view.version for view in versions if view.version.number == file.latest_version)
    parents = [(p, v, n) for p, v, n in _parents(db, file.id) if access.can(p.folder_id, Role.VIEWER)]
    parent_views = _file_views(db, tree, access, [(p, v) for p, v, _ in parents])
    used_by = [UsedBy(view, n) for view, (_, _, n) in zip(parent_views, parents, strict=True)]
    return FileDetail(_file_views(db, tree, access, [(file, latest)])[0], versions, used_by)


def version_content(db: Session, user: User, file_id: int, number: int | None = None) -> tuple[File, Version]:
    """The file and version to download; the latest version unless a number is given."""
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id, deleted_ok=True)
    version = db.scalar(
        select(Version).where(Version.file_id == file.id, Version.number == (number or file.latest_version))
    )
    if version is None:
        raise NotFound(f"{tree.file_path(file)} has no version {number}")
    return file, version


def checkouts(db: Session, user: User, *, mine: bool = False) -> list[FileView]:
    """Checked-out files the user can see: who has what, on which computer."""
    tree, access = _context(db, user)
    where = [File.checked_out_by.is_not(None), File.deleted_at.is_(None)]
    if mine:
        where.append(File.checked_out_by == user.id)
    rows = [(f, v) for f, v in _with_latest(db, *where) if access.can(f.folder_id, Role.VIEWER)]
    return _file_views(db, tree, access, rows)


def sync(db: Session, user: User, since: int = 0) -> SyncResult:
    """What changed since the client's cursor (a seq from an earlier sync).

    Returns every visible live folder and file when since is 0, unknown, or
    older than the last permission change (full=True); otherwise only folders
    and files changed after it, including deleted files. Pass the returned seq
    as `since` next time. (Deleting a folder counts as a permission change:
    clients know folders by path, and drop what a full sync doesn't list.)
    """
    # Read the cursor before the rows: every change up to seq has committed by then (see begin_write).
    seq, access_seq = db.execute(select(VaultState.seq, VaultState.access_seq)).one()
    full = since <= 0 or since > seq or since < access_seq
    tree, access = _context(db, user)
    folders = [
        _folder_view(tree, access, f)
        for f in tree.by_id.values()
        if f.parent_id is not None and f.deleted_at is None and access.visible(f.id) and (full or f.change_seq > since)
    ]
    changed = File.deleted_at.is_(None) if full else File.change_seq > since
    rows = [(f, v) for f, v in _with_latest(db, changed) if access.can(f.folder_id, Role.VIEWER)]
    return SyncResult(seq, full, folders, _file_views(db, tree, access, rows))


def activity(
    db: Session, user: User, *, limit: int = 100, before: int | None = None, file_id: int | None = None
) -> list[EventView]:
    """Recent events the user may see, newest first. Account events are for admins only."""
    tree, access = _context(db, user)
    limit = max(1, min(limit, 500))

    def visible(event: Event) -> bool:
        if event.folder_id is None:
            return user.is_admin
        return event.folder_id in tree.by_id and access.can(event.folder_id, Role.VIEWER)

    found: list[Event] = []
    cursor = before
    while len(found) < limit:
        stmt = select(Event).order_by(Event.id.desc()).limit(limit)
        if cursor is not None:
            stmt = stmt.where(Event.id < cursor)
        if file_id is not None:
            stmt = stmt.where(Event.file_id == file_id)
        page = db.scalars(stmt).all()
        found += [e for e in page if visible(e)]
        if len(page) < limit:
            break
        cursor = page[-1].id
    found = found[:limit]
    users = _users(db, {e.user_id for e in found})
    version_ids = {e.version_id for e in found if e.version_id is not None}
    query = (
        select(Version.id, Checkin).join(Checkin, Checkin.id == Version.checkin_id).where(Version.id.in_(version_ids))
    )
    checkins = {version_id: checkin for version_id, checkin in db.execute(query)}
    return [
        EventView(e, users.get(e.user_id) if e.user_id else None, checkins.get(e.version_id) if e.version_id else None)
        for e in found
    ]


# --- changing files -----------------------------------------------------------------------


def _ensure_folders(db: Session, tree: Tree, access: Access, user: User, names: list[str], seq: int) -> Folder:
    """The folder at names, creating any missing folders along the way."""
    folder, depth = tree.deepest(names)
    if depth == len(names):
        return folder
    access.require(folder.id, Role.EDITOR, f"create folders in {tree.label(folder.id)}")
    for name in names[depth:]:
        if _live_file(db, folder, name) is not None:
            raise Conflict(f"{paths.join(tree.path(folder.id), name)} is a file, not a folder", code="exists")
        child = Folder(
            parent_id=folder.id,
            name=name,
            name_key=paths.key(name),
            created_at=utcnow(),
            created_by=user.id,
            change_seq=seq,
        )
        db.add(child)
        db.flush()
        tree.add(child)
        _event(db, user, "create_folder", folder_id=child.id, path=tree.path(child.id))
        folder = child
    return folder


def create_folder(db: Session, user: User, path: str) -> FolderView:
    names = paths.split(path)
    if not names:
        raise ApiError("The vault root already exists", code="exists")
    seq = begin_write(db)
    tree, access = _context(db, user)
    if tree.find(names) is not None:
        raise Conflict(f"{paths.join(*names)} already exists", code="exists")
    folder = _ensure_folders(db, tree, access, user, names, seq)
    db.commit()
    return _folder_view(tree, access, folder)


def checkout(db: Session, user: User, refs: list[FileRef], host: str, *, force: bool = False) -> list[FileView]:
    """Lock files for editing on this computer. All or nothing; already yours here is fine.

    With force, files checked out elsewhere are taken over: your own check-out moves to this
    computer, and a lead can take someone else's, which releases it (a 'break lock').
    """
    host = _host(host)
    seq = begin_write(db)
    tree, access = _context(db, user)
    files = _resolve_many(db, tree, access, refs)
    for file in files:
        access.require(file.folder_id, Role.EDITOR, f"check out {tree.file_path(file)}")
    taken = [
        f for f in files if f.checked_out_by is not None and (f.checked_out_by, f.checked_out_host) != (user.id, host)
    ]
    locks = {f.id: _lock_json(db, tree, f) for f in taken}
    if taken and not force:
        text = ", ".join(_lock_text(locks[f.id]) for f in taken)
        raise Conflict("Already checked out: " + text, code="checked_out", files=list(locks.values()))
    for file in taken:
        if file.checked_out_by != user.id:
            lock = locks[file.id]
            access.require(file.folder_id, Role.LEAD, f"take over {lock['user']}'s check-out of {lock['path']}")
    now = utcnow()
    for file in files:
        if file.id in locks:
            lock = locks[file.id]
            if file.checked_out_by == user.id:
                _event(db, user, "undo_checkout", file=file, path=lock["path"], host=lock["host"])
            else:
                _event(db, user, "break_lock", file=file, path=lock["path"], host=lock["host"], holder=lock["email"])
            _clear_lock(file)
        if file.checked_out_by is None:
            file.checked_out_by, file.checked_out_at, file.checked_out_host = user.id, now, host
            file.change_seq = seq
            _event(db, user, "checkout", file=file, path=tree.file_path(file), host=host)
    db.commit()
    views = _views_by_id(db, tree, access, files)
    return [views[f.id] for f in files]


def undo_checkout(db: Session, user: User, refs: list[FileRef]) -> list[FileView]:
    """Release locks without checking in. Leads can release other people's (a 'break lock')."""
    seq = begin_write(db)
    tree, access = _context(db, user)
    files = _resolve_many(db, tree, access, refs)
    for file in files:
        if file.checked_out_by not in (None, user.id):
            holder = _lock_json(db, tree, file)["user"]
            access.require(file.folder_id, Role.LEAD, f"undo {holder}'s check-out of {tree.file_path(file)}")
    for file in files:
        if file.checked_out_by is None:
            continue
        lock = _lock_json(db, tree, file)
        if file.checked_out_by == user.id:
            _event(db, user, "undo_checkout", file=file, path=lock["path"], host=lock["host"])
        else:
            _event(db, user, "break_lock", file=file, path=lock["path"], host=lock["host"], holder=lock["email"])
        _clear_lock(file)
        file.change_seq = seq
    db.commit()
    views = _views_by_id(db, tree, access, files)
    return [views[f.id] for f in files]


@dataclass
class Reference:
    path: str
    version: int | None = None  # None: the latest version, or the one in the same check-in


@dataclass
class CheckinItem:
    path: str
    sha256: str
    size: int
    references: list[Reference] = field(default_factory=list)


CheckinStatus = Literal["created", "updated", "unchanged"]


@dataclass
class CheckinResult:
    checkin_id: int | None  # None when nothing changed
    files: list[tuple[CheckinStatus, FileView]]


def _require_own_lock(db: Session, tree: Tree, file: File, user: User, host: str) -> None:
    path = tree.file_path(file)
    if file.checked_out_by is None:
        raise Conflict(f"Check out {path} before checking it in", code="not_checked_out", path=path)
    lock = _lock_json(db, tree, file)
    if file.checked_out_by != user.id:
        raise Conflict(f"{path} is checked out by {lock['user']}", code="checked_out", files=[lock])
    if file.checked_out_host != host:
        raise Conflict(
            f"{path} is checked out to you on {file.checked_out_host}, not {host}",
            code="checked_out_elsewhere",
            files=[lock],
        )


def checkin(
    db: Session,
    user: User,
    items: list[CheckinItem],
    *,
    comment: str = "",
    host: str,
    keep_checked_out: bool = False,
) -> CheckinResult:
    """Check in new versions of your checked-out files and add new files, all or nothing.

    Upload each item's contents (PUT /api/blobs/{sha256}) first. New files may
    go in new folders, which are created. An item's references name the files
    it uses (an assembly's parts, a drawing's model) by vault path; they must be
    in the vault already or in this check-in, and are pinned to the version used.
    A file whose contents didn't change gets no new version but is still
    released, unless keep_checked_out is set; if it had no references
    recorded and now has some, it gets a version to record them.
    """
    host = _host(host)
    if not items:
        raise ApiError("Nothing to check in")
    seq = begin_write(db)
    tree, access = _context(db, user)
    now = utcnow()

    planned: list[tuple[CheckinItem, list[str], File | None]] = []
    seen: set[str] = set()
    for item in items:
        names = paths.split(item.path)
        if not names:
            raise ApiError("A check-in item has an empty path", code="bad_path")
        path = paths.join(*names)
        if paths.key(path) in seen:
            raise ApiError(f"{path} is listed twice")
        seen.add(paths.key(path))
        blob = db.get(Blob, item.sha256)
        if blob is None:
            raise ApiError(f"Upload {path} before checking it in", code="blob_missing", path=path, sha256=item.sha256)
        if blob.size != item.size:
            raise ApiError(f"The size of {path} doesn't match its upload", code="size_mismatch", path=path)
        existing = _live_file(db, tree.find(names[:-1]), names[-1])
        if existing is not None:
            access.require(existing.folder_id, Role.EDITOR, f"check in {path}")
            _require_own_lock(db, tree, existing, user, host)
        else:
            parent, depth = tree.deepest(names[:-1])
            access.require(parent.id, Role.EDITOR, f"add files to {tree.label(parent.id)}")
            if depth == len(names) - 1 and paths.key(names[-1]) in tree.children[parent.id]:
                raise Conflict(f"{path} is a folder", code="exists", path=path)
        planned.append((item, names, existing))

    record: Checkin | None = None

    def checkin_id() -> int:
        nonlocal record
        if record is None:
            record = Checkin(user_id=user.id, host=host, comment=comment.strip(), created_at=now)
            db.add(record)
            db.flush()
        return record.id

    done: dict[str, tuple[CheckinStatus, File, Version, CheckinItem]] = {}
    for item, names, existing in planned:
        status: CheckinStatus
        version: Version | None = None
        if existing is None:
            folder = _ensure_folders(db, tree, access, user, names[:-1], seq)
            file = File(
                folder_id=folder.id,
                name=names[-1],
                name_key=paths.key(names[-1]),
                latest_version=1,
                created_at=now,
                created_by=user.id,
            )
            db.add(file)
            db.flush()
            status = "created"
        else:
            file = existing
            latest = _version(db, file.id, file.latest_version)
            # Same contents, same version; unless it's the first time SolidWorks says what it uses (it was
            # uploaded in the web app, which can't tell), which is worth a version that records it.
            recorded = db.scalar(select(VersionRef.version_id).where(VersionRef.version_id == latest.id).limit(1))
            first_references = bool(item.references) and recorded is None
            if latest.blob_sha256 == item.sha256 and not first_references:
                status, version = "unchanged", latest
            else:
                status = "updated"
                file.latest_version += 1
        if version is None:
            version = Version(
                file_id=file.id,
                number=file.latest_version,
                checkin_id=checkin_id(),
                blob_sha256=item.sha256,
                size=item.size,
                created_at=now,
                created_by=user.id,
            )
            db.add(version)
        if keep_checked_out:
            if file.checked_out_by is None:
                file.checked_out_by, file.checked_out_at, file.checked_out_host = user.id, now, host
        else:
            _clear_lock(file)
        file.change_seq = seq
        done[paths.key(tree.file_path(file))] = (status, file, version, item)
    db.flush()

    missing = []
    unlinked: list[str] = []  # drawings that don't show a part or assembly
    misnamed: list[dict[str, str]] = []  # drawings not named after one they show
    for status, file, version, item in done.values():
        if status == "unchanged":
            continue  # same contents, same references
        linked: set[int] = set()
        shows: list[File] = []
        for ref in item.references:
            ref_names = paths.split(ref.path)
            in_batch = done.get(paths.key(paths.join(*ref_names)))
            if in_batch is not None:
                child, child_version = in_batch[1], in_batch[2].number
            else:
                child = _live_file(db, tree.find(ref_names[:-1]), ref_names[-1]) if ref_names else None
                if child is None:
                    missing.append({"file": tree.file_path(file), "reference": ref.path})
                    continue
                child_version = ref.version or child.latest_version
                if child_version > child.latest_version:
                    raise ApiError(f"{ref.path} has no version {ref.version}", code="bad_reference")
            if child.id == file.id or child.id in linked:
                continue
            linked.add(child.id)
            db.add(VersionRef(version_id=version.id, child_file_id=child.id, child_version=child_version))
            if paths.is_model(child.name):
                shows.append(child)
        # A drawing stays tied to what it shows: by reference, and by name, so the two sit side by side.
        if paths.is_drawing(file.name):
            if not shows:
                unlinked.append(tree.file_path(file))
            elif not any(paths.named_after(file.name, model.name) for model in shows):
                misnamed.append({"drawing": tree.file_path(file), "shows": tree.file_path(shows[0])})
    if missing:
        raise ApiError(
            "Some referenced files aren't in the vault; add them to this check-in",
            code="missing_references",
            missing=missing,
        )
    if unlinked:
        raise ApiError(
            f"{', '.join(unlinked)} {'doesn' if len(unlinked) == 1 else 'don'}'t show a part or assembly in the "
            "vault. Check drawings in from SolidWorks, with the Vault add-in: it records what each drawing shows.",
            code="drawing_without_model",
            drawings=unlinked,
        )
    if misnamed:
        first = misnamed[0]
        model = first["shows"].rsplit("/", 1)[-1]
        stem = model.rsplit(".", 1)[0]
        raise ApiError(
            f"Name each drawing after what it shows, so they stay together: {first['drawing']} shows {model}, so "
            f'call it {stem}.SLDDRW, or something that starts with its name, like "{stem} - machining.SLDDRW".',
            code="drawing_name",
            drawings=misnamed,
        )

    for status, file, version, _ in done.values():
        path = tree.file_path(file)
        if status != "unchanged":
            action = "add" if status == "created" else "checkin"
            _event(db, user, action, file=file, version=version, path=path, number=version.number, host=host)
        elif not keep_checked_out:
            _event(db, user, "undo_checkout", file=file, path=path, host=host, unchanged=True)
    db.commit()
    views = _views_by_id(db, tree, access, [f for _, f, _, _ in done.values()])
    return CheckinResult(record.id if record else None, [(s, views[f.id]) for s, f, _, _ in done.values()])


def revert(
    db: Session, user: User, file_id: int, number: int, *, comment: str = "", host: str = "web", force: bool = False
) -> FileView:
    """Make an older version the latest again, as a new version with its contents and references.

    Nothing is lost: it's recorded as a check-in like any other. It needs editor rights, and the
    file not checked out by someone else; a lead can force that, which releases their check-out.
    Your own check-out ends, as it would with a check-in.
    """
    host = _host(host)
    seq = begin_write(db)
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id)
    path = tree.file_path(file)
    access.require(file.folder_id, Role.EDITOR, f"revert {path}")
    if number == file.latest_version:
        raise ApiError(f"v{number} is already the latest version of {path}", code="bad_version")
    if not 1 <= number < file.latest_version:
        raise ApiError(f"{path} has no version {number}", code="bad_version")
    if file.checked_out_by is not None and file.checked_out_by != user.id:
        lock = _lock_json(db, tree, file)
        if not force:
            raise Conflict(
                f"{path} is checked out by {lock['user']} on {lock['host']}", code="checked_out", files=[lock]
            )
        access.require(file.folder_id, Role.LEAD, f"release {lock['user']}'s check-out of {path}")
        _event(db, user, "break_lock", file=file, path=path, host=lock["host"], holder=lock["email"])

    old = _version(db, file.id, number)
    now = utcnow()
    note = comment.strip()
    record = Checkin(
        user_id=user.id, host=host, comment=f"Reverted to v{number}" + (f": {note}" if note else ""), created_at=now
    )
    db.add(record)
    db.flush()
    file.latest_version += 1
    version = Version(
        file_id=file.id,
        number=file.latest_version,
        checkin_id=record.id,
        blob_sha256=old.blob_sha256,
        size=old.size,
        created_at=now,
        created_by=user.id,
    )
    db.add(version)
    db.flush()
    for ref in db.scalars(select(VersionRef).where(VersionRef.version_id == old.id)):
        db.add(VersionRef(version_id=version.id, child_file_id=ref.child_file_id, child_version=ref.child_version))
    _clear_lock(file)
    file.change_seq = seq
    _event(
        db, user, "revert", file=file, version=version, path=path, number=version.number, reverted_to=number, host=host
    )
    db.commit()
    return _views_by_id(db, tree, access, [file])[file.id]


@dataclass
class Deleted:
    folders: list[FolderView]
    files: list[FileView]  # the files named; not the ones that went with their folders


def delete(
    db: Session, user: User, refs: list[FileRef], *, folders: list[str] | None = None, force: bool = False
) -> Deleted:
    """Move files, and folders with everything in them, to the trash, all or nothing; they can be restored.

    Refuses files someone else has checked out, and files that files staying behind still use (SolidWorks
    would miss them), unless force. Deleting files takes editor access; a folder takes a lead of it, as
    moving one does. Everything deleted in one go shares its deleted_at, so a folder comes back with what
    went with it (see restore_folder).
    """
    seq = begin_write(db)
    tree, access = _context(db, user)
    chosen = []
    for path in folders or []:
        folder = tree.find(paths.split(path))
        if folder is None or not access.visible(folder.id):
            raise NotFound(f"There's no folder {path}")
        if folder.parent_id is None:
            raise ApiError("The top of the vault can't be deleted", code="bad_delete")
        access.require(folder.id, Role.LEAD, f"delete {tree.path(folder.id)}")
        chosen.append(folder)
    named = _resolve_many(db, tree, access, refs)
    if not chosen and not named:
        raise ApiError("Say what to delete", code="bad_delete")
    for file in named:
        access.require(file.folder_id, Role.EDITOR, f"delete {tree.file_path(file)}")
    # A folder inside another one being deleted goes with that one.
    ids = {f.id for f in chosen}
    tops = [f for f in chosen if not ids.intersection(tree.ancestry(f.id)[1:])]
    inside = {top.id: _files_under(db, tree, top) for top in tops}
    files = {f.id: f for f in named} | {f.id: f for found in inside.values() for f in found}

    for file in files.values():
        if file.checked_out_by not in (None, user.id):
            lock = _lock_json(db, tree, file)
            raise Conflict(f"{lock['path']} is checked out by {lock['user']}", code="checked_out", files=[lock])
    if not force:
        in_use = [
            {"path": tree.file_path(file), "used_by": tree.file_path(parent)}
            for file in files.values()
            for parent, _, _ in _parents(db, file.id)
            if parent.id not in files
        ]
        if in_use:
            parents = ", ".join(sorted({u["used_by"] for u in in_use}))
            raise Conflict(f"Still used by {parents}", code="in_use", used_by=in_use)

    now = utcnow()
    for top in tops:
        for folder in _subtree(tree, top):
            folder.deleted_at, folder.deleted_by, folder.change_seq = now, user.id, seq
        _event(db, user, "delete_folder", folder_id=top.id, path=tree.path(top.id), files=len(inside[top.id]))
    with_folders = {f.id for found in inside.values() for f in found}
    for file in files.values():
        file.deleted_at, file.deleted_by = now, user.id
        _clear_lock(file)
        file.change_seq = seq
        if file.id not in with_folders:
            _event(db, user, "delete", file=file, path=tree.file_path(file))
    if tops:
        _bump_access(db, seq)  # clients know folders by path: they sync everything again, without these
    db.commit()
    views = _views_by_id(db, tree, access, named)
    return Deleted([_folder_view(tree, access, f, user) for f in tops], [views[f.id] for f in named])


def _revive(db: Session, tree: Tree, folder: Folder, seq: int) -> None:
    """Bring a folder back from the trash, and any deleted folders above it, top down: where something in
    it is restored to. Refuses if a folder or file has taken one's name since."""
    chain = [tree.by_id[i] for i in reversed(tree.ancestry(folder.id))]
    for dead in chain:
        if dead.deleted_at is None:
            continue
        assert dead.parent_id is not None  # the top of the vault is never deleted
        if _taken(db, tree, tree.by_id[dead.parent_id], dead.name):
            raise Conflict(
                f"Something else is at {tree.path(dead.id)} now; move it out of the way first", code="exists"
            )
        dead.deleted_at = dead.deleted_by = None
        dead.change_seq = seq
        tree.add(dead)


def restore(db: Session, user: User, file_id: int) -> FileView:
    """Bring a deleted file back, with its full history; and its folder, if that was deleted too."""
    seq = begin_write(db)
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id, deleted_ok=True)
    path = tree.file_path(file)
    access.require(file.folder_id, Role.EDITOR, f"restore {path}")
    if file.deleted_at is not None:
        folder = tree.by_id[file.folder_id]
        _revive(db, tree, folder, seq)
        if _taken(db, tree, folder, file.name):
            raise Conflict(f"Something else is at {path} now; move it out of the way first", code="exists")
        file.deleted_at = file.deleted_by = None
        file.change_seq = seq
        _event(db, user, "restore", file=file, path=path)
        db.commit()
    return _views_by_id(db, tree, access, [file])[file.id]


def _deleted_with(tree: Tree, folder: Folder) -> list[Folder]:
    """A deleted folder and the folders under it that were deleted along with it (not before)."""
    under: dict[int, list[Folder]] = defaultdict(list)
    for other in tree.by_id.values():
        if other.parent_id is not None and other.deleted_at is not None:
            under[other.parent_id].append(other)
    found, pending = [], [folder]
    while pending:
        current = pending.pop()
        found.append(current)
        pending.extend(f for f in under[current.id] if f.deleted_at == folder.deleted_at)
    return found


def restore_folder(db: Session, user: User, folder_id: int) -> FolderView:
    """Bring a deleted folder back with everything deleted along with it, and the folders above it if they
    were deleted too. What was deleted from it before stays in its trash. Takes a lead of it, like deleting it."""
    seq = begin_write(db)
    tree, access = _context(db, user)
    folder = tree.by_id.get(folder_id)
    if folder is None or folder.parent_id is None or not access.visible(folder.id):
        raise NotFound(f"Folder {folder_id} not found")
    access.require(folder.id, Role.LEAD, f"restore {tree.path(folder.id)}")
    if folder.deleted_at is not None:
        when = folder.deleted_at
        folders = _deleted_with(tree, folder)
        _revive(db, tree, folder, seq)
        for inside in folders[1:]:
            inside.deleted_at = inside.deleted_by = None
            inside.change_seq = seq
            tree.add(inside)
        ids = [f.id for f in folders]
        files = db.scalars(select(File).where(File.folder_id.in_(ids), File.deleted_at == when)).all()
        for file in files:
            file.deleted_at = file.deleted_by = None
            file.change_seq = seq
        _event(db, user, "restore_folder", folder_id=folder.id, path=tree.path(folder.id), files=len(files))
        db.commit()
    return _folder_view(tree, access, folder)


# --- moving and renaming ------------------------------------------------------------------------


@dataclass
class Moved:
    folders: list[FolderView]
    files: list[FileView]


def _folder_of(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


def _relative(start: str, target: str) -> tuple[str, ...]:
    """How to get from one folder to another: '..' for each step up, then the names down (compared as keys)."""
    here, there = [paths.key(n) for n in start.split("/") if n], [paths.key(n) for n in target.split("/") if n]
    common = 0
    while common < min(len(here), len(there)) and here[common] == there[common]:
        common += 1
    return ("..",) * (len(here) - common) + tuple(there[common:])


def _still_found(old: str, new: str, user_old: str, user_new: str) -> bool:
    """Whether SolidWorks still finds a file moved from old to new, from a file that uses it (at user_old, now user_new).

    SolidWorks looks for a referenced file by name: in the referencing file's folder, and where it was relative
    to that file. So the name must stay, and the file must end up in the user's folder or in the same place
    relative to it (their folder moving together, say).
    """
    if paths.key(new.rsplit("/", 1)[-1]) != paths.key(old.rsplit("/", 1)[-1]):
        return False
    if paths.key(_folder_of(new)) == paths.key(_folder_of(user_new)):
        return True
    return _relative(_folder_of(user_old), _folder_of(old)) == _relative(_folder_of(user_new), _folder_of(new))


def _check_moves(db: Session, tree: Tree, moves: dict[int, tuple[str, str]]) -> None:
    """Refuse moves that would break SolidWorks references or strand a check-out; moves maps file ids to paths."""
    for file_id in moves:
        file = db.get(File, file_id)
        assert file is not None
        if file.checked_out_by is not None:
            lock = _lock_json(db, tree, file)
            raise Conflict(
                f"{lock['path']} is checked out by {lock['user']} on {lock['host']}: move it once it's checked in",
                code="checked_out",
                files=[lock],
            )
    broken = []
    for file_id, (old, new) in moves.items():
        for user_file, _, _ in _parents(db, file_id):
            user_old = tree.file_path(user_file)
            user_new = moves.get(user_file.id, (user_old, user_old))[1]
            if not _still_found(old, new, user_old, user_new):
                broken.append({"path": old, "used_by": user_old})
    if broken:
        first = broken[0]
        raise Conflict(
            f"{first['used_by']} uses {first['path']}, and SolidWorks wouldn't find it after this. Keep a file where "
            "the files that use it can find it: in their folder, or where it was next to them (move their folder "
            "together). To rename it, rename it in SolidWorks, then check both in.",
            code="in_use",
            used_by=broken,
        )


def _subtree(tree: Tree, folder: Folder) -> list[Folder]:
    """A folder and every folder under it."""
    found, pending = [], [folder]
    while pending:
        current = pending.pop()
        found.append(current)
        pending.extend(tree.children[current.id].values())
    return found


def _files_under(db: Session, tree: Tree, folder: Folder) -> list[File]:
    """Live files in a folder and every folder under it."""
    ids = [f.id for f in _subtree(tree, folder)]
    return list(db.scalars(select(File).where(File.folder_id.in_(ids), File.deleted_at.is_(None))))


def _taken(db: Session, tree: Tree, parent: Folder, name: str, itself: File | Folder | None = None) -> bool:
    """Whether a live file or a folder other than itself has this name in a folder."""
    file = _live_file(db, parent, name)
    folder = tree.children[parent.id].get(paths.key(name))
    return (file is not None and file is not itself) or (folder is not None and folder is not itself)


def _finish_move(db: Session, user: User, seq: int, files: list[File], folders: list[Folder]) -> Moved:
    """Mark what moved as changed, down to everything in moved folders, and have every client sync everything
    again: clients know folders by path, and where a file is decides who can see it (see sync)."""
    tree = _context(db, user)[0]  # with the new paths
    for folder in folders:
        for inside in _subtree(tree, folder):
            inside.change_seq = seq
        for file in _files_under(db, tree, folder):
            file.change_seq = seq
    for file in files:
        file.change_seq = seq
    _bump_access(db, seq)
    db.commit()
    tree, access = _context(db, user)
    views = _views_by_id(db, tree, access, files) if files else {}
    return Moved([_folder_view(tree, access, f) for f in folders], [views[f.id] for f in files])


def move(db: Session, user: User, *, files: list[FileRef], folders: list[str], to: str) -> Moved:
    """Move files and folders into a folder (made if it isn't there yet), all or nothing.

    Checked-out files don't move, and neither does a file that the files using it wouldn't find
    afterwards (see _still_found). Moving files takes editor access where they are and where they
    go; moving a folder, which takes its permissions along, takes a lead of it.
    """
    seq = begin_write(db)
    tree, access = _context(db, user)
    moving_folders = []
    for path in folders:
        folder = tree.find(paths.split(path))
        if folder is None or not access.visible(folder.id):
            raise NotFound(f"There's no folder {path}")
        if folder.parent_id is None:
            raise ApiError("The top of the vault doesn't move", code="bad_move")
        access.require(folder.id, Role.LEAD, f"move {tree.path(folder.id)}")
        moving_folders.append(folder)
    moving_files = _resolve_many(db, tree, access, files)
    if not moving_folders and not moving_files:
        raise ApiError("Say what to move", code="bad_move")
    dest_names = paths.split(to)
    deepest, _ = tree.deepest(dest_names)
    for folder in moving_folders:
        if folder.id in tree.ancestry(deepest.id):
            raise ApiError(f"{tree.path(folder.id)} can't go inside itself", code="bad_move")
    dest = _ensure_folders(db, tree, access, user, dest_names, seq)
    access.require(dest.id, Role.EDITOR, f"move files into {tree.label(dest.id)}")

    moves: dict[int, tuple[str, str]] = {}
    names: set[str] = set()  # of what's moving into dest, so two things can't take one name
    dest_path = tree.path(dest.id)
    for folder in moving_folders:
        if folder.parent_id == dest.id:
            continue
        if paths.key(folder.name) in names or _taken(db, tree, dest, folder.name):
            raise Conflict(f"{paths.join(dest_path, folder.name)} is taken", code="exists")
        names.add(paths.key(folder.name))
        old_base, new_base = tree.path(folder.id), paths.join(dest_path, folder.name)
        for file in _files_under(db, tree, folder):
            old = tree.file_path(file)
            moves[file.id] = (old, new_base + old[len(old_base) :])
    for file in moving_files:
        old = tree.file_path(file)
        access.require(file.folder_id, Role.EDITOR, f"move {old}")
        if file.id in moves:
            raise ApiError(f"{old} is moving with its folder already", code="bad_move")
        if file.folder_id == dest.id:
            continue
        if paths.key(file.name) in names or _taken(db, tree, dest, file.name):
            raise Conflict(f"{paths.join(dest_path, file.name)} is taken", code="exists")
        names.add(paths.key(file.name))
        moves[file.id] = (old, paths.join(dest_path, file.name))
    for _, new in moves.values():
        paths.split(new)  # still within the length limit
    _check_moves(db, tree, moves)

    moved_folders = [f for f in moving_folders if f.parent_id != dest.id]
    moved_files = [f for f in moving_files if f.folder_id != dest.id]
    for folder in moved_folders:
        _event(
            db,
            user,
            "move_folder",
            folder_id=folder.id,
            path=paths.join(dest_path, folder.name),
            moved_from=tree.path(folder.id),
        )
        folder.parent_id = dest.id
    for file in moved_files:
        _event(db, user, "move", file=file, path=moves[file.id][1], moved_from=moves[file.id][0])
        file.folder_id = dest.id
    db.flush()
    return _finish_move(db, user, seq, moved_files, moved_folders)


def rename(db: Session, user: User, *, file: FileRef | None = None, folder: str | None = None, name: str) -> Moved:
    """Rename a file (keeping its type) or a folder, where it is.

    A file that other files use keeps its name, since SolidWorks finds it by name; so do folders
    with such files in them, unless the files using them are inside too. Renaming a file takes
    editor access to its folder; renaming a folder takes a lead of it.
    """
    new_name = paths.clean_name(name)
    seq = begin_write(db)
    tree, access = _context(db, user)
    if (file is None) == (folder is None):
        raise ApiError("Rename a file or a folder", code="bad_rename")
    moves: dict[int, tuple[str, str]] = {}
    if file is not None:
        target = _resolve(db, tree, access, file)
        old = tree.file_path(target)
        access.require(target.folder_id, Role.EDITOR, f"rename {old}")
        if paths.extension(new_name) != paths.extension(target.name):
            raise ApiError(f"{new_name} would change what kind of file {target.name} is", code="bad_rename")
        parent = tree.by_id[target.folder_id]
        if _taken(db, tree, parent, new_name, target):
            raise Conflict(f"{paths.join(tree.path(parent.id), new_name)} is taken", code="exists")
        new = paths.join(tree.path(parent.id), new_name)
        paths.split(new)
        moves[target.id] = (old, new)
        _check_moves(db, tree, moves)
        _event(db, user, "rename", file=target, path=new, moved_from=old)
        target.name, target.name_key = new_name, paths.key(new_name)
        db.flush()
        return _finish_move(db, user, seq, [target], [])

    assert folder is not None
    renamed = tree.find(paths.split(folder))
    if renamed is None or not access.visible(renamed.id):
        raise NotFound(f"There's no folder {folder}")
    if renamed.parent_id is None:
        raise ApiError("The top of the vault has no name", code="bad_rename")
    access.require(renamed.id, Role.LEAD, f"rename {tree.path(renamed.id)}")
    parent = tree.by_id[renamed.parent_id]
    if _taken(db, tree, parent, new_name, renamed):
        raise Conflict(f"{paths.join(tree.path(parent.id), new_name)} is taken", code="exists")
    old_base, new_base = tree.path(renamed.id), paths.join(tree.path(parent.id), new_name)
    for inside in _files_under(db, tree, renamed):
        old = tree.file_path(inside)
        moves[inside.id] = (old, new_base + old[len(old_base) :])
    for _, new in moves.values():
        paths.split(new)
    _check_moves(db, tree, moves)
    _event(db, user, "rename_folder", folder_id=renamed.id, path=new_base, moved_from=old_base)
    renamed.name, renamed.name_key = new_name, paths.key(new_name)
    db.flush()
    return _finish_move(db, user, seq, [], [renamed])


def can_upload(db: Session, user: User) -> bool:
    """Editors anywhere may upload contents. A blob on its own gives access to nothing."""
    if user.is_admin:
        return True
    roles = db.scalars(select(Grant.role).where(or_(Grant.user_id == user.id, Grant.user_id.is_(None))))
    return any(role.rank >= Role.EDITOR.rank for role in roles)


def blob_size(db: Session, sha256: str) -> int | None:
    blob = db.get(Blob, sha256)
    return blob.size if blob else None


def register_blob(db: Session, sha256: str, size: int) -> None:
    """Record verified contents that are now in the blob store."""
    if db.get(Blob, sha256) is not None:
        return
    db.add(Blob(sha256=sha256, size=size, created_at=utcnow()))
    try:
        db.commit()
    except IntegrityError:  # the same contents were uploaded concurrently
        db.rollback()


# --- Caliper: versions' 3D models ---------------------------------------------------------

Units = Literal["mm", "cm", "m", "in", "ft"]  # a document's length unit, which Caliper measures in
_MAX_COMPONENTS = 20_000  # a big assembly has a few thousand
_MAX_DEPTH = 32


@dataclass
class ModelView:
    """A version's 3D model in one configuration, for Caliper."""

    model: CaliperModel
    version: int
    created_by: User

    @property
    def kind(self) -> Literal["part", "assembly"]:
        return "part" if self.model.mesh_sha256 is not None else "assembly"


@dataclass
class AssemblyModel:
    view: ModelView
    # The components the user can see, each with "model": whether its file has a model of its own, at its version and
    # in its configuration.
    components: list[dict[str, Any]]
    left_out: int  # components of files the user can't see, left out with everything in them


def _caliper_kind(name: str) -> Literal["part", "assembly"] | None:
    extension = paths.extension(name)
    return "part" if extension == ".sldprt" else "assembly" if extension == ".sldasm" else None


def _walk(components: list[dict[str, Any]], depth: int = 1) -> Iterator[tuple[dict[str, Any], int]]:
    """Every component of an assembly's model, at every level, with how deep it is (1: the assembly's own)."""
    for component in components:
        yield component, depth
        yield from _walk(component.get("children") or [], depth + 1)


def _files_by_id(db: Session, ids: set[int]) -> dict[int, File]:
    found: dict[int, File] = {}
    wanted = sorted(ids)
    for start in range(0, len(wanted), _BATCH):
        found.update((f.id, f) for f in db.scalars(select(File).where(File.id.in_(wanted[start : start + _BATCH]))))
    return found


def _find_model(db: Session, tree: Tree, file: File, version: int, configuration: str) -> CaliperModel:
    model = db.scalar(
        select(CaliperModel)
        .join(Version, Version.id == CaliperModel.version_id)
        .where(Version.file_id == file.id, Version.number == version, CaliperModel.configuration == configuration)
    )
    if model is None:
        raise NotFound(
            f"{tree.file_path(file)} v{version} has no 3D model in its {configuration} configuration", code="no_model"
        )
    return model


def caliper_models(db: Session, user: User, file_id: int) -> list[ModelView]:
    """A file's 3D models for Caliper: each version's, in each configuration, newest version first, and in a version
    the first one made first (the configuration SolidWorks had open)."""
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id, deleted_ok=True)
    rows = db.execute(
        select(CaliperModel, Version.number)
        .join(Version, Version.id == CaliperModel.version_id)
        .where(Version.file_id == file.id)
        .order_by(Version.number.desc(), CaliperModel.id)
    ).all()
    users = _users(db, {model.created_by for model, _ in rows})
    return [ModelView(model, number, users[model.created_by]) for model, number in rows]


def caliper_missing(db: Session, user: User, wanted: list[tuple[int, int, str]]) -> list[tuple[int, int, str]]:
    """Which of these (file id, version, configuration) have no 3D model yet, of files the user can see: what Vault for
    SolidWorks asks before making models, so it makes only those."""
    _, access = _context(db, user)
    files = _files_by_id(db, {file_id for file_id, _, _ in wanted})
    have: set[tuple[int, int, str]] = set()
    ids = sorted(files)
    for start in range(0, len(ids), _BATCH):
        rows = db.execute(
            select(Version.file_id, Version.number, CaliperModel.configuration)
            .join(Version, Version.id == CaliperModel.version_id)
            .where(Version.file_id.in_(ids[start : start + _BATCH]))
        )
        have.update((file_id, number, configuration) for file_id, number, configuration in rows)

    def needs(file_id: int, version: int, configuration: str) -> bool:
        file = files.get(file_id)
        return (
            file is not None
            and access.can(file.folder_id, Role.VIEWER)
            and 1 <= version <= file.latest_version
            and (file_id, version, configuration) not in have
        )

    return [model for model in dict.fromkeys(wanted) if needs(*model)]


def _check_components(db: Session, tree: Tree, access: Access, components: list[dict[str, Any]]) -> None:
    """An assembly's components name files the user can see, at versions those have, or carry shapes of their own."""
    walked = list(_walk(components))
    if len(walked) > _MAX_COMPONENTS:
        raise ApiError(f"An assembly's model has at most {_MAX_COMPONENTS} components", code="bad_model")
    if max((depth for _, depth in walked), default=0) > _MAX_DEPTH:
        raise ApiError(f"An assembly's model is at most {_MAX_DEPTH} levels deep", code="bad_model")
    files = _files_by_id(db, {c["file_id"] for c, _ in walked if c.get("file_id") is not None})
    for component, _ in walked:
        name, file_id, version = component["name"], component.get("file_id"), component.get("version")
        if file_id is None:
            if not component.get("mesh") and not component.get("children"):
                raise ApiError(f"Component {name} has no file, shape, or components", code="bad_model")
            continue
        file = files.get(file_id)
        if file is None or not access.can(file.folder_id, Role.VIEWER):
            raise ApiError(f"Component {name} is of file {file_id}, which isn't in the vault", code="bad_model")
        if version is None or version > file.latest_version:
            raise ApiError(
                f"Component {name} is of {tree.file_path(file)} v{version}, which it doesn't have", code="bad_model"
            )


def put_caliper_model(
    db: Session,
    store: BlobStore,
    user: User,
    file_id: int,
    *,
    version: int,
    configuration: str,
    units: str,
    mesh: str | None = None,
    components: list[dict[str, Any]] | None = None,
) -> ModelView:
    """Save a version's 3D model in one configuration, for Caliper: a part's mesh (vault/caliper.py; upload it first,
    PUT /api/blobs/{sha256}), or an assembly's components.

    Anyone who may upload contents and can see the file may add a model its version doesn't have yet, as Vault for
    SolidWorks does for each part of an assembly it checks in. Making one again, in place of the one there, takes
    editor rights to the file's folder. An assembly's components are a tree. Each names its file, a part or a
    sub-assembly, at a version and in a configuration; or carries its shape (mesh: a virtual part's, which the
    assembly keeps); and says where it is (transform: the rows of a 3 x 4 matrix to the assembly's coordinates,
    rotation and then translation in millimeters), whether SolidWorks hid it, its color over its part's, and a
    sub-assembly's own components (children, placed in the same coordinates).
    """
    meshes = list(
        dict.fromkeys(([mesh] if mesh else []) + [c["mesh"] for c, _ in _walk(components or []) if c.get("mesh")])
    )
    # Blobs never change, so checking their contents, which takes a moment, can come before the write lock.
    for sha in meshes:
        if not store.exists(sha):
            raise ApiError("Upload the mesh first (PUT /api/blobs/{sha256})", code="blob_missing", sha256=sha)
        caliper.check_mesh(store.path(sha))
    begin_write(db)
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id, deleted_ok=True)
    path = tree.file_path(file)
    if not can_upload(db, user):
        raise Forbidden("You need editor access somewhere to add 3D models")
    kind = _caliper_kind(file.name)
    if kind is None:
        raise ApiError(f"Caliper's models are of SolidWorks parts and assemblies: {path} isn't one", code="bad_model")
    if (kind == "part") != (mesh is not None) or (kind == "assembly") != (components is not None):
        raise ApiError(
            f"A part's model is a mesh, and an assembly's is its components: {path} is a{'n' if kind == 'assembly' else ''} "
            f"{kind}",
            code="bad_model",
        )
    if units not in get_args(Units):
        raise ApiError(f"Caliper measures in {', '.join(get_args(Units))}, not {units}", code="bad_model")
    target = db.scalar(select(Version).where(Version.file_id == file.id, Version.number == version))
    if target is None:
        raise NotFound(f"{path} has no version {version}")
    for sha in meshes:
        if db.get(Blob, sha) is None:  # in the store, but its upload was never recorded
            raise ApiError("Upload the mesh again (PUT /api/blobs/{sha256})", code="blob_missing", sha256=sha)
    if components is not None:
        _check_components(db, tree, access, components)
    model = db.scalar(
        select(CaliperModel).where(CaliperModel.version_id == target.id, CaliperModel.configuration == configuration)
    )
    if model is None:
        model = CaliperModel(version_id=target.id, configuration=configuration)
        db.add(model)
    else:
        access.require(file.folder_id, Role.EDITOR, f"make the 3D model of {path} v{version} again")
    model.units, model.mesh_sha256, model.components = units, mesh, components
    model.created_at, model.created_by = utcnow(), user.id
    db.commit()
    return ModelView(model, version, user)


_MAX_READ = 1 << 28  # bigger files aren't read for their 3D view here: Vault for SolidWorks makes theirs


def _keep(store: BlobStore, data: bytes) -> tuple[str, int]:
    """Put bytes the server made in the blob store, under their SHA-256 (not yet recorded in blobs)."""
    sha = hashlib.sha256(data).hexdigest()
    if not store.exists(sha):
        temp = store.temp_path()
        try:
            temp.write_bytes(data)
            store.commit(sha, temp)
        finally:
            temp.unlink(missing_ok=True)
    return sha, len(data)


def _by_path[T](names: list[str], same: list[tuple[File, T]], tree: Tree, least: int = 0) -> tuple[File, T] | None:
    """Of files with a component's name, the one whose path ends most like the one SolidWorks saved for it (names), if
    at least `least` of their names agree; none when two end alike."""
    if not same:
        return None
    mine = [paths.key(name) for name in names]

    def common(file: File) -> int:
        theirs = [paths.key(name) for name in paths.split(tree.file_path(file))]
        n = 0
        while n < min(len(theirs), len(mine)) and theirs[-1 - n] == mine[-1 - n]:
            n += 1
        return n

    if len(same) == 1:
        return same[0] if least == 0 or common(same[0][0]) >= least else None
    ranked = sorted(same, key=lambda found: common(found[0]), reverse=True)
    best = common(ranked[0][0])
    return ranked[0] if best > common(ranked[1][0]) and best >= least else None


class _Finder:
    """Which file a component of an assembly's version is, by the path SolidWorks saved for it: one of the version's
    references with its name; else, as versions from the web app and from Kenesto reference nothing, the vault's file
    with its name in a folder of its folder's name (not deleted: a name alone, as STEP imports' SOLID-1, could be any
    file's), at the version it had when the assembly's version was made, or its first."""

    def __init__(self, db: Session, tree: Tree, when: datetime) -> None:
        self._db, self._tree, self._when = db, tree, when
        self._named: dict[str, list[File]] = {}

    def file_of(self, path: str, refs: list[tuple[File, int]]) -> tuple[File, int] | None:
        names = [name for name in re.split(r"[\\/]", path) if name]
        if not names:
            return None
        key = paths.key(names[-1])
        found = _by_path(names, [(file, version) for file, version in refs if file.name_key == key], self._tree)
        if found is not None:
            return found
        if key not in self._named:
            alive = select(File).where(File.name_key == key, File.deleted_at.is_(None))
            self._named[key] = list(self._db.scalars(alive))
        named = _by_path(names, [(file, 0) for file in self._named[key]], self._tree, least=min(2, len(names)))
        if named is None:
            return None
        then = self._db.scalar(
            select(func.max(Version.number)).where(Version.file_id == named[0].id, Version.created_at <= self._when)
        )
        return named[0], then or 1


def _refs_of(db: Session, version: Version) -> list[tuple[File, int]]:
    rows = db.execute(
        select(File, VersionRef.child_version)
        .join(VersionRef, VersionRef.child_file_id == File.id)
        .where(VersionRef.version_id == version.id)
    )
    return [(file, number) for file, number in rows]


def make_caliper_model(db: Session, store: BlobStore, user: User, file_id: int, version: int) -> ModelView:
    """Make a version's 3D model from the 3D view SolidWorks saved in the file itself (vault/solidworks.py), in the
    configuration it was saved in: so Caliper shows SolidWorks files that Vault for SolidWorks made no model of. A
    version that has a model keeps it, and that one comes back.

    Anyone who can see the file may, as the model comes from the file. An assembly's components are the files its
    version references, or else the vault's files with their names (_Finder), each with its shape as the assembly
    shows it where SolidWorks saved one; the others show their own models. Who sees which is decided when it's shown
    (caliper_assembly)."""
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id, deleted_ok=True)
    path = tree.file_path(file)
    kind = _caliper_kind(file.name)
    if kind is None:
        raise ApiError(f"Caliper's models are of SolidWorks parts and assemblies: {path} isn't one", code="bad_model")
    target = db.scalar(select(Version).where(Version.file_id == file.id, Version.number == version))
    if target is None:
        raise NotFound(f"{path} has no version {version}")
    made = db.scalar(select(CaliperModel).where(CaliperModel.version_id == target.id).order_by(CaliperModel.id))
    if made is not None:
        return ModelView(made, version, _users(db, {made.created_by})[made.created_by])
    if target.size > _MAX_READ:
        raise solidworks.Unreadable(
            f"{path} v{version} is over {_MAX_READ >> 20} MB, too big to read here: make its 3D view in SolidWorks "
            "(Make 3D view, on the Vault tab)"
        )

    # Versions never change, so reading one, which takes a moment, comes before the write lock.
    data = store.path(target.blob_sha256).read_bytes()
    kept: dict[str, int] = {}  # blobs made, with their sizes
    mesh: str | None = None
    components: list[dict[str, Any]] | None = None
    try:
        if kind == "part":
            part = solidworks.read_part(data)
            configuration, units = part.configuration[:255], part.units
            mesh, size = _keep(store, caliper.write_mesh(part.bodies))
            kept[mesh] = size
        else:
            assembly = solidworks.read_assembly(data)
            configuration, units = assembly.configuration[:255], assembly.units
            finder = _Finder(db, tree, target.created_at)

            def place(found: list[solidworks.Component], refs: list[tuple[File, int]]) -> list[dict[str, Any]]:
                out = []
                for component in found:
                    match = None if component.virtual else finder.file_of(component.path, refs)
                    shape = None
                    if component.shape is not None:
                        shape, size = _keep(store, caliper.write_mesh(component.shape))
                        kept[shape] = size
                    inner: list[tuple[File, int]] = []
                    if match is not None and component.children:
                        inner = _refs_of(db, _version(db, match[0].id, match[1]))
                    children = place(component.children, inner)
                    if match is None and shape is None and not children:
                        continue  # nothing to show or open
                    out.append(
                        {
                            "name": component.name[:255],
                            "file_id": match[0].id if match else None,
                            "version": match[1] if match else None,
                            "configuration": component.configuration[:255],
                            "transform": component.transform,
                            "hidden": component.hidden,
                            "color": None,
                            "opacity": 1.0,
                            "mesh": shape,
                            "children": children,
                        }
                    )
                return out

            components = place(assembly.components, _refs_of(db, target))
            if not components:
                raise solidworks.Unreadable(
                    "Caliper found none of its parts: they aren't in the vault, or they're kept inside it (virtual "
                    "components) without a 3D view. Make its 3D view in SolidWorks (Make 3D view, on the Vault tab)"
                )
            if sum(1 for _ in _walk(components)) > _MAX_COMPONENTS:
                raise solidworks.Unreadable(f"It has over {_MAX_COMPONENTS} components, more than Caliper shows")
    except solidworks.Unreadable as e:
        raise solidworks.Unreadable(f"{path} v{version}: {e.message}") from e

    begin_write(db)
    tree, access = _context(db, user)
    _resolve(db, tree, access, file_id, deleted_ok=True)  # still theirs to see
    made = db.scalar(
        select(CaliperModel).where(CaliperModel.version_id == target.id, CaliperModel.configuration == configuration)
    )
    if made is None:  # else someone made it meanwhile
        for sha, size in kept.items():
            if db.get(Blob, sha) is None:
                db.add(Blob(sha256=sha, size=size, created_at=utcnow()))
        made = CaliperModel(
            version_id=target.id,
            configuration=configuration,
            units=units,
            mesh_sha256=mesh,
            components=components,
            created_at=utcnow(),
            created_by=user.id,
        )
        db.add(made)
    db.commit()
    return ModelView(made, version, _users(db, {made.created_by})[made.created_by])


def caliper_assembly(db: Session, user: User, file_id: int, version: int, configuration: str) -> AssemblyModel:
    """An assembly's model, with the components the user can see: one of a file they can't see is left out, with
    everything in it, as the rest of the vault leaves out such files."""
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id, deleted_ok=True)
    model = _find_model(db, tree, file, version, configuration)
    if model.components is None:
        raise ApiError(f"{tree.file_path(file)} is a part: its model is a mesh", code="bad_model")
    walked = [component for component, _ in _walk(model.components)]
    files = _files_by_id(db, {c["file_id"] for c in walked if c.get("file_id") is not None})
    have: set[tuple[int, int, str]] = set()  # (file id, version, configuration) with models of their own
    ids = sorted(files)
    for start in range(0, len(ids), _BATCH):
        rows = db.execute(
            select(Version.file_id, Version.number, CaliperModel.configuration)
            .join(Version, Version.id == CaliperModel.version_id)
            .where(Version.file_id.in_(ids[start : start + _BATCH]))
        )
        have.update((file_id, number, configuration) for file_id, number, configuration in rows)
    left_out = 0

    def visible(components: list[dict[str, Any]]) -> list[dict[str, Any]]:
        nonlocal left_out
        kept = []
        for component in components:
            file_id = component.get("file_id")
            file = files.get(file_id) if file_id is not None else None
            if file_id is not None and (file is None or not access.can(file.folder_id, Role.VIEWER)):
                left_out += 1
                continue
            own = (file_id, component.get("version"), component.get("configuration")) in have
            kind = _caliper_kind(file.name) if file is not None else None
            children = visible(component.get("children") or [])
            kept.append({**component, "model": own, "kind": kind, "children": children})
        return kept

    components = visible(model.components)
    creator = _users(db, {model.created_by})[model.created_by]
    return AssemblyModel(ModelView(model, version, creator), components, left_out)


def caliper_mesh(
    db: Session, user: User, file_id: int, version: int, configuration: str, mesh: str | None = None
) -> str:
    """The blob of a part's mesh; or, given mesh, of a shape an assembly's model carries (a virtual part's), if a
    component the user can see has it."""
    if mesh is not None:
        assembly = caliper_assembly(db, user, file_id, version, configuration)
        if not any(component.get("mesh") == mesh for component, _ in _walk(assembly.components)):
            raise NotFound("No component of the assembly that you can see has that shape", code="no_model")
        return mesh
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id, deleted_ok=True)
    model = _find_model(db, tree, file, version, configuration)
    if model.mesh_sha256 is None:
        raise ApiError(f"{tree.file_path(file)} is an assembly: its parts have the meshes", code="bad_model")
    return model.mesh_sha256


# --- permissions --------------------------------------------------------------------------


def folder_grants(db: Session, user: User, path: str) -> tuple[FolderView, list[GrantView]]:
    """Who has access to a folder: its own grants and the ones it inherits, root first."""
    tree, access = _context(db, user)
    folder = tree.find(paths.split(path))
    if folder is None or not access.visible(folder.id):
        raise NotFound(f"{path} not found")
    chain = tree.ancestry(folder.id)
    depth = {folder_id: -i for i, folder_id in enumerate(chain)}
    grants = sorted(
        db.scalars(select(Grant).where(Grant.folder_id.in_(chain))),
        key=lambda g: (depth[g.folder_id], -g.role.rank),
    )
    users = _users(db, {g.user_id for g in grants})
    views = [GrantView(tree.path(g.folder_id), users.get(g.user_id) if g.user_id else None, g.role) for g in grants]
    return _folder_view(tree, access, folder), views


def set_grant(db: Session, user: User, path: str, *, user_id: int | None, role: Role | None) -> None:
    """Give a person (or, with user_id None, everyone) a role on a folder; role None removes it."""
    seq = begin_write(db)
    tree, access = _context(db, user)
    folder = tree.find(paths.split(path))
    if folder is None or not access.visible(folder.id):
        raise NotFound(f"{path} not found")
    access.require(folder.id, Role.LEAD, f"change who can access {tree.label(folder.id)}")
    target = None
    if user_id is not None:
        target = db.get(User, user_id)
        if target is None:
            raise NotFound(f"User {user_id} not found")
    who = Grant.user_id.is_(None) if user_id is None else Grant.user_id == user_id
    existing = db.scalar(select(Grant).where(Grant.folder_id == folder.id, who))
    if role is None:
        if existing is not None:
            db.delete(existing)
    elif existing is not None:
        existing.role = role
    else:
        db.add(Grant(folder_id=folder.id, user_id=user_id, role=role, created_at=utcnow(), created_by=user.id))
    _bump_access(db, seq)
    _event(
        db,
        user,
        "grant",
        folder_id=folder.id,
        path=tree.path(folder.id),
        principal=target.email if target else "everyone",
        role=role.value if role else None,
    )
    db.commit()
