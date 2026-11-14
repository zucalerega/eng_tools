"""Request and response bodies of the site's own API: accounts, sign-in, and tokens, and the pieces of bodies the apps
share. Each app has its own (vault/schemas.py, yorg/schemas.py, piper/schemas.py)."""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field

from .. import auth, clients
from ..feedback import Names
from ..models import Feedback, SiteSettings, Token, User, WhitelistEmail


def _tidy_folder(value: str) -> str:
    """A folder path, tidied: forward slashes, no empty or padded parts ("" for none)."""
    return "/".join(part.strip() for part in value.replace("\\", "/").split("/") if part.strip())


# Where an app keeps something in folders that are only paths (Yorg's views and scripts), or names a folder by its path
# (Piper's diagrams, whose folders are their own): a path of folders, as "Hotfires/HF-3", or "" for none (at the top).
FolderPath = Annotated[str, Field(max_length=300), AfterValidator(_tidy_folder)]


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
    last_login_at: datetime | None  # in the list of everyone, only for admins and your own (people.last_sign_in)
    # For admins (people.last_active): when they last used the site, and whether they're on now. Otherwise null and
    # false.
    last_active_at: datetime | None = None
    active_now: bool = False
    # For admins (people.time_on_site): how long they've had the web app open, and worked in SolidWorks, in seconds.
    # Otherwise null.
    site_seconds: int | None = None
    solidworks_seconds: int | None = None

    @classmethod
    def of(
        cls,
        user: User,
        last_active: datetime | None = None,
        site_seconds: int | None = None,
        solidworks_seconds: int | None = None,
    ) -> "UserOut":
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
            solidworks_seconds=solidworks_seconds,
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
    # The oldest Vault client (the add-in, the CLI) that can change the vault, like "0.5.4": older ones' changes are
    # refused (426 client_too_old), and they can still read it. Null: any client can.
    min_client_version: str | None

    @classmethod
    def of(cls, site: SiteSettings) -> "SiteSettingsOut":
        return cls(whitelist=site.whitelist, min_client_version=site.min_client_version)


class UsageDayOut(BaseModel):
    day: date
    people: int  # who used the site that day: the web app, the add-in, or the CLI
    site_seconds: int  # how long the web app was open that day, everyone's together
    solidworks_seconds: int  # how long people worked in SolidWorks that day, with the add-in, everyone's together


class UsageOut(BaseModel):
    """How many people used the site each day, and how long they had the web app open and worked in SolidWorks
    (people.site_usage)."""

    timezone: str  # the days': the one asked for, or UTC if the server doesn't know it
    days: list[UsageDayOut]  # oldest first; the last is today, so far
    people: int  # who used the site on any of those days
    since: date | None  # the first day anything was recorded: nothing was before it
    total_site_seconds: int  # everyone's time on the web app, since it was first counted
    total_solidworks_seconds: int  # everyone's time in SolidWorks, since it was first counted
    solidworks_since: date | None  # the first day time in SolidWorks was counted: add-ins before said nothing


class LoadPointOut(BaseModel):
    at: datetime  # the start of its stretch
    cpu: float | None  # % of all CPUs busy in its busiest minute
    steal: float | None  # % the hypervisor took for other machines then
    memory: float | None  # % of memory in use in its fullest minute


class ServerLoadOut(BaseModel):
    """How hard the server has worked, minute by minute (people.server_load)."""

    cpus: int
    minutes: int  # each point's stretch: 1, or 10 for more than a day
    points: list[LoadPointOut]  # oldest first; a stretch the server wasn't running is left out
    memory_used: int | None  # the latest sample's, in bytes
    memory_total: int | None


class AddInComputerOut(BaseModel):
    name: str  # as the add-in said it when it signed in
    version: str | None  # the add-in's, as its requests last said it
    signed_in_at: datetime
    last_used_at: datetime | None
    in_use: bool  # used in the last 90 days, so its person has it
    outdated: bool  # older than the installer offered now: it offers itself the update


class AddInPersonOut(BaseModel):
    user: UserRef
    computers: list[AddInComputerOut]  # where they're signed in with the add-in
    downloaded_at: datetime | None  # when they last downloaded the installer
    downloaded_version: str | None
    downloads: int  # how many times, updates by the add-in included


