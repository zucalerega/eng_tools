"""folders go to the trash

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-26 21:40:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 0001 left the folders' unique (parent_id, name_key) unnamed. Postgres names it itself; SQLite reports no
# name, so batch mode names it by this convention, to drop it by that name.
_NAMES = {"uq": "uq_%(table_name)s_%(column_0_N_name)s"}


def _unique_name() -> str:
    for unique in sa.inspect(op.get_bind()).get_unique_constraints("folders"):
        if unique["column_names"] == ["parent_id", "name_key"]:
            return unique["name"] or "uq_folders_parent_id_name_key"
    raise RuntimeError("folders has no unique (parent_id, name_key) to replace")


def upgrade() -> None:
    unique = _unique_name()
    with op.batch_alter_table("folders", schema=None, naming_convention=_NAMES) as batch_op:
        batch_op.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("deleted_by", sa.Integer(), nullable=True))
        batch_op.create_foreign_key("fk_folders_deleted_by_users", "users", ["deleted_by"], ["id"])
        # A deleted folder keeps its name, and a new one can take it: names are unique among live folders.
        batch_op.drop_constraint(unique, type_="unique")
        batch_op.create_index(
            "uq_folders_live_name",
            ["parent_id", "name_key"],
            unique=True,
            sqlite_where=sa.text("deleted_at IS NULL"),
            postgresql_where=sa.text("deleted_at IS NULL"),
        )


def downgrade() -> None:
    # Fails if a deleted folder shares its name with a live one next to it: restore or rename one first.
    with op.batch_alter_table("folders", schema=None) as batch_op:
        batch_op.drop_index(
            "uq_folders_live_name",
            sqlite_where=sa.text("deleted_at IS NULL"),
            postgresql_where=sa.text("deleted_at IS NULL"),
        )
        batch_op.create_unique_constraint("uq_folders_parent_id_name_key", ["parent_id", "name_key"])
        batch_op.drop_constraint("fk_folders_deleted_by_users", type_="foreignkey")
        batch_op.drop_column("deleted_by")
        batch_op.drop_column("deleted_at")
