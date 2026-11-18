"""buildflow places: where people are trained to make parts, and how far each person's trained at each

Buildflow's shop (buildflow/shop.py) keeps, beside its machines, the places people are trained in (a department's
machine shop, a makerspace), each with training of its own (buildflow_places), and each person's level at each
(buildflow_place_skills), as buildflow_skills keeps theirs on each machine. New tables, so nothing that's there changes;
no places are put in, since each school has its own: admins add them.

Revision ID: 0041
Revises: 0040
Create Date: 2026-11-18 19:45:00.000000
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
        "buildflow_places",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=40), nullable=False),
        sa.Column("name_key", sa.String(length=40), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name_key", name="uq_buildflow_places_name"),
    )
    op.create_table(
        "buildflow_place_skills",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("place_id", sa.Integer(), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["place_id"], ["buildflow_places.id"]),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "place_id", name="uq_buildflow_place_skills_user_place"),
    )
    with op.batch_alter_table("buildflow_place_skills", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_place_skills_place_id"), ["place_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_place_skills_user_id"), ["user_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("buildflow_place_skills", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_place_skills_user_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_place_skills_place_id"))

    op.drop_table("buildflow_place_skills")
    op.drop_table("buildflow_places")
