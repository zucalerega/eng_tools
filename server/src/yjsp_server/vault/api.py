"""Vault API: browse, history, download, check out/in, delete/restore, move/rename, sync, uploads, and who has access
to each folder."""

import hashlib
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from ..api.deps import DB, ActiveUser, Config
from ..errors import ApiError, Forbidden, TooLarge
from . import vault
from .schemas import (
    CheckinIn,
    CheckinOut,
    CheckoutIn,
    DeletedOut,
    DeleteIn,
    EventOut,
    FileDetailOut,
    FileOut,
    FilesIn,
    FilesOut,
    FolderIn,
    FolderOut,
    GrantIn,
    GrantsOut,
    ListingOut,
    MovedOut,
    MoveIn,
    RenameIn,
    RevertIn,
    SyncOut,
)
from .storage import SHA256, BlobStore

router = APIRouter(prefix="/api", tags=["vault"])


def get_store(request: Request) -> BlobStore:
    return request.app.state.vault_store


Store = Annotated[BlobStore, Depends(get_store)]


@router.get("/folders")
def get_folder(user: ActiveUser, db: DB, path: str = "", deleted: bool = False) -> ListingOut:
    """A folder's subfolders and files. deleted=true lists its trash instead: the folders and files deleted from it."""
    return ListingOut.of(vault.list_folder(db, user, path, deleted=deleted))


@router.post("/folders", status_code=201)
def post_folder(body: FolderIn, user: ActiveUser, db: DB) -> FolderOut:
    return FolderOut.of(vault.create_folder(db, user, body.path))


@router.get("/files/{file_id}")
def get_file(file_id: int, user: ActiveUser, db: DB) -> FileDetailOut:
    """A file with its version history (newest first) and the files that use it."""
    return FileDetailOut.of(vault.file_detail(db, user, file_id))


@router.get("/files/{file_id}/content", response_class=FileResponse)
def get_content(file_id: int, user: ActiveUser, db: DB, store: Store, version: int | None = None) -> FileResponse:
    """Download a version (default: the latest)."""
    file, found = vault.version_content(db, user, file_id, version)
    headers = {"X-Vault-Version": str(found.number), "X-Vault-SHA256": found.blob_sha256}
    return FileResponse(
        store.path(found.blob_sha256), filename=file.name, media_type="application/octet-stream", headers=headers
    )


@router.post("/checkout")
def post_checkout(body: CheckoutIn, user: ActiveUser, db: DB) -> FilesOut:
    return FilesOut.of(vault.checkout(db, user, body.files, body.host, force=body.force))


@router.post("/files/{file_id}/revert")
def post_revert(file_id: int, body: RevertIn, user: ActiveUser, db: DB) -> FileOut:
    """Make an older version the latest again (a new version with its contents)."""
    return FileOut.of(
        vault.revert(db, user, file_id, body.version, comment=body.comment, host=body.host, force=body.force)
    )


@router.post("/undo-checkout")
def post_undo_checkout(body: FilesIn, user: ActiveUser, db: DB) -> FilesOut:
    return FilesOut.of(vault.undo_checkout(db, user, body.files))


@router.post("/checkin")
def post_checkin(body: CheckinIn, user: ActiveUser, db: DB) -> CheckinOut:
    items = [
        vault.CheckinItem(i.path, i.sha256, i.size, [vault.Reference(r.path, r.version) for r in i.references])
        for i in body.items
    ]
    result = vault.checkin(
        db, user, items, comment=body.comment, host=body.host, keep_checked_out=body.keep_checked_out
    )
    return CheckinOut.of(result)


@router.post("/delete")
def post_delete(body: DeleteIn, user: ActiveUser, db: DB) -> DeletedOut:
    """Move files, and folders with everything in them, to the trash (GET /api/folders?deleted=true)."""
    return DeletedOut.of(vault.delete(db, user, body.files, folders=body.folders, force=body.force))


@router.post("/files/{file_id}/restore")
def post_restore(file_id: int, user: ActiveUser, db: DB) -> FileOut:
    """Bring a deleted file back (and its folder, if that was deleted too)."""
    return FileOut.of(vault.restore(db, user, file_id))


