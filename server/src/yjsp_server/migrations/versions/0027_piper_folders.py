"""piper: folders of their own

Piper's folders become their own, as Yorg's datasets' are: a table of folders, each in another or at the top, and a
diagram in one by its id, where it had a path ("Vespula/GSE"). Each path's folders are made from the diagrams that
were in them, whatever their case (two that differ only in it are one folder), each made by whoever made the first
diagram in it, when they made it; and each diagram's put in its own. Then the paths go. Nothing else changes.

Revision ID: 0027
Revises: 0026
Create Date: 2026-10-26 00:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FOLDERS = sa.table(
    "piper_folders",
    sa.column("id", sa.Integer),
    sa.column("parent_id", sa.Integer),
    sa.column("name", sa.String),
    sa.column("name_key", sa.String),
    sa.column("created_at", sa.DateTime(timezone=True)),
    sa.column("created_by", sa.Integer),
)
DIAGRAMS = sa.table(
    "piper_diagrams",
    sa.column("id", sa.Integer),
    sa.column("folder", sa.String),
    sa.column("created_at", sa.DateTime(timezone=True)),
    sa.column("created_by", sa.Integer),
)


def _parts(path: str) -> list[str]:
    """A path's folders' names, as the server tidied them (api/schemas.py _tidy_folder, as it was)."""
    return [part.strip() for part in path.replace("\\", "/").split("/") if part.strip()]


def upgrade() -> None:
    op.create_table(
        "piper_folders",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("name_key", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["parent_id"], ["piper_folders.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("piper_folders", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_piper_folders_parent_id"), ["parent_id"], unique=False)
    with op.batch_alter_table("piper_diagrams", schema=None) as batch_op:
        batch_op.add_column(sa.Column("folder_id", sa.Integer(), nullable=True))
        batch_op.create_index(batch_op.f("ix_piper_diagrams_folder_id"), ["folder_id"], unique=False)
        batch_op.create_foreign_key("fk_piper_diagrams_folder_id_piper_folders", "piper_folders", ["folder_id"], ["id"])

    # Each path's folders, from the diagrams in them, the first made first.
    connection = op.get_bind()
    placed = connection.execute(
        sa.select(DIAGRAMS.c.id, DIAGRAMS.c.folder, DIAGRAMS.c.created_by, DIAGRAMS.c.created_at)
        .where(DIAGRAMS.c.folder != "")
        .order_by(DIAGRAMS.c.created_at, DIAGRAMS.c.id)
    ).all()
    made: dict[tuple[int | None, str], int] = {}  # (the folder it's in, its name lowercased): its id
    for diagram_id, path, created_by, created_at in placed:
        parent: int | None = None
        for name in _parts(path):
            key = (parent, name.lower())
            if key not in made:
                made[key] = connection.execute(
                    sa.insert(FOLDERS)
                    .values(
                        parent_id=parent,
                        name=name[:200],
                        name_key=name[:200].lower(),
                        created_at=created_at,
                        created_by=created_by,
                    )
                    .returning(FOLDERS.c.id)
                ).scalar_one()
            parent = made[key]
        connection.execute(
            sa.text("UPDATE piper_diagrams SET folder_id = :folder WHERE id = :id"),
            {"folder": parent, "id": diagram_id},
        )

    with op.batch_alter_table("piper_diagrams", schema=None) as batch_op:
        batch_op.drop_column("folder")


def downgrade() -> None:
    with op.batch_alter_table("piper_diagrams", schema=None) as batch_op:
        batch_op.add_column(sa.Column("folder", sa.String(length=300), server_default="", nullable=False))
    connection = op.get_bind()
    folders = {
        row.id: (row.parent_id, row.name)
        for row in connection.execute(sa.text("SELECT id, parent_id, name FROM piper_folders"))
    }

    def path(folder_id: int | None) -> str:
        names: list[str] = []
        while folder_id is not None and len(names) < 100:
            parent, name = folders[folder_id]
            names.insert(0, name)
            folder_id = parent
        return "/".join(names)

    for diagram_id, folder_id in connection.execute(
        sa.text("SELECT id, folder_id FROM piper_diagrams WHERE folder_id IS NOT NULL")
    ).all():
        connection.execute(
            sa.text("UPDATE piper_diagrams SET folder = :path WHERE id = :id"),
            {"path": path(folder_id)[:300], "id": diagram_id},
        )
    with op.batch_alter_table("piper_diagrams", schema=None) as batch_op:
        batch_op.drop_constraint("fk_piper_diagrams_folder_id_piper_folders", type_="foreignkey")
        batch_op.drop_index(batch_op.f("ix_piper_diagrams_folder_id"))
        batch_op.drop_column("folder_id")
    with op.batch_alter_table("piper_folders", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_piper_folders_parent_id"))
    op.drop_table("piper_folders")
