"""vault: where each 3D model is from

Caliper says where the view it shows is from: Vault for SolidWorks, which made it from what SolidWorks had open; or the
server, which read a part's from the 3D view SolidWorks saved in its file, or made it from the solid the file keeps
(close, not SolidWorks' own triangles). A new column that may be empty: the models already there keep none, and the
server tells Vault for SolidWorks' by their reader (vault.py, _source), and says of the rest only that they were read
from their files.

Revision ID: 0032
Revises: 0031
Create Date: 2026-11-14 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0032"
down_revision: str | None = "0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable, so SQLite adds it in place, without copying the models.
    with op.batch_alter_table("caliper_models", schema=None) as batch_op:
        batch_op.add_column(sa.Column("source", sa.String(length=16), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("caliper_models", schema=None) as batch_op:
        batch_op.drop_column("source")
