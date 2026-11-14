"""Bug reports and feature requests: members send them from Help in the web app, Claude looks at each for the site's
owner (Assistant.look), and on Admin > Requests the owner approves one, or an admin declines it, or marks it done, with
a reply for whoever sent it.

Approving starts Claude Code building it (docs/deploying.md, "Requests"): the server fires a Claude Code routine, a
saved cloud session on the owner's Claude account with the repository, whose own prompt says to build what it's sent,
as CLAUDE.md says, and open a draft pull request for the owner to review. The server sends the request, Claude's look,
and the owner's note, and keeps the link to the session it started; it never changes code itself. Only the owner
(YJSP_FEEDBACK_APPROVER) can approve, since the routine runs on their account, and what a member wrote reaches Claude
Code only after they've read it. Each request is approved at most once: there's no taking back a session that started.
"""

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

import httpx2
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, sessionmaker

from .assistant import Assistant
from .config import Settings
from .db import utcnow
from .errors import ApiError, Conflict, Forbidden, NotFound
from .models import Feedback, FeedbackKind, FeedbackStatus, User

log = logging.getLogger(__name__)

MOST_TITLE = 200
MOST_BODY = 10_000
MOST_PAGE = 500
MOST_REPLY = 2_000  # a reply to whoever sent it, or the owner's note to Claude Code
# How many one person can send in a day: each costs a look from Claude.
DAILY = 10
DAY = timedelta(hours=24)
# The most a routine fire takes (docs: 65,536 characters), less room to spare; and how long to wait for it.
MOST_FIRE = 60_000
FIRE_WAIT = 30.0


class FeedbackRoutineOff(ApiError):
    """Approving isn't set up on this server: no routine, or no owner to approve."""

    status = 503
    code = "feedback_routine_off"


class FeedbackRoutineFailed(ApiError):
    """Claude Code didn't start the routine: the request stays as it was, to approve again."""

    status = 502
    code = "feedback_routine_failed"


class TooMany(ApiError):
    status = 429
    code = "feedback_daily_limit"


@dataclass
class Sent:
    """What someone sends: a bug report or a feature request, from a page of the web app."""

    kind: str
    title: str
    body: str
    page: str | None


