"""buildflow plan: each component's lead time, the day it has to be ready by, and what it needs first

Buildflow's build plan (buildflow/progress.py): how long a component takes to get once it's ordered or started
(buildflow_components.lead_days), when it has to be ready by for the build (need_by), and the components that have to
be ready before it can be started (buildflow_needs). Two columns that may be empty, added in place, and a new table, so
nothing that's there changes.

Revision ID: 0039
Revises: 0038
Create Date: 2026-11-17 19:07:56.128702
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0039"
down_revision: str | None = "0038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "buildflow_needs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("component_id", sa.Integer(), nullable=False),
        sa.Column("needs_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["component_id"],
            ["buildflow_components.id"],
        ),
        sa.ForeignKeyConstraint(
            ["needs_id"],
            ["buildflow_components.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("component_id", "needs_id", name="uq_buildflow_needs_component_needs"),
    )
    with op.batch_alter_table("buildflow_needs", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_needs_component_id"), ["component_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_needs_needs_id"), ["needs_id"], unique=False)

    with op.batch_alter_table("buildflow_components", schema=None) as batch_op:
        batch_op.add_column(sa.Column("lead_days", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("need_by", sa.Date(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("buildflow_components", schema=None) as batch_op:
        batch_op.drop_column("need_by")
        batch_op.drop_column("lead_days")

    with op.batch_alter_table("buildflow_needs", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_needs_needs_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_needs_component_id"))

    op.drop_table("buildflow_needs")
