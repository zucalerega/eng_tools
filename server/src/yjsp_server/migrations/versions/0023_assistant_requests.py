"""accounts: what the assistant's answers cost

Each question to the assistant (Help in the web app), with the tokens Claude's answer took and what it cost, so the
assistant keeps to its budget and each person to a daily limit (assistant.py). What was asked isn't kept. A new table:
nothing that's there changes.

It was 0017 on its branch, which now follows 0.6.0 (#80): it comes after that's 0022, the vault pause.

Revision ID: 0023
Revises: 0022
Create Date: 2026-10-23 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "assistant_requests",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("cache_write_tokens", sa.Integer(), nullable=False),
        sa.Column("cache_read_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("cost", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("assistant_requests", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_assistant_requests_at"), ["at"], unique=False)
        batch_op.create_index(batch_op.f("ix_assistant_requests_user_id"), ["user_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("assistant_requests", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_assistant_requests_user_id"))
        batch_op.drop_index(batch_op.f("ix_assistant_requests_at"))
    op.drop_table("assistant_requests")
