"""Accounts as admins and their owners change them: inviting, approving, and disabling people, admin rights, the
whitelist, and your own name; and who has been on when, and how full the server's disk is.

Vault's index carries people's names and what they may see, so a change here makes every Vault client sync everything
again (vault.people_changed), and it goes in Vault's activity log (vault.log), the site's only one.
"""

import re
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import disk
from .config import Settings
from .errors import ApiError, Conflict, Forbidden, NotFound
from .models import SiteSettings, Token, User, UserStatus
from .vault import vault

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def init(db: Session) -> None:
    """Create the site_settings row if it isn't there yet."""
    if db.get(SiteSettings, 1) is None:
        db.add(SiteSettings(id=1, whitelist=False))
        db.commit()


def _require_admin(user: User) -> None:
    if not user.is_admin:
        raise Forbidden("Only admins can do that", code="admin_only")


def list_users(db: Session, user: User) -> list[User]:
    """Admins see every account; everyone else sees active members (to grant access, say)."""
    stmt = select(User).order_by(User.name, User.email)
    if not user.is_admin:
        stmt = stmt.where(User.status == UserStatus.ACTIVE)
    return list(db.scalars(stmt))


def last_active(db: Session, viewer: User) -> dict[int, datetime]:
    """
    When each account last used the site, by user id: its last sign-in, or the last use of any of its sessions and
    clients (the web app, the add-in, the CLI). Only admins see when people were on; anyone else gets nothing.
    """
    if not viewer.is_admin:
        return {}
    found: dict[int, datetime] = {}
    uses = db.execute(select(Token.user_id, func.max(Token.last_used_at)).group_by(Token.user_id)).all()
    logins = db.execute(select(User.id, User.last_login_at)).all()
    for user_id, at in [*uses, *logins]:
        if at is not None and (user_id not in found or at > found[user_id]):
            found[user_id] = at
    return found


def time_on_site(viewer: User, user: User) -> int | None:
    """How long the account has had the web app open, in seconds (auth.authenticate counts it). Only for admins."""
    return user.site_seconds if viewer.is_admin else None


def invite_user(db: Session, admin: User, email: str, name: str = "") -> User:
    """Pre-approve an email: the account is active from its first sign-in."""
    _require_admin(admin)
    email = email.strip().lower()
    if not _EMAIL.match(email):
        raise ApiError(f"{email!r} isn't an email address", code="bad_email")
    vault.begin_write(db)
    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise Conflict(f"{email} already has an account", code="exists")
    user = User(email=email, name=name.strip(), status=UserStatus.INVITED)
    db.add(user)
    vault.log(db, admin, "invite_user", email=email)
    db.commit()
    return user


def update_user(
    db: Session,
    admin: User,
    user_id: int,
    *,
    status: UserStatus | None = None,
    is_admin: bool | None = None,
    name: str | None = None,
) -> User:
    """Approve or disable an account, make or unmake an admin, fix a name."""
    _require_admin(admin)
    seq = vault.begin_write(db)
    user = db.get(User, user_id)
    if user is None:
        raise NotFound(f"User {user_id} not found")
    if user.id == admin.id and (status not in (None, UserStatus.ACTIVE) or is_admin is False):
        raise ApiError("You can't disable yourself or drop your own admin rights", code="self_lockout")
    changes: dict[str, Any] = {}
    if status is not None and status != user.status:
        if status not in (UserStatus.ACTIVE, UserStatus.DISABLED):
            raise ApiError("An account can be set active or disabled", code="bad_status")
        user.status = status
        changes["status"] = status.value
    if is_admin is not None and is_admin != user.is_admin:
        user.is_admin = is_admin
        changes["is_admin"] = is_admin
    if name is not None and name.strip() != user.name:
        user.name = name.strip()
        changes["name"] = user.name
    if changes:
        vault.people_changed(db, seq)
        vault.log(db, admin, "update_user", email=user.email, **changes)
    db.commit()
    return user


def rename_self(db: Session, user: User, name: str) -> User:
    """Change your own name: how everyone sees you. (An admin fixes anyone's with update_user; signing in again keeps
    it, auth.sign_in.)"""
    name = name.strip()
    if not name:
        raise ApiError("A name can't be empty", code="bad_name")
    if len(name) > 200:
        raise ApiError("A name can be at most 200 characters", code="bad_name")
    seq = vault.begin_write(db)
    me = db.get_one(User, user.id)
    if name != me.name:
        me.name = name
        vault.people_changed(db, seq)  # names come with the vault's index
        vault.log(db, me, "update_user", email=me.email, name=name)
    db.commit()
    return me


def site_settings(db: Session, user: User) -> SiteSettings:
    """What admins decide for everyone: whether new people need an invite or approval to join (the whitelist)."""
    _require_admin(user)
    return db.get_one(SiteSettings, 1)


def disk_usage(db: Session, admin: User, settings: Settings) -> disk.DiskUsage:
    """How full the server's disk is, and how much of it Vault's files, Yorg's, and the database take (admins)."""
    _require_admin(admin)
    return disk.measure(db, settings)


def update_site_settings(db: Session, admin: User, *, whitelist: bool | None = None) -> SiteSettings:
    """Turn the whitelist on or off.

    Accounts that already exist keep their status either way. Off, anyone who signs in joins at once
    (auth.sign_in), so the people waiting for approval are approved now: they could sign in again to join.
    """
    _require_admin(admin)
    seq = vault.begin_write(db)
    site = db.get_one(SiteSettings, 1)
    if whitelist is not None and whitelist != site.whitelist:
        site.whitelist = whitelist
        vault.log(db, admin, "update_settings", whitelist=whitelist)
        waiting = [] if whitelist else list(db.scalars(select(User).where(User.status == UserStatus.PENDING)))
        for user in waiting:
            user.status = UserStatus.ACTIVE
            vault.log(db, admin, "update_user", email=user.email, status=user.status.value)
        if waiting:
            vault.people_changed(db, seq)
    db.commit()
    return site
