"""Vault API: browse, history, download, check out/in, delete/restore, move/rename, sync, uploads, and who has access
to each folder.

Every change to the vault takes ChangingUser, which refuses it from a Vault client older than the oldest admins let make
changes (clients.refuse_old); reads take ActiveUser, so old clients can still read. Caliper's POSTs only read (what's
missing, or the model a file's own 3D view gives), so they're reads too."""

import hashlib
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .. import disk
from ..api.deps import DB, ActiveUser, ChangingUser, Config
from ..errors import ApiError, Forbidden, TooLarge
from . import vault
from .schemas import (
    CaliperAssemblyOut,
    CaliperMakeIn,
    CaliperMissingIn,
    CaliperMissingOut,
    CaliperModelIn,
    CaliperModelOut,
    CaliperModelsOut,
    CaliperWantIn,
    CheckinIn,
    CheckinOut,
    CheckoutIn,
    DeletedOut,
    DeleteIn,
    DrawingOut,
    DrawingPdfIn,
    DrawingPdfOut,
    DrawingsMissingIn,
    DrawingsMissingOut,
    DrawingWantIn,
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
def post_folder(body: FolderIn, user: ChangingUser, db: DB) -> FolderOut:
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


@router.get("/files/{file_id}/caliper")
def get_caliper(file_id: int, user: ActiveUser, db: DB, store: Store) -> CaliperModelsOut:
    """A file's 3D models for Caliper, the web app's 3D viewer: each version's, in each configuration."""
    models = vault.caliper_models(db, store, user, file_id)
    return CaliperModelsOut(models=[CaliperModelOut.of(view) for view in models])


@router.put("/files/{file_id}/caliper")
def put_caliper(file_id: int, body: CaliperModelIn, user: ChangingUser, db: DB, store: Store) -> CaliperModelOut:
    """Save a version's 3D model in one configuration: a part's mesh (upload it first, PUT /api/blobs/{sha256}), or an
    assembly's components. Adding one that's missing takes editor access somewhere; replacing one, to its folder."""
    components = None if body.components is None else [c.model_dump() for c in body.components]
    view = vault.put_caliper_model(
        db,
        store,
        user,
        file_id,
        version=body.version,
        configuration=body.configuration,
        units=body.units,
        mesh=body.mesh,
        components=components,
    )
    return CaliperModelOut.of(view)


@router.post("/files/{file_id}/caliper/make")
def post_caliper_make(file_id: int, body: CaliperMakeIn, user: ActiveUser, db: DB, store: Store) -> CaliperModelOut:
    """Make a version's 3D model from the 3D view SolidWorks saved in the file, in the configuration it was saved in,
    for anyone who can see the file; or the model the version has already. 422 unreadable_file says why not."""
    return CaliperModelOut.of(vault.make_caliper_model(db, store, user, file_id, body.version))


@router.post("/caliper/missing")
def post_caliper_missing(body: CaliperMissingIn, user: ActiveUser, db: DB) -> CaliperMissingOut:
    """Which of these versions, in these configurations, have no 3D model yet: what Vault for SolidWorks makes."""
    wanted = [(m.file_id, m.version, m.configuration) for m in body.models]
    missing = vault.caliper_missing(db, user, wanted)
    return CaliperMissingOut(missing=[CaliperWantIn(file_id=f, version=v, configuration=c) for f, v, c in missing])


@router.get("/files/{file_id}/caliper/assembly")
def get_caliper_assembly(
    file_id: int, user: ActiveUser, db: DB, store: Store, version: int, configuration: str
) -> CaliperAssemblyOut:
    """An assembly's model: its components that you can see, where each is, and whether each has a model of its own."""
    return CaliperAssemblyOut.of(vault.caliper_assembly(db, store, user, file_id, version, configuration))


@router.get("/files/{file_id}/caliper/mesh", response_class=FileResponse)
def get_caliper_mesh(
    file_id: int,
    request: Request,
    user: ActiveUser,
    db: DB,
    store: Store,
    version: int,
    configuration: str,
    mesh: str | None = None,
) -> Response:
    """A part's mesh (vault/caliper.py); or, with mesh=, a shape that an assembly's model carries (a virtual part's).
    It's stored gzip-compressed and sent that way (Content-Encoding: gzip), so browsers unpack it as it comes."""
    sha = vault.caliper_mesh(db, store, user, file_id, version, configuration, mesh)
    # A model can be made again, so ask each time; but the same mesh needn't come again.
    headers = {"ETag": f'"{sha}"', "Cache-Control": "private, no-cache"}
    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)
    headers["Content-Encoding"] = "gzip"
    return FileResponse(store.path(sha), media_type="application/octet-stream", headers=headers)


@router.get("/files/{file_id}/drawing")
def get_drawing(file_id: int, user: ActiveUser, db: DB, store: Store, version: int) -> DrawingOut:
    """A drawing's version, for Caliper: the PDF Vault for SolidWorks made of it, if it made one, and its sheets, each
    with whether SolidWorks saved a picture of it in the file."""
    return DrawingOut.of(vault.drawing_view(db, store, user, file_id, version))


