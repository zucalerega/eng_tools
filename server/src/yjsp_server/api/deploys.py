"""Deploying main from the site: Admin > People's Deploy card, for the site's owner alone. deploy.py has the rules; the
deploy itself is yjsp-deploy's (deploy/deploy-here.sh), which the site can only start."""

from typing import Annotated

from fastapi import APIRouter, Query, Request

from ..deploy import Deploys
from .deps import ActiveUser
from .schemas import DeployIn, DeployLiveOut, DeployLogOut, DeployMainOut, DeployRunOut, DeploysOut

router = APIRouter(prefix="/api/deploys", tags=["deploys"])


def _deploys(request: Request) -> Deploys:
    return request.app.state.deploys


@router.get("")
def state(request: Request, user: ActiveUser) -> DeploysOut:
    """Whether deploying from the site is set up here, what's live, and the last deploys, a running one among them."""
    deploys = _deploys(request)
    deploys.require_owner(user)
    problem = deploys.problem()
    live = deploys.live()
    return DeploysOut(
        available=problem is None,
        reason=problem,
        repository=deploys.github.repository,
        live=DeployLiveOut(commit=live.commit, subject=live.subject, deployed_at=live.deployed_at) if live else None,
        deploys=[DeployRunOut.of(run) for run in deploys.deploys()],
    )


@router.get("/main")
def main(request: Request, user: ActiveUser, fresh: bool = False) -> DeployMainOut:
    """What deploying now would deploy, from GitHub: main's newest commit, CI on it, the migrations it would run, and
    main's commits since what's live. `fresh`: asked of GitHub anew, rather than as it said a few seconds ago."""
    deploys = _deploys(request)
    deploys.require_owner(user)
    return DeployMainOut.of(deploys.main(fresh))


@router.post("", status_code=202)
def start(body: DeployIn, request: Request, user: ActiveUser) -> DeployRunOut:
    """Deploy main's newest commit, which must be `commit` (what the card showed), once CI has passed on it: starts
    yjsp-deploy, and returns its deploy as it starts."""
    return DeployRunOut.of(_deploys(request).start(user, body.commit))


@router.get("/{deploy_id}/log")
def log(deploy_id: str, request: Request, user: ActiveUser, start: Annotated[int, Query(ge=0)] = 0) -> DeployLogOut:
    """What a deploy has said, from byte `start` of its log: ask again from `size` for what it says next."""
    deploys = _deploys(request)
    deploys.require_owner(user)
    text, size = deploys.log(deploy_id, start)
    return DeployLogOut(text=text, size=size)
