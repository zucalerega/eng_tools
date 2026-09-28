"""Yorg: folders of datasets

A new table, and a folder for each dataset (none yet: they stay at the top). SQLite adds the dataset's foreign key by
copying yorg_datasets, which yorg_channels points at: db.migrate turns the checks off for that and back on after.

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-28 11:34:40.108642
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "yorg_folders",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("name_key", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["parent_id"], ["yorg_folders.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("yorg_datasets", schema=None) as batch_op:
        batch_op.add_column(sa.Column("folder_id", sa.Integer(), nullable=True))
        batch_op.create_index(batch_op.f("ix_yorg_datasets_folder_id"), ["folder_id"], unique=False)
        batch_op.create_foreign_key("fk_yorg_datasets_folder_id_yorg_folders", "yorg_folders", ["folder_id"], ["id"])


def downgrade() -> None:
    with op.batch_alter_table("yorg_datasets", schema=None) as batch_op:
        batch_op.drop_constraint("fk_yorg_datasets_folder_id_yorg_folders", type_="foreignkey")
        batch_op.drop_index(batch_op.f("ix_yorg_datasets_folder_id"))
        batch_op.drop_column("folder_id")
    op.drop_table("yorg_folders")
