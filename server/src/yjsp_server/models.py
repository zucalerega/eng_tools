"""The site's tables: accounts, their sign-in tokens, and the settings admins choose. Each app keeps its own
(vault/models.py, yorg/models.py). Timestamps are timezone-aware UTC (db.UTCDateTime)."""

import enum
from datetime import datetime

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, UTCDateTime, enum_column, utcnow


class UserStatus(enum.StrEnum):
    INVITED = "invited"  # added by an admin; active from their first sign-in
    PENDING = "pending"  # signed in without an invite; waiting for an admin
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
    # On: only people an admin invited join; anyone else who signs in waits for an admin to approve them.
    # Off: anyone who signs in joins at once (auth.sign_in).
    whitelist: Mapped[bool] = mapped_column(default=False)
