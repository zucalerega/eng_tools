"""Vault operations: folders, check-out/check-in, history, deletion, permissions, sync.

Independent of HTTP so they can be tested and reused directly. Each function
takes the acting user and checks permissions through Access. Every mutating
function starts with begin_write(); read its docstring before adding one.
"""

import hashlib
import re
import threading
import unicodedata
from collections import OrderedDict, defaultdict
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
from . import caliper, numbers, paths, solidworks
from .access import Access, Tree
from .models import (
    Applies,
    Blob,
    CaliperModel,
    Checkin,
    Event,
    File,
    Folder,
    FormerName,
    Grant,
    Numbering,
    PartKind,
    PartNumber,
    Role,
    VaultState,
    Version,
    VersionRef,
)
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
    former_names: list[str] = field(default_factory=list)  # _former_names


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
    former = _former_names(db, [f for f, _ in rows])
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
            former.get(f.id, []),
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


def _former_names(db: Session, files: list[File]) -> dict[int, list[str]]:
    """The names each file had before its renames (FormerName), each once, as it was last spelled, in the order the
    file last left them; not its name now, which a move keeps. By file id, for files that had any."""
    had: dict[int, dict[str, str]] = defaultdict(dict)  # by file: names by key, oldest first
    ids = [f.id for f in files]
    for start in range(0, len(ids), _BATCH):
        rows = db.execute(
            select(FormerName.file_id, FormerName.path, FormerName.name_key)
            .where(FormerName.file_id.in_(ids[start : start + _BATCH]))
            .order_by(FormerName.id)
        )
        for file_id, path, key in rows:
            had[file_id].pop(key, None)  # to the end, as the last it left
            had[file_id][key] = path.rsplit("/", 1)[-1]
    found = {f.id: [name for key, name in had[f.id].items() if key != f.name_key] for f in files if f.id in had}
    return {file_id: names for file_id, names in found.items() if names}


# --- finding files ------------------------------------------------------------------------


def _live_file(db: Session, folder: Folder | None, name: str) -> File | None:
    if folder is None:
        return None
    return db.scalar(
        select(File).where(File.folder_id == folder.id, File.name_key == paths.key(name), File.deleted_at.is_(None))
    )


def _find(db: Session, tree: Tree, access: Access, ref: FileRef, *, deleted_ok: bool = False) -> File | None:
    """A file the user can see, by id or path; None for one they can't see, as for one that isn't there."""
    if isinstance(ref, int):
        file = db.get(File, ref)
        if file is not None and file.deleted_at is not None and not deleted_ok:
            file = None
    else:
        names = paths.split(ref)
        file = _live_file(db, tree.find(names[:-1]), names[-1]) if names else None
    return file if file is not None and access.can(file.folder_id, Role.VIEWER) else None


def _resolve(db: Session, tree: Tree, access: Access, ref: FileRef, *, deleted_ok: bool = False) -> File:
    """A file the user can see, by id or path. Files they can't see are 'not found'."""
    file = _find(db, tree, access, ref, deleted_ok=deleted_ok)
    if file is None:
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


def _named(tree: Tree, access: Access, files: list[File]) -> str:
    """Files for a message: the paths of the ones the user can see, then how many others there are ("A.SLDASM and 2
    files you can't see"). Files they can't see go unnamed, but they still count where they're why something can't be
    done, as files that use one being deleted or moved are."""
    shown = sorted({tree.file_path(f) for f in files if access.can(f.folder_id, Role.VIEWER)})
    unseen = len({f.id for f in files if not access.can(f.folder_id, Role.VIEWER)})
    parts = [", ".join(shown)] if shown else []
    if unseen:
        parts.append("a file you can't see" if unseen == 1 else f"{unseen} files you can't see")
    return " and ".join(parts)


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
    """The folder at names, creating any missing folders along the way. Folders the user can't see count as missing
    (Access.deepest), so the answer doesn't say whether one is there."""
    folder, depth = access.deepest(names)
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
    # Only a folder the user can see "exists". One they can't see gets what a free name in the same place gets (from
    # _ensure_folders): that they can't add folders there, which is so, or they'd see it. "Exists" would tell them
    # what's there; that answer tells them nothing they didn't know.
    if access.deepest(names)[1] == len(names):
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
    title: str | None = None  # what it's called (describe); a new file's is otherwise its number's, or its name's
    vendor: bool | None = None  # a vendor's part (describe); a new file's is as its name says (numbers.vendors)
    base_version: int | None = None  # the version its changes start from: refused (out_of_date) if there's a newer one


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


def _state(db: Session) -> VaultState:
    state = db.get(VaultState, 1)
    assert state is not None
    return state


def _holder(db: Session, number: int, kind: str) -> PartNumber | None:
    """The record of a file that has this part number (in the trash or not), if one has it."""
    held = PartNumber.number == number, PartNumber.kind == kind, PartNumber.file_id.is_not(None)
    return db.scalar(select(PartNumber).where(*held).limit(1))


