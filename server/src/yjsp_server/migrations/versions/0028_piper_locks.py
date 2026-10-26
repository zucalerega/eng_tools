"""piper: who's editing

A diagram can be held by whoever's editing it, so no one else's save goes over theirs: who (locked_by), since when
(locked_at), and when their editor last said they're still at it (lock_seen_at). Nobody holds any diagram to begin
with, so the columns start empty. Nothing else changes.

Revision ID: 0028
Revises: 0027
Create Date: 2026-10-26 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0028"
down_revision: str | None = "0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("piper_diagrams", schema=None) as batch_op:
        batch_op.add_column(sa.Column("locked_by", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("lock_seen_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.create_foreign_key("fk_piper_diagrams_locked_by_users", "users", ["locked_by"], ["id"])


def downgrade() -> None:
    with op.batch_alter_table("piper_diagrams", schema=None) as batch_op:
        batch_op.drop_constraint("fk_piper_diagrams_locked_by_users", type_="foreignkey")
        batch_op.drop_column("lock_seen_at")
        batch_op.drop_column("locked_at")
        batch_op.drop_column("locked_by")
