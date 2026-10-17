"""vault: which reader made each 3D model

The server notes which version of its reader made each Caliper model it reads from a file, so it can read them again
when a newer one is out; 0 for one Vault for SolidWorks made. A new column that may be empty: the models already there
keep none, and the server tells them by what they carry (vault.py, _reader).

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-17 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable, so SQLite adds it in place, without copying the models.
    with op.batch_alter_table("caliper_models", schema=None) as batch_op:
        batch_op.add_column(sa.Column("reader", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("caliper_models", schema=None) as batch_op:
        batch_op.drop_column("reader")