def _part_number(db: Session, name: str, *, file: File | None, vendor: bool, new: bool) -> PartNumber | None:
    """What a file's name (a new file's, or one a file is renamed to) says of its part number, held to the rules
    (docs/vault.md, "Part numbers"): the number it takes, a part's, an assembly's, or a STEP or STL file's own, for
    the caller to give it, or the one it has; None for a name after a number another file has (a drawing's, a PDF's,
    an export's), or a name that's no number.

    Refused: a number not handed out, or someone else's, or of a kind for something else; a part or an assembly named
    by more than its number; a vendor's part named like a number; and a new part, assembly, STEP or STL file without
    one, once they need them (Numbering.REQUIRE).
    """
    numbered = numbers.parse(name)
    if numbered is None:
        needs = new and numbers.holds(name) and _state(db).numbering is Numbering.REQUIRE
        if needs and not (vendor or numbers.vendors(name)):
            raise ApiError(
                f"{name} needs a part number: start new parts and assemblies with New, in the web app or in "
                "SolidWorks, which gives them one; or, for a vendor's part, say it's a vendor's",
                code="part_number_needed",
                name=name,
            )
        return None
    if vendor:
        _check_vendor(name)
    own = numbered.text
    if file is not None:
        mine = db.scalar(select(PartNumber).where(PartNumber.file_id == file.id))
        if mine is not None and (mine.number, mine.kind) == (numbered.number, numbered.kind):
            return mine
    holder = _holder(db, numbered.number, numbered.kind)
    if numbers.holds(name) and numbered.exact and holder is None:
        # It takes the number: one handed out and not yet used, of a kind for what it is.
        unused = db.scalar(
            select(PartNumber).where(
                PartNumber.number == numbered.number,
                PartNumber.kind == numbered.kind,
                PartNumber.legacy.is_(False),
                PartNumber.file_id.is_(None),
                PartNumber.released_at.is_(None),
            )
        )
        if unused is None:
            raise ApiError(
                f"{own} wasn't handed out: get a part number with New, in the web app or in SolidWorks",
                code="unknown_part_number",
                name=name,
            )
        kind = db.get(PartKind, numbered.kind)
        if kind is None or not numbers.fits(kind.applies, name):
            what = "an assembly" if numbers.applies_to(name) == "assembly" else "a part"
            raise ApiError(
                f"{own} was handed out for {kind.label if kind else 'something else'}, so it can't be {what}'s",
                code="bad_part_number",
                name=name,
            )
        return unused
    if numbers.holds(name) and not numbers.exports(name):
        if not numbered.exact:
            raise ApiError(
                f"Call it {own}{name[len(paths.stem(name)) :]}: a part's or an assembly's name is its number, and "
                "its title says what it is",
                code="bad_part_number",
                name=name,
            )
        # Another file has it (where the user may not see it: the number says no more than that).
        raise Conflict(
            f"{own} is another file's part number: a part or an assembly takes a number of its own",
            code="part_number_taken",
            name=name,
        )
    if holder is None:
        raise ApiError(
            f"No part or assembly has {own}: a drawing, a PDF, or an export is named after the number of what it's "
            "of, once that's in the vault",
            code="unknown_part_number",
            name=name,
        )
    return None


