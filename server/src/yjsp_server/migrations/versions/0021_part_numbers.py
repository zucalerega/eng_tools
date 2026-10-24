"""vault: part numbers, their kinds, and whether new files take them

Part numbers (vault/numbers.py; docs/vault.md, "Part numbers"): the kinds admins keep, starting with one for parts and
one for assemblies, which the vault's files take when they're numbered; the numbers handed out, and the files that
have them; and the vault's next number, and whether new files take numbers (off, until the vault's files are numbered).

Ground Structures named their parts and assemblies by numbers of their own before (00000011-001 to 00000011-013, the
parts of one project, and 00000011-501 its assembly). They keep their names, so each is recorded as holding its number
(legacy), and the numbers handed out start after the largest any file's name has.

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-23 16:00:00.000000
"""

import re
from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_BATCH = 500
# As numbers.py has them now: a name that starts with a number and a kind, and the types that hold numbers.
_NUMBERED = re.compile(r"^(\d{8})-(\d{3})(?![0-9A-Za-z])")
_HOLDERS = (".sldprt", ".sldasm", ".step", ".stp", ".stl")


def _numbered(name: str) -> tuple[int, str, str] | None:
    """A name's number, kind, and type, if it starts with a part number."""
    dot = name.rfind(".")
    stem, extension = (name[:dot], name[dot:].lower()) if dot > 0 else (name, "")
    found = _NUMBERED.match(stem)
    return (int(found.group(1)), found.group(2), extension) if found else None


def upgrade() -> None:
    with op.batch_alter_table("vault_state", schema=None) as batch_op:
        batch_op.add_column(sa.Column("next_number", sa.Integer(), server_default="1", nullable=False))
        batch_op.add_column(
            sa.Column(
                "numbering",
                sa.Enum("off", "offer", "require", name="numbering", native_enum=False, length=16),
                server_default="off",
                nullable=False,
            )
        )

    op.create_table(
        "part_kinds",
        sa.Column("code", sa.String(length=3), nullable=False),
        sa.Column("label", sa.String(length=100), nullable=False),
        sa.Column(
            "applies", sa.Enum("part", "assembly", "any", name="applies", native_enum=False, length=16), nullable=False
        ),
        sa.Column("retired", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("code"),
    )
    op.create_table(
        "part_numbers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=3), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("file_id", sa.Integer(), nullable=True),
        sa.Column("legacy", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("issued_by", sa.Integer(), nullable=True),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["file_id"], ["files.id"]),
        sa.ForeignKeyConstraint(["issued_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("part_numbers", schema=None) as batch_op:
        batch_op.create_index("ix_part_numbers_issued_by", ["issued_by"], unique=False)
        batch_op.create_index("ix_part_numbers_number_kind", ["number", "kind"], unique=False)
        batch_op.create_index("uq_part_numbers_file_id", ["file_id"], unique=True)
        batch_op.create_index(
            "uq_part_numbers_number",
            ["number"],
            unique=True,
            sqlite_where=sa.text("legacy = 0"),
            postgresql_where=sa.text("NOT legacy"),
        )

    now = datetime.now(UTC)
    kinds = sa.table(
        "part_kinds",
        sa.column("code", sa.String),
        sa.column("label", sa.String),
        sa.column("applies", sa.String),
        sa.column("retired", sa.Boolean),
        sa.column("created_at", sa.DateTime(timezone=True)),
    )
    op.bulk_insert(
        kinds,
        [
            {"code": "001", "label": "Part", "applies": "part", "retired": False, "created_at": now},
            {"code": "501", "label": "Assembly", "applies": "assembly", "retired": False, "created_at": now},
        ],
    )

    connection = op.get_bind()
    files = sa.table("files", sa.column("id", sa.Integer), sa.column("name", sa.String))
    legacy, largest = [], 0
    for id, name in connection.execute(sa.select(files.c.id, files.c.name).order_by(files.c.id)):
        numbered = _numbered(name)
        if numbered is None:
            continue
        number, kind, extension = numbered
        largest = max(largest, number)
        if extension in _HOLDERS:
            legacy.append(
                {"number": number, "kind": kind, "title": "", "file_id": id, "legacy": True, "issued_at": now}
            )
    numbers = sa.table(
        "part_numbers",
        sa.column("number", sa.Integer),
        sa.column("kind", sa.String),
        sa.column("title", sa.String),
        sa.column("file_id", sa.Integer),
        sa.column("legacy", sa.Boolean),
        sa.column("issued_at", sa.DateTime(timezone=True)),
    )
    for start in range(0, len(legacy), _BATCH):
        connection.execute(numbers.insert(), legacy[start : start + _BATCH])
    state = sa.table("vault_state", sa.column("next_number", sa.Integer))
    connection.execute(state.update().values(next_number=largest + 1))


def downgrade() -> None:
    with op.batch_alter_table("part_numbers", schema=None) as batch_op:
        batch_op.drop_index("uq_part_numbers_number", sqlite_where=sa.text("legacy = 0"))
        batch_op.drop_index("uq_part_numbers_file_id")
        batch_op.drop_index("ix_part_numbers_number_kind")
        batch_op.drop_index("ix_part_numbers_issued_by")
    op.drop_table("part_numbers")
    op.drop_table("part_kinds")
    with op.batch_alter_table("vault_state", schema=None) as batch_op:
        batch_op.drop_column("numbering")
        batch_op.drop_column("next_number")
