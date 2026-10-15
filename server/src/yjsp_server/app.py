"""The FastAPI application: the site (sign-in, accounts, the web app) and its two apps, Vault and Yorg."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import sessionmaker
from starlette.middleware.sessions import SessionMiddleware

from . import __version__, load, people
from .api import downloads, signin, web
from .api import people as people_api
from .config import Settings
from .db import make_engine, migrate
from .errors import ApiError
from .limits import BodyLimit
from .security import SecurityHeaders, hide_sign_in_codes
from .vault import api as vault_api
from .vault.storage import BlobStore
from .vault.vault import init_vault
from .yorg import api as yorg_api
from .yorg import scripts as yorg_scripts
from .yorg.datasets import recover as recover_yorg
from .yorg.files import DataFiles
from .yorg.saved import Saved
from .yorg.system import api as yorg_system_api
from .yorg.system.runs import Runs


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    settings.check()
    engine = make_engine(settings.database_url)
    sessions = sessionmaker(engine, expire_on_commit=False)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        migrate(engine)
        with sessions() as db:
            people.init(db)
            init_vault(db)
            recover_yorg(db)
        app.state.server_load.start()
        yield
        app.state.server_load.stop()
        app.state.yorg_runs.close()
        engine.dispose()

    # The API's own docs (/docs) are for development: in production they'd map the whole API for anyone.
    hidden = {"docs_url": None, "redoc_url": None, "openapi_url": None} if settings.production else {}
    app = FastAPI(title="YJSP", version=__version__, lifespan=lifespan, **hidden)
    app.state.settings = settings
    app.state.sessionmaker = sessions
    app.state.server_load = load.Sampler(sessions)  # a sample of the CPU and memory a minute (Admin > People)
    app.state.vault_store = BlobStore(settings.vault_dir / "blobs")
    app.state.yorg_files = DataFiles(settings.yorg_dir)
    app.state.yorg_models = Saved(settings.yorg_dir, "model", "model")
    app.state.yorg_scripts = Saved(settings.yorg_dir, "script", "code")
    app.state.yorg_runs = Runs(settings.yorg_dir)
    app.state.oauth = signin.make_oauth(settings)
    # Carries sign-in state between the redirect to Google or Microsoft and the callback.
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.secret_key,
        session_cookie="yjsp_signin",
        max_age=600,
        same_site="lax",
        https_only=settings.production,
    )

    # Outside everything that reads a request, so that a request too big for the server is refused before anything
    # reads it. Only SecurityHeaders, which reads nothing of it, is outside it, so a refusal has the headers too.
    app.add_middleware(BodyLimit)
    app.add_middleware(SecurityHeaders, https=settings.production)
    hide_sign_in_codes()

    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError) -> JSONResponse:
        body = {"error": exc.code, "message": exc.message}
        if exc.details:
            body["details"] = exc.details
        return JSONResponse(body, status_code=exc.status)

    @app.get("/healthz", include_in_schema=False)
    def healthz() -> dict[str, bool]:
        return {"ok": True}

    app.include_router(signin.router)
    app.include_router(people_api.router)
    app.include_router(downloads.router)
    app.include_router(vault_api.router)
    app.include_router(yorg_api.router)
    app.include_router(yorg_system_api.router)
    app.include_router(yorg_scripts.router)
    web.mount_assets(app, settings)
    app.include_router(web.router)  # last: it takes every path nothing else did
    return app
