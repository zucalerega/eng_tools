"""accounts: who has the SolidWorks add-in

For Admin > People's add-in tracker (clients.py): each download of a file the web app offers, and each CLI's or add-in's
version, as its requests say it, on its token. A new table and a new column that may be empty: nothing that's there
changes, downloads are counted from the deploy on, and a token learns its client's version at its next use.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-15 20:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "downloads",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("version", sa.String(length=32), nullable=True),
        sa.Column("by_client", sa.Boolean(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("downloads", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_downloads_user_id"), ["user_id"], unique=False)
    # Nullable, so SQLite adds it in place, without copying tokens.
    with op.batch_alter_table("tokens", schema=None) as batch_op:
        batch_op.add_column(sa.Column("client_version", sa.String(length=32), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("tokens", schema=None) as batch_op:
        batch_op.drop_column("client_version")
    with op.batch_alter_table("downloads", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_downloads_user_id"))
    op.drop_table("downloads")