class Requests:
    """The requests on this server, and Claude's looks at them, each in a thread of its own as it's sent (or asked
    again), so sending one doesn't wait for Claude."""

    def __init__(self, settings: Settings, sessions: sessionmaker[Session], assistant: Assistant):
        self.settings = settings
        self.sessions = sessions
        self.assistant = assistant
        self._looking: set[int] = set()  # the requests Claude is looking at now
        self._threads: list[threading.Thread] = []
        self._lock = threading.Lock()

    def looking(self, feedback_id: int) -> bool:
        with self._lock:
            return feedback_id in self._looking

    def send(self, db: Session, user: User, sent: Sent) -> Feedback:
        """Keep what they sent, and have Claude look at it, for the owner."""
        kind = _kind(sent.kind)
        title, body = sent.title.strip(), sent.body.strip()
        if not title or len(title) > MOST_TITLE:
            raise ApiError(f"A request's title holds 1 to {MOST_TITLE} characters")
        if not body or len(body) > MOST_BODY:
            raise ApiError(f"Say what happened, or what you'd like, in 1 to {MOST_BODY:,} characters")
        page = (sent.page or "").strip()[:MOST_PAGE] or None
        recent = db.scalar(
            select(func.count()).where(Feedback.user_id == user.id, Feedback.created_at >= utcnow() - DAY)
        )
        if (recent or 0) >= DAILY:
            raise TooMany(f"You've sent {DAILY} requests in the last 24 hours: send more tomorrow")
        item = Feedback(user_id=user.id, kind=kind, title=title, body=body, page=page)
        db.add(item)
        db.commit()
        self.look_later(item.id)
        return item

    def look_again(self, db: Session, admin: User, feedback_id: int) -> Feedback:
        """Have Claude look at a request again, as after its budget ran out (admins)."""
        _require_admin(admin)
        item = _get(db, feedback_id)
        if self.looking(item.id):
            raise Conflict(f"Claude is looking at request #{item.id} now", code="feedback_looking")
        self.look_later(item.id)
        return item

    def look_later(self, feedback_id: int) -> None:
        with self._lock:
            if feedback_id in self._looking:
                return
            self._looking.add(feedback_id)
            thread = threading.Thread(target=self._look, args=(feedback_id,), name="feedback-look", daemon=True)
            self._threads = [t for t in self._threads if t.is_alive()] + [thread]
        thread.start()

    def wait(self) -> None:
        """Until Claude has looked at every request it's looking at (the tests)."""
        with self._lock:
            threads = list(self._threads)
        for thread in threads:
            thread.join()

    def _look(self, feedback_id: int) -> None:
        try:
            with self.sessions() as db:
                item = db.get_one(Feedback, feedback_id)
                kind, title, body, page = item.kind.value, item.title, item.body, item.page
            try:
                written, spent = self.assistant.look(kind, title, body, page)
                problem = None if written else "Claude wouldn't look at this one: read it yourself"
            except ApiError as error:
                written, spent, problem = None, 0, error.message
            with self.sessions() as db:
                item = db.get_one(Feedback, feedback_id)
                if written:
                    item.evaluation = written
                item.evaluation_problem = problem
                item.evaluated_at = utcnow()
                item.evaluation_cost += spent
                db.commit()
        except Exception:  # a look that broke mustn't take the server with it: an admin can ask again
            log.exception("Claude's look at request %s broke", feedback_id)
        finally:
            with self._lock:
                self._looking.discard(feedback_id)

    def mine(self, db: Session, user: User) -> list[Feedback]:
        """The requests someone has sent, the newest first."""
        return list(
            db.scalars(select(Feedback).where(Feedback.user_id == user.id).order_by(Feedback.created_at.desc()))
        )

    def everyone(self, db: Session, admin: User) -> list[Feedback]:
        """Every request, the newest first (admins)."""
        _require_admin(admin)
        return list(db.scalars(select(Feedback).order_by(Feedback.created_at.desc())))

    def _check_owner(self, user: User) -> None:
        """Fails unless this person can approve requests on this server: the owner, with the routine set up."""
        settings = self.settings
        owner = settings.feedback_approver.strip().lower()
        if not owner:
            raise FeedbackRoutineOff("No one can approve requests on this server: its YJSP_FEEDBACK_APPROVER isn't set")
        if not user.is_admin or user.email.lower() != owner:
            raise Forbidden(
                "Only the site's owner can approve requests, as Claude Code builds them on their account",
                code="feedback_owner_only",
            )
        if not settings.feedback_routine_url or not settings.feedback_routine_token:
            raise FeedbackRoutineOff(
                "Approving needs the Claude Code routine that builds requests: set YJSP_FEEDBACK_ROUTINE_URL and "
                "YJSP_FEEDBACK_ROUTINE_TOKEN in the server's .env"
            )

    def why_not_approve(self, user: User) -> str | None:
        """Why this person can't approve requests on this server, or None if they can."""
        try:
            self._check_owner(user)
        except ApiError as error:
            return error.message
        return None

    def approve(self, db: Session, owner: User, feedback_id: int, note: str | None) -> Feedback:
        """Have Claude Code build a request: start the routine with it, and keep the link to its session (the owner)."""
        self._check_owner(owner)
        note = _words(note, "A note for Claude Code")
        item = _get(db, feedback_id)
        # Claimed first, so a second click, or a second tab, can't start a second session.
        claimed = db.execute(
            update(Feedback)
            .where(Feedback.id == item.id, Feedback.status == FeedbackStatus.NEW)
            .values(status=FeedbackStatus.APPROVED, decided_by_id=owner.id, decided_at=utcnow(), note=note)
        ).rowcount
        db.commit()
        db.refresh(item)
        if not claimed:
            raise _decided(item)
        try:
            url = fire(self.settings, _for_claude_code(item))
        except ApiError:
            item.status, item.decided_by_id, item.decided_at, item.note = FeedbackStatus.NEW, None, None, None
            db.commit()
            raise
        item.session_url = url
        db.commit()
        return item

    def decline(self, db: Session, admin: User, feedback_id: int, reply: str | None) -> Feedback:
        """Turn a request down, saying why to whoever sent it (admins)."""
        _require_admin(admin)
        reply = _words(reply, "A reply")
        if reply is None:
            raise ApiError("Say why it's declined: whoever sent it sees your reply")
        item = _get(db, feedback_id)
        if item.status != FeedbackStatus.NEW:
            raise _decided(item)
        item.status, item.reply, item.decided_by_id, item.decided_at = (
            FeedbackStatus.DECLINED,
            reply,
            admin.id,
            utcnow(),
        )
        db.commit()
        return item

    def finish(self, db: Session, admin: User, feedback_id: int, reply: str | None) -> Feedback:
        """Mark a request done, as when what Claude Code built has merged, with a reply for whoever sent it (admins)."""
        _require_admin(admin)
        reply = _words(reply, "A reply")
        item = _get(db, feedback_id)
        if item.status in (FeedbackStatus.DONE, FeedbackStatus.DECLINED):
            raise _decided(item)
        item.status, item.decided_by_id, item.decided_at = FeedbackStatus.DONE, admin.id, utcnow()
        if reply is not None:
            item.reply = reply
        db.commit()
        return item


