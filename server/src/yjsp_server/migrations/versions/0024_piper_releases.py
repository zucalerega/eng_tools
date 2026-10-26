"""piper: releases of diagrams, and their approvals

A diagram's revision put forward as its next release, to the approvers named for it, and each approver's say;
released, it takes the diagram's next letter (A, B, ...), and the diagram notes its latest release. New tables, and two
new columns on piper_diagrams that start empty (no diagram has been released): SQLite adds those in place, so nothing
that points at piper_diagrams is copied.

Revision ID: 0024
Revises: 0023
Create Date: 2026-10-25 20:15:34.171588
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "piper_releases",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("diagram_id", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("letter", sa.String(length=8), nullable=True),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("state", sa.String(length=20), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("requested_by", sa.Integer(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["diagram_id"],
            ["piper_diagrams.id"],
        ),
        sa.ForeignKeyConstraint(
            ["requested_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("diagram_id", "letter", name="uq_piper_releases_diagram_letter"),
    )
    with op.batch_alter_table("piper_releases", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_piper_releases_diagram_id"), ["diagram_id"], unique=False)

    op.create_table(
        "piper_approvals",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("release_id", sa.Integer(), nullable=False),
        sa.Column("approver_id", sa.Integer(), nullable=False),
        sa.Column("decision", sa.String(length=20), nullable=False),
        sa.Column("comment", sa.Text(), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["approver_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["release_id"],
            ["piper_releases.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("release_id", "approver_id", name="uq_piper_approvals_release_approver"),
    )
    with op.batch_alter_table("piper_approvals", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_piper_approvals_release_id"), ["release_id"], unique=False)

    with op.batch_alter_table("piper_diagrams", schema=None) as batch_op:
        batch_op.add_column(sa.Column("released", sa.String(length=8), nullable=True))
        batch_op.add_column(sa.Column("released_revision", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("piper_diagrams", schema=None) as batch_op:
        batch_op.drop_column("released_revision")
        batch_op.drop_column("released")

    with op.batch_alter_table("piper_approvals", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_piper_approvals_release_id"))

    op.drop_table("piper_approvals")
    with op.batch_alter_table("piper_releases", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_piper_releases_diagram_id"))

    op.drop_table("piper_releases")
