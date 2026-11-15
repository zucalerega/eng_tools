"""The site's tables: accounts, their sign-in tokens, the settings and whitelist admins choose, what Claude in Help
has cost, the bug reports and feature requests members send, and the deals found for what the team wants. Each app
keeps its own (vault/models.py, yorg/models.py, piper/models.py, buildflow/models.py). Timestamps are timezone-aware UTC
(db.UTCDateTime)."""

import enum
from datetime import datetime

from sqlalchemy import BigInteger, Float, ForeignKey, String, Text, UniqueConstraint
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
    DEALS = "deals"  # Claude's verdicts on listings found for what the team wants (deals/finder.py)


class AssistantRequest(Base):
    """A request to Claude, and what it cost: its budget and each person's daily limit add these up (assistant.py).
    What was asked, and the answer, aren't kept. Only a question is someone's: a read to keep the help loaded, a look
    at a request, or a say on deals, is no one's, so it counts against the budgets, and no one's limit."""

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


class Deal(Base):
    """A listing found for something the team wants (deals/), as its source said it when it was last checked: kept
    current every few hours, and shown only while it's fresh, as eBay's terms ask. What it's for is said as the app that
    wants it said it then (`want_*`), since the site asks no app again."""

    __tablename__ = "deals"
    __table_args__ = (UniqueConstraint("source", "listing", "want_key", name="uq_deals_source_listing_want"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(16))  # "ebay"
    listing: Mapped[str] = mapped_column(String(100))  # its id there: "v1|1234567890|0"
    title: Mapped[str] = mapped_column(String(300))
    url: Mapped[str] = mapped_column(String(2000))  # its page there
    image: Mapped[str | None] = mapped_column(String(2000))
    price: Mapped[int]  # in cents: an auction's current bid
    currency: Mapped[str] = mapped_column(String(3))
    shipping: Mapped[int | None]  # in cents; None: worked out at checkout
    condition: Mapped[str] = mapped_column(String(100), default="")
    auction: Mapped[bool] = mapped_column(default=False)
    ends_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    want_key: Mapped[str] = mapped_column(String(200), index=True)  # "buildflow:component:12"
    want_title: Mapped[str] = mapped_column(String(200))  # "Main oxidizer valve"
    want_where: Mapped[str] = mapped_column(String(300))  # "Elytra, Fluids"
    want_href: Mapped[str] = mapped_column(String(500))  # its page on the site
    search: Mapped[str] = mapped_column(String(400))  # what found it
    fit: Mapped[float] = mapped_column(Float)  # 0 to 1: how well its words fit what's wanted (deals/rank.py)
    # What the search found typically costs, shipped, in cents (the median of those that fit): its price against this is
    # how good a deal it is. None: too few to say.
    typical: Mapped[int | None]
    reason: Mapped[str] = mapped_column(String(500), default="")  # why it would do, in words
    found_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    checked_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)  # as its source said then
    # Gone: ended, sold, taken down, or no longer wanted (what it's for is built or bought). Kept, as a dismissal is.
    gone_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    # Dismissed: someone said it won't do, so it isn't found again for what it's for.
    dismissed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    dismissed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class DealRun(Base):
    """A run of the deals finder: a search for everything the team wants, or a check of the deals shown, and how it
    went (Admin > Deals)."""

    __tablename__ = "deal_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16))  # "search" or "refresh"
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    started_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))  # None: on schedule
    wants: Mapped[int] = mapped_column(default=0)  # searched for
    searches: Mapped[int] = mapped_column(default=0)  # calls to the source
    listings: Mapped[int] = mapped_column(default=0)  # seen
    found: Mapped[int] = mapped_column(default=0)  # deals shown after it
    gone: Mapped[int] = mapped_column(default=0)  # deals it found gone
    judged: Mapped[bool] = mapped_column(default=False)  # Claude said which would do
    cost: Mapped[int] = mapped_column(BigInteger, default=0)  # Claude's, in millionths of a US dollar
    problem: Mapped[str | None] = mapped_column(String(500))  # what went wrong, if anything


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
