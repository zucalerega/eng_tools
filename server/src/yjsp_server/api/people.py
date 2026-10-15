"""People API: your account, everyone's (for admins), the whitelist, how full the server's disk is (for admins), and
your sign-in tokens."""

from dataclasses import asdict

from fastapi import APIRouter

from .. import auth, people
from ..models import UserStatus
from .deps import DB, ActiveUser, AnyUser, Config
from .schemas import (
    InviteIn,
    MePatch,
    SiteSettingsOut,
    SiteSettingsPatch,
    StorageOut,
    TokenOut,
    UserOut,
    UserPatch,
)

router = APIRouter(prefix="/api", tags=["people"])


@router.get("/me")
def get_me(user: AnyUser) -> UserOut:
    """Who you're signed in as, including whether an admin has approved you yet."""
    return UserOut.of(user)


@router.patch("/me")
def patch_me(body: MePatch, user: ActiveUser, db: DB) -> UserOut:
    """Change your own name."""
    return UserOut.of(people.rename_self(db, user, body.name))


@router.get("/users")
def get_users(user: ActiveUser, db: DB) -> list[UserOut]:
    """Admins see every account, including ones waiting for approval, and when each was last on; others see active
    members."""
    active = people.last_active(db, user)
    return [UserOut.of(u, active.get(u.id), people.time_on_site(user, u)) for u in people.list_users(db, user)]


@router.post("/users", status_code=201)
def post_user(body: InviteIn, user: ActiveUser, db: DB) -> UserOut:
    """Invite an email (admins): that person is active from their first sign-in."""
    return UserOut.of(people.invite_user(db, user, body.email, body.name))


@router.patch("/users/{user_id}")
def patch_user(user_id: int, body: UserPatch, user: ActiveUser, db: DB) -> UserOut:
    """Approve (status=active) or disable an account, or change admin rights (admins)."""
    status = UserStatus(body.status) if body.status else None
    return UserOut.of(people.update_user(db, user, user_id, status=status, is_admin=body.is_admin, name=body.name))


@router.get("/settings")
def get_site_settings(user: ActiveUser, db: DB) -> SiteSettingsOut:
    """Whether new people need an invite or an admin's approval to join: the whitelist (admins)."""
    return SiteSettingsOut.of(people.site_settings(db, user))


@router.patch("/settings")
def patch_site_settings(body: SiteSettingsPatch, user: ActiveUser, db: DB) -> SiteSettingsOut:
    """Turn the whitelist on or off (admins). Off, anyone can join, so it approves everyone waiting too."""
    return SiteSettingsOut.of(people.update_site_settings(db, user, whitelist=body.whitelist))


@router.get("/storage")
def get_storage(user: ActiveUser, db: DB, settings: Config) -> StorageOut:
    """How full the server's disk is, and how much of it Vault's files, Yorg's, and the database take (admins)."""
    return StorageOut(**asdict(people.disk_usage(db, user, settings)))


@router.get("/tokens")
def get_tokens(user: AnyUser, db: DB) -> list[TokenOut]:
    """Your signed-in browsers and clients."""
    return [TokenOut.of(t) for t in auth.list_tokens(db, user)]


@router.delete("/tokens/{token_id}", status_code=204)
def delete_token(token_id: int, user: AnyUser, db: DB) -> None:
    """Sign a browser or client out."""
    auth.revoke_token(db, user, token_id)
