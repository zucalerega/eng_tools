"""Settings, read from YJSP_* environment variables or a .env file."""

import os
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_SECRET = "dev-only-secret-do-not-use-in-production"
ENV_FILE = ".env"
# What the settings were called before the site was YJSP. Kept only to refuse them (refuse_old_settings): with a .env
# still using them, the server would otherwise start on its defaults, a development server with a new, empty database.
_OLD_PREFIX = "CVC_"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="YJSP_", env_file=ENV_FILE, extra="ignore")

    env: Literal["development", "production"] = "development"
    host: str = "127.0.0.1"
    port: int = 8000
    # Where people reach the site; Google redirects back to {public_url}/auth/callback, and Microsoft to
    # {public_url}/auth/microsoft/callback.
    public_url: str = "http://localhost:8000"
    # One database for the site: its accounts, and Vault's, Yorg's, and Piper's tables.
    database_url: str = "sqlite:///data/yjsp.db"
    # Signs the sign-in state cookie and the client sign-in confirmation form.
    secret_key: str = DEV_SECRET
    google_client_id: str = ""
    google_client_secret: str = ""
    # Sign-in with Georgia Tech accounts, which are Microsoft 365 accounts: an app registered in Microsoft Entra
    # (docs/design.md, "Deploying"). Only GT's accounts can use it (auth.sign_in_microsoft).
    microsoft_client_id: str = ""
    microsoft_client_secret: str = ""
    # Comma-separated emails that become active admins when they sign in.
    bootstrap_admins: str = ""
    # /auth/dev-login and /auth/dev-token: sign in as any email, for local testing only.
    dev_auth: bool = False
    session_days: int = 30
    max_upload_mb: int = 2048
    # The web app's build (`npm run build` in web/). The default is the build in this repository.
    web_dir: Path = Path(__file__).resolve().parents[3] / "web" / "dist"
    # Software members can download from the web app: put Vault-Setup.exe (the SolidWorks add-in's
    # installer, from CI) and vault.exe here. Unset: the web app says to ask an admin.
    downloads_dir: Path | None = None
    # Vault's files: every version of every file, in blobs/. Back it up with the database.
    vault_dir: Path = Path("data/vault")
    # Yorg's files: each dataset's upload and the arrays read from it, and saved scripts and models. Back it up too.
    yorg_dir: Path = Path("data/yorg")
    # What the off-site backup (deploy/yjsp-offsite, run by root) last wrote about itself, for Admin > People. Missing:
    # no off-site backup here.
    backup_status: Path = Path("backups/offsite.json")
    # The help (/help, and what the assistant reads): README.md, docs/, and the add-in's README, as in the repository
    # (help.py). The default is this repository; the live server keeps a copy of them beside the server.
    help_dir: Path = Path(__file__).resolve().parents[3]
    # The assistant: Claude, through Anthropic's API, answering members' questions from the help (assistant.py). It's off
    # without a key and a budget (in all, monthly, or both). The key is a secret, like YJSP_SECRET_KEY: only in the
    # server's .env.
    anthropic_api_key: str = ""
    # What the assistant may spend in all, in US dollars: the API credits it has. Once its answers have cost that much,
    # it stops answering until this is raised (the database keeps what each one cost). 0: no budget in all.
    assistant_budget: float = 0
    # What it may spend each calendar month, from 00:00 UTC on the 1st, in US dollars: the API credits a Claude Max plan
    # includes each month, say. Once this month's answers have cost that much, it stops answering until the next month.
    # 0: no monthly budget.
    assistant_monthly_budget: float = 0
    # What one person's questions may cost in any 24 hours, in US dollars.
    assistant_daily_limit: float = 1.0
    # Only models whose prices assistant.PRICES knows, so that every answer is counted at what it cost.
    assistant_model: Literal["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"] = "claude-sonnet-5-5"
    # How hard Claude thinks before it answers: higher is slower and costs more, and reasons better.
    assistant_effort: Literal["low", "medium", "high", "xhigh", "max"] = "high"
    # Keep the help ready between questions: Anthropic keeps what Claude read for an hour, so when nothing has read it
    # for 50 minutes the server reads it again, and a question hours after the last doesn't pay to have the whole help
    # read in full and kept. Each read costs a fraction of a cent (with Claude Sonnet 5.5 and the help as it is, about
    # $6 a month, around the clock) and counts against the budgets.
    assistant_keep_warm: bool = False
    # Another address for Anthropic's API: a gateway, or the tests' stand-in. Empty: Anthropic's own.
    anthropic_base_url: str = ""

    @property
    def production(self) -> bool:
        return self.env == "production"

    @property
    def admin_emails(self) -> set[str]:
        return {e.strip().lower() for e in self.bootstrap_admins.split(",") if e.strip()}

    def check(self) -> None:
        """Refuse to run production with development shortcuts or without a way to sign in."""
        if not self.production:
            return
        problems = []
        if self.secret_key == DEV_SECRET or len(self.secret_key) < 32:
            problems.append("set YJSP_SECRET_KEY to a random string of at least 32 characters")
        if self.dev_auth:
            problems.append("turn off YJSP_DEV_AUTH")
        sign_ins = {
            "GOOGLE": (self.google_client_id, self.google_client_secret),
            "MICROSOFT": (self.microsoft_client_id, self.microsoft_client_secret),
        }
        if not any(all(pair) for pair in sign_ins.values()):
            problems.append(
                "set up a sign-in: YJSP_MICROSOFT_CLIENT_ID and YJSP_MICROSOFT_CLIENT_SECRET (Georgia Tech accounts), "
                "or YJSP_GOOGLE_CLIENT_ID and YJSP_GOOGLE_CLIENT_SECRET"
            )
        for name, pair in sign_ins.items():
            if any(pair) and not all(pair):
                problems.append(f"set both YJSP_{name}_CLIENT_ID and YJSP_{name}_CLIENT_SECRET, or neither")
        if not self.public_url.startswith("https://"):
            problems.append("YJSP_PUBLIC_URL must start with https://")
        if self.anthropic_api_key and self.assistant_budget <= 0 and self.assistant_monthly_budget <= 0:
            problems.append(
                "set YJSP_ASSISTANT_MONTHLY_BUDGET (each month) or YJSP_ASSISTANT_BUDGET (in all) to what the assistant "
                "may spend, in US dollars, or unset YJSP_ANTHROPIC_API_KEY"
            )
        if problems:
            raise RuntimeError("Can't start in production: " + "; ".join(problems))


def refuse_old_settings(environ: Mapping[str, str] = os.environ, env_file: Path = Path(ENV_FILE)) -> None:
    """Refuse to start while any setting still has its name from before YJSP, in the environment or the .env file."""
    names = set(environ)
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            names.add(line.strip().removeprefix("export ").split("=", 1)[0].strip())  # a comment stays one
    old = sorted(name for name in names if name.upper().startswith(_OLD_PREFIX))
    if old:
        raise RuntimeError(
            f"Settings start with YJSP_ now: rename {', '.join(old)} (in the environment or {env_file}) to start with "
            f"YJSP_ instead, and replace {_OLD_PREFIX}BLOB_DIR with YJSP_VAULT_DIR, the folder its blobs/ folder is "
            "in. docs/deploying.md has the steps for the live server."
        )
