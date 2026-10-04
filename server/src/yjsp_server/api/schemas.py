"""Request and response bodies of the site's own API: accounts, sign-in, and tokens. Each app has its own
(vault/schemas.py, yorg/schemas.py)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from .. import auth
from ..models import SiteSettings, Token, User


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
    last_login_at: datetime | None
    # For admins (people.last_active): when they last used the site, and whether they're on now. Otherwise null and
    # false.
    last_active_at: datetime | None = None
    active_now: bool = False

    @classmethod
    def of(cls, user: User, last_active: datetime | None = None) -> "UserOut":
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
    whitelist: bool  # on: only invited people join, and anyone else who signs in waits for an admin's approval

    @classmethod
    def of(cls, site: SiteSettings) -> "SiteSettingsOut":
        return cls(whitelist=site.whitelist)


class SiteSettingsPatch(BaseModel):
    whitelist: bool | None = None  # turning it off approves everyone waiting


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


class ClientTokenIn(BaseModel):
    code: str
    verifier: str = Field(min_length=43, max_length=128)
