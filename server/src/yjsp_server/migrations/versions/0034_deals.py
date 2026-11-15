"""deals: listings on eBay for what the team wants, and the runs that find them

The deals finder (deals/) searches eBay each day for what the team's apps want, and keeps the listings that would do
(deals), each with what it's for as the app said it, and how each run went (deal_runs). New tables, and a new purpose
for a request to Claude (assistant_requests.purpose "deals", a plain string), so nothing that's there changes.

Revision ID: 0034
Revises: 0033
Create Date: 2026-11-14 23:56:07.008524
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0034"
down_revision: str | None = "0033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "deal_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_by", sa.Integer(), nullable=True),
        sa.Column("wants", sa.Integer(), nullable=False),
        sa.Column("searches", sa.Integer(), nullable=False),
        sa.Column("listings", sa.Integer(), nullable=False),
        sa.Column("found", sa.Integer(), nullable=False),
        sa.Column("gone", sa.Integer(), nullable=False),
        sa.Column("judged", sa.Boolean(), nullable=False),
        sa.Column("cost", sa.BigInteger(), nullable=False),
        sa.Column("problem", sa.String(length=500), nullable=True),
        sa.ForeignKeyConstraint(["started_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("deal_runs", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_deal_runs_started_at"), ["started_at"], unique=False)

    op.create_table(
        "deals",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("listing", sa.String(length=100), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("url", sa.String(length=2000), nullable=False),
        sa.Column("image", sa.String(length=2000), nullable=True),
        sa.Column("price", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("shipping", sa.Integer(), nullable=True),
        sa.Column("condition", sa.String(length=100), nullable=False),
        sa.Column("auction", sa.Boolean(), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("want_key", sa.String(length=200), nullable=False),
        sa.Column("want_title", sa.String(length=200), nullable=False),
        sa.Column("want_where", sa.String(length=300), nullable=False),
        sa.Column("want_href", sa.String(length=500), nullable=False),
        sa.Column("search", sa.String(length=400), nullable=False),
        sa.Column("fit", sa.Float(), nullable=False),
        sa.Column("typical", sa.Integer(), nullable=True),
        sa.Column("reason", sa.String(length=500), nullable=False),
        sa.Column("found_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("gone_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dismissed_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["dismissed_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source", "listing", "want_key", name="uq_deals_source_listing_want"),
    )
    with op.batch_alter_table("deals", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_deals_checked_at"), ["checked_at"], unique=False)
        batch_op.create_index(batch_op.f("ix_deals_want_key"), ["want_key"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("deals", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_deals_want_key"))
        batch_op.drop_index(batch_op.f("ix_deals_checked_at"))

    op.drop_table("deals")
    with op.batch_alter_table("deal_runs", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_deal_runs_started_at"))

    op.drop_table("deal_runs")
