"""vault: where each 3D model came from

Caliper says where each model it shows came from: made in SolidWorks by Vault for SolidWorks, the 3D view SolidWorks
saved in the file, the server's triangles of the solid SolidWorks saved in it, or an assembly's places as its file keeps
them. A new column that may be empty. The models Vault for SolidWorks made are known by their reader (0), and say so; the
others the server read before it noted how stay empty, which Caliper calls read from the file.

Revision ID: 0030
Revises: 0029
Create Date: 2026-11-13 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030"
down_revision: str | None = "0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable, so SQLite adds it in place, without copying the models.
    with op.batch_alter_table("caliper_models", schema=None) as batch_op:
        batch_op.add_column(sa.Column("source", sa.String(length=16), nullable=True))
    op.execute("UPDATE caliper_models SET source = 'solidworks' WHERE reader = 0")


def downgrade() -> None:
    with op.batch_alter_table("caliper_models", schema=None) as batch_op:
        batch_op.drop_column("source")
