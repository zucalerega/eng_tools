"""accounts: the whitelist's emails

The Georgia Tech addresses that can make an account while the whitelist is on, which admins add on Admin > Whitelist
(one at a time, or a roster's), each with the account that signed in as it. A new table: nothing that's there changes,
and the whitelist starts empty.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-15 01:24:09.759570
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "whitelist_emails",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
    )


def downgrade() -> None:
    op.drop_table("whitelist_emails")
