"""buildflow: the team's programs, each one's bill of design

Buildflow is a new app (buildflow/): each program (Hopper, Elytra, Felicette 2, HETS) has its vehicle's drawing, its
milestones in four phases (design, build, test, launch), its subsystems and their components, and each component's
progress at each milestone, its links, and its people; and what's been done to it, its activity. All new tables, so
nothing there already changes.

Revision ID: 0033
Revises: 0032
Create Date: 2026-11-14 23:12:56.839389
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0033"
down_revision: str | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "buildflow_programs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("name_key", sa.String(length=100), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("profile", sa.JSON(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name_key", name="uq_buildflow_programs_name"),
    )
    op.create_table(
        "buildflow_milestones",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("program_id", sa.Integer(), nullable=False),
        sa.Column(
            "phase",
            sa.Enum("design", "build", "test", "launch", name="phase", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=40), nullable=False),
        sa.Column("name_key", sa.String(length=40), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("review", sa.Boolean(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["program_id"], ["buildflow_programs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("program_id", "name_key", name="uq_buildflow_milestones_program_name"),
    )
    with op.batch_alter_table("buildflow_milestones", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_milestones_program_id"), ["program_id"], unique=False)

    op.create_table(
        "buildflow_subsystems",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("program_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("name_key", sa.String(length=100), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["program_id"], ["buildflow_programs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("program_id", "name_key", name="uq_buildflow_subsystems_program_name"),
    )
    with op.batch_alter_table("buildflow_subsystems", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_subsystems_program_id"), ["program_id"], unique=False)

    op.create_table(
        "buildflow_components",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("program_id", sa.Integer(), nullable=False),
        sa.Column("subsystem_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("bought", sa.Boolean(), nullable=False),
        sa.Column("x", sa.Float(), nullable=True),
        sa.Column("y", sa.Float(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("lead_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["lead_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["program_id"], ["buildflow_programs.id"]),
        sa.ForeignKeyConstraint(["removed_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["subsystem_id"], ["buildflow_subsystems.id"]),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("buildflow_components", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_components_program_id"), ["program_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_components_subsystem_id"), ["subsystem_id"], unique=False)

    op.create_table(
        "buildflow_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("program_id", sa.Integer(), nullable=False),
        sa.Column("component_id", sa.Integer(), nullable=True),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("what", sa.String(length=500), nullable=False),
        sa.ForeignKeyConstraint(["component_id"], ["buildflow_components.id"]),
        sa.ForeignKeyConstraint(["program_id"], ["buildflow_programs.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("buildflow_events", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_events_at"), ["at"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_events_component_id"), ["component_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_events_program_id"), ["program_id"], unique=False)

    op.create_table(
        "buildflow_links",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("component_id", sa.Integer(), nullable=False),
        sa.Column(
            "phase",
            sa.Enum("design", "build", "test", "launch", name="phase", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("milestone_id", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("url", sa.String(length=2000), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("added_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["added_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["component_id"], ["buildflow_components.id"]),
        sa.ForeignKeyConstraint(["milestone_id"], ["buildflow_milestones.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("buildflow_links", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_links_component_id"), ["component_id"], unique=False)

    op.create_table(
        "buildflow_people",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("component_id", sa.Integer(), nullable=False),
        sa.Column(
            "phase",
            sa.Enum("design", "build", "test", "launch", name="phase", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["component_id"], ["buildflow_components.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("component_id", "phase", "user_id", name="uq_buildflow_people_component_phase_user"),
    )
    with op.batch_alter_table("buildflow_people", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_people_component_id"), ["component_id"], unique=False)

    op.create_table(
        "buildflow_progress",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("component_id", sa.Integer(), nullable=False),
        sa.Column("milestone_id", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "not_started", "in_progress", "done", "blocked", "skipped", name="status", native_enum=False, length=16
            ),
            nullable=False,
        ),
        sa.Column("due", sa.Date(), nullable=True),
        sa.Column("done_on", sa.Date(), nullable=True),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["component_id"], ["buildflow_components.id"]),
        sa.ForeignKeyConstraint(["milestone_id"], ["buildflow_milestones.id"]),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("component_id", "milestone_id", name="uq_buildflow_progress_component_milestone"),
    )
    with op.batch_alter_table("buildflow_progress", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_buildflow_progress_component_id"), ["component_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_buildflow_progress_milestone_id"), ["milestone_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("buildflow_progress", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_progress_milestone_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_progress_component_id"))

    op.drop_table("buildflow_progress")
    with op.batch_alter_table("buildflow_people", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_people_component_id"))

    op.drop_table("buildflow_people")
    with op.batch_alter_table("buildflow_links", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_links_component_id"))

    op.drop_table("buildflow_links")
    with op.batch_alter_table("buildflow_events", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_events_program_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_events_component_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_events_at"))

    op.drop_table("buildflow_events")
    with op.batch_alter_table("buildflow_components", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_components_subsystem_id"))
        batch_op.drop_index(batch_op.f("ix_buildflow_components_program_id"))

    op.drop_table("buildflow_components")
    with op.batch_alter_table("buildflow_subsystems", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_subsystems_program_id"))

    op.drop_table("buildflow_subsystems")
    with op.batch_alter_table("buildflow_milestones", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_buildflow_milestones_program_id"))

    op.drop_table("buildflow_milestones")
    op.drop_table("buildflow_programs")
