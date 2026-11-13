"""The assistant's API: whether you can ask Claude, asking it (the answer comes as it's written), and what it has cost
(admins). assistant.py has its rules."""

from dataclasses import asdict

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ..assistant import Assistant, Turn
from .deps import DB, ActiveUser
from .schemas import AskIn, AssistantOut, AssistantSettingsIo, AssistantSpenderOut, AssistantSpendingOut, UserRef

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


def _assistant(request: Request) -> Assistant:
    return request.app.state.assistant


@router.get("")
def get_assistant(request: Request, user: ActiveUser, db: DB) -> AssistantOut:
    """Whether you can ask Claude now (and if not, why), and how much of your daily limit you've used."""
    return AssistantOut(**asdict(_assistant(request).status(db, user)))


@router.post("/ask")
def ask(body: AskIn, request: Request, user: ActiveUser, db: DB) -> StreamingResponse:
    """Ask Claude the conversation's last question. The answer comes as lines of JSON as Claude writes it
    (application/x-ndjson): {"type": "thinking"} while it thinks, {"type": "text", "text": ...} for each piece, and last
    {"type": "done", "stop_reason": ..., "day_used": ...} or {"type": "error", "error": code, "message": ...}."""
    turns = [Turn(m.role, m.text, m.page) for m in body.messages]
    answer = _assistant(request).ask(db, user, turns)
    # The answer can take minutes to come, and needs nothing more of the database: its connection goes back now, rather
    # than when the response ends, so a few answers at once don't hold every connection the server has.
    db.close()
    # No proxy on the way should hold the answer back to send it whole.
    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(answer.lines(), media_type="application/x-ndjson", headers=headers)


@router.get("/spending")
def get_spending(request: Request, user: ActiveUser, db: DB) -> AssistantSpendingOut:
    """What the assistant has cost, in all, this month, today, and on each person's questions; its budgets and limits
    (admins)."""
    found = _assistant(request).spending(db, user)
    people = [
        AssistantSpenderOut(
            user=UserRef.of(p.user), questions=p.questions, spent=p.spent, last_asked_at=p.last_asked_at
        )
        for p in found.people
    ]
    return AssistantSpendingOut(
        available=found.available,
        reason=found.reason,
        budget=found.budget,
        spent=found.spent,
        monthly_budget=found.monthly_budget,
        month_spent=found.month_spent,
        today=found.today,
        daily_limit=found.daily_limit,
        model=found.model,
        effort=found.effort,
        keep_warm=found.keep_warm,
        keep_hours=found.keep_hours,
        keep_warm_spent=found.keep_warm_spent,
        month_questions=found.month_questions,
        month_questions_loaded=found.month_questions_loaded,
        people=people,
    )


@router.put("/settings")
def put_settings(body: AssistantSettingsIo, request: Request, user: ActiveUser, db: DB) -> AssistantSettingsIo:
    """Keep the help loaded for Claude around the clock (keep_hours null), or only for some hours after each question
    (admins)."""
    return AssistantSettingsIo(keep_hours=_assistant(request).keep_loaded(db, user, body.keep_hours))
