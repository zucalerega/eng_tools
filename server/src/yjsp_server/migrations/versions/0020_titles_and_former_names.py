"""vault: titles, vendor parts, and former names

Every file gets a title, what people call it: part numbers (docs/vault.md) make file names numbers, and the title is
what's shown beside them. Files take their names without their types (Fin Bracket for Fin Bracket.SLDPRT), the first
migration that fills in data: SQLite and Postgres cut strings differently, so Python does it, in batches. A vendor flag
marks files that keep a vendor's name. Both are non-null columns with server defaults, which SQLite adds in place,
without copying files, which most tables point at. former_names keeps where files were before a rename or a move,
which SolidWorks files that used them still name.

It was 0018 on its branch. Drawings' PDFs, the oldest client, and Piper merged before it as 0017 to 0019, so it follows
Piper's 0019; other branches' migrations take the next numbers when they merge, each pointing at the one before.

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-23 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_BATCH = 500


def _stem(name: str) -> str:
    """A name without its type, as paths.stem has it then."""
    dot = name.rfind(".")
    return name[:dot] if dot > 0 else name


def upgrade() -> None:
    with op.batch_alter_table("files", schema=None) as batch_op:
        batch_op.add_column(sa.Column("title", sa.String(length=200), server_default="", nullable=False))
        batch_op.add_column(sa.Column("vendor", sa.Boolean(), server_default=sa.false(), nullable=False))
    files = sa.table("files", sa.column("id", sa.Integer), sa.column("name", sa.String), sa.column("title", sa.String))
    connection = op.get_bind()
    rows = connection.execute(sa.select(files.c.id, files.c.name).order_by(files.c.id)).all()
    named = files.update().where(files.c.id == sa.bindparam("file")).values(title=sa.bindparam("stem"))
    for start in range(0, len(rows), _BATCH):
        connection.execute(
            named, [{"file": id, "stem": _stem(name)[:200]} for id, name in rows[start : start + _BATCH]]
        )

    op.create_table(
        "former_names",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("file_id", sa.Integer(), nullable=False),
        sa.Column("path", sa.String(length=1024), nullable=False),
        sa.Column("name_key", sa.String(length=255), nullable=False),
        sa.Column("changed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("changed_by", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["changed_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["file_id"], ["files.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("former_names", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_former_names_file_id"), ["file_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_former_names_name_key"), ["name_key"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("former_names", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_former_names_name_key"))
        batch_op.drop_index(batch_op.f("ix_former_names_file_id"))
    op.drop_table("former_names")
    with op.batch_alter_table("files", schema=None) as batch_op:
        batch_op.drop_column("vendor")
        batch_op.drop_column("title")
