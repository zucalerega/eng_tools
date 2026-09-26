"""People and permissions API: your account, users, folder grants, and sign-in tokens."""

from fastapi import APIRouter

from .. import auth, vault
from ..models import UserStatus
from .deps import DB, ActiveUser, AnyUser
from .schemas import GrantIn, GrantsOut, InviteIn, TokenOut, UserOut, UserPatch

router = APIRouter(prefix="/api", tags=["people"])


@router.get("/me")
def get_me(user: AnyUser) -> UserOut:
    """Who you're signed in as, including whether an admin has approved you yet."""
    return UserOut.of(user)


@router.get("/users")
def get_users(user: ActiveUser, db: DB) -> list[UserOut]:
    """Admins see every account, including ones waiting for approval; others see active members."""
    return [UserOut.of(u) for u in vault.list_users(db, user)]


@router.post("/users", status_code=201)
def post_user(body: InviteIn, user: ActiveUser, db: DB) -> UserOut:
    """Invite an email (admins): that person is active from their first sign-in."""
    return UserOut.of(vault.invite_user(db, user, body.email, body.name))


@router.patch("/users/{user_id}")
def patch_user(user_id: int, body: UserPatch, user: ActiveUser, db: DB) -> UserOut:
    """Approve (status=active) or disable an account, or change admin rights (admins)."""
    status = UserStatus(body.status) if body.status else None
    return UserOut.of(vault.update_user(db, user, user_id, status=status, is_admin=body.is_admin, name=body.name))


@router.get("/grants")
def get_grants(user: ActiveUser, db: DB, path: str = "") -> GrantsOut:
    """Who has access to a folder, including grants inherited from the folders above it."""
    return GrantsOut.of(*vault.folder_grants(db, user, path))


@router.put("/grants")
def put_grant(body: GrantIn, user: ActiveUser, db: DB) -> GrantsOut:
    """Set (or with role=null, remove) a person's or everyone's role on a folder (leads and admins)."""
    vault.set_grant(db, user, body.path, user_id=body.user_id, role=body.role)
    return GrantsOut.of(*vault.folder_grants(db, user, body.path))


@router.get("/tokens")
def get_tokens(user: AnyUser, db: DB) -> list[TokenOut]:
    """Your signed-in browsers and clients."""
    return [TokenOut.of(t) for t in auth.list_tokens(db, user)]


@router.delete("/tokens/{token_id}", status_code=204)
def delete_token(token_id: int, user: AnyUser, db: DB) -> None:
    """Sign a browser or client out."""
    auth.revoke_token(db, user, token_id)
