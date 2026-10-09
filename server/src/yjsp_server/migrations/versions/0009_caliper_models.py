"""Vault: Caliper's 3D models

A version's 3D model in each of its configurations, for Caliper, the web app's 3D viewer: a part's mesh (a blob) or an
assembly's components. A new table: nothing that's there changes, and versions from before have no model until Vault
for SolidWorks makes one.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-08 19:26:38.894122
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "caliper_models",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("version_id", sa.Integer(), nullable=False),
        sa.Column("configuration", sa.String(length=255), nullable=False),
        sa.Column("units", sa.String(length=8), nullable=False),
        sa.Column("mesh_sha256", sa.String(length=64), nullable=True),
        sa.Column("components", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["mesh_sha256"], ["blobs.sha256"]),
        sa.ForeignKeyConstraint(["version_id"], ["versions.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("version_id", "configuration", name="uq_caliper_models_version_configuration"),
    )


def downgrade() -> None:
    op.drop_table("caliper_models")
