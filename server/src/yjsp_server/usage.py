"""Who used the site when, for Admin > People's tracker: how many people were on each day, and how long they had the
web app open and worked in SolidWorks (admins only).

auth.authenticate notes a token's use at most once a minute, and each time this records that its owner was on in that
hour: with the web app, the add-in, or the CLI. A browser session used again within a few minutes had the web app open
all along, so that time counts too (auth._SAME_VISIT), and so does the add-in's, as time in SolidWorks, when its
request says someone is working in it. Hours are kept in UTC, and grouped into days in the time zone the page asks
for, so that a day is the team's own and not UTC's.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import Session

from .db import utcnow
from .models import SiteUsage, User

# Who was on in which hour is kept this long: past a year, for a year-to-year look, and no longer.
KEEP = timedelta(days=400)


def record(db: Session, user_id: int, at: datetime, site_seconds: int = 0, solidworks_seconds: int = 0) -> None:
    """Note that someone used the site at that time, with that many more seconds on the web app and in SolidWorks
    (often none). The caller commits."""
    hour = at.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    insert = postgresql.insert if db.get_bind().dialect.name == "postgresql" else sqlite.insert
    stmt = insert(SiteUsage).values(
        hour=hour, user_id=user_id, site_seconds=site_seconds, solidworks_seconds=solidworks_seconds
    )
    # Two of someone's tokens (a browser and the add-in, say) can note the same hour at once: add up, never collide.
    excluded = stmt.excluded
    db.execute(
        stmt.on_conflict_do_update(
            index_elements=["hour", "user_id"],
            set_={
                "site_seconds": SiteUsage.site_seconds + excluded.site_seconds,
                "solidworks_seconds": SiteUsage.solidworks_seconds + excluded.solidworks_seconds,
            },
        )
    )
    if site_seconds or solidworks_seconds:
        db.execute(
            update(User)
            .where(User.id == user_id)
            .values(
                site_seconds=User.site_seconds + site_seconds,
                solidworks_seconds=User.solidworks_seconds + solidworks_seconds,
            )
        )
    # The oldest hour is a look at the index: only when one is past KEEP does anything go.
    oldest = db.scalar(select(func.min(SiteUsage.hour)))
    if oldest is not None and oldest < hour - KEEP:
        db.execute(delete(SiteUsage).where(SiteUsage.hour < hour - KEEP))


@dataclass
class Day:
    day: date
    people: int  # who used the site that day
    site_seconds: int  # how long the web app was open that day, everyone's together
    solidworks_seconds: int  # how long people worked in SolidWorks that day, everyone's together


@dataclass
class Usage:
    timezone: str  # the days': the one asked for, or UTC if it isn't one this server knows
    days: list[Day]  # oldest first; the last is today, so far
    people: int  # who used the site on any of those days
    since: date | None  # the first day anything was recorded: before it, nothing was
    total_site_seconds: int  # everyone's time on the web app, since it was first counted
    total_solidworks_seconds: int  # everyone's time in SolidWorks, since it was first counted
    # The first day anyone's time in SolidWorks was counted: the add-in says it from the release that added it on.
    solidworks_since: date | None


def daily(db: Session, days: int, timezone: str) -> Usage:
    """The last `days` days of the site's use, today last, in the time zone (an IANA name, like America/New_York)."""
    zone, name = _zone(timezone)
    today = utcnow().astimezone(zone).date()
    first = today - timedelta(days=days - 1)
    start = datetime.combine(first, time(), tzinfo=zone).astimezone(UTC)
    on: dict[date, set[int]] = {first + timedelta(days=n): set() for n in range(days)}
    site = dict.fromkeys(on, 0)
    solidworks = dict.fromkeys(on, 0)
    rows = db.execute(
        select(SiteUsage.hour, SiteUsage.user_id, SiteUsage.site_seconds, SiteUsage.solidworks_seconds).where(
            SiteUsage.hour >= start
        )
    )
    for hour, user_id, site_seconds, solidworks_seconds in rows:
        day = hour.astimezone(zone).date()
        if day in on:  # an hour from later today, by a clock that's ahead, isn't
            on[day].add(user_id)
            site[day] += site_seconds
            solidworks[day] += solidworks_seconds
    earliest = db.scalar(select(func.min(SiteUsage.hour)))
    earliest_solidworks = db.scalar(select(func.min(SiteUsage.hour)).where(SiteUsage.solidworks_seconds > 0))
    totals = db.execute(
        select(func.coalesce(func.sum(User.site_seconds), 0), func.coalesce(func.sum(User.solidworks_seconds), 0))
    ).one()
    return Usage(
        timezone=name,
        days=[Day(day, len(on[day]), site[day], solidworks[day]) for day in on],
        people=len(set().union(*on.values())),
        since=earliest.astimezone(zone).date() if earliest else None,
        total_site_seconds=int(totals[0]),
        total_solidworks_seconds=int(totals[1]),
        solidworks_since=earliest_solidworks.astimezone(zone).date() if earliest_solidworks else None,
    )


def _zone(name: str) -> tuple[tzinfo, str]:
    """The time zone by its IANA name, or UTC if this server doesn't know it (a container without time zone data)."""
    try:
        return ZoneInfo(name), name
    except (ZoneInfoNotFoundError, ValueError):
        return UTC, "UTC"
