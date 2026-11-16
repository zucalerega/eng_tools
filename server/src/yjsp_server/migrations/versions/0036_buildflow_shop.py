"""buildflow shop: the machines in the team's shop, who's trained on each, and the parts queued to be machined

Buildflow's shop (buildflow/shop.py), from the team's machining tracker: its machines (buildflow_machines), each
person's level on each (buildflow_skills), and the parts queued to be made on them (buildflow_shop_parts), each one
for a component of a program, or a program, or neither. New tables, so nothing that's there changes; the tracker's four
machines are put in to start.

Revision ID: 0036
Revises: 0035
Create Date: 2026-11-16 20:34:29.532003
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0036"
down_revision: str | None = "0035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    machines = op.create_table(
        "buildflow_machines",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=40), nullable=False),
        sa.Column("name_key", sa.String(length=40), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name_key", name="uq_buildflow_machines_name"),
    )
    op.create_table(
        "buildflow_skills",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("machine_id", sa.Integer(), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["machine_id"],
            ["buildflow_machines.id"],
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "machine_id", name="uq_buildflow_skills_user_machine"),
    )
    with op.batch_alter_table("buildflow_skills", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_skills_machine_id"), ["machine_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_skills_user_id"), ["user_id"], unique=False)

    op.create_table(
        "buildflow_shop_parts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("program_id", sa.Integer(), nullable=True),
        sa.Column("component_id", sa.Integer(), nullable=True),
        sa.Column("machine_id", sa.Integer(), nullable=False),
        sa.Column("material", sa.String(length=100), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("hours", sa.Float(), nullable=True),
        sa.Column("drawing", sa.String(length=2000), nullable=False),
        sa.Column("cad", sa.String(length=2000), nullable=False),
        sa.Column(
            "status",
            sa.Enum("queued", "in_progress", "blocked", "done", name="shopstatus", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("requester_id", sa.Integer(), nullable=True),
        sa.Column("machinist_id", sa.Integer(), nullable=True),
        sa.Column("need_by", sa.Date(), nullable=True),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["component_id"],
            ["buildflow_components.id"],
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["machine_id"],
            ["buildflow_machines.id"],
        ),
        sa.ForeignKeyConstraint(
            ["machinist_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["program_id"],
            ["buildflow_programs.id"],
        ),
        sa.ForeignKeyConstraint(
            ["removed_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["requester_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("buildflow_shop_parts", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_shop_parts_component_id"), ["component_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_shop_parts_machine_id"), ["machine_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_shop_parts_program_id"), ["program_id"], unique=False)

    # The machines the shop has, as the tracker had them: admins rename, add, and retire them.
    op.bulk_insert(
        machines,
        [
            {"name": name, "name_key": name.lower(), "position": position, "retired_at": None}
            for position, name in enumerate(["Lathe", "Mill", "Waterjet", "CNC"])
        ],
    )


def downgrade() -> None:
    with op.batch_alter_table("buildflow_shop_parts", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_shop_parts_program_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_shop_parts_machine_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_shop_parts_component_id"))

    op.drop_table("buildflow_shop_parts")
    with op.batch_alter_table("buildflow_skills", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_skills_user_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_skills_machine_id"))

    op.drop_table("buildflow_skills")
    op.drop_table("buildflow_machines")
