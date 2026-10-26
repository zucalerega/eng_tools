"""piper: color schemes

The team's color schemes, defined in Piper: each one's fluids (name, label, color, gas or not) and the colors of
valves' states. A new table, with one scheme in it to begin with, the team's default: "YJSP standard", the colors Piper
drew in before there were schemes (web/src/piper/fluids.ts and colors.ts as they were, combustion gas included). Nothing
that's there changes: diagrams keep the colors they have until someone picks a scheme for them.

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-25 21:00:00.000000
"""

from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _fluid(id: str, name: str, label: str, color: str, gas: bool) -> dict[str, object]:
    return {"id": id, "name": name, "label": label, "color": color, "gas": gas}


# Piper's standard fluids as they were when schemes came (web/src/piper/fluids.ts), copied: a migration never changes.
STANDARD_FLUIDS = [
    _fluid("lox", "Liquid oxygen", "LOX", "#2f6fd6", False),
    _fluid("gox", "Gaseous oxygen", "GOX", "#5fa8f5", True),
    _fluid("n2o", "Nitrous oxide", "N2O", "#159a9c", False),
    _fluid("h2o2", "Hydrogen peroxide", "H2O2", "#b23a8c", False),
    _fluid("rp1", "RP-1", "RP-1", "#d1392b", False),
    _fluid("ethanol", "Ethanol", "ETH", "#e8702a", False),
    _fluid("ipa", "Isopropyl alcohol", "IPA", "#d38a0c", False),
    _fluid("methane", "Liquid methane", "LCH4", "#a0522d", False),
    _fluid("lh2", "Liquid hydrogen", "LH2", "#4cb5c4", False),
    _fluid("gn2", "Nitrogen", "GN2", "#2e9e4f", True),
    _fluid("ghe", "Helium", "GHe", "#8a55d0", True),
    _fluid("air", "Air", "AIR", "#7d8794", True),
    _fluid("water", "Water", "H2O", "#22a6d6", False),
    _fluid("hydraulic", "Hydraulic oil", "HYD", "#7b7b2a", False),
    _fluid("fuel", "Fuel", "FUEL", "#d1392b", False),
    _fluid("oxidizer", "Oxidizer", "OX", "#2f6fd6", False),
    _fluid("pressurant", "Pressurant", "PRESS", "#2e9e4f", True),
    _fluid("purge", "Purge", "PURGE", "#5d9b8a", True),
    _fluid("vent", "Vent", "VENT", "#9aa3ad", True),
    _fluid("combustion", "Combustion gas", "HOT GAS", "#e0457b", True),
]


def upgrade() -> None:
    op.create_table(
        "piper_schemes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("fluids", sa.JSON(), nullable=False),
        sa.Column("states", sa.JSON(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    schemes = sa.table(
        "piper_schemes",
        sa.column("name", sa.String),
        sa.column("fluids", sa.JSON),
        sa.column("states", sa.JSON),
        sa.column("is_default", sa.Boolean),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    now = datetime.now(UTC)
    op.bulk_insert(
        schemes,
        [
            {
                "name": "YJSP standard",
                "fluids": STANDARD_FLUIDS,
                "states": {"no": "#2e9e4f", "nc": "#d64541", "fip": "#5b7a99", "other": "#e0a500"},
                "is_default": True,
                "created_at": now,
                "updated_at": now,
            }
        ],
    )


def downgrade() -> None:
    op.drop_table("piper_schemes")