def _taking_order(name: str) -> int:
    """Parts and assemblies take their part numbers first, then STEP and STL files, so that the drawings, PDFs and
    exports named after them in the same check-in find who has their numbers (_part_number)."""
    if numbers.holds(name):
        return 1 if numbers.exports(name) else 0
    return 2


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
    in the vault already, where the user can see them, or in this check-in, and
    are pinned to the version used.
    A file whose contents didn't change gets no new version but is still
    released, unless keep_checked_out is set; if it had no references
    recorded and now has some, it gets a version to record them.
    A new file's name is held to the rules of part numbers (_part_number): a
    part named by a number handed out takes it.
    """
    host = _host(host)
    if not items:
        raise ApiError("Nothing to check in")
    seq = begin_write(db)
    tree, access = _context(db, user)
    now = utcnow()

    planned: list[tuple[CheckinItem, list[str], File | None, str | None]] = []
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
        # A file or folder the user can't see is as good as not there: checking one in answers as adding a new file
        # there would (refused: see Access.deepest).
        existing = _find(db, tree, access, path)
        if existing is not None:
            access.require(existing.folder_id, Role.EDITOR, f"check in {path}")
            _require_own_lock(db, tree, existing, user, host)
            if item.vendor:
                _check_vendor(existing.name)
            if item.base_version is not None and item.base_version != existing.latest_version:
                raise Conflict(
                    f"{path} is at v{existing.latest_version} now, not v{item.base_version}, which these changes "
                    "start from: get its latest version and make them again there",
                    code="out_of_date",
                    path=path,
                    version=existing.latest_version,
                )
        else:
            parent, depth = access.deepest(names[:-1])
            access.require(parent.id, Role.EDITOR, f"add files to {tree.label(parent.id)}")
            if depth == len(names) - 1 and paths.key(names[-1]) in tree.children[parent.id]:
                raise Conflict(f"{path} is a folder", code="exists", path=path)
        planned.append((item, names, existing, None if item.title is None else _title(item.title, path)))

    record: Checkin | None = None

    def checkin_id() -> int:
        nonlocal record
        if record is None:
            record = Checkin(user_id=user.id, host=host, comment=comment.strip(), created_at=now)
            db.add(record)
            db.flush()
        return record.id

    done: dict[str, tuple[CheckinStatus, File, Version, CheckinItem]] = {}
    for item, names, existing, title in sorted(planned, key=lambda plan: _taking_order(plan[1][-1])):
        status: CheckinStatus
        version: Version | None = None
        if existing is None:
            folder = _ensure_folders(db, tree, access, user, names[:-1], seq)
            vendor = numbers.vendors(names[-1]) if item.vendor is None else item.vendor
            number = _part_number(db, names[-1], file=None, vendor=vendor, new=True)
            file = File(
                folder_id=folder.id,
                name=names[-1],
                name_key=paths.key(names[-1]),
                # Until someone names it (describe): what its number was handed out to be called, or its name.
                title=title or (number.title if number is not None and number.title else paths.stem(names[-1])),
                vendor=vendor,
                latest_version=1,
                created_at=now,
                created_by=user.id,
            )
            db.add(file)
            db.flush()
            if number is not None:
                number.file_id = file.id
                db.flush()
            status = "created"
        else:
            file = existing
            _describe(db, user, tree, file, title, item.vendor)
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
    done = {key: done[key] for key in (paths.key(paths.join(*names)) for _, names, _, _ in planned)}  # as they came

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
                # A file the user can't see is missing, as one that isn't there is: they can't use it, and whether
                # it's there, or which versions it has, stays hidden.
                child = _find(db, tree, access, ref.path)
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
            (file, parent)
            for file in files.values()
            for parent, _, _ in _parents(db, file.id)
            if parent.id not in files
        ]
        if in_use:
            raise Conflict(
                f"Still used by {_named(tree, access, [parent for _, parent in in_use])}",
                code="in_use",
                used_by=[
                    {"path": tree.file_path(file), "used_by": tree.file_path(parent)}
                    for file, parent in in_use
                    if access.can(parent.folder_id, Role.VIEWER)
                ],
            )

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


def _check_moves(db: Session, tree: Tree, access: Access, moves: dict[int, tuple[str, str]]) -> None:
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
    broken: list[tuple[str, File]] = []  # a moving file's path, and a file using it that wouldn't find it
    for file_id, (old, new) in moves.items():
        for user_file, _, _ in _parents(db, file_id):
            user_old = tree.file_path(user_file)
            user_new = moves.get(user_file.id, (user_old, user_old))[1]
            if not _still_found(old, new, user_old, user_new):
                broken.append((old, user_file))
    if broken:
        first = broken[0][0]
        raise Conflict(
            f"{first} is used by {_named(tree, access, [u for path, u in broken if path == first])}, and SolidWorks "
            "wouldn't find it after this. Keep a file where the files that use it can find it: in their folder, or "
            "where it was next to them (move their folder together). To rename it, rename it in SolidWorks, then "
            "check both in.",
            code="in_use",
            used_by=[
                {"path": path, "used_by": tree.file_path(u)}
                for path, u in broken
                if access.can(u.folder_id, Role.VIEWER)
            ],
        )


def _remember(db: Session, user: User, moves: dict[int, tuple[str, str]]) -> None:
    """Keep where moving files were (FormerName): SolidWorks files saved with them there still name them so."""
    now = utcnow()
    for file_id, (old, new) in moves.items():
        if paths.key(old) != paths.key(new):  # a change of case changes nothing to find a file by
            name_key = paths.key(old.rsplit("/", 1)[-1])
            db.add(FormerName(file_id=file_id, path=old, name_key=name_key, changed_at=now, changed_by=user.id))


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
    _check_moves(db, tree, access, moves)
    _remember(db, user, moves)

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


def _renumbered(db: Session, file: File, name: str) -> PartNumber | None:
    """The part number a file renamed so has (_part_number), held to the rule that a part number never changes: a
    file that has one keeps it, in its name. Ground Structures' numbers from before (legacy) may have more after them
    in their names, which can change."""
    mine = db.scalar(select(PartNumber).where(PartNumber.file_id == file.id))
    if mine is not None:
        numbered = numbers.parse(name)
        if (
            numbered is None
            or (numbered.number, numbered.kind) != (mine.number, mine.kind)
            or not (mine.legacy or numbered.exact)
        ):
            raise Conflict(
                f"{file.name} is named by its part number, {numbers.text(mine.number, mine.kind)}, which never "
                "changes: to say what it is, change its title instead",
                code="part_number_fixed",
                name=file.name,
            )
    return _part_number(db, name, file=file, vendor=file.vendor, new=False)


def _check_drawing_name(db: Session, drawing: File, name: str) -> None:
    """A drawing renamed stays named after a part or assembly it shows, as a check-in has it (checkin)."""
    if not paths.is_drawing(name):
        return
    latest = _version(db, drawing.id, drawing.latest_version)
    shows = [child for child, _ in _refs_of(db, latest) if paths.is_model(child.name)]
    if shows and not any(paths.named_after(name, model.name) for model in shows):
        stem = paths.stem(shows[0].name)
        raise ApiError(
            f"Name {drawing.name} after what it shows, {shows[0].name}, so they stay together: {stem}.SLDDRW, or "
            f'something that starts with its name, like "{stem} - machining.SLDDRW".',
            code="drawing_name",
            name=name,
        )


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
        number = _renumbered(db, target, new_name)
        _check_drawing_name(db, target, new_name)
        parent = tree.by_id[target.folder_id]
        if _taken(db, tree, parent, new_name, target):
            raise Conflict(f"{paths.join(tree.path(parent.id), new_name)} is taken", code="exists")
        new = paths.join(tree.path(parent.id), new_name)
        paths.split(new)
        moves[target.id] = (old, new)
        _check_moves(db, tree, access, moves)
        _remember(db, user, moves)
        _event(db, user, "rename", file=target, path=new, moved_from=old)
        target.name, target.name_key = new_name, paths.key(new_name)
        if number is not None:
            number.file_id = target.id
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
    _check_moves(db, tree, access, moves)
    _remember(db, user, moves)
    _event(db, user, "rename_folder", folder_id=renamed.id, path=new_base, moved_from=old_base)
    renamed.name, renamed.name_key = new_name, paths.key(new_name)
    db.flush()
    return _finish_move(db, user, seq, [], [renamed])


_TITLE_MAX = 200  # files.title's size


def _title(title: str, path: str) -> str:
    """A title as it's kept, trimmed; refused if it says nothing, runs long, or has a tab, a line break or another
    control character, which lists can't show."""
    title = unicodedata.normalize("NFC", title).strip()
    if not title:
        raise ApiError(f"Say what {path} is called", code="bad_title", path=path)
    if len(title) > _TITLE_MAX:
        raise ApiError(f"{path}'s title is longer than {_TITLE_MAX} characters", code="bad_title", path=path)
    if any(unicodedata.category(c) == "Cc" for c in title):
        raise ApiError(f"{path}'s title has a tab or a line break in it", code="bad_title", path=path)
    return title


