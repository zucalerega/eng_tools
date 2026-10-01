"""Yorg: folders of views

A folder for each saved view: a path of its own ("Hotfires/HF-3"), not one of the datasets' folders. Those saved
before are at the top (""). SQLite adds the column in place: nothing points at yorg_views, and nothing's copied.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-01 11:02:52.582485
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("yorg_views", schema=None) as batch_op:
        batch_op.add_column(sa.Column("folder", sa.String(length=300), server_default="", nullable=False))


def downgrade() -> None:
    with op.batch_alter_table("yorg_views", schema=None) as batch_op:
        batch_op.drop_column("folder")
