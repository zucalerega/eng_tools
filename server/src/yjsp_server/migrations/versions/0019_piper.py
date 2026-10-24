"""piper: diagrams and their revisions

Piper, the site's third app, draws the team's fluid systems: its diagrams, each with a name, a folder, and a
description, and their revisions, each a drawing as the web app saved it, compressed. New tables only: nothing that's
there changes.

It was 0017 when it merged, as were drawings' PDFs and the oldest client's: it follows those, which merged first.

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-23 12:07:59.770160
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "piper_diagrams",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("folder", sa.String(length=300), server_default="", nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("summary", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["deleted_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "piper_revisions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("diagram_id", sa.Integer(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("drawing", sa.LargeBinary(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("note", sa.String(length=200), server_default="", nullable=False),
        sa.Column("restored_from", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("author_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["diagram_id"], ["piper_diagrams.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("diagram_id", "number", name="uq_piper_revisions_diagram_number"),
    )
    with op.batch_alter_table("piper_revisions", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_piper_revisions_diagram_id"), ["diagram_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("piper_revisions", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_piper_revisions_diagram_id"))
    op.drop_table("piper_revisions")
    op.drop_table("piper_diagrams")