@dataclass
class Description:
    file: FileRef
    title: str | None = None  # what it's called; None leaves it
    vendor: bool | None = None  # whether it's a vendor's part, which keeps the vendor's name; None leaves it


def describe(db: Session, user: User, changes: list[Description]) -> list[FileView]:
    """Say what files are called (their titles) and which are vendors' parts, all or nothing.

    Neither is in the file, so neither makes a version or needs a check-out (someone else's is fine). It takes
    editor access to the file's folder, as a rename does.
    """
    if not changes:
        raise ApiError("Say which files to describe")
    seq = begin_write(db)
    tree, access = _context(db, user)
    planned: list[tuple[File, str | None, bool | None]] = []
    seen: set[int] = set()
    for change in changes:
        file = _resolve(db, tree, access, change.file)
        path = tree.file_path(file)
        if file.id in seen:
            raise ApiError(f"{path} is listed twice")
        seen.add(file.id)
        what = f"name {path}" if change.title is not None else f"say whose part {path} is"
        access.require(file.folder_id, Role.EDITOR, what)
        if change.vendor:
            _check_vendor(file.name)
        planned.append((file, None if change.title is None else _title(change.title, path), change.vendor))

    for file, title, vendor in planned:
        if _describe(db, user, tree, file, title, vendor):
            file.change_seq = seq
    db.commit()
    views = _views_by_id(db, tree, access, [file for file, _, _ in planned])
    return [views[file.id] for file, _, _ in planned]


def _check_vendor(name: str) -> None:
    if numbers.parse(name) is not None:
        raise ApiError(
            f"{name} is named by a part number, so it isn't a vendor's part", code="bad_part_number", name=name
        )


def _describe(db: Session, user: User, tree: Tree, file: File, title: str | None, vendor: bool | None) -> bool:
    """Give a file a title, or say whether it's a vendor's part, where that changes anything, as the activity log
    says (describe); whether it did. The caller marks the file changed (change_seq)."""
    detail: dict[str, Any] = {}
    if title is not None and title != file.title:
        detail |= {"title": title, "was": file.title}
        file.title = title
    if vendor is not None and vendor != file.vendor:
        detail["vendor"] = file.vendor = vendor
    if detail:
        _event(db, user, "describe", file=file, path=tree.file_path(file), **detail)
    return bool(detail)


# --- part numbers (numbers.py; docs/vault.md, "Part numbers") ---------------------------------------


_MAX_UNUSED = 20  # numbers an editor may have handed out and not yet used; admins any, to number the whole vault
_MAX_AT_ONCE = 10_000


def _require_admin(user: User, what: str) -> None:
    if not user.is_admin:
        raise Forbidden(f"Only admins can {what}")


def _label(label: str) -> str:
    label = unicodedata.normalize("NFC", label).strip()
    if not label or len(label) > 100 or any(unicodedata.category(c) == "Cc" for c in label):
        raise ApiError("Say what a kind is in a line of at most 100 characters", code="bad_kind")
    return label


def numbering(db: Session) -> tuple[Numbering, int]:
    """Whether new files take part numbers, and the next number to hand out."""
    state = _state(db)
    return state.numbering, state.next_number


def set_numbering(
    db: Session, user: User, *, mode: Numbering | None = None, next_number: int | None = None
) -> tuple[Numbering, int]:
    """An admin turns part numbers on or off for new files, or moves the next number on. Numbers only go up, so none
    is ever handed out twice."""
    begin_write(db)
    _require_admin(user, "change how part numbers are handed out")
    state = _state(db)
    detail: dict[str, Any] = {}
    if next_number is not None and next_number != state.next_number:
        if next_number < state.next_number or next_number > numbers.LARGEST:
            raise ApiError(
                f"Part numbers only go up: the next can be {numbers.digits(state.next_number)} or later",
                code="bad_next_number",
            )
        detail["next_number"] = state.next_number = next_number
    if mode is not None and mode is not state.numbering:
        state.numbering = mode
        detail["numbering"] = mode.value
    if detail:
        _event(db, user, "numbering", **detail)
    db.commit()
    return numbering(db)


def part_kinds(db: Session) -> list[PartKind]:
    """The kinds of part numbers, retired ones too (their numbers keep them), by code."""
    return list(db.scalars(select(PartKind).order_by(PartKind.code)))


def add_part_kind(db: Session, user: User, code: str, label: str, applies: Applies) -> PartKind:
    """An admin adds a kind to the list: 002 Sheet metal part, for parts."""
    begin_write(db)
    _require_admin(user, "change the kinds of part numbers")
    if not numbers.is_kind(code):
        raise ApiError(f"A kind is three digits, like 001, not {code}", code="bad_kind")
    there = db.get(PartKind, code)
    if there is not None:
        raise Conflict(f"{code} is {there.label} already", code="exists")
    kind = PartKind(code=code, label=_label(label), applies=applies, created_at=utcnow(), created_by=user.id)
    db.add(kind)
    _event(db, user, "part_kind", code=code, label=kind.label, applies=applies.value, retired=False)
    db.commit()
    return kind


