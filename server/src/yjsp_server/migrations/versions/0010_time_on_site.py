"""accounts: time on site

How long each account has spent with the web app open, in seconds, for Admin > People. Existing accounts start at 0:
nothing was counted before. A non-null column with a server default, which SQLite adds in place, without copying
users, which most tables point at.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-14 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("site_seconds", sa.Integer(), server_default="0", nullable=False))


def downgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("site_seconds")
