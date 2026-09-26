"""Migrations match the models, and concurrent writers are serialized safely."""

from concurrent.futures import ThreadPoolExecutor

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import select

from cvc_server import vault
from cvc_server.db import Base, make_engine, migrate
from cvc_server.errors import Conflict
from cvc_server.models import User


def test_migrations_match_models(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path / 'm.db'}")
    migrate(engine)
    with engine.connect() as connection:
        assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []


def test_concurrent_checkouts_have_one_winner(app, team):
    chief = team.member("chief@x.test", admin=True)
    team.checkin(chief, {"Nozzle.SLDPRT": b"nozzle"})
    emails = [f"member{i}@x.test" for i in range(8)]
    for email in emails:
        team.member(email, admin=True)

    def attempt(email: str) -> str:
        with app.state.sessionmaker() as db:
            user = db.scalar(select(User).where(User.email == email))
            try:
                vault.checkout(db, user, ["Nozzle.SLDPRT"], host=email)
            except Conflict:
                return "taken"
            return "won"

    with ThreadPoolExecutor(len(emails)) as pool:
        results = list(pool.map(attempt, emails))
    assert sorted(results) == ["taken"] * 7 + ["won"]
