"""The FastAPI application: the site (sign-in, accounts, the web app) and its four apps, Vault, Yorg, Piper, and
Buildflow."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import sessionmaker
from starlette.middleware.sessions import SessionMiddleware

from . import __version__, demo, load, people
from .api import assistant as assistant_api
from .api import deals as deals_api
from .api import demo as demo_api
from .api import downloads, signin, web
from .api import feedback as feedback_api
from .api import help as help_api
from .api import people as people_api
from .assistant import Assistant
from .buildflow import api as buildflow_api
from .buildflow import wants as buildflow_wants
from .config import Settings
from .db import make_engine, migrate
from .deals.finder import Deals
from .errors import ApiError
from .feedback import Requests
from .limits import BodyLimit
from .piper import api as piper_api
from .piper import wants as piper_wants
from .piper.diagrams import stored as piper_stored
from .security import SecurityHeaders, hide_sign_in_codes
from .vault import api as vault_api
from .vault import wants as vault_wants
from .vault.reading import Reader
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
            if settings.demo:
                demo.ready(db)  # only the demo's own database, never the team's
            people.init(db)
            init_vault(db)
            recover_yorg(db)
        app.state.server_load.start()
        app.state.assistant.start()
        if settings.caliper_read_ahead:
            app.state.caliper_reader.start()
        app.state.deals.start(schedule=settings.deals_schedule)
        yield
        await app.state.demo.close()
        app.state.deals.stop()
        app.state.caliper_reader.stop()
        app.state.assistant.stop()
        app.state.server_load.stop()
        app.state.yorg_runs.close()
        engine.dispose()

    # The API's own docs (/docs) are for development: in production they'd map the whole API for anyone.
    hidden = {"docs_url": None, "redoc_url": None, "openapi_url": None} if settings.production else {}
    app = FastAPI(title=settings.site_name, version=__version__, lifespan=lifespan, **hidden)
    app.state.settings = settings
    app.state.sessionmaker = sessions
    app.state.server_load = load.Sampler(sessions)  # a sample of the CPU and memory a minute (Admin > People)
    app.state.vault_store = BlobStore(settings.vault_dir / "blobs")
    # Reads SolidWorks files' 3D models for Caliper ahead of their being opened.
    app.state.caliper_reader = Reader(sessions, app.state.vault_store)
    app.state.yorg_files = DataFiles(settings.yorg_dir)
    app.state.yorg_scripts = Saved(settings.yorg_dir, "script", "code")
    app.state.yorg_runs = Runs(settings.yorg_dir)
    app.state.piper_stored = piper_stored  # what Piper keeps in the database, for the storage the site shows (disk.py)
    app.state.oauth = signin.make_oauth(settings)
    app.state.assistant = Assistant(settings, sessions)  # Claude, answering from the help (Help in the web app)
    # Bug reports and feature requests, which Claude looks at and the owner can have Claude Code build.
    app.state.feedback = Requests(settings, sessions, app.state.assistant)
    # Deals on eBay for what the team wants: what each app wants, handed over here, as the site imports no app;
    # Buildflow's first, its components standing for their CAD in Vault and their parts on P&IDs.
    app.state.deals = Deals(
        settings, sessions, app.state.assistant, [buildflow_wants.wants, piper_wants.wants, vault_wants.wants]
    )
    # The demo, at /demo: its own server, which this passes requests to (YJSP_DEMO_URL); none without one.
    app.state.demo = demo_api.Passer(settings.demo_url)
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
    if settings.demo:
        app.add_middleware(demo.Guard)  # reads only, before anything else looks: the demo can't be changed
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
    app.include_router(help_api.router)
    app.include_router(people_api.router)
    app.include_router(assistant_api.router)
    app.include_router(feedback_api.router)
    app.include_router(deals_api.router)
    app.include_router(downloads.router)
    app.include_router(vault_api.router)
    app.include_router(yorg_api.router)
    app.include_router(yorg_system_api.router)
    app.include_router(yorg_scripts.router)
    app.include_router(piper_api.router)
    app.include_router(buildflow_api.router)
    app.include_router(demo_api.router)
    web.mount_assets(app, settings)
    app.include_router(web.router)  # last: it takes every path nothing else did
    return app
