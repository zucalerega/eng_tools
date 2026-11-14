"""feedback: bug reports and feature requests, and what each request to Claude was for

Members send bug reports and feature requests from Help (feedback.py), which Claude looks at for the owner, who can
approve one to have Claude Code build it. Each look costs what a question does, so it's kept with the questions' costs,
but it's no one's question: assistant_requests says what each request was for (purpose). Every request kept so far
with someone asking is their question, and every other one is a read that kept the help loaded.

Revision ID: 0031
Revises: 0030
Create Date: 2026-11-13 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0031"
down_revision: str | None = "0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    purpose = sa.Enum("question", "keep_warm", "feedback", name="assistantpurpose", native_enum=False, length=16)
    # With a default, so SQLite adds it in place, and the rows there have one.
    with op.batch_alter_table("assistant_requests", schema=None) as batch_op:
        batch_op.add_column(sa.Column("purpose", purpose, server_default="question", nullable=False))
    op.execute("UPDATE assistant_requests SET purpose = 'keep_warm' WHERE user_id IS NULL")

    op.create_table(
        "feedback",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.Enum("bug", "feature", name="feedbackkind", native_enum=False, length=16), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("page", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "status",
            sa.Enum("new", "approved", "declined", "done", name="feedbackstatus", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("evaluation", sa.Text(), nullable=True),
        sa.Column("evaluation_problem", sa.String(length=500), nullable=True),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("evaluation_cost", sa.BigInteger(), nullable=False),
        sa.Column("decided_by_id", sa.Integer(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reply", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("session_url", sa.String(length=500), nullable=True),
        sa.ForeignKeyConstraint(["decided_by_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("feedback", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_feedback_created_at"), ["created_at"], unique=False)
        batch_op.create_index(batch_op.f("ix_feedback_user_id"), ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_table("feedback")
    with op.batch_alter_table("assistant_requests", schema=None) as batch_op:
        batch_op.drop_column("purpose")
