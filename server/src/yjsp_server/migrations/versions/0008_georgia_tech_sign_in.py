"""accounts: Georgia Tech sign-in

Each account can be tied to a Georgia Tech account, by its object ID in GT's Microsoft tenant, as it can to a Google
account (google_sub). Existing accounts have none until their first GT sign-in. A unique index rather than a
constraint: SQLite adds the column and the index in place, without copying users, which most tables point at.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-03 22:30:58.692575
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("microsoft_oid", sa.String(length=64), nullable=True))
        batch_op.create_index(batch_op.f("ix_users_microsoft_oid"), ["microsoft_oid"], unique=True)


def downgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_users_microsoft_oid"))
        batch_op.drop_column("microsoft_oid")
