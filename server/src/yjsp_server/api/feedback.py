"""Bug reports and feature requests' API: sending one, with screenshots, and seeing your own, and for admins, every
one, Claude's look at each, and answering them; the owner approves one to have Claude Code build it. feedback.py has
the rules."""

from fastapi import APIRouter, Request, Response

from ..feedback import Requests, Sent, names
from ..models import Feedback
from .deps import DB, ActiveUser
from .schemas import FeedbackApproveIn, FeedbackIn, FeedbackListOut, FeedbackOut, FeedbackReplyIn

router = APIRouter(prefix="/api/feedback", tags=["feedback"])


def _requests(request: Request) -> Requests:
    return request.app.state.feedback


def _as_admin(request: Request, db: DB, item: Feedback) -> FeedbackOut:
    return FeedbackOut.of(item, names(db, [item]), _requests(request).looking(item.id))


@router.post("")
def send(body: FeedbackIn, request: Request, user: ActiveUser, db: DB) -> FeedbackOut:
    """Send a bug report or a feature request. Claude looks at it for the owner meanwhile."""
    item = _requests(request).send(db, user, Sent(body.kind, body.title, body.body, body.page, body.screenshots))
    return FeedbackOut.of(item)


@router.get("/mine")
def mine(request: Request, user: ActiveUser, db: DB) -> list[FeedbackOut]:
    """The requests you've sent, the newest first, with what's become of each."""
    return [FeedbackOut.of(item) for item in _requests(request).mine(db, user)]


@router.get("/{feedback_id}/screenshots/{screenshot_id}")
def screenshot(feedback_id: int, screenshot_id: int, request: Request, user: ActiveUser, db: DB) -> Response:
    """A screenshot sent with a request, as it was sent: for whoever sent it, and admins."""
    found = _requests(request).screenshot(db, user, feedback_id, screenshot_id)
    # Never changes, and it's theirs: the browser keeps it, and nothing shared between does.
    headers = {"Cache-Control": "private, max-age=31536000, immutable"}
    return Response(found.data, media_type=found.content_type, headers=headers)


@router.get("")
def everyone(request: Request, user: ActiveUser, db: DB) -> FeedbackListOut:
    """Every request, the newest first, with Claude's look at each (admins)."""
    requests = _requests(request)
    items = requests.everyone(db, user)
    who = names(db, items)
    why = requests.why_not_approve(user)
    return FeedbackListOut(
        requests=[FeedbackOut.of(item, who, requests.looking(item.id)) for item in items],
        can_approve=why is None,
        why_not_approve=why,
    )


@router.post("/{feedback_id}/approve")
def approve(feedback_id: int, body: FeedbackApproveIn, request: Request, user: ActiveUser, db: DB) -> FeedbackOut:
    """Have Claude Code build it: starts the routine, and returns the link to its session (the owner)."""
    return _as_admin(request, db, _requests(request).approve(db, user, feedback_id, body.note))


@router.post("/{feedback_id}/decline")
def decline(feedback_id: int, body: FeedbackReplyIn, request: Request, user: ActiveUser, db: DB) -> FeedbackOut:
    """Turn it down, saying why to whoever sent it (admins)."""
    return _as_admin(request, db, _requests(request).decline(db, user, feedback_id, body.reply))


@router.post("/{feedback_id}/done")
def done(feedback_id: int, body: FeedbackReplyIn, request: Request, user: ActiveUser, db: DB) -> FeedbackOut:
    """Mark it done, with a reply for whoever sent it if you like (admins)."""
    return _as_admin(request, db, _requests(request).finish(db, user, feedback_id, body.reply))


@router.post("/{feedback_id}/look")
def look(feedback_id: int, request: Request, user: ActiveUser, db: DB) -> FeedbackOut:
    """Have Claude look at it again, as when it couldn't before (admins)."""
    return _as_admin(request, db, _requests(request).look_again(db, user, feedback_id))
