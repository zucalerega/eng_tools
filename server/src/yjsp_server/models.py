"""The site's tables: accounts, their sign-in tokens, the settings and whitelist admins choose, what Claude in Help
has cost, and the bug reports and feature requests members send. Each app keeps its own (vault/models.py,
yorg/models.py, piper/models.py). Timestamps are timezone-aware UTC (db.UTCDateTime)."""

import enum
from datetime import datetime

from sqlalchemy import BigInteger, Float, ForeignKey, String, Text
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


class AssistantPurpose(enum.StrEnum):
    QUESTION = "question"  # someone's question in Help
    KEEP_WARM = "keep_warm"  # a read to keep the help loaded between questions (YJSP_ASSISTANT_KEEP_WARM)
    FEEDBACK = "feedback"  # Claude's look at a bug report or feature request, for the owner (feedback.py)


class AssistantRequest(Base):
    """A request to Claude, and what it cost: its budget and each person's daily limit add these up (assistant.py).
    What was asked, and the answer, aren't kept. Only a question is someone's: a read to keep the help loaded, or a
    look at a request, is no one's, so it counts against the budgets, and no one's limit."""

    __tablename__ = "assistant_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)  # null: not a question
    purpose: Mapped[AssistantPurpose] = mapped_column(
        enum_column(AssistantPurpose), default=AssistantPurpose.QUESTION, server_default="question"
    )
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    model: Mapped[str] = mapped_column(String(64))  # the model that answered
    input_tokens: Mapped[int] = mapped_column(default=0)  # read in full
    cache_write_tokens: Mapped[int] = mapped_column(default=0)  # read in full, and kept for the next questions
    cache_read_tokens: Mapped[int] = mapped_column(default=0)  # read again from what was kept, for much less
    output_tokens: Mapped[int] = mapped_column(default=0)  # written, thinking included
    cost: Mapped[int] = mapped_column(BigInteger, default=0)  # in millionths of a US dollar


class FeedbackKind(enum.StrEnum):
    BUG = "bug"
    FEATURE = "feature"


class FeedbackStatus(enum.StrEnum):
    NEW = "new"  # waiting for the owner
    APPROVED = "approved"  # the owner approved it: Claude Code is building it (session_url)
    DECLINED = "declined"  # an admin turned it down, saying why (reply)
    DONE = "done"  # built, or otherwise dealt with


class Feedback(Base):
    """A bug report or a feature request a member sent from Help (feedback.py). Claude looks at it for the owner
    (evaluation), who can approve it, which starts a Claude Code routine building it; or an admin declines it, or marks
    it done, with a reply for whoever sent it."""

    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)  # who sent it
    kind: Mapped[FeedbackKind] = mapped_column(enum_column(FeedbackKind))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    page: Mapped[str | None] = mapped_column(String(500))  # where in the web app they sent it from
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    status: Mapped[FeedbackStatus] = mapped_column(enum_column(FeedbackStatus), default=FeedbackStatus.NEW)
    # Claude's look at it, in Markdown, from the help; or why it couldn't look (Claude's budget spent, say).
    evaluation: Mapped[str | None] = mapped_column(Text)
    evaluation_problem: Mapped[str | None] = mapped_column(String(500))
    evaluated_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    evaluation_cost: Mapped[int] = mapped_column(BigInteger, default=0)  # in millionths of a US dollar, every look
    # Who approved, declined, or finished it, when, and what they told whoever sent it.
    decided_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    reply: Mapped[str | None] = mapped_column(Text)
    # Approved: what the owner added for Claude Code, and the session building it.
    note: Mapped[str | None] = mapped_column(Text)
    session_url: Mapped[str | None] = mapped_column(String(500))


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
    # How long Claude keeps the help loaded after a question, in hours (1 to 24), the server reading it again meanwhile
    # (assistant.Assistant.keep_warm): 1 is only the hour Anthropic keeps it after each read. None, as it starts: always,
    # around the clock.
    assistant_keep_hours: Mapped[int | None] = mapped_column()


class WhitelistEmail(Base):
    """A Georgia Tech address that can make an account, by signing in with Georgia Tech, while the whitelist is on
    (Admin > Whitelist in the web app). Taking it off changes no account it made."""

    __tablename__ = "whitelist_emails"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    added_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    # The account that signed in as it, once one has: by an alias, its email can be another of the person's addresses.
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
