"""accounts: the hours each person used the site

For Admin > People's tracker: which hours each person used the site in, and how long they had the web app open in
each (usage.py). A new table: nothing that's there changes, and the tracker counts from the deploy on, since nothing
kept this before.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-15 06:10:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "site_usage",
        sa.Column("hour", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("site_seconds", sa.Integer(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("hour", "user_id"),
    )


def downgrade() -> None:
    op.drop_table("site_usage")
