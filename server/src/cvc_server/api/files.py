"""Vault API: browse, history, download, check out/in, delete/restore, sync, and uploads."""

import hashlib

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .. import vault
from ..errors import CvcError, Forbidden, TooLarge
from ..storage import SHA256
from .deps import DB, ActiveUser, Config, Store
from .schemas import (
    CheckinIn,
    CheckinOut,
    CheckoutIn,
    DeleteIn,
    EventOut,
    FileDetailOut,
    FileOut,
    FilesIn,
    FilesOut,
    FolderIn,
    FolderOut,
    ListingOut,
    RevertIn,
    SyncOut,
)

router = APIRouter(prefix="/api", tags=["vault"])


@router.get("/folders")
def get_folder(user: ActiveUser, db: DB, path: str = "", deleted: bool = False) -> ListingOut:
    """A folder's subfolders and files. deleted=true lists its trash instead."""
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
    headers = {"X-CVC-Version": str(found.number), "X-CVC-SHA256": found.blob_sha256}
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
def post_delete(body: DeleteIn, user: ActiveUser, db: DB) -> FilesOut:
    return FilesOut.of(vault.delete(db, user, body.files, force=body.force))


@router.post("/files/{file_id}/restore")
def post_restore(file_id: int, user: ActiveUser, db: DB) -> FileOut:
    return FileOut.of(vault.restore(db, user, file_id))


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


def _check_sha(sha256: str) -> None:
    if not SHA256.fullmatch(sha256):
        raise CvcError("Blobs are named by their SHA-256, as 64 lowercase hex digits", code="bad_sha256")


@router.head("/blobs/{sha256}")
def head_blob(sha256: str, user: ActiveUser, db: DB) -> Response:
    """200 if the server already has these contents (skip the upload), else 404."""
    _check_sha(sha256)
    size = vault.blob_size(db, sha256)
    if size is None:
        return Response(status_code=404)
    return Response(status_code=200, headers={"X-CVC-Size": str(size)})


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
            raise CvcError(
                "The upload doesn't match its SHA-256; it was damaged on the way, so try again", code="hash_mismatch"
            )
        store.commit(sha256, temp)
    finally:
        temp.unlink(missing_ok=True)
    await run_in_threadpool(vault.register_blob, db, sha256, size)
    return JSONResponse({"sha256": sha256, "size": size, "stored": True}, status_code=201)