def change_part_kind(
    db: Session,
    user: User,
    code: str,
    *,
    label: str | None = None,
    applies: Applies | None = None,
    retired: bool | None = None,
) -> PartKind:
    """An admin renames a kind, retires it (no new numbers of it are handed out) or brings it back, or says what it's
    for, while no file has a number of it. A kind is never deleted: the numbers handed out keep it."""
    begin_write(db)
    _require_admin(user, "change the kinds of part numbers")
    kind = db.get(PartKind, code)
    if kind is None:
        raise NotFound(f"There's no kind {code}")
    if applies is not None and applies is not kind.applies:
        if _holder_of_kind(db, code):
            raise Conflict(
                f"Files have numbers of {code} already, so it stays a kind of {kind.applies.value}",
                code="kind_in_use",
            )
        kind.applies = applies
    if label is not None:
        kind.label = _label(label)
    if retired is not None:
        kind.retired = retired
    _event(db, user, "part_kind", code=code, label=kind.label, applies=kind.applies.value, retired=kind.retired)
    db.commit()
    return kind


def _holder_of_kind(db: Session, code: str) -> bool:
    held = PartNumber.kind == code, PartNumber.file_id.is_not(None)
    return db.scalar(select(PartNumber.id).where(*held).limit(1)) is not None


def reserve_numbers(db: Session, user: User, kind: str, *, count: int = 1, title: str = "") -> list[PartNumber]:
    """Hand out the next part numbers, in order, of a kind: the web app's and the add-in's New, and the vault's
    renumbering. A file checked in named by one takes it (_part_number), with its title if it's given none of its
    own. Editors get them once an admin turns part numbers on, up to _MAX_UNUSED unused at a time; admins any."""
    begin_write(db)
    state = _state(db)
    if not user.is_admin:
        if state.numbering is Numbering.OFF:
            raise Forbidden(
                "Part numbers aren't handed out yet: an admin turns them on (Admin > Part numbers)",
                code="numbering_off",
            )
        if not can_upload(db, user):
            raise Forbidden("Part numbers are for new files: you need editor access to a folder to get them")
    found = db.get(PartKind, kind)
    if found is None or found.retired:
        raise ApiError(f"{kind} isn't a kind of part number: pick one from the list", code="bad_kind")
    if not 1 <= count <= _MAX_AT_ONCE:
        raise ApiError(f"Ask for 1 to {_MAX_AT_ONCE} part numbers at a time", code="bad_count")
    titled = _title(title, "A new file") if title.strip() else ""
    if not user.is_admin:
        unused = len(unused_numbers(db, user))
        if unused + count > _MAX_UNUSED:
            raise Conflict(
                f"You have {unused} part numbers you haven't used: use them, or give them back, first",
                code="too_many_numbers",
            )
    first = state.next_number
    if first + count - 1 > numbers.LARGEST:
        raise Conflict("The vault has run out of part numbers", code="numbers_exhausted")
    state.next_number = first + count
    now = utcnow()
    issued = [
        PartNumber(number=n, kind=kind, title=titled, issued_at=now, issued_by=user.id)
        for n in range(first, first + count)
    ]
    db.add_all(issued)
    _event(db, user, "reserve_numbers", first=numbers.text(first, kind), count=count, title=titled)
    db.commit()
    return issued


def unused_numbers(db: Session, user: User) -> list[PartNumber]:
    """The part numbers handed out to someone that no file has yet, and they haven't given back: theirs to use."""
    mine = (
        PartNumber.issued_by == user.id,
        PartNumber.file_id.is_(None),
        PartNumber.released_at.is_(None),
        PartNumber.legacy.is_(False),
    )
    return list(db.scalars(select(PartNumber).where(*mine).order_by(PartNumber.number)))


def release_numbers(db: Session, user: User, texts: list[str]) -> list[PartNumber]:
    """Give back part numbers handed out and not used: no file ever takes them. Your own; an admin, anyone's."""
    begin_write(db)
    now = utcnow()
    released: list[PartNumber] = []
    for text in texts:
        numbered = numbers.parse(text)
        if numbered is None or not numbered.exact:
            raise ApiError(f"{text} isn't a part number, like 00000123-001", code="bad_part_number")
        issued = db.scalar(
            select(PartNumber).where(
                PartNumber.number == numbered.number, PartNumber.kind == numbered.kind, PartNumber.legacy.is_(False)
            )
        )
        if issued is None or (issued.issued_by != user.id and not user.is_admin):
            raise NotFound(f"{numbered.text} isn't one of your part numbers")
        if issued.file_id is not None:
            raise Conflict(f"{numbered.text} is a file's, for good", code="part_number_used")
        if issued.released_at is None:
            issued.released_at = now
            released.append(issued)
    if released:
        _event(db, user, "release_numbers", numbers=[numbers.text(n.number, n.kind) for n in released])
    db.commit()
    return released


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


def _cad_format(name: str) -> Literal["step", "iges"] | None:
    """A STEP or IGES file's format, which Caliper reads in the browser (as web/src/vault/paths.ts has it)."""
    extension = paths.extension(name)
    return "step" if extension in (".step", ".stp") else "iges" if extension in (".iges", ".igs") else None


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


_UPLOADED = 0  # CaliperModel.reader of a model Vault for SolidWorks made


