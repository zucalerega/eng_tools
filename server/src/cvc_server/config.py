"""Settings, read from CVC_* environment variables or a .env file."""

from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_SECRET = "dev-only-secret-do-not-use-in-production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CVC_", env_file=".env", extra="ignore")

    env: Literal["development", "production"] = "development"
    host: str = "127.0.0.1"
    port: int = 8000
    # Where people reach CVC; Google redirects back to {public_url}/auth/callback.
    public_url: str = "http://localhost:8000"
    database_url: str = "sqlite:///data/cvc.db"
    blob_dir: Path = Path("data/blobs")
    # Signs the Google sign-in state cookie and the client sign-in confirmation form.
    secret_key: str = DEV_SECRET
    google_client_id: str = ""
    google_client_secret: str = ""
    # Comma-separated emails that become active admins when they sign in.
    bootstrap_admins: str = ""
    # /auth/dev-login and /auth/dev-token: sign in as any email, for local testing only.
    dev_auth: bool = False
    session_days: int = 30
    max_upload_mb: int = 2048

    @property
    def production(self) -> bool:
        return self.env == "production"

    @property
    def admin_emails(self) -> set[str]:
        return {e.strip().lower() for e in self.bootstrap_admins.split(",") if e.strip()}

    def check(self) -> None:
        """Refuse to run production with development shortcuts or without Google sign-in."""
        if not self.production:
            return
        problems = []
        if self.secret_key == DEV_SECRET or len(self.secret_key) < 32:
            problems.append("set CVC_SECRET_KEY to a random string of at least 32 characters")
        if self.dev_auth:
            problems.append("turn off CVC_DEV_AUTH")
        if not (self.google_client_id and self.google_client_secret):
            problems.append("set CVC_GOOGLE_CLIENT_ID and CVC_GOOGLE_CLIENT_SECRET")
        if not self.public_url.startswith("https://"):
            problems.append("CVC_PUBLIC_URL must start with https://")
        if problems:
            raise RuntimeError("Can't start in production: " + "; ".join(problems))
