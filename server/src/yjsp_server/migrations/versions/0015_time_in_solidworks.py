"""accounts: time in SolidWorks

How long each account has worked in SolidWorks with Vault's add-in, in seconds, in all and in each hour it used the
site, for Admin > People, beside its time on the web app. Existing rows start at 0: nothing was counted before. Non-null
columns with a server default, which SQLite adds in place, without copying users, which most tables point at.

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-16 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("solidworks_seconds", sa.Integer(), server_default="0", nullable=False))
    with op.batch_alter_table("site_usage", schema=None) as batch_op:
        batch_op.add_column(sa.Column("solidworks_seconds", sa.Integer(), server_default="0", nullable=False))


def downgrade() -> None:
    with op.batch_alter_table("site_usage", schema=None) as batch_op:
        batch_op.drop_column("solidworks_seconds")
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("solidworks_seconds")
