"""piper: pictures

The pictures drawings show (an injector, a TCA): a new table of PNGs and JPEGs as they were uploaded, each named by its
SHA-256. In the database, so the nightly and off-site backups keep them with the drawings. Nothing that's there
changes.

Revision ID: 0026
Revises: 0025
Create Date: 2026-10-25 22:34:21.970407
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "piper_images",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("content_type", sa.String(length=32), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("uploaded_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["uploaded_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("sha256", name="uq_piper_images_sha256"),
    )


def downgrade() -> None:
    op.drop_table("piper_images")
