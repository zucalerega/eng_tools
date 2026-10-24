"""vault: an admin's pause

An admin pauses the vault for work on all of it, such as numbering every file at once (docs/vault.md, "Pausing the
vault"): changes wait until it's back, but the admin's own, from the computer they paused it on (vault.pause).
vault_state is one row that nothing points at, so SQLite copying it for the foreign key loses nothing.

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-23 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PAUSED_BY = "fk_vault_state_paused_by_users"  # SQLite's batch mode needs it named


def upgrade() -> None:
    with op.batch_alter_table("vault_state", schema=None) as batch_op:
        batch_op.add_column(sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(
            sa.Column("paused_by", sa.Integer(), sa.ForeignKey("users.id", name=_PAUSED_BY), nullable=True)
        )
        batch_op.add_column(sa.Column("paused_host", sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column("paused_reason", sa.String(length=500), server_default="", nullable=False))


def downgrade() -> None:
    with op.batch_alter_table("vault_state", schema=None) as batch_op:
        batch_op.drop_column("paused_reason")
        batch_op.drop_column("paused_host")
        batch_op.drop_column("paused_by")
        batch_op.drop_column("paused_at")
