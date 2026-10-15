"""the server's load, a sample a minute

How busy the server's CPUs were and how full its memory, each minute, kept a week (load.py), for Admin > People's
server load chart. A new table: nothing that's there changes, and the chart starts at the deploy.

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-15 07:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "server_load",
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("cpu", sa.Float(), nullable=True),
        sa.Column("steal", sa.Float(), nullable=True),
        sa.Column("memory_used", sa.BigInteger(), nullable=True),
        sa.Column("memory_total", sa.BigInteger(), nullable=True),
        sa.PrimaryKeyConstraint("at"),
    )


def downgrade() -> None:
    op.drop_table("server_load")
