"""Who has Vault's SolidWorks add-in, for admins (Admin > People): who has signed in with it, on which computers, with
which version, and when they last used it; who downloaded its installer; and how many people have it.

The add-in signs in as "SolidWorks add-in on <computer>" (VaultPane.cs) and the CLI as "vault CLI on <computer>", so a
token's name tells them apart; each says its version in its requests, which the token keeps (auth.authenticate).
Downloads are counted as the web app serves them (record_download), from the deploy that began counting them on.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import auth
from .db import utcnow
from .errors import Forbidden
from .models import DownloadRecord, Token, User

ADD_IN = "SolidWorks add-in on "  # the start of the add-in's tokens' names
INSTALLER = "Vault-Setup.exe"  # the add-in's installer, among the downloads
# An add-in used this recently is one someone has: a laptop put away for a semester isn't.
HAS_IT = timedelta(days=90)
THIS_WEEK = timedelta(days=7)


@dataclass
class Computer:
    name: str  # as the add-in said it when it signed in
    version: str | None  # the add-in's, as its requests last said it
    signed_in_at: datetime
    last_used_at: datetime | None


@dataclass
class Person:
    user: User
    computers: list[Computer] = field(default_factory=list)  # where they're signed in with the add-in
    downloaded_at: datetime | None = None  # when they last downloaded the installer
    downloaded_version: str | None = None
    downloads: int = 0  # how many times, updates by the add-in included


@dataclass
class AddIn:
    people: list[Person]  # everyone who has it or downloaded it, the most recently on first
    have_it: int  # people signed in with it, and using it in the last HAS_IT
    this_week: int  # of them, who used it in the last week
    downloaded: int  # people who downloaded the installer
    counting_since: datetime | None  # the first download counted: none were before


def record_download(db: Session, user: User, name: str, version: str | None, user_agent: str) -> None:
    """Note that someone downloaded a file: from the web app, or the add-in updating itself."""
    by_client = auth.client_version(user_agent) is not None
    db.add(DownloadRecord(user_id=user.id, name=name, version=version, by_client=by_client, at=utcnow()))
    db.commit()


def add_in(db: Session, viewer: User) -> AddIn:
    """Who has the add-in, and who downloaded its installer (admins)."""
    if not viewer.is_admin:
        raise Forbidden("Only admins can do that", code="admin_only")
    now = utcnow()
    people: dict[int, Person] = {}

    def person(user: User) -> Person:
        return people.setdefault(user.id, Person(user))

    signed_in = db.execute(
        select(Token, User)
        .join(User, User.id == Token.user_id)
        .where(Token.kind == auth.CLIENT, Token.name.startswith(ADD_IN), Token.revoked_at.is_(None))
        .order_by(Token.id)
    )
    for token, user in signed_in:
        if token.expires_at is not None and token.expires_at <= now:
            continue
        computer = token.name.removeprefix(ADD_IN) or "a computer"
        person(user).computers.append(Computer(computer, token.client_version, token.created_at, token.last_used_at))
    downloads = db.execute(
        select(DownloadRecord, User)
        .join(User, User.id == DownloadRecord.user_id)
        .where(DownloadRecord.name == INSTALLER)
        .order_by(DownloadRecord.at)
    )
    for record, user in downloads:
        found = person(user)
        found.downloads += 1
        found.downloaded_at, found.downloaded_version = record.at, record.version

    def last_on(found: Person) -> datetime:
        times = [c.last_used_at or c.signed_in_at for c in found.computers] + [found.downloaded_at]
        return max((t for t in times if t is not None), default=datetime.min.replace(tzinfo=now.tzinfo))

    def used_within(found: Person, span: timedelta) -> bool:
        return any(now - (c.last_used_at or c.signed_in_at) <= span for c in found.computers)

    ordered = sorted(people.values(), key=last_on, reverse=True)
    return AddIn(
        people=ordered,
        have_it=sum(1 for p in ordered if used_within(p, HAS_IT)),
        this_week=sum(1 for p in ordered if used_within(p, THIS_WEEK)),
        downloaded=sum(1 for p in ordered if p.downloads),
        counting_since=db.scalar(select(func.min(DownloadRecord.at))),
    )
