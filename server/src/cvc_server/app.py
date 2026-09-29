"""The FastAPI application."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import sessionmaker
from starlette.middleware.sessions import SessionMiddleware

from . import __version__
from .api import admin, downloads, files, signin, web
from .config import Settings
from .db import make_engine, migrate
from .errors import CvcError
from .storage import BlobStore
from .vault import init_vault
from .yorg import api as yorg_api
from .yorg.datasets import recover as recover_yorg
from .yorg.files import DataFiles
from .yorg.system import api as yorg_system_api
from .yorg.system.runs import Runs
from .yorg.system.store import Models


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    settings.check()
    engine = make_engine(settings.database_url)
    sessions = sessionmaker(engine, expire_on_commit=False)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        migrate(engine)
        with sessions() as db:
            init_vault(db)
            recover_yorg(db)
        yield
        app.state.yorg_runs.close()
        engine.dispose()

    app = FastAPI(title="Vault", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.sessionmaker = sessions
    app.state.store = BlobStore(settings.blob_dir)
    app.state.yorg_files = DataFiles(settings.yorg_dir)
    app.state.yorg_models = Models(settings.yorg_dir)
    app.state.yorg_runs = Runs(settings.yorg_dir)
    app.state.oauth = signin.make_oauth(settings)
    # Carries Google sign-in state between the redirect to Google and the callback.
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.secret_key,
        session_cookie="cvc_signin",
        max_age=600,
        same_site="lax",
        https_only=settings.production,
    )

    @app.exception_handler(CvcError)
    async def cvc_error(_: Request, exc: CvcError) -> JSONResponse:
        body = {"error": exc.code, "message": exc.message}
        if exc.details:
            body["details"] = exc.details
        return JSONResponse(body, status_code=exc.status)

    @app.get("/healthz", include_in_schema=False)
    def healthz() -> dict[str, bool]:
        return {"ok": True}

    app.include_router(files.router)
    app.include_router(downloads.router)
    app.include_router(admin.router)
    app.include_router(signin.router)
    app.include_router(yorg_api.router)
    app.include_router(yorg_system_api.router)
    web.mount_assets(app, settings)
    app.include_router(web.router)  # last: it takes every path nothing else did
    return app
