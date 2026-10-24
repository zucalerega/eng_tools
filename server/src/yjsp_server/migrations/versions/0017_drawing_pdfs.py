"""Vault: drawings' PDFs, for Caliper

A drawing version's sheets as a PDF (a blob), which Vault for SolidWorks saves when it checks a drawing in, for Caliper
to show in the web app. A new table: nothing that's there changes, and versions from before have no PDF until Vault
for SolidWorks makes one (Caliper shows the pictures of their sheets SolidWorks saved in them meanwhile).

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-23 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "drawing_pdfs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("version_id", sa.Integer(), nullable=False),
        sa.Column("pdf_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["pdf_sha256"], ["blobs.sha256"]),
        sa.ForeignKeyConstraint(["version_id"], ["versions.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("version_id", name="uq_drawing_pdfs_version"),
    )


def downgrade() -> None:
    op.drop_table("drawing_pdfs")
