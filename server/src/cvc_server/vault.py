"""Vault operations: folders, check-out/check-in, history, deletion, permissions, sync.

Independent of HTTP so they can be tested and reused directly. Each function
takes the acting user and checks permissions through Access. Every mutating
function starts with begin_write(); read its docstring before adding one.
"""

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import paths
from .access import Access, Tree
from .db import utcnow
from .errors import Conflict, CvcError, Forbidden, NotFound
from .models import Blob, Checkin, Event, File, Folder, Grant, Role, User, UserStatus, VaultState, Version, VersionRef

FileRef = int | str  # a file id, or a vault path
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


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


# --- what the API gets back -------------------------------------------------------------


@dataclass
class FolderView:
    id: int
    path: str
    name: str
    role: str | None  # the user's effective role; None if the folder is only a way through


@dataclass
class FileView:
    file: File
    path: str
    latest: Version
    modified_by: User
    locked_by: User | None
    # What the latest version uses that the user can see (an assembly's parts): (file id, version used).
    uses: list[tuple[int, int]] = field(default_factory=list)


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


def _folder_view(tree: Tree, access: Access, folder: Folder) -> FolderView:
    return FolderView(folder.id, tree.path(folder.id), folder.name, access.role(folder.id))


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
    users = _users(db, {v.created_by for _, v in rows} | {f.checked_out_by for f, _ in rows})
    uses = _uses(db, access, [v.id for _, v in rows])
    return [
        FileView(
            f,
            tree.file_path(f),
            v,
            users[v.created_by],
            users.get(f.checked_out_by) if f.checked_out_by else None,
            uses.get(v.id, []),
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
        raise CvcError("Say which computer this is (host)", code="bad_host")
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
    """A folder's subfolders and files (or, with deleted=True, its deleted files)."""
    tree, access = _context(db, user)
    folder = tree.find(paths.split(path))
    if folder is None or not access.visible(folder.id):
        raise NotFound(f"{path} not found")
    subfolders = sorted(
        (f for f in tree.children[folder.id].values() if access.visible(f.id)), key=lambda f: f.name_key
    )
    files: list[FileView] = []
    if access.can(folder.id, Role.VIEWER):
        state = File.deleted_at.is_not(None) if deleted else File.deleted_at.is_(None)
        files = _file_views(db, tree, access, _with_latest(db, File.folder_id == folder.id, state))
    return Listing(_folder_view(tree, access, folder), [_folder_view(tree, access, f) for f in subfolders], files)


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
    as `since` next time.
    """
    # Read the cursor before the rows: every change up to seq has committed by then (see begin_write).
    seq, access_seq = db.execute(select(VaultState.seq, VaultState.access_seq)).one()
    full = since <= 0 or since > seq or since < access_seq
    tree, access = _context(db, user)
    folders = [
        _folder_view(tree, access, f)
        for f in tree.by_id.values()
        if f.parent_id is not None and access.visible(f.id) and (full or f.change_seq > since)
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
        raise CvcError("The vault root already exists", code="exists")
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
    released, unless keep_checked_out is set.
    """
    host = _host(host)
    if not items:
        raise CvcError("Nothing to check in")
    seq = begin_write(db)
    tree, access = _context(db, user)
    now = utcnow()

    planned: list[tuple[CheckinItem, list[str], File | None]] = []
    seen: set[str] = set()
    for item in items:
        names = paths.split(item.path)
        if not names:
            raise CvcError("A check-in item has an empty path", code="bad_path")
        path = paths.join(*names)
        if paths.key(path) in seen:
            raise CvcError(f"{path} is listed twice")
        seen.add(paths.key(path))
        blob = db.get(Blob, item.sha256)
        if blob is None:
            raise CvcError(f"Upload {path} before checking it in", code="blob_missing", path=path, sha256=item.sha256)
        if blob.size != item.size:
            raise CvcError(f"The size of {path} doesn't match its upload", code="size_mismatch", path=path)
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
            if latest.blob_sha256 == item.sha256:
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
                    raise CvcError(f"{ref.path} has no version {ref.version}", code="bad_reference")
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
        raise CvcError(
            "Some referenced files aren't in the vault; add them to this check-in",
            code="missing_references",
            missing=missing,
        )
    if unlinked:
        raise CvcError(
            f"{', '.join(unlinked)} {'doesn' if len(unlinked) == 1 else 'don'}'t show a part or assembly in the "
            "vault. Check drawings in from SolidWorks, with the CVC add-in: it records what each drawing shows.",
            code="drawing_without_model",
            drawings=unlinked,
        )
    if misnamed:
        first = misnamed[0]
        model = first["shows"].rsplit("/", 1)[-1]
        stem = model.rsplit(".", 1)[0]
        raise CvcError(
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
        raise CvcError(f"v{number} is already the latest version of {path}", code="bad_version")
    if not 1 <= number < file.latest_version:
        raise CvcError(f"{path} has no version {number}", code="bad_version")
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


def delete(db: Session, user: User, refs: list[FileRef], *, force: bool = False) -> list[FileView]:
    """Move files to the trash (restorable). Refuses files other files still use, unless force."""
    seq = begin_write(db)
    tree, access = _context(db, user)
    files = _resolve_many(db, tree, access, refs)
    for file in files:
        access.require(file.folder_id, Role.EDITOR, f"delete {tree.file_path(file)}")
        if file.checked_out_by not in (None, user.id):
            lock = _lock_json(db, tree, file)
            raise Conflict(f"{lock['path']} is checked out by {lock['user']}", code="checked_out", files=[lock])
    if not force:
        deleting = {f.id for f in files}
        in_use = [
            {"path": tree.file_path(file), "used_by": tree.file_path(parent)}
            for file in files
            for parent, _, _ in _parents(db, file.id)
            if parent.id not in deleting
        ]
        if in_use:
            parents = ", ".join(sorted({u["used_by"] for u in in_use}))
            raise Conflict(f"Still used by {parents}", code="in_use", used_by=in_use)
    now = utcnow()
    for file in files:
        file.deleted_at, file.deleted_by = now, user.id
        _clear_lock(file)
        file.change_seq = seq
        _event(db, user, "delete", file=file, path=tree.file_path(file))
    db.commit()
    views = _views_by_id(db, tree, access, files)
    return [views[f.id] for f in files]


def restore(db: Session, user: User, file_id: int) -> FileView:
    """Bring a deleted file back, with its full history."""
    seq = begin_write(db)
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id, deleted_ok=True)
    path = tree.file_path(file)
    access.require(file.folder_id, Role.EDITOR, f"restore {path}")
    if file.deleted_at is not None:
        folder = tree.by_id[file.folder_id]
        if _live_file(db, folder, file.name) is not None or file.name_key in tree.children[folder.id]:
            raise Conflict(f"Something else is at {path} now; move it out of the way first", code="exists")
        file.deleted_at = file.deleted_by = None
        file.change_seq = seq
        _event(db, user, "restore", file=file, path=path)
        db.commit()
    return _views_by_id(db, tree, access, [file])[file.id]


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


# --- people and permissions -------------------------------------------------------------


def _require_admin(user: User) -> None:
    if not user.is_admin:
        raise Forbidden("Only admins can do that", code="admin_only")


def list_users(db: Session, user: User) -> list[User]:
    """Admins see every account; everyone else sees active members (to grant access, say)."""
    stmt = select(User).order_by(User.name, User.email)
    if not user.is_admin:
        stmt = stmt.where(User.status == UserStatus.ACTIVE)
    return list(db.scalars(stmt))


def invite_user(db: Session, admin: User, email: str, name: str = "") -> User:
    """Pre-approve an email: the account is active from its first Google sign-in."""
    _require_admin(admin)
    email = email.strip().lower()
    if not _EMAIL.match(email):
        raise CvcError(f"{email!r} isn't an email address", code="bad_email")
    begin_write(db)
    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise Conflict(f"{email} already has an account", code="exists")
    user = User(email=email, name=name.strip(), status=UserStatus.INVITED)
    db.add(user)
    _event(db, admin, "invite_user", email=email)
    db.commit()
    return user


def update_user(
    db: Session,
    admin: User,
    user_id: int,
    *,
    status: UserStatus | None = None,
    is_admin: bool | None = None,
    name: str | None = None,
) -> User:
    """Approve or disable an account, make or unmake an admin, fix a name."""
    _require_admin(admin)
    seq = begin_write(db)
    user = db.get(User, user_id)
    if user is None:
        raise NotFound(f"User {user_id} not found")
    if user.id == admin.id and (status not in (None, UserStatus.ACTIVE) or is_admin is False):
        raise CvcError("You can't disable yourself or drop your own admin rights", code="self_lockout")
    changes: dict[str, Any] = {}
    if status is not None and status != user.status:
        if status not in (UserStatus.ACTIVE, UserStatus.DISABLED):
            raise CvcError("An account can be set active or disabled", code="bad_status")
        user.status = status
        changes["status"] = status.value
    if is_admin is not None and is_admin != user.is_admin:
        user.is_admin = is_admin
        changes["is_admin"] = is_admin
    if name is not None and name.strip() != user.name:
        user.name = name.strip()
        changes["name"] = user.name
    if changes:
        _bump_access(db, seq)
        _event(db, admin, "update_user", email=user.email, **changes)
    db.commit()
    return user


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
