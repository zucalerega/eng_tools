"""feedback: screenshots with a request

A bug report or a feature request can carry up to 3 screenshots (feedback.py), which whoever sent it and admins see,
and Claude's look reads. A new table, in the database like Piper's pictures so the backups keep them: the requests
already there have none.

Revision ID: 0041
Revises: 0040
Create Date: 2026-11-18 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0041"
down_revision: str | None = "0040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "feedback_screenshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("feedback_id", sa.Integer(), nullable=False),
        sa.Column("content_type", sa.String(length=32), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.ForeignKeyConstraint(["feedback_id"], ["feedback.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("feedback_screenshots", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_feedback_screenshots_feedback_id"), ["feedback_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("feedback_screenshots", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_feedback_screenshots_feedback_id"))
    op.drop_table("feedback_screenshots")
