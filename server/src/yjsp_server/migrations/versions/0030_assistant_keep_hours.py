"""site settings: how long Claude keeps the help loaded after a question

Admins choose, on Admin > People, whether the server keeps the help loaded for Claude around the clock or only for some
hours after each question (assistant.Assistant.keep_warm). A new column that may be empty, as it is on the row that's
there: empty is around the clock, which the server now does unless its settings turn it off.

Revision ID: 0030
Revises: 0029
Create Date: 2026-11-13 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030"
down_revision: str | None = "0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable, so SQLite adds it in place.
    with op.batch_alter_table("site_settings", schema=None) as batch_op:
        batch_op.add_column(sa.Column("assistant_keep_hours", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("site_settings", schema=None) as batch_op:
        batch_op.drop_column("assistant_keep_hours")