def fire(settings: Settings, text: str) -> str:
    """Start the routine with `text`: the link to the Claude Code session it started. Fails with what to do next if
    Claude Code doesn't start it (docs: platform.claude.com/docs/en/api/claude-code/routines-fire)."""
    headers = {
        "Authorization": f"Bearer {settings.feedback_routine_token}",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
    }
    try:
        response = httpx2.post(settings.feedback_routine_url, json={"text": text}, headers=headers, timeout=FIRE_WAIT)
    except httpx2.HTTPError as error:
        log.warning("Starting the routine failed: %s", type(error).__name__)
        raise FeedbackRoutineFailed("The server couldn't reach Claude Code to start building it: try again") from None
    if response.status_code == 200:
        try:
            url = response.json()["claude_code_session_url"]
        except (ValueError, KeyError, TypeError):
            url = None
        if isinstance(url, str) and url.startswith("https://"):
            return url
        raise FeedbackRoutineFailed("Claude Code started building it, but didn't say where: look on claude.ai/code")
    said = _said(response)
    log.warning("Claude Code didn't start the routine (%s): %s", response.status_code, said)
    status = response.status_code
    if status == 401:
        message = (
            "Claude Code turned down the routine's token: make a new one on the routine's page (claude.ai/code/routines) "
            "and put it in the server's YJSP_FEEDBACK_ROUTINE_TOKEN"
        )
    elif status == 403:
        message = "Claude Code won't start routines for the owner's Claude account: check its plan at claude.ai"
    elif status == 404:
        message = "Claude Code has no routine at YJSP_FEEDBACK_ROUTINE_URL: copy the URL from the routine's API trigger"
    elif status == 429:
        message = "Claude Code has started as many routines as it will this hour: approve it again later"
    elif status >= 500:
        message = "Claude Code is overloaded or down just now: approve it again in a few minutes"
    else:
        message = f"Claude Code didn't start building it ({said}): if the routine is paused, turn it back on"
    raise FeedbackRoutineFailed(message)


def _said(response: httpx2.Response) -> str:
    """What Claude Code said was wrong, from its error."""
    try:
        error = response.json().get("error", {})
        said = error.get("message") if isinstance(error, dict) else None
    except (ValueError, AttributeError):
        said = None
    return str(said)[:200] if said else f"HTTP {response.status_code}"


def _for_claude_code(item: Feedback) -> str:
    """What the routine is sent: the request, the owner's note, and Claude's look. Not who sent it: the pull request
    has no need of their name."""
    kind = "bug report" if item.kind == FeedbackKind.BUG else "feature request"
    parts = [
        f"YJSP request #{item.id}: a {kind} from a team member, which the owner has read and approved for you to build.",
        f"Sent on {item.created_at:%Y-%m-%d}, from {item.page or 'the web app'}.",
        f"## Title\n\n{item.title}",
        f"## What they wrote\n\n{item.body}",
    ]
    if item.note:
        parts.append(f"## The owner's note\n\n{item.note}")
    if item.evaluation:
        parts.append(f"## Claude's look at it, from the site's help, before it was approved\n\n{item.evaluation}")
    text = "\n\n".join(parts)
    return text if len(text) <= MOST_FIRE else text[:MOST_FIRE] + "\n\n[Cut off: it was too long to send whole.]"


def _kind(kind: str) -> FeedbackKind:
    try:
        return FeedbackKind(kind)
    except ValueError:
        raise ApiError("A request is a bug report (bug) or a feature request (feature)") from None


def _words(text: str | None, what: str) -> str | None:
    text = (text or "").strip()
    if len(text) > MOST_REPLY:
        raise ApiError(f"{what} holds up to {MOST_REPLY:,} characters")
    return text or None


def _get(db: Session, feedback_id: int) -> Feedback:
    item = db.get(Feedback, feedback_id)
    if item is None:
        raise NotFound(f"Request #{feedback_id} not found")
    return item


def _decided(item: Feedback) -> Conflict:
    said = {
        FeedbackStatus.APPROVED: "was approved already: Claude Code is building it",
        FeedbackStatus.DECLINED: "was declined already",
        FeedbackStatus.DONE: "is done already",
        FeedbackStatus.NEW: "changed meanwhile: look again",
    }[item.status]
    return Conflict(f"Request #{item.id} {said}", code="feedback_decided")


def _require_admin(user: User) -> None:
    if not user.is_admin:
        raise Forbidden("Only admins can see everyone's requests and answer them", code="admin_only")


# For the API's responses: who's who, without a query for each.
Names = Callable[[int | None], User | None]


def names(db: Session, items: list[Feedback]) -> Names:
    ids = {i.user_id for i in items} | {i.decided_by_id for i in items if i.decided_by_id}
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}
    return lambda user_id: users.get(user_id) if user_id is not None else None
