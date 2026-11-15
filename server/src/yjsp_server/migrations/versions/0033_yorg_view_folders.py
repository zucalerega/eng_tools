"""yorg: folders of views of their own

Saved views' folders become their own, as the datasets' are (and Piper's diagrams' since 0027): a table of folders,
each in another or at the top, and a view in one by its id, where it had a path ("Hotfires/HF-3"). Each path's folders
are made from the views that were in them, whatever their case (two that differ only in it are one folder), each made
by whoever saved the oldest view in it or under it, when they saved it, so the person who started using a folder can
still rename, move, or delete it; and each view's put in its own. Then the paths go. Nothing else changes. On SQLite,
yorg_views is copied to change it; nothing points at it.

Revision ID: 0033
Revises: 0032
Create Date: 2026-11-14 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0033"
down_revision: str | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FOLDERS = sa.table(
    "yorg_view_folders",
    sa.column("id", sa.Integer),
    sa.column("parent_id", sa.Integer),
    sa.column("name", sa.String),
    sa.column("name_key", sa.String),
    sa.column("created_at", sa.DateTime(timezone=True)),
    sa.column("created_by", sa.Integer),
)
VIEWS = sa.table(
    "yorg_views",
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
        "yorg_view_folders",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("name_key", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["parent_id"], ["yorg_view_folders.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("yorg_view_folders", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_yorg_view_folders_parent_id"), ["parent_id"], unique=False)
    with op.batch_alter_table("yorg_views", schema=None) as batch_op:
        batch_op.add_column(sa.Column("folder_id", sa.Integer(), nullable=True))
        batch_op.create_index(batch_op.f("ix_yorg_views_folder_id"), ["folder_id"], unique=False)
        batch_op.create_foreign_key(
            "fk_yorg_views_folder_id_yorg_view_folders", "yorg_view_folders", ["folder_id"], ["id"]
        )

    # Each path's folders, from the views in them, the oldest first: so a folder is made by the oldest view in it or
    # under it, whoever saved that.
    connection = op.get_bind()
    placed = connection.execute(
        sa.select(VIEWS.c.id, VIEWS.c.folder, VIEWS.c.created_by, VIEWS.c.created_at)
        .where(VIEWS.c.folder != "")
        .order_by(VIEWS.c.created_at, VIEWS.c.id)
    ).all()
    made: dict[tuple[int | None, str], int] = {}  # (the folder it's in, its name lowercased): its id
    for view_id, path, created_by, created_at in placed:
        parent: int | None = None
        for name in _parts(path):
            key = (parent, name[:200].lower())
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
            sa.text("UPDATE yorg_views SET folder_id = :folder WHERE id = :id"),
            {"folder": parent, "id": view_id},
        )

    with op.batch_alter_table("yorg_views", schema=None) as batch_op:
        batch_op.drop_column("folder")


def downgrade() -> None:
    with op.batch_alter_table("yorg_views", schema=None) as batch_op:
        batch_op.add_column(sa.Column("folder", sa.String(length=300), server_default="", nullable=False))
    connection = op.get_bind()
    folders = {
        row.id: (row.parent_id, row.name)
        for row in connection.execute(sa.text("SELECT id, parent_id, name FROM yorg_view_folders"))
    }

    def path(folder_id: int | None) -> str:
        names: list[str] = []
        while folder_id is not None and len(names) < 100:
            parent, name = folders[folder_id]
            names.insert(0, name)
            folder_id = parent
        return "/".join(names)

    for view_id, folder_id in connection.execute(
        sa.text("SELECT id, folder_id FROM yorg_views WHERE folder_id IS NOT NULL")
    ).all():
        connection.execute(
            sa.text("UPDATE yorg_views SET folder = :path WHERE id = :id"),
            {"path": path(folder_id)[:300], "id": view_id},
        )
    with op.batch_alter_table("yorg_views", schema=None) as batch_op:
        batch_op.drop_constraint("fk_yorg_views_folder_id_yorg_view_folders", type_="foreignkey")
        batch_op.drop_index(batch_op.f("ix_yorg_views_folder_id"))
        batch_op.drop_column("folder_id")
    with op.batch_alter_table("yorg_view_folders", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_yorg_view_folders_parent_id"))
    op.drop_table("yorg_view_folders")
