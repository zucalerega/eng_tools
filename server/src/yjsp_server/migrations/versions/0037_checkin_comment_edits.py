"""vault: editing a check-in's comment

A check-in's comment can be changed after it's made, by whoever checked it in or a lead (vault.edit_comment), to fix a
typo or say more. The check-in notes who changed it last, and when; what it said before is in the activity log. Two new
columns that may be empty: the check-ins already there were never edited. On SQLite, checkins is copied to add the
foreign key, with foreign keys off (db.migrate), so the versions that point at it keep their check-ins.

Revision ID: 0037
Revises: 0036
Create Date: 2026-11-17 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0037"
down_revision: str | None = "0036"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_EDITED_BY = "fk_checkins_comment_edited_by_users"  # SQLite's batch mode needs it named


def upgrade() -> None:
    with op.batch_alter_table("checkins", schema=None) as batch_op:
        batch_op.add_column(sa.Column("comment_edited_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(
            sa.Column("comment_edited_by", sa.Integer(), sa.ForeignKey("users.id", name=_EDITED_BY), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("checkins", schema=None) as batch_op:
        batch_op.drop_column("comment_edited_by")
        batch_op.drop_column("comment_edited_at")