def _gzipped_here(store: BlobStore, sha256: str) -> bool:
    """Whether the server wrote a mesh: Python's gzip names no operating system in its header (255), where .NET's, which
    Vault for SolidWorks writes meshes with, names the one it ran on."""
    try:
        with store.path(sha256).open("rb") as f:
            head = f.read(10)
    except OSError:
        return False
    return len(head) == 10 and head[:2] == b"\x1f\x8b" and head[9] == 255


def _reader(store: BlobStore, model: CaliperModel) -> int:
    """What made a model (CaliperModel.reader). One made before the server noted it is the server's first reader's if
    the server wrote what it carries: a part's mesh; or an assembly's components, none with a color of its own (only
    Vault for SolidWorks gives them one) or a shape the server didn't write. Else it's Vault for SolidWorks'."""
    if model.reader is not None:
        return model.reader
    if model.mesh_sha256 is not None:
        return 1 if _gzipped_here(store, model.mesh_sha256) else _UPLOADED
    for component, _ in _walk(model.components or []):
        if component.get("color") is not None or component.get("opacity", 1) != 1:
            return _UPLOADED
        if component.get("mesh") and not _gzipped_here(store, component["mesh"]):
            return _UPLOADED
    return 1


def _outdated(store: BlobStore, model: CaliperModel) -> bool:
    """Whether an older reader of the server's made a model: it's read again when it's next wanted (make_caliper_model),
    so its version's models aren't listed till then, nor does it count as a part's own model in an assembly. Vault for
    SolidWorks' models stay."""
    return _UPLOADED < _reader(store, model) < solidworks.READER


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


def caliper_models(db: Session, store: BlobStore, user: User, file_id: int) -> list[ModelView]:
    """A file's 3D models for Caliper: each version's, in each configuration, newest version first, and in a version
    the first one made first (the configuration SolidWorks had open). Not a version's that an older reader made any of:
    Caliper then has the server make them again (make_caliper_model)."""
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id, deleted_ok=True)
    rows = db.execute(
        select(CaliperModel, Version.number)
        .join(Version, Version.id == CaliperModel.version_id)
        .where(Version.file_id == file.id)
        .order_by(Version.number.desc(), CaliperModel.id)
    ).all()
    outdated = {number for model, number in rows if _outdated(store, model)}
    rows = [(model, number) for model, number in rows if number not in outdated]
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
    model.units, model.mesh_sha256, model.components, model.reader = units, mesh, components, _UPLOADED
    model.created_at, model.created_by = utcnow(), user.id
    db.commit()
    return ModelView(model, version, user)


_MAX_READ = 1 << 28  # bigger files aren't read for their 3D view here: Vault for SolidWorks makes theirs
# SolidWorks files read at once for their 3D views: each can take a few hundred MB, on a server with 6 GB.
_READING = threading.BoundedSemaphore(2)
_READING_WAIT = 60.0  # seconds a look waits for its turn before it's told to try again
# Why a file couldn't be read, by its contents' SHA-256: a version's bytes never change, so neither does that, and
# reading it again on every look (up to _MAX_READ, a moment's work) would let a few clicks keep the server busy.
_UNREADABLE: OrderedDict[str, str] = OrderedDict()
_UNREADABLE_KEPT = 1000


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


def _by_path[T](names: list[str], same: list[tuple[str, File, T]], least: int = 0) -> tuple[File, T] | None:
    """Of files with a component's name, where they are or were (a vault path each), the one whose path ends most like
    the one SolidWorks saved for it (names), if at least `least` of their names agree; none when two end alike."""
    mine = [paths.key(name) for name in names]
    best: dict[int, tuple[int, File, T]] = {}  # by file: how many names agree, where most do
    for path, file, value in same:
        theirs = [paths.key(name) for name in path.split("/")]
        n = 0
        while n < min(len(theirs), len(mine)) and theirs[-1 - n] == mine[-1 - n]:
            n += 1
        if file.id not in best or n > best[file.id][0]:
            best[file.id] = (n, file, value)
    ranked = sorted(best.values(), key=lambda found: found[0], reverse=True)
    if not ranked or ranked[0][0] < least or (len(ranked) > 1 and ranked[0][0] == ranked[1][0]):
        return None
    return ranked[0][1], ranked[0][2]


class _Finder:
    """Which file a component of an assembly's version is, by the path SolidWorks saved for it: one of the version's
    references with its name, now or before a rename (FormerName); else, as versions from the web app and from Kenesto
    reference nothing, the vault's file with its name in a folder of its folder's name (not deleted: a name alone, as
    STEP imports' SOLID-1, could be any file's), or the one that was there before a rename, at the version it had when
    the assembly's version was made, or its first. A file there now comes first, as SolidWorks would open it."""

    def __init__(self, db: Session, tree: Tree, when: datetime) -> None:
        self._db, self._tree, self._when = db, tree, when
        self._named: dict[str, list[File]] = {}
        self._had: dict[str, list[tuple[str, File]]] = {}  # files that had a name, with where they had it

    def _former(self, key: str) -> list[tuple[str, File]]:
        if key not in self._had:
            had = select(FormerName.path, File).join(File, File.id == FormerName.file_id)
            self._had[key] = [(path, file) for path, file in self._db.execute(had.where(FormerName.name_key == key))]
        return self._had[key]

    def file_of(self, path: str, refs: list[tuple[File, int]]) -> tuple[File, int] | None:
        names = [name for name in re.split(r"[\\/]", path) if name]
        if not names:
            return None
        key = paths.key(names[-1])
        used = {file.id: version for file, version in refs}
        theirs = [(self._tree.file_path(file), file, version) for file, version in refs if file.name_key == key]
        theirs += [(where, file, used[file.id]) for where, file in self._former(key) if file.id in used]
        found = _by_path(names, theirs)
        if found is not None:
            return found
        if key not in self._named:
            alive = select(File).where(File.name_key == key, File.deleted_at.is_(None))
            self._named[key] = list(self._db.scalars(alive))
        least = min(2, len(names))
        named = _by_path(names, [(self._tree.file_path(file), file, 0) for file in self._named[key]], least)
        if named is None:
            had = [(where, file, 0) for where, file in self._former(key) if file.deleted_at is None]
            named = _by_path(names, had, least)
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


