"""Deals' API: the deals found for what the team wants, dismissing one, and for admins how the finder's doing and a
search now; and the address eBay's account deletion notifications go to. deals/finder.py has the rules."""

from typing import Annotated

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import select

from ..deals.finder import ENDPOINT, Deals
from ..models import User
from .deps import DB, ActiveUser
from .schemas import DealDismissIn, DealOut, DealRunOut, DealsStatusOut

router = APIRouter(prefix="/api/deals", tags=["deals"])


def _deals(request: Request) -> Deals:
    return request.app.state.deals


@router.get("")
def get_deals(
    request: Request,
    user: ActiveUser,
    db: DB,
    app: Annotated[str, Query(max_length=40, pattern=r"^[a-z]*$")] = "",
    limit: Annotated[int, Query(ge=1, le=200)] = 60,
) -> list[DealOut]:
    """The deals to show, the best first: checked on their source in the last six hours, neither gone nor dismissed.
    app: only those for what one app wants (buildflow, vault, piper)."""
    return [DealOut.of(deal) for deal in _deals(request).shown(db, app or None, limit)]


@router.put("/{deal_id}/dismissed")
def put_dismissed(deal_id: int, body: DealDismissIn, request: Request, user: ActiveUser, db: DB) -> DealOut:
    """Say a deal won't do (dismissed), so it isn't shown or found again for what it's for; or take that back."""
    return DealOut.of(_deals(request).dismiss(db, user, deal_id, body.dismissed))


def _status(request: Request, db: DB, user: User) -> DealsStatusOut:
    status = _deals(request).status(db, user)
    ids = {run.started_by for run in status.runs if run.started_by is not None}
    people = {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}
    return DealsStatusOut(
        available=status.available,
        reason=status.reason,
        claude=status.claude,
        running=status.running,
        next_search=status.next_search,
        shown=status.shown,
        runs=[DealRunOut.of(run, people.get(run.started_by or 0)) for run in status.runs],
    )


@router.get("/status")
def get_status(request: Request, user: ActiveUser, db: DB) -> DealsStatusOut:
    """How the deals finder's doing: whether it's set up, its last runs, and when it searches next (admins)."""
    return _status(request, db, user)


@router.post("/search", status_code=202)
def post_search(request: Request, user: ActiveUser, db: DB) -> DealsStatusOut:
    """Search for everything the team wants now, in the background (admins): 409 `deals_running` if a run's going,
    503 `deals_off` if it isn't set up."""
    _deals(request).search_later(user)
    return _status(request, db, user)


# eBay's Marketplace Account Deletion notifications, which a production keyset has to answer (docs/deploying.md,
# "Deals"). Deals keep nothing of anyone on eBay, so a notification needs nothing done: it's acknowledged. Not signed
# in: eBay calls them.


@router.get(ENDPOINT.removeprefix("/api/deals"), include_in_schema=False)
def get_ebay_challenge(
    request: Request, challenge_code: Annotated[str, Query(min_length=1, max_length=500)]
) -> dict[str, str]:
    """eBay checking it's this site's address: the hash of its code, the verification token, and the address."""
    return {"challengeResponse": _deals(request).challenge(challenge_code)}


@router.post(ENDPOINT.removeprefix("/api/deals"), status_code=204, include_in_schema=False)
def post_ebay_notification(request: Request) -> Response:
    """An eBay account deleted: nothing of it is kept here."""
    _deals(request).challenge("")  # 404 unless the address is set up
    return Response(status_code=204)
