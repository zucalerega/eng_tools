"""Settings, read from YJSP_* environment variables or a .env file."""

import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_SECRET = "dev-only-secret-do-not-use-in-production"
# Georgia Tech's accounts, YJSP's school's: Microsoft 365 accounts in GT's own directory (tenant) in Microsoft Entra,
# whose addresses are gatech.edu's. The defaults of the school's settings (Settings.school_name, ...).
GT_TENANT = "482198bb-ae7b-4b25-8b7a-6d7f32faa083"
GT_DOMAIN = "gatech.edu"
_PLAIN = r"^[^<>&\"\x00-\x1f]+$"  # a name the pages show as it is
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
    # Whose site it is, as its pages say: its short name (the top bar, the tabs, the sign-in pages, the help) and the
    # team's (the sign-in pages, the help, Claude's instructions, a P&ID's title block). YJSP's are the defaults.
    site_name: str = Field(default="YJSP", min_length=1, max_length=40, pattern=_PLAIN)
    team_name: str = Field(default="Yellow Jacket Space Program", min_length=1, max_length=120, pattern=_PLAIN)
    # The team's logo: a folder with logo-on-light.png (its letters dark, for light pages) and logo-on-dark.png (light,
    # for the dark theme), about 245 by 173 pixels or as wide for its height. Unset: YJSP's (brand/).
    brand_dir: Path | None = None
    # One database for the site: its accounts, and Vault's, Yorg's, and Piper's tables.
    database_url: str = "sqlite:///data/yjsp.db"
    # Signs the sign-in state cookie and the client sign-in confirmation form.
    secret_key: str = DEV_SECRET
    google_client_id: str = ""
    google_client_secret: str = ""
    # Google makes accounts too, for the school's addresses (school_domains): for a school whose accounts are Google's.
    # Off: Google signs in only to accounts already there, or invited (YJSP's: its school's accounts are Microsoft's).
    google_makes_accounts: bool = False
    # Sign-in with the school's accounts, if they're Microsoft 365 accounts (Georgia Tech's are): an app registered in
    # Microsoft Entra (docs/design.md, "Deploying"). Only the school's directory's accounts can use it, at an address of
    # the school's (auth.sign_in_microsoft).
    microsoft_client_id: str = ""
    microsoft_client_secret: str = ""
    # The school whose accounts people join with (docs/design.md, "Sign-in and accounts"): what the pages call it; its
    # email domains, comma-separated, each with its subdomains (cc.gatech.edu), the only addresses that make an account
    # by signing in or go on the whitelist; and its directory in Microsoft Entra, by its tenant ID. Georgia Tech's are
    # the defaults. No domains: people join only by an admin's invite. Production refuses Microsoft's sign-in for another
    # school's addresses while the directory is still Georgia Tech's (check).
    school_name: str = Field(default="Georgia Tech", min_length=1, max_length=60, pattern=_PLAIN)
    school_domains: str = Field(default=GT_DOMAIN, pattern=r"^\s*([a-z0-9.-]+\.[a-z]{2,}\s*(,\s*|$))*$")
    microsoft_tenant: str = Field(default=GT_TENANT, pattern=r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
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
    # Read each SolidWorks file's 3D model for Caliper once it's checked in (vault/reading.py), so it's there when the
    # file's first opened. Off: each is read when someone first opens it, as before.
    caliper_read_ahead: bool = True
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
    # Keep the help loaded between questions: Anthropic keeps what Claude read for an hour, so when nothing has read it
    # for 50 minutes the server reads it again, and a question hours after the last doesn't pay to have the whole help
    # read in full and kept. Each read costs a fraction of a cent (with Claude Sonnet 5.5 and the help as it is, about
    # $7 a month, around the clock) and counts against the budgets. Admins choose, on Admin > People, whether it's kept
    # loaded always or only for some hours after each question. Off (0): the server never reads it between questions,
    # whatever they choose.
    assistant_keep_warm: bool = True
    # Another address for Anthropic's API: a gateway, or the tests' stand-in. Empty: Anthropic's own.
    anthropic_base_url: str = ""
    # Bug reports and feature requests members send from Help (feedback.py). The owner, who alone can approve one, by
    # the email they sign in with: approving starts Claude Code building it, on their Claude account. Empty: no one can.
    feedback_approver: str = ""
    # The Claude Code routine an approval starts (docs/deploying.md, "Requests"): the URL and the token of its API
    # trigger, from the routine's page at claude.ai/code/routines. The token is a secret, like YJSP_SECRET_KEY: only in
    # the server's .env. Either empty: requests can be sent, looked at, and declined, but not approved.
    feedback_routine_url: str = ""
    feedback_routine_token: str = ""

    # Deals (deals/): eBay's Browse API, which the server searches each day for what the team wants. A keyset of an
    # application on developer.ebay.com, for production: its App ID (client ID), and its Cert ID (client secret), a
    # secret like YJSP_SECRET_KEY. Either empty: no deals are looked for.
    ebay_client_id: str = ""
    ebay_client_secret: str = ""
    # Another address for eBay's API: the tests' stand-in. Empty: eBay's own.
    ebay_base_url: str = ""
    # eBay's Marketplace Account Deletion notifications, which a production keyset needs answered (docs/deploying.md,
    # "Deals"): the verification token given for {public_url}/api/deals/ebay/account-deletion on the keyset's page, 32 to
    # 80 letters, digits, underscores, and dashes. Empty: that address isn't there.
    ebay_verification_token: str = ""
    # When to search each day: the hour, in UTC. Shown deals are checked again every four hours.
    deals_hour: int = Field(default=10, ge=0, le=23)
    # Where the team is, for eBay's shipping estimates: a US ZIP code. Empty: no estimates for calculated shipping.
    deals_zip: str = ""
    # Have Claude say which listings would do (its budgets permitting): off, a listing's words alone decide.
    deals_claude: bool = True
    # Search each day and keep what's shown current, on its own. Off: only when an admin asks (the tests).
    deals_schedule: bool = True

    # The demo (docs/design.md, "The demo"): a server of its own beside the site, with made-up data (`yjsp-demo seed`
    # makes it), that anyone can look at without signing in, as its guest, and no one can change. It has no sign-in,
    # Claude, deals, or requests, and refuses to start with their settings (check).
    demo: bool = False
    # Where people reach the site when a proxy in front of it takes that off each request's path: /demo for the demo,
    # which the site passes /demo to (demo_url). The web app's addresses, and the help's, start with it. Empty: the
    # site's at the root of its address. Only the demo has one, for now: the sign-in pages don't follow it (check).
    root_path: str = Field(default="", pattern=r"^(/[A-Za-z0-9._~-]+)*$")
    # The demo, for the site to pass /demo and everything under it to (api/demo.py): the demo's own server, on this
    # machine, like http://127.0.0.1:8200. Empty: there's no demo here.
    demo_url: str = Field(default="", pattern=r"^(https?://[^/?#\s]+)?$")

    @property
    def production(self) -> bool:
        return self.env == "production"

    @property
    def school_domain_list(self) -> list[str]:
        """The school's email domains, each a domain its addresses are at, or under (school_domains)."""
        return [domain.strip() for domain in self.school_domains.split(",") if domain.strip()]

    @property
    def admin_emails(self) -> set[str]:
        return {e.strip().lower() for e in self.bootstrap_admins.split(",") if e.strip()}

    def check(self) -> None:
        """Refuse to run production with development shortcuts or without a way to sign in, and the demo, in
        production or not, with anything it mustn't have."""
        if self.demo and (demo_problems := self._demo_problems()):
            raise RuntimeError("Can't start the demo: " + "; ".join(demo_problems))
        if self.root_path and not self.demo:
            # The sign-in pages, and Google's and Microsoft's ways back to them, are at the root of the address yet.
            raise RuntimeError("Can't start: YJSP_ROOT_PATH is only for the demo (YJSP_DEMO=1) for now: unset it")
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
        if not self.demo and not any(all(pair) for pair in sign_ins.values()):  # the demo has no sign-in
            problems.append(
                "set up a sign-in: YJSP_MICROSOFT_CLIENT_ID and YJSP_MICROSOFT_CLIENT_SECRET (the school's accounts), "
                "or YJSP_GOOGLE_CLIENT_ID and YJSP_GOOGLE_CLIENT_SECRET"
            )
        for name, pair in sign_ins.items():
            if any(pair) and not all(pair):
                problems.append(f"set both YJSP_{name}_CLIENT_ID and YJSP_{name}_CLIENT_SECRET, or neither")
        if (
            all(sign_ins["MICROSOFT"])
            and self.microsoft_tenant == GT_TENANT
            and GT_DOMAIN not in self.school_domain_list
        ):
            # Georgia Tech's directory, the default, for another school's site: no one could ever sign in with it.
            problems.append(
                "set YJSP_MICROSOFT_TENANT to the Directory (tenant) ID of the school's directory in Microsoft Entra, "
                "where its sign-in app is registered: it's Georgia Tech's until then"
            )
        if not self.public_url.startswith("https://"):
            problems.append("YJSP_PUBLIC_URL must start with https://")
        if bool(self.ebay_client_id) != bool(self.ebay_client_secret):
            problems.append("set both YJSP_EBAY_CLIENT_ID and YJSP_EBAY_CLIENT_SECRET, or neither")
        token = self.ebay_verification_token
        if token and not re.fullmatch(r"[A-Za-z0-9_-]{32,80}", token):
            problems.append("YJSP_EBAY_VERIFICATION_TOKEN must be 32 to 80 letters, digits, underscores, and dashes")
        if self.anthropic_api_key and self.assistant_budget <= 0 and self.assistant_monthly_budget <= 0:
            problems.append(
                "set YJSP_ASSISTANT_MONTHLY_BUDGET (each month) or YJSP_ASSISTANT_BUDGET (in all) to what the assistant "
                "may spend, in US dollars, or unset YJSP_ANTHROPIC_API_KEY"
            )
        if problems:
            raise RuntimeError("Can't start in production: " + "; ".join(problems))

    def _demo_problems(self) -> list[str]:
        """What the demo can't have: anyone uses it without signing in, so nothing in it may sign anyone in, spend
        anything, or reach anyone (docs/design.md, "The demo")."""
        settings = {
            "YJSP_DEV_AUTH": self.dev_auth,
            "YJSP_GOOGLE_CLIENT_ID": self.google_client_id,
            "YJSP_GOOGLE_CLIENT_SECRET": self.google_client_secret,
            "YJSP_MICROSOFT_CLIENT_ID": self.microsoft_client_id,
            "YJSP_MICROSOFT_CLIENT_SECRET": self.microsoft_client_secret,
            "YJSP_ANTHROPIC_API_KEY": self.anthropic_api_key,
            "YJSP_FEEDBACK_ROUTINE_URL": self.feedback_routine_url,
            "YJSP_FEEDBACK_ROUTINE_TOKEN": self.feedback_routine_token,
            "YJSP_EBAY_CLIENT_ID": self.ebay_client_id,
            "YJSP_EBAY_CLIENT_SECRET": self.ebay_client_secret,
            "YJSP_DEMO_URL": self.demo_url,
        }
        found = [name for name, value in settings.items() if value]
        if not found:
            return []
        return [f"unset {', '.join(found)}: the demo has no sign-in, Claude, requests, deals, or demo of its own"]


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
