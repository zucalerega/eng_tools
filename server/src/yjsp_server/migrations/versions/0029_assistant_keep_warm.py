"""assistant: keeping the help ready

The server can read the help again between questions, so Anthropic keeps it ready for the next one
(YJSP_ASSISTANT_KEEP_WARM). Those reads cost money, so they're kept with the questions' costs, but they're no one's
question: assistant_requests.user_id may now be empty. Every request kept so far is someone's, and stays theirs.

Revision ID: 0029
Revises: 0028
Create Date: 2026-10-29 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0029"
down_revision: str | None = "0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("assistant_requests", schema=None) as batch_op:
        batch_op.alter_column("user_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    # What keeping the help ready cost goes with it: a request has to be someone's again.
    op.execute("DELETE FROM assistant_requests WHERE user_id IS NULL")
    with op.batch_alter_table("assistant_requests", schema=None) as batch_op:
        batch_op.alter_column("user_id", existing_type=sa.Integer(), nullable=False)
