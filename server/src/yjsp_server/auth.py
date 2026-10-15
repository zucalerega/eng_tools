"""Accounts and credentials: signing in with Google or a Georgia Tech account, tokens, and the CLI/add-in browser
sign-in."""

import base64
import hashlib
import hmac
import secrets
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from . import usage
from .config import Settings
from .db import utcnow
from .errors import Forbidden, NotFound
from .models import ClientAuthCode, SiteSettings, Token, User, UserStatus, WhitelistEmail

SESSION = "session"  # browser cookie
CLIENT = "client"  # CLI or SolidWorks add-in, sent as "Authorization: Bearer ..."
CODE_TTL = timedelta(minutes=5)
# How often a token's last_used_at is refreshed: often enough to tell who's on now (an open page asks every few
# seconds), without a write for every request.
_TOUCH_EVERY = timedelta(minutes=1)
ACTIVE_NOW = 2 * _TOUCH_EVERY  # last active this recently: on now
# A CLI's or the add-in's token unused this long has lapsed: a laptop left in a drawer, or one that went missing, isn't
# signed in forever. The clients say the sign-in expired and ask for a new one. (A browser's session has a fixed end.)
CLIENT_IDLE = timedelta(days=90)
# A browser session used again within this long was open the whole time, so the gap counts as time on the site. An
# open page asks who you are every minute while it's visible (session.ts); a longer gap means the page was closed or
# hidden.
_SAME_VISIT = timedelta(minutes=5)
# Georgia Tech's accounts are Microsoft 365 accounts, in GT's own directory (tenant) in Microsoft Entra, which sends
# their sign-ins to GT's login page, Duo and all. Signing in with Microsoft lets in only this tenant's people.
GT_TENANT = "482198bb-ae7b-4b25-8b7a-6d7f32faa083"
GT_DOMAIN = "gatech.edu"


def _digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def whitelist_on(db: Session) -> bool:
    """Whether only the emails on the whitelist, and people admins invite, can make an account (Admin > Whitelist in
    the web app)."""
    return db.get_one(SiteSettings, 1).whitelist


def sign_in(db: Session, settings: Settings, *, subject: str, email: str, name: str, email_verified: bool) -> User:
    """Find the account for a Google identity.

    Google doesn't make new accounts (since October 2026): new people join with their Georgia Tech account. It signs
    in to one that's there already: its own, or one under its email, such as an admin's invite. Emails in
    YJSP_BOOTSTRAP_ADMINS are always active admins, made if need be. A disabled account stays disabled.
    """
    if not email_verified:
        raise Forbidden("Your Google account's email address isn't verified", code="unverified_email")
    email = email.strip().lower()
    return _sign_in(db, settings, "google_sub", subject, [email], name, "Google account", makes_accounts=False)


def sign_in_microsoft(db: Session, settings: Settings, claims: Mapping[str, Any]) -> User:
    """Find or create the account for a Georgia Tech account, from the ID token Microsoft signed (whose signature,
    issuer, audience, and nonce the sign-in has checked).

    Only GT's own people get in: the token must come from GT's tenant, for someone with a GT address. A guest whom GT
    invited from outside has an outside address. An account is tied to the person's Microsoft object ID, which stays
    the same even if the app is registered again, and found the first time by any of their GT addresses: their GT
    username's (gburdell3@gatech.edu), or an alias. The rest is as for Google (sign_in), except that a GT account
    makes a new account: anyone's while the whitelist is off, and only one whose address is on it while it's on.
    """
    addresses = [claims.get("preferred_username"), claims.get("email")]  # the username's first, for new accounts
    found = [a.strip().lower() for a in addresses if isinstance(a, str)]
    gt_addresses = list(dict.fromkeys(a for a in found if gt_address(a)))
    subject = claims.get("oid")
    if claims.get("tid") != GT_TENANT or not isinstance(subject, str) or not subject or not gt_addresses:
        raise Forbidden(
            f"Only Georgia Tech accounts sign in this way: sign in with your GT username (like gburdell3@{GT_DOMAIN})",
            code="not_georgia_tech",
        )
    name = claims.get("name")
    name = name if isinstance(name, str) else ""
    return _sign_in(db, settings, "microsoft_oid", subject, gt_addresses, name, "GT account", makes_accounts=True)


