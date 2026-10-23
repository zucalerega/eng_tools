"""The site's tables: accounts, their sign-in tokens, and the settings and whitelist admins choose. Each app keeps
its own (vault/models.py, yorg/models.py). Timestamps are timezone-aware UTC (db.UTCDateTime)."""

import enum
from datetime import datetime

from sqlalchemy import BigInteger, Float, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, UTCDateTime, enum_column, utcnow


class UserStatus(enum.StrEnum):
    INVITED = "invited"  # added by an admin; active from their first sign-in
    # Signed in without an invite while the whitelist was on, which made an account that waited for an admin. Since
    # October 2026 such a sign-in is turned away instead (auth._sign_in), so only accounts from before are pending.
    PENDING = "pending"
    ACTIVE = "active"
    DISABLED = "disabled"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    google_sub: Mapped[str | None] = mapped_column(String(255), unique=True)
    # A Georgia Tech account's object ID in GT's Microsoft tenant (auth.sign_in_microsoft). A unique index rather than
    # a constraint, so SQLite adds it in place instead of copying the table everything points at.
    microsoft_oid: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    status: Mapped[UserStatus] = mapped_column(enum_column(UserStatus), default=UserStatus.PENDING)
    is_admin: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    # Time spent with the web app open, in seconds (usage.record adds it up). Admins see it.
    site_seconds: Mapped[int] = mapped_column(default=0, server_default="0")
    # Time spent working in SolidWorks, as the add-in says it (auth.authenticate), in seconds. Admins see it.
    solidworks_seconds: Mapped[int] = mapped_column(default=0, server_default="0")

    @property
    def display_name(self) -> str:
        return self.name or self.email


class Token(Base):
    """A browser session or a CLI/add-in credential. Only the secret's SHA-256 is stored."""

    __tablename__ = "tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # auth.SESSION or auth.CLIENT
    name: Mapped[str] = mapped_column(String(200), default="")
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    # A CLI's or the add-in's version, as its requests last said it (User-Agent: vault-client/<version>).
    client_version: Mapped[str | None] = mapped_column(String(32))


class DownloadRecord(Base):
    """Someone downloading a file the web app offers, as Vault-Setup.exe, the add-in's installer: Admin > People's
    add-in tracker (clients.py)."""

    __tablename__ = "downloads"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    version: Mapped[str | None] = mapped_column(String(32))  # a program's, read from it
    by_client: Mapped[bool] = mapped_column(default=False)  # the add-in updating itself, not someone in a browser
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class SiteUsage(Base):
    """An hour in which someone used the site, and how long they had the web app open in it and worked in SolidWorks:
    Admin > People's daily active users and time on the site (usage.py)."""

    __tablename__ = "site_usage"

    hour: Mapped[datetime] = mapped_column(UTCDateTime, primary_key=True)  # its start, in UTC
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    site_seconds: Mapped[int] = mapped_column(default=0, server_default="0")
    solidworks_seconds: Mapped[int] = mapped_column(default=0, server_default="0")


class ServerLoad(Base):
    """A minute of the server's work: how busy its CPUs were and how full its memory, kept a week (load.py)."""

    __tablename__ = "server_load"

    at: Mapped[datetime] = mapped_column(UTCDateTime, primary_key=True)  # the minute's end
    cpu: Mapped[float | None] = mapped_column(Float)  # % of all CPUs busy
    steal: Mapped[float | None] = mapped_column(Float)  # % taken by the hypervisor for other machines
    memory_used: Mapped[int | None] = mapped_column(BigInteger)  # bytes
    memory_total: Mapped[int | None] = mapped_column(BigInteger)


class ClientAuthCode(Base):
    """One-time code from the CLI/add-in browser sign-in, redeemed with a PKCE verifier."""

    __tablename__ = "client_auth_codes"

    id: Mapped[int] = mapped_column(primary_key=True)
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    challenge: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class SiteSettings(Base):
    """A single row (id 1): what admins decide for everyone, in the web app.

    The server's own settings come from the environment instead (config.Settings).
    """

    __tablename__ = "site_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    # On: only the emails on the whitelist (WhitelistEmail) and people an admin invited can make an account; anyone
    # else who signs in is turned away. Off: anyone with a Georgia Tech account can (auth._sign_in).
    whitelist: Mapped[bool] = mapped_column(default=False)
    # The oldest Vault client (the add-in, the CLI) that can change the vault, like "0.5.4": older ones can still read
    # it, and are told to update (clients.refuse_old). None, as it starts: any client can.
    min_client_version: Mapped[str | None] = mapped_column(String(32))


class WhitelistEmail(Base):
    """A Georgia Tech address that can make an account, by signing in with Georgia Tech, while the whitelist is on
    (Admin > Whitelist in the web app). Taking it off changes no account it made."""

    __tablename__ = "whitelist_emails"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    added_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    # The account that signed in as it, once one has: by an alias, its email can be another of the person's addresses.
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
