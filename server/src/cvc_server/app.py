"""The FastAPI application."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import sessionmaker
from starlette.middleware.sessions import SessionMiddleware

from . import __version__
from .api import admin, files, signin, web
from .config import Settings
from .db import make_engine, migrate
from .errors import CvcError
from .storage import BlobStore
from .vault import init_vault


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
        yield
        engine.dispose()

    app = FastAPI(title="Vault", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.sessionmaker = sessions
    app.state.store = BlobStore(settings.blob_dir)
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
    app.include_router(admin.router)
    app.include_router(signin.router)
    web.mount_assets(app, settings)
    app.include_router(web.router)  # last: it takes every path nothing else did
    return app
