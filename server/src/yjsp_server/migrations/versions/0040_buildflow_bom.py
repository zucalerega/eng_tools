"""buildflow bom: each program's bill of materials, read in from the team's own spreadsheets

Buildflow's bills of materials (buildflow/bom.py): each line a part to buy for one of a program's components (or none
yet), how many, from whom, at what cost, how long it takes to come, and where it is (buildflow_bom_lines). A new
table, so nothing that's there changes.

Revision ID: 0040
Revises: 0039
Create Date: 2026-11-17 19:58:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0040"
down_revision: str | None = "0039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "buildflow_bom_lines",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("program_id", sa.Integer(), nullable=False),
        sa.Column("component_id", sa.Integer(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("part_number", sa.String(length=100), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("quantity", sa.Float(), nullable=True),
        sa.Column("unit", sa.String(length=20), nullable=False),
        sa.Column("vendor", sa.String(length=200), nullable=False),
        sa.Column("unit_cost", sa.Integer(), nullable=True),
        sa.Column("lead_days", sa.Integer(), nullable=True),
        sa.Column("url", sa.String(length=2000), nullable=False),
        sa.Column(
            "status",
            sa.Enum("to_order", "ordered", "received", name="bomstatus", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["component_id"],
            ["buildflow_components.id"],
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["program_id"],
            ["buildflow_programs.id"],
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("buildflow_bom_lines", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_bom_lines_component_id"), ["component_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_bom_lines_program_id"), ["program_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("buildflow_bom_lines", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_bom_lines_program_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_bom_lines_component_id"))

    op.drop_table("buildflow_bom_lines")