def _read_solidworks(
    store: BlobStore, sha256: str, kind: str, name: str
) -> solidworks.Part | list[solidworks.Assembly]:
    """A SolidWorks file's 3D view (solidworks.py), read a couple at a time; one that can't be, refused (Unreadable)
    at once from then on."""
    if sha256 in _UNREADABLE:
        raise solidworks.Unreadable(f"{name}: {_UNREADABLE[sha256]}")
    if not _READING.acquire(timeout=_READING_WAIT):
        raise Conflict("The server is reading other SolidWorks files: try again in a minute", code="busy")
    try:
        data = store.path(sha256).read_bytes()
        return solidworks.read_part(data) if kind == "part" else solidworks.read_assembly(data)
    except solidworks.Unreadable as e:
        _UNREADABLE[sha256] = e.message
        while len(_UNREADABLE) > _UNREADABLE_KEPT:
            _UNREADABLE.popitem(last=False)
        raise solidworks.Unreadable(f"{name}: {e.message}") from e
    finally:
        _READING.release()


def _kept(components: list[solidworks.Component]) -> Iterator[solidworks.Component]:
    """The virtual parts that an assembly's own file keeps: its own, and its virtual sub-assemblies'."""
    for component in components:
        if component.virtual and component.children:
            yield from _kept(component.children)
        elif component.virtual:
            yield component


# The shapes of the virtual parts a file keeps, by their names from its components down.
_Kept = dict[tuple[str, ...], list[caliper.MeshBody] | None]


def _kept_shapes(components: list[solidworks.Component], above: tuple[str, ...] = ()) -> _Kept:
    shapes: _Kept = {}
    for component in components:
        if component.virtual and component.children:
            shapes |= _kept_shapes(component.children, (*above, component.name))
        elif component.virtual:
            shapes[(*above, component.name)] = component.shape
    return shapes


def _graft(components: list[solidworks.Component], shapes: _Kept, above: tuple[str, ...] = ()) -> None:
    """Give virtual parts without shapes the ones the file that keeps them has."""
    for component in components:
        if component.virtual and component.children:
            _graft(component.children, shapes, (*above, component.name))
        elif component.virtual and component.shape is None:
            component.shape = shapes.get((*above, component.name))


def _kept_in(store: BlobStore, version: Version, configuration: str, name: str) -> _Kept:
    """The shapes of the virtual parts a sub-assembly keeps in its own file, in a configuration (else the one it was
    saved in): only those, as the rest of what the file has isn't wanted, and a model can read many sub-assemblies.
    None where it can't be read."""
    if version.size > _MAX_READ:
        return {}
    try:
        read = _read_solidworks(store, version.blob_sha256, "assembly", name)
    except solidworks.Unreadable:
        return {}
    made = read if isinstance(read, list) else []
    chosen = next((a for a in made if a.configuration == configuration), made[0] if made else None)
    return _kept_shapes(chosen.components) if chosen is not None else {}


# A model to make, in one configuration: its name, units, and a part's mesh or an assembly's components.
_Wanted = tuple[str, str, str | None, list[dict[str, Any]] | None]


def _read_models(
    db: Session, store: BlobStore, tree: Tree, target: Version, kind: str, name: str
) -> tuple[list[_Wanted], dict[str, int]]:
    """A version's models, read from its file (make_caliper_model), with the blobs made for them and their sizes. The
    configuration SolidWorks had open comes first, as it's the one Caliper shows first. Unreadable says why not."""
    if target.size > _MAX_READ:
        raise solidworks.Unreadable(
            f"{name} is over {_MAX_READ >> 20} MB, too big to read here: make its 3D view in SolidWorks "
            "(Make 3D view, on the Vault tab)"
        )

    # Versions never change, so reading one, which takes a moment, comes before the write lock.
    read = _read_solidworks(store, target.blob_sha256, kind, name)
    kept: dict[str, int] = {}  # blobs made, with their sizes
    wanted: list[_Wanted] = []
    try:
        if isinstance(read, solidworks.Part):
            mesh, size = _keep(store, caliper.write_mesh(read.bodies))
            kept[mesh] = size
            wanted.append((read.configuration[:255], read.units, mesh, None))
        else:
            finder = _Finder(db, tree, target.created_at)
            # The shapes of the virtual parts sub-assemblies keep in their own files, by file, version and
            # configuration.
            theirs: dict[tuple[int, int, str], _Kept] = {}

            def kept_in(sub: File, number: int, configuration: str) -> _Kept:
                key = (sub.id, number, configuration)
                if key not in theirs:
                    name = f"{tree.file_path(sub)} v{number}"
                    theirs[key] = _kept_in(store, _version(db, sub.id, number), configuration, name)
                return theirs[key]

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
                        if any(part.shape is None for part in _kept(component.children)):
                            _graft(component.children, kept_in(*match, component.configuration))
                    children = place(component.children, inner)
                    if match is None and shape is None and not children and not component.virtual:
                        continue  # nothing to show or open; a virtual part says why it shows nothing
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
                            "virtual": component.virtual,
                            "children": children,
                        }
                    )
                return out

            refs = _refs_of(db, target)
            for assembly in read:
                components = place(assembly.components, refs)
                if sum(1 for _ in _walk(components)) > _MAX_COMPONENTS:
                    raise solidworks.Unreadable(f"It has over {_MAX_COMPONENTS} components, more than Caliper shows")
                if components:
                    wanted.append((assembly.configuration[:255], assembly.units, None, components))
            if not wanted:
                raise solidworks.Unreadable(
                    "Caliper found none of its parts in the vault. Make its 3D view in SolidWorks (Make 3D view, on the "
                    "Vault tab)"
                )
    except solidworks.Unreadable as e:
        raise solidworks.Unreadable(f"{name}: {e.message}") from e

    return wanted, kept


