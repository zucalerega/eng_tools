"""Accounts and credentials: Google sign-in, tokens, and the CLI/add-in browser sign-in."""

import base64
import hashlib
import hmac
import secrets
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .config import Settings
from .db import utcnow
from .errors import Forbidden, NotFound
from .models import ClientAuthCode, Token, User, UserStatus

SESSION = "session"  # browser cookie
CLIENT = "client"  # CLI or SolidWorks add-in, sent as "Authorization: Bearer ..."
CODE_TTL = timedelta(minutes=5)
_TOUCH_EVERY = timedelta(minutes=5)  # how often last_used_at is refreshed; avoids a write per request


def _digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def sign_in(db: Session, settings: Settings, *, subject: str, email: str, name: str, email_verified: bool) -> User:
    """Find or create the account for a Google identity.

    A new account waits for an admin (pending) unless an admin invited the email
    or it's in CVC_BOOTSTRAP_ADMINS.
    """
    if not email_verified:
        raise Forbidden("Your Google account's email address isn't verified", code="unverified_email")
    email = email.strip().lower()
    user = db.scalar(select(User).where(User.google_sub == subject))
    if user is None:
        user = db.scalar(select(User).where(User.email == email))
        if user is not None and user.google_sub not in (None, subject):
            raise Forbidden(f"{email} belongs to a different Google account", code="identity_mismatch")
    if user is None:
        user = User(email=email, name=name.strip(), status=UserStatus.PENDING)
        db.add(user)
    user.google_sub = subject
    user.name = user.name or name.strip()
    if email in settings.admin_emails:
        user.status, user.is_admin = UserStatus.ACTIVE, True
    elif user.status == UserStatus.INVITED:
        user.status = UserStatus.ACTIVE
    user.last_login_at = utcnow()
    db.commit()
    return user


def issue_token(db: Session, user: User, *, kind: str, name: str, ttl: timedelta | None = None) -> str:
    """A new secret for the user. Only its hash is stored, so it can't be shown again."""
    secret = "cvc_" + secrets.token_urlsafe(32)
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
    if token is None or token.revoked_at is not None or (token.expires_at is not None and token.expires_at <= now):
        return None
    if token.last_used_at is None or now - token.last_used_at > _TOUCH_EVERY:
        token.last_used_at = now
        db.commit()
    return db.get(User, token.user_id)


def revoke_secret(db: Session, secret: str) -> None:
    db.execute(
        update(Token).where(Token.token_hash == _digest(secret), Token.revoked_at.is_(None)).values(revoked_at=utcnow())
    )
    db.commit()


def list_tokens(db: Session, user: User) -> list[Token]:
    """The user's signed-in browsers and clients that are still valid."""
    now = utcnow()
    tokens = db.scalars(
        select(Token).where(Token.user_id == user.id, Token.revoked_at.is_(None)).order_by(Token.id.desc())
    )
    return [t for t in tokens if t.expires_at is None or t.expires_at > now]


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
