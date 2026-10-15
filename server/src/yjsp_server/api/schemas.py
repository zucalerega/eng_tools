"""Request and response bodies of the site's own API: accounts, sign-in, and tokens. Each app has its own
(vault/schemas.py, yorg/schemas.py)."""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from .. import auth
from ..models import SiteSettings, Token, User, WhitelistEmail


class UserRef(BaseModel):
    id: int
    name: str
    email: str

    @classmethod
    def of(cls, user: User) -> "UserRef":
        return cls(id=user.id, name=user.display_name, email=user.email)


class UserOut(BaseModel):
    id: int
    name: str
    email: str
    status: str
    is_admin: bool
    created_at: datetime
    last_login_at: datetime | None
    # For admins (people.last_active): when they last used the site, and whether they're on now. Otherwise null and
    # false.
    last_active_at: datetime | None = None
    active_now: bool = False
    # For admins (people.time_on_site): how long they've had the web app open, in seconds. Otherwise null.
    site_seconds: int | None = None

    @classmethod
    def of(cls, user: User, last_active: datetime | None = None, site_seconds: int | None = None) -> "UserOut":
        return cls(
            id=user.id,
            name=user.display_name,
            email=user.email,
            status=user.status.value,
            is_admin=user.is_admin,
            created_at=user.created_at,
            last_login_at=user.last_login_at,
            last_active_at=last_active,
            active_now=auth.active_now(last_active),
            site_seconds=site_seconds,
        )


class InviteIn(BaseModel):
    email: str
    name: str = ""


class UserPatch(BaseModel):
    status: Literal["active", "disabled"] | None = None
    is_admin: bool | None = None
    name: str | None = None


class MePatch(BaseModel):
    name: str = Field(max_length=200)  # your name, as everyone sees it


class SiteSettingsOut(BaseModel):
    # On: only the emails on the whitelist and invited people can make an account; anyone else who signs in is turned
    # away. Off: anyone with a Georgia Tech account can.
    whitelist: bool

    @classmethod
    def of(cls, site: SiteSettings) -> "SiteSettingsOut":
        return cls(whitelist=site.whitelist)


class UsageDayOut(BaseModel):
    day: date
    people: int  # who used the site that day: the web app, the add-in, or the CLI
    site_seconds: int  # how long the web app was open that day, everyone's together


class UsageOut(BaseModel):
    """How many people used the site each day, and how long they had the web app open (people.site_usage)."""

    timezone: str  # the days': the one asked for, or UTC if the server doesn't know it
    days: list[UsageDayOut]  # oldest first; the last is today, so far
    people: int  # who used the site on any of those days
    since: date | None  # the first day anything was recorded: nothing was before it
    total_site_seconds: int  # everyone's time on the web app, since it was first counted


class StorageOut(BaseModel):
    """How full the server's disk is, and how much of it each part of the site takes, in bytes (people.disk_usage)."""

    total: int
    free: int  # what the server can still write
    vault: int
    yorg: int
    database: int


class SiteSettingsPatch(BaseModel):
    whitelist: bool | None = None  # turning it off approves everyone waiting


class TokenOut(BaseModel):
    id: int
    kind: str
    name: str
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None

    @classmethod
    def of(cls, token: Token) -> "TokenOut":
        return cls(
            id=token.id,
            kind=token.kind,
            name=token.name,
            created_at=token.created_at,
            last_used_at=token.last_used_at,
            expires_at=token.expires_at,
        )


class TokenIssuedOut(BaseModel):
    token: str
    user: UserOut


class DevTokenIn(BaseModel):
    email: str
    name: str = ""


class ClientTokenIn(BaseModel):
    code: str
    verifier: str = Field(min_length=43, max_length=128)


class WhitelistIn(BaseModel):
    # One typed in, or a roster's: at most a few thousand, each at most as long as an email can be.
    emails: list[Annotated[str, Field(max_length=320)]] = Field(min_length=1, max_length=5000)


class WhitelistEntryOut(BaseModel):
    id: int
    email: str
    added_at: datetime
    account: UserOut | None  # the account it has, once it has one (people.whitelist)

    @classmethod
    def of(cls, entry: WhitelistEmail, account: User | None) -> "WhitelistEntryOut":
        return cls(
            id=entry.id,
            email=entry.email,
            added_at=entry.added_at,
            account=UserOut.of(account) if account else None,
        )


class WhitelistAddedOut(BaseModel):
    added: list[str]
    already: list[str]  # on the whitelist before
    not_georgia_tech: list[str]  # left off: only Georgia Tech accounts make accounts
