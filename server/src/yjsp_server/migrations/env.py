"""Alembic environment.

The server runs `upgrade head` at startup (db.migrate). One chain of migrations for the whole database: the
site's tables and each app's. After changing any models.py, generate a migration from server/:

    uv run alembic revision --autogenerate -m "what changed"
"""

from alembic import context

from yjsp_server import models  # noqa: F401  (registers the site's tables)
from yjsp_server.db import Base, UTCDateTime, make_engine
from yjsp_server.piper import models as piper_models  # noqa: F401  (and Piper's)
from yjsp_server.tempo import models as tempo_models  # noqa: F401  (and Tempo's)
from yjsp_server.vault import models as vault_models  # noqa: F401  (and Vault's)
from yjsp_server.yorg import models as yorg_models  # noqa: F401  (and Yorg's)


def render_item(type_, obj, autogen_context):
    # UTCDateTime only converts values in Python; the column itself is a timezone-aware DateTime.
    if type_ == "type" and isinstance(obj, UTCDateTime):
        return "sa.DateTime(timezone=True)"
    return False


def run(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=Base.metadata,
        render_as_batch=True,  # SQLite can't ALTER most things; batch mode rebuilds the table
        render_item=render_item,
    )
    with context.begin_transaction():
        context.run_migrations()


connection = context.config.attributes.get("connection")
if connection is not None:
    run(connection)
else:
    from yjsp_server.config import Settings

    with make_engine(Settings().database_url).connect() as conn:
        run(conn)
