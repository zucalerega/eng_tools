"""site settings: the oldest Vault client that can change the vault

Admins can have the vault take changes only from add-ins and CLIs at least as new as a version they set (Admin > People,
clients.refuse_old). A new column that may be empty, as it is on the row that's there: until an admin sets it, any
client can change the vault, as before.

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
    # Nullable, so SQLite adds it in place.
    with op.batch_alter_table("site_settings", schema=None) as batch_op:
        batch_op.add_column(sa.Column("min_client_version", sa.String(length=32), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("site_settings", schema=None) as batch_op:
        batch_op.drop_column("min_client_version")
