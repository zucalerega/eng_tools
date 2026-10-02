"""site settings: the sign-up whitelist

A new table of one row, which vault.init_vault adds at startup with the whitelist off: from this release on,
anyone who signs in with Google joins at once, until an admin turns the whitelist on. Accounts keep their status.

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-28 18:53:02.557494
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "site_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("whitelist", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("site_settings")