class AddInOut(BaseModel):
    """Who has the SolidWorks add-in, and who downloaded its installer (clients.add_in)."""

    people: list[AddInPersonOut]  # the most recently on first
    have_it: int  # people signed in with it and using it in the last 90 days
    this_week: int  # of them, who used it in the last week
    downloaded: int  # people who downloaded the installer
    newest: str | None  # the installer's version, offered now
    on_newest: int  # of the people who have it, who are on it (or newer) on a computer they use
    counting_since: datetime | None  # the first download counted: none were before

    @classmethod
    def of(cls, found: "clients.AddIn") -> "AddInOut":
        return cls(
            people=[
                AddInPersonOut(
                    user=UserRef.of(p.user),
                    computers=[AddInComputerOut(**vars(c)) for c in p.computers],
                    downloaded_at=p.downloaded_at,
                    downloaded_version=p.downloaded_version,
                    downloads=p.downloads,
                )
                for p in found.people
            ],
            have_it=found.have_it,
            this_week=found.this_week,
            downloaded=found.downloaded,
            newest=found.newest,
            on_newest=found.on_newest,
            counting_since=found.counting_since,
        )


class BackupOut(BaseModel):
    """What the off-site backup last said about itself (backups.status)."""

    backed_up_at: datetime | None  # the last copy that worked
    snapshot: str | None
    backup_failed_at: datetime | None  # the last that didn't, if it's since that one
    backup_error: str | None
    verified_at: datetime | None  # the last restore that checked out
    verify_failed_at: datetime | None
    verify_error: str | None


class StorageOut(BaseModel):
    """How full the server's disk is, and how much of it each part of the site takes, in bytes (people.disk_usage); and
    whether the data is copied off the server."""

    total: int
    free: int  # what the server can still write
    vault: int
    yorg: int
    database: int
    piper: int = 0  # its drawings and pictures: a part of the database
    backup: BackupOut | None = None  # null: no off-site backup on this server


class StorageSummaryOut(BaseModel):
    """How full the server's disk is, and how much of it each app takes, in bytes, for the home page (people.storage):
    anyone signed in sees it. The rest of what's used is the system, the rest of the database, and its backups."""

    total: int
    free: int  # what the server can still write
    vault: int
    yorg: int
    piper: int


class SiteSettingsPatch(BaseModel):
    whitelist: bool | None = None  # turning it off approves everyone waiting
    # A version no newer than the installer offered, or null to take changes from any client again. Left out, it stays.
    min_client_version: str | None = Field(default=None, max_length=32)


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
    # The token's own name, as a client names it ("SolidWorks add-in on PC-1"), to stand in for that client.
    client: str = Field(default="", max_length=200)


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


class AssistantMessageIn(BaseModel):
    role: Literal["user", "assistant"]
    # A question's length, and an answer's, are the assistant's to check (assistant._check), saying which is too long.
    text: str = Field(max_length=100_000)
    # A question's: the page of the web app it was asked from, like /vault/file/12.
    page: str | None = Field(default=None, max_length=300)


class AskIn(BaseModel):
    """A question to the assistant, with the conversation so far: questions and answers in turn, the question last."""

    messages: list[AssistantMessageIn] = Field(min_length=1, max_length=40)


class FeedbackIn(BaseModel):
    """A bug report (kind "bug") or a feature request ("feature"), from a page of the web app. feedback.py checks the
    lengths, saying what fits."""

    kind: str = Field(max_length=16)
    title: str = Field(max_length=2_000)
    body: str = Field(max_length=50_000)
    page: str | None = Field(default=None, max_length=2_000)


class FeedbackReplyIn(BaseModel):
    reply: str | None = Field(default=None, max_length=20_000)  # for whoever sent it


class FeedbackApproveIn(BaseModel):
    note: str | None = Field(default=None, max_length=20_000)  # for Claude Code, with the request