def make_caliper_model(db: Session, store: BlobStore, user: User, file_id: int, version: int) -> ModelView:
    """Make a version's 3D model from the 3D view SolidWorks saved in the file itself, or a part's from its solid where
    it saved none (vault/solidworks.py), in the configuration it was saved in: so Caliper shows SolidWorks files that
    Vault for SolidWorks made no model of. A version that has a model keeps it, and that one comes back; but one an
    older reader made (an older release of the server, solidworks.READER) is read again, as reading has improved since,
    and stands until it can be: while the file is unreadable now, or the server busy.

    Anyone who can see the file may, as the model comes from the file. An assembly's components are the files its
    version references, or else the vault's files with their names (_Finder), each with its shape as the assembly
    shows it where SolidWorks saved one; the others show their own models. A virtual part, which an assembly keeps
    inside its file (as SolidWorks Routing does tubes), carries the shape of its solid, from the file that keeps it:
    the assembly's own, or that of a sub-assembly that's a file of its own, read for it. Who sees which is decided when
    it's shown (caliper_assembly)."""
    tree, access = _context(db, user)
    file = _resolve(db, tree, access, file_id, deleted_ok=True)
    path = tree.file_path(file)
    kind = _caliper_kind(file.name)
    if kind is None:
        raise ApiError(f"Caliper's models are of SolidWorks parts and assemblies: {path} isn't one", code="bad_model")
    target = db.scalar(select(Version).where(Version.file_id == file.id, Version.number == version))
    if target is None:
        raise NotFound(f"{path} has no version {version}")

    def view(model: CaliperModel) -> ModelView:
        return ModelView(model, version, _users(db, {model.created_by})[model.created_by])

    models = list(
        db.scalars(select(CaliperModel).where(CaliperModel.version_id == target.id).order_by(CaliperModel.id))
    )
    current = [model for model in models if not _outdated(store, model)]
    if models and len(current) == len(models):
        return view(models[0])
    try:
        wanted, kept = _read_models(db, store, tree, target, kind, f"{path} v{version}")
    except (solidworks.Unreadable, Conflict):
        if not models:
            raise
        return view((current or models)[0])

    begin_write(db)
    tree, access = _context(db, user)
    _resolve(db, tree, access, file_id, deleted_ok=True)  # still theirs to see
    # Any made meanwhile, by this reader or Vault for SolidWorks, stay. An older reader's give way to this one's, and
    # go where it makes no model of their configuration.
    have: dict[str, CaliperModel] = {}
    for model in db.scalars(select(CaliperModel).where(CaliperModel.version_id == target.id)):
        if _outdated(store, model):
            db.delete(model)
        else:
            have[model.configuration] = model
    db.flush()
    for sha, size in kept.items():
        if db.get(Blob, sha) is None:
            db.add(Blob(sha256=sha, size=size, created_at=utcnow()))
    for configuration, units, mesh, components in wanted:
        if configuration not in have:
            have[configuration] = CaliperModel(
                version_id=target.id,
                configuration=configuration,
                units=units,
                mesh_sha256=mesh,
                components=components,
                created_at=utcnow(),
                created_by=user.id,
                reader=solidworks.READER,
            )
            db.add(have[configuration])
            db.flush()  # in order, so the one SolidWorks had open comes first
    db.commit()
    return view(have[wanted[0][0]])


def caliper_assembly(
    db: Session, store: BlobStore, user: User, file_id: int, version: int, configuration: str
) -> AssemblyModel:
    """An assembly's model, with the components the user can see: one of a file they can't see is left out, with
    everything in it, as the rest of the vault leaves out such files. A component whose file's model an older reader
    made has none of its own (model), so Caliper has the server make it again."""
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
            select(Version.file_id, Version.number, CaliperModel)
            .join(Version, Version.id == CaliperModel.version_id)
            .where(Version.file_id.in_(ids[start : start + _BATCH]))
        )
        have.update(
            (file_id, number, model.configuration) for file_id, number, model in rows if not _outdated(store, model)
        )
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
            cad = _cad_format(file.name) if file is not None else None
            children = visible(component.get("children") or [])
            kept.append({**component, "model": own, "kind": kind, "format": cad, "children": children})
        return kept

    components = visible(model.components)
    creator = _users(db, {model.created_by})[model.created_by]
    return AssemblyModel(ModelView(model, version, creator), components, left_out)


def caliper_mesh(
    db: Session, store: BlobStore, user: User, file_id: int, version: int, configuration: str, mesh: str | None = None
) -> str:
    """The blob of a part's mesh; or, given mesh, of a shape an assembly's model carries (a virtual part's), if a
    component the user can see has it."""
    if mesh is not None:
        assembly = caliper_assembly(db, store, user, file_id, version, configuration)
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