def sign_in_dev(db: Session, settings: Settings, email: str, name: str) -> User:
    """Sign in as any email, for local development (YJSP_DEV_AUTH), as if Georgia Tech vouched for it: a new account
    follows GT's rules, the whitelist's, so they can be tried out."""
    email = email.strip().lower()
    name = name or email.split("@")[0]
    return _sign_in(db, settings, "google_sub", f"dev:{email}", [email], name, "Google account", makes_accounts=True)


def gt_address(address: str) -> bool:
    """Whether it's a Georgia Tech address: GT's own domain, or one of its departments'."""
    _, at, domain = address.rpartition("@")
    return bool(at) and (domain == GT_DOMAIN or domain.endswith("." + GT_DOMAIN))


def _sign_in(
    db: Session,
    settings: Settings,
    identity: Literal["google_sub", "microsoft_oid"],
    subject: str,
    addresses: list[str],
    name: str,
    kind: str,
    *,
    makes_accounts: bool,
) -> User:
    """The account for an identity a sign-in vouched for, with the rules of sign_in and sign_in_microsoft.

    It's found by the identity, or else by the first of its addresses that has an account (an invite, say, or the
    same person's account from another sign-in), which the identity is tied to from then on. Only a sign-in that
    makes_accounts makes one, and only with the whitelist off or for an address on it; a bootstrap admin's is always
    made. Anyone else is turned away, told what to do, rather than left waiting for an admin.
    """
    column = getattr(User, identity)
    user = db.scalar(select(User).where(column == subject))
    if user is None:
        for address in addresses:
            if (user := db.scalar(select(User).where(User.email == address))) is not None:
                break
        if user is not None and getattr(user, identity) not in (None, subject):
            raise Forbidden(f"{user.email} belongs to a different {kind}", code="identity_mismatch")
    admin = not settings.admin_emails.isdisjoint(addresses)
    listed = db.scalar(select(WhitelistEmail).where(WhitelistEmail.email.in_(addresses)).limit(1))
    if user is None:
        if not admin and not makes_accounts:
            raise Forbidden(
                f"{addresses[0]} has no YJSP account, and Google doesn't make new ones: sign in with your Georgia Tech "
                "account, or ask an admin to invite this email",
                code="no_account",
            )
        if not admin and listed is None and whitelist_on(db):
            raise Forbidden(
                f"{addresses[0]} isn't on YJSP's whitelist: ask an admin to add it, then sign in again",
                code="not_whitelisted",
            )
        user = User(email=addresses[0], name=name.strip(), status=UserStatus.ACTIVE)
        db.add(user)
    setattr(user, identity, subject)
    user.name = user.name or name.strip()
    if admin:
        user.status, user.is_admin = UserStatus.ACTIVE, True
    elif user.status == UserStatus.INVITED:
        user.status = UserStatus.ACTIVE
    elif user.status == UserStatus.PENDING and (listed is not None or not whitelist_on(db)):
        user.status = UserStatus.ACTIVE  # waiting from before, and let in since
    if listed is not None and listed.user_id is None:
        db.flush()  # the new account's id
        listed.user_id = user.id
    user.last_login_at = utcnow()
    db.commit()
    return user


def issue_token(db: Session, user: User, *, kind: str, name: str, ttl: timedelta | None = None) -> str:
    """A new secret for the user. Only its hash is stored, so it can't be shown again."""
    secret = "yjsp_" + secrets.token_urlsafe(32)
    now = utcnow()
    db.add(
        Token(
            user_id=user.id,
            kind=kind,
            name=name[:200],
            token_hash=_digest(secret),
            created_at=now,
            expires_at=now + ttl if ttl else None,
        )
    )
    db.commit()
    return secret