class FeedbackOut(BaseModel):
    """A request, as whoever sent it sees it; admins see who sent it, Claude's look at it, and what's building it."""

    id: int
    kind: str  # "bug" or "feature"
    title: str
    body: str
    page: str | None  # where in the web app it was sent from
    created_at: datetime
    status: str  # "new" (waiting for the owner), "approved" (Claude Code is building it), "declined", or "done"
    reply: str | None  # an admin's answer to whoever sent it
    decided_at: datetime | None
    # Admins only:
    sender: UserRef | None = None
    decided_by: UserRef | None = None
    evaluation: str | None = None  # Claude's look at it, in Markdown
    evaluation_problem: str | None = None  # why Claude couldn't look
    looking: bool = False  # Claude is looking at it now
    evaluation_cost: float | None = None  # what Claude's looks at it cost, in US dollars
    note: str | None = None  # the owner's note for Claude Code
    session_url: str | None = None  # the Claude Code session building it

    @classmethod
    def of(cls, item: Feedback, names: Names | None = None, looking: bool = False) -> "FeedbackOut":
        """With `names` (who's who), as admins see it."""
        out = cls(
            id=item.id,
            kind=item.kind.value,
            title=item.title,
            body=item.body,
            page=item.page,
            created_at=item.created_at,
            status=item.status.value,
            reply=item.reply,
            decided_at=item.decided_at,
        )
        if names is not None:
            sender, decider = names(item.user_id), names(item.decided_by_id)
            out.sender = UserRef.of(sender) if sender else None
            out.decided_by = UserRef.of(decider) if decider else None
            out.evaluation = item.evaluation
            out.evaluation_problem = item.evaluation_problem
            out.looking = looking
            out.evaluation_cost = round(item.evaluation_cost / 1_000_000, 6)
            out.note = item.note
            out.session_url = item.session_url
        return out


class FeedbackListOut(BaseModel):
    """Every request, the newest first, and whether the admin looking can approve them (and if not, why)."""

    requests: list[FeedbackOut]
    can_approve: bool
    why_not_approve: str | None


class AssistantSettingsIo(BaseModel):
    """How long Claude keeps the help loaded after a question, in hours (1 to 24: 1 is only the hour Anthropic keeps it
    after each read), or null for always, around the clock (admins, assistant.Assistant.keep_loaded)."""

    keep_hours: int | None


class AssistantOut(BaseModel):
    """What someone sees of the assistant before asking (assistant.Assistant.status)."""

    available: bool  # whether they can ask now
    reason: str | None  # why not, when they can't
    model: str
    day_used: float  # how much of their daily limit their questions in the last 24 hours took, from 0 to 1
    budget: float | None  # US dollars it may spend in all (0: no budget in all); for admins only
    spent: float | None  # what it has spent; for admins only
    monthly_budget: float | None  # US dollars it may spend each calendar month (0: no monthly budget); for admins only
    month_spent: float | None  # what it has spent this month, since the 1st at 00:00 UTC; for admins only


class AssistantSpenderOut(BaseModel):
    user: UserRef
    questions: int
    spent: float  # US dollars
    last_asked_at: datetime


class AssistantSpendingOut(BaseModel):
    """What the assistant has cost, and on whose questions (assistant.Assistant.spending)."""

    available: bool  # whether people can ask now
    reason: str | None  # why not, when they can't
    budget: float  # US dollars it may spend in all (0: no budget in all)
    spent: float
    monthly_budget: float  # US dollars it may spend each calendar month (0: no monthly budget)
    month_spent: float  # this month, since the 1st at 00:00 UTC
    today: float  # in the last 24 hours, everyone's together
    daily_limit: float  # what one person's questions may cost in 24 hours
    model: str
    effort: str
    keep_warm: bool = False  # whether the server may keep the help loaded between questions (YJSP_ASSISTANT_KEEP_WARM)
    keep_hours: int | None = None  # for how long after a question, as admins chose (1 to 24); null: always
    keep_warm_spent: float = 0  # what that cost this month, in month_spent too
    feedback_spent: float = 0  # what Claude's looks at bug reports and feature requests cost this month, in month_spent
    month_questions: int = 0  # this month's questions
    month_questions_loaded: int = 0  # of those, the ones that found the help loaded, and read it for much less
    people: list[AssistantSpenderOut]  # the most spent first