@router.post("/folders/{folder_id}/restore")
def post_restore_folder(folder_id: int, user: ActiveUser, db: DB) -> FolderOut:
    """Bring a deleted folder back, with everything deleted along with it."""
    return FolderOut.of(vault.restore_folder(db, user, folder_id))


@router.post("/move")
def post_move(body: MoveIn, user: ActiveUser, db: DB) -> MovedOut:
    """Move files and folders into a folder; what SolidWorks files use has to stay findable."""
    return MovedOut.of(vault.move(db, user, files=body.files, folders=body.folders, to=body.to))


@router.post("/rename")
def post_rename(body: RenameIn, user: ActiveUser, db: DB) -> MovedOut:
    """Rename a file (keeping its type) or a folder."""
    return MovedOut.of(vault.rename(db, user, file=body.file, folder=body.folder, name=body.name))


@router.get("/checkouts")
def get_checkouts(user: ActiveUser, db: DB, mine: bool = False) -> FilesOut:
    """Who has what checked out, on which computer."""
    return FilesOut.of(vault.checkouts(db, user, mine=mine))


@router.get("/sync")
def get_sync(user: ActiveUser, db: DB, since: int = 0) -> SyncOut:
    """Changes since a previous sync's seq (everything when since=0)."""
    return SyncOut.of(vault.sync(db, user, since))


@router.get("/activity")
def get_activity(
    user: ActiveUser, db: DB, limit: int = 100, before: int | None = None, file_id: int | None = None
) -> list[EventOut]:
    """Recent events, newest first. Page with before=<id of the last event you have>."""
    return [EventOut.of(e) for e in vault.activity(db, user, limit=limit, before=before, file_id=file_id)]


@router.get("/grants")
def get_grants(user: ActiveUser, db: DB, path: str = "") -> GrantsOut:
    """Who has access to a folder, including grants inherited from the folders above it."""
    return GrantsOut.of(*vault.folder_grants(db, user, path))


@router.put("/grants")
def put_grant(body: GrantIn, user: ActiveUser, db: DB) -> GrantsOut:
    """Set (or with role=null, remove) a person's or everyone's role on a folder (leads and admins)."""
    vault.set_grant(db, user, body.path, user_id=body.user_id, role=body.role)
    return GrantsOut.of(*vault.folder_grants(db, user, body.path))


def _check_sha(sha256: str) -> None:
    if not SHA256.fullmatch(sha256):
        raise ApiError("Blobs are named by their SHA-256, as 64 lowercase hex digits", code="bad_sha256")


@router.head("/blobs/{sha256}")
def head_blob(sha256: str, user: ActiveUser, db: DB) -> Response:
    """200 if the server already has these contents (skip the upload), else 404."""
    _check_sha(sha256)
    size = vault.blob_size(db, sha256)
    if size is None:
        return Response(status_code=404)
    return Response(status_code=200, headers={"X-Vault-Size": str(size)})


@router.put("/blobs/{sha256}")
async def put_blob(
    sha256: str, request: Request, user: ActiveUser, db: DB, store: Store, settings: Config
) -> JSONResponse:
    """Upload file contents as the raw request body. The server verifies the SHA-256."""
    _check_sha(sha256)
    if not await run_in_threadpool(vault.can_upload, db, user):
        raise Forbidden("You need editor access somewhere to upload files", code="forbidden")
    limit = settings.max_upload_mb * 1024 * 1024
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise TooLarge(f"Files over {settings.max_upload_mb} MB aren't accepted")
    if store.exists(sha256):
        size = store.path(sha256).stat().st_size
        await run_in_threadpool(vault.register_blob, db, sha256, size)
        return JSONResponse({"sha256": sha256, "size": size, "stored": False})

    temp = store.temp_path()
    try:
        digest, size = hashlib.sha256(), 0
        with temp.open("wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise TooLarge(f"Files over {settings.max_upload_mb} MB aren't accepted")
                digest.update(chunk)
                out.write(chunk)
        if digest.hexdigest() != sha256:
            raise ApiError(
                "The upload doesn't match its SHA-256; it was damaged on the way, so try again", code="hash_mismatch"
            )
        store.commit(sha256, temp)
    finally:
        temp.unlink(missing_ok=True)
    await run_in_threadpool(vault.register_blob, db, sha256, size)
    return JSONResponse({"sha256": sha256, "size": size, "stored": True}, status_code=201)