def authenticate(db: Session, secret: str) -> User | None:
    """The user a token belongs to, if the token is valid. Account status is the caller's check."""
    token = db.scalar(select(Token).where(Token.token_hash == _digest(secret)))
    now = utcnow()
    if token is None or not _valid(token, now):
        return None
    last_used = token.last_used_at
    if last_used is None or now - last_used > _TOUCH_EVERY:
        # Only if no other request touched it first, so a gap is counted once.
        unchanged = Token.last_used_at.is_(None) if last_used is None else Token.last_used_at == last_used
        touched = db.execute(update(Token).where(Token.id == token.id, unchanged).values(last_used_at=now)).rowcount
        if touched:
            visit = token.kind == SESSION and last_used is not None and now - last_used <= _SAME_VISIT
            usage.record(db, token.user_id, now, round((now - last_used).total_seconds()) if visit else 0)
        db.commit()
    return db.get(User, token.user_id)


def active_now(last_active: datetime | None) -> bool:
    """Whether someone last active then is using the site now: a page open, the add-in, or the CLI."""
    return last_active is not None and utcnow() - last_active <= ACTIVE_NOW


def revoke_secret(db: Session, secret: str) -> None:
    db.execute(
        update(Token).where(Token.token_hash == _digest(secret), Token.revoked_at.is_(None)).values(revoked_at=utcnow())
    )
    db.commit()


def _valid(token: Token, now: datetime) -> bool:
    """Not revoked, not past its end, and for a CLI or the add-in, used in the last CLIENT_IDLE."""
    if token.revoked_at is not None or (token.expires_at is not None and token.expires_at <= now):
        return False
    return token.kind != CLIENT or now - (token.last_used_at or token.created_at) <= CLIENT_IDLE


def list_tokens(db: Session, user: User) -> list[Token]:
    """The user's signed-in browsers and clients that are still valid."""
    now = utcnow()
    tokens = db.scalars(
        select(Token).where(Token.user_id == user.id, Token.revoked_at.is_(None)).order_by(Token.id.desc())
    )
    return [t for t in tokens if _valid(t, now)]


def revoke_token(db: Session, user: User, token_id: int) -> None:
    token = db.get(Token, token_id)
    if token is None or token.user_id != user.id:
        raise NotFound(f"Token {token_id} not found")
    token.revoked_at = token.revoked_at or utcnow()
    db.commit()


# --- CLI / add-in sign-in -----------------------------------------------------------------
#
# Like OAuth for native apps (RFC 8252 + PKCE): the client listens on
# 127.0.0.1:<port>, opens /auth/client in the browser with a PKCE challenge, the
# person confirms, the browser is redirected to the client with a one-time code,
# and the client trades the code plus its PKCE verifier for a token.


def pkce_challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def create_client_code(db: Session, user: User, *, challenge: str, name: str) -> str:
    code = secrets.token_urlsafe(32)
    now = utcnow()
    db.add(
        ClientAuthCode(
            code_hash=_digest(code),
            user_id=user.id,
            challenge=challenge,
            name=name[:200],
            created_at=now,
            expires_at=now + CODE_TTL,
        )
    )
    db.commit()
    return code


def redeem_client_code(db: Session, code: str, verifier: str) -> tuple[str, User]:
    """Trade a one-time code and its PKCE verifier for a client token."""
    row = db.scalar(select(ClientAuthCode).where(ClientAuthCode.code_hash == _digest(code)))
    now = utcnow()
    if row is None or row.used_at is not None or row.expires_at <= now:
        raise Forbidden("This sign-in has expired; sign in again from the client", code="invalid_code")
    # Burn the code first, so a wrong verifier can't be retried.
    claimed = db.execute(
        update(ClientAuthCode)
        .where(ClientAuthCode.id == row.id, ClientAuthCode.used_at.is_(None))
        .values(used_at=now)
        .execution_options(synchronize_session=False)
    ).rowcount
    db.commit()
    if claimed != 1 or not hmac.compare_digest(pkce_challenge(verifier), row.challenge):
        raise Forbidden("Sign-in verification failed; sign in again from the client", code="invalid_code")
    user = db.get(User, row.user_id)
    if user is None or user.status != UserStatus.ACTIVE:
        raise Forbidden("Your account isn't active", code="pending_approval")
    return issue_token(db, user, kind=CLIENT, name=row.name), user