@router.get("/files/{file_id}/drawing/sheet", response_class=Response)
def get_drawing_sheet(
    file_id: int, request: Request, user: ActiveUser, db: DB, store: Store, version: int, sheet: int = 1
) -> Response:
    """The picture of a drawing's sheet (1 for the first) that SolidWorks saved in the file: a PNG."""
    picture = vault.sheet_picture(db, store, user, file_id, version, sheet)
    # A version never changes, and nor does what's read from it, but how it's read may.
    headers = {"ETag": f'"{hashlib.sha256(picture).hexdigest()[:32]}"', "Cache-Control": "private, max-age=86400"}
    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)
    return Response(picture, media_type="image/png", headers=headers)


@router.get("/files/{file_id}/drawing/pdf", response_class=FileResponse)
def get_drawing_pdf(file_id: int, request: Request, user: ActiveUser, db: DB, store: Store, version: int) -> Response:
    """The PDF Vault for SolidWorks made of a drawing's version, which Caliper shows in a frame, in the browser's PDF
    viewer."""
    name, sha = vault.drawing_pdf(db, user, file_id, version)
    headers = {
        "ETag": f'"{sha}"',
        "Cache-Control": "private, no-cache",  # it can be made again
        # The site's own pages may frame it; and the site's policy, which allows no plugins, would stop the viewer.
        "Content-Security-Policy": "frame-ancestors 'self'",
        "X-Frame-Options": "SAMEORIGIN",
    }
    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)
    return FileResponse(
        store.path(sha), media_type="application/pdf", filename=name, content_disposition_type="inline", headers=headers
    )


@router.put("/files/{file_id}/drawing/pdf")
def put_drawing_pdf(file_id: int, body: DrawingPdfIn, user: ActiveUser, db: DB, store: Store) -> DrawingPdfOut:
    """Save a drawing version's sheets as a PDF (upload it first, PUT /api/blobs/{sha256}), as Vault for SolidWorks
    does when it checks a drawing in. Adding one that's missing takes editor access somewhere; replacing one, to its
    folder."""
    return DrawingPdfOut.of(vault.put_drawing_pdf(db, store, user, file_id, version=body.version, pdf=body.pdf))


@router.post("/drawings/missing")
def post_drawings_missing(body: DrawingsMissingIn, user: ActiveUser, db: DB) -> DrawingsMissingOut:
    """Which of these drawings' versions have no PDF yet: what Vault for SolidWorks makes."""
    missing = vault.drawings_missing(db, user, [(d.file_id, d.version) for d in body.drawings])
    return DrawingsMissingOut(missing=[DrawingWantIn(file_id=f, version=v) for f, v in missing])


@router.post("/checkout")
def post_checkout(body: CheckoutIn, user: ChangingUser, db: DB) -> FilesOut:
    return FilesOut.of(vault.checkout(db, user, body.files, body.host, force=body.force))


@router.post("/files/{file_id}/revert")
def post_revert(file_id: int, body: RevertIn, user: ChangingUser, db: DB) -> FileOut:
    """Make an older version the latest again (a new version with its contents)."""
    return FileOut.of(
        vault.revert(db, user, file_id, body.version, comment=body.comment, host=body.host, force=body.force)
    )


@router.post("/undo-checkout")
def post_undo_checkout(body: FilesIn, user: ChangingUser, db: DB) -> FilesOut:
    return FilesOut.of(vault.undo_checkout(db, user, body.files))


@router.post("/checkin")
def post_checkin(body: CheckinIn, user: ChangingUser, db: DB) -> CheckinOut:
    items = [
        vault.CheckinItem(i.path, i.sha256, i.size, [vault.Reference(r.path, r.version) for r in i.references])
        for i in body.items
    ]
    result = vault.checkin(
        db, user, items, comment=body.comment, host=body.host, keep_checked_out=body.keep_checked_out
    )
    return CheckinOut.of(result)


@router.post("/delete")
def post_delete(body: DeleteIn, user: ChangingUser, db: DB) -> DeletedOut:
    """Move files, and folders with everything in them, to the trash (GET /api/folders?deleted=true)."""
    return DeletedOut.of(vault.delete(db, user, body.files, folders=body.folders, force=body.force))


@router.post("/files/{file_id}/restore")
def post_restore(file_id: int, user: ChangingUser, db: DB) -> FileOut:
    """Bring a deleted file back (and its folder, if that was deleted too)."""
    return FileOut.of(vault.restore(db, user, file_id))


@router.post("/folders/{folder_id}/restore")
def post_restore_folder(folder_id: int, user: ChangingUser, db: DB) -> FolderOut:
    """Bring a deleted folder back, with everything deleted along with it."""
    return FolderOut.of(vault.restore_folder(db, user, folder_id))


@router.post("/move")
def post_move(body: MoveIn, user: ChangingUser, db: DB) -> MovedOut:
    """Move files and folders into a folder; what SolidWorks files use has to stay findable."""
    return MovedOut.of(vault.move(db, user, files=body.files, folders=body.folders, to=body.to))


@router.post("/rename")
def post_rename(body: RenameIn, user: ChangingUser, db: DB) -> MovedOut:
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
def put_grant(body: GrantIn, user: ChangingUser, db: DB) -> GrantsOut:
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
    sha256: str, request: Request, user: ChangingUser, db: DB, store: Store, settings: Config
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
    disk.make_room(store.root, int(declared) if declared.isdigit() else 0)

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
