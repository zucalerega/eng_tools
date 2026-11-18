"""buildflow reviews: design reviews held for several components at once, with their files and notes

Buildflow's reviews (buildflow/reviews.py): a review held at one of a program's review milestones for several of its
components (buildflow_reviews), the components it covers (buildflow_review_components), and its files, as links
(buildflow_review_links). New tables, so nothing that's there changes.

Revision ID: 0038
Revises: 0037
Create Date: 2026-11-17 18:26:57.640175
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0038"
down_revision: str | None = "0037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "buildflow_reviews",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("program_id", sa.Integer(), nullable=False),
        sa.Column("milestone_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("held_on", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["milestone_id"],
            ["buildflow_milestones.id"],
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
            ["updated_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("buildflow_reviews", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_reviews_milestone_id"), ["milestone_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_reviews_program_id"), ["program_id"], unique=False)

    op.create_table(
        "buildflow_review_components",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("review_id", sa.Integer(), nullable=False),
        sa.Column("component_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["component_id"],
            ["buildflow_components.id"],
        ),
        sa.ForeignKeyConstraint(
            ["review_id"],
            ["buildflow_reviews.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("review_id", "component_id", name="uq_buildflow_review_components_review_component"),
    )
    with op.batch_alter_table("buildflow_review_components", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_review_components_component_id"), ["component_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_review_components_review_id"), ["review_id"], unique=False)

    op.create_table(
        "buildflow_review_links",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("review_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("url", sa.String(length=2000), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("added_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["added_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["review_id"],
            ["buildflow_reviews.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("buildflow_review_links", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_review_links_review_id"), ["review_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("buildflow_review_links", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_review_links_review_id"))

    op.drop_table("buildflow_review_links")
    with op.batch_alter_table("buildflow_review_components", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_review_components_review_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_review_components_component_id"))

    op.drop_table("buildflow_review_components")
    with op.batch_alter_table("buildflow_reviews", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_reviews_program_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_reviews_milestone_id"))

    op.drop_table("buildflow_reviews")
