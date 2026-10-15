"""Who used the site when, for Admin > People's tracker: how many people were on each day, and how long they had the
web app open (admins only)."""

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import update

from yjsp_server import auth
from yjsp_server.db import utcnow
from yjsp_server.models import SiteUsage, Token, User

ATLANTA = ZoneInfo("America/New_York")


def browser(app, team, email: str) -> dict[str, str]:
    """A signed-in browser of theirs, whose web app asks who they are every minute while it's open."""
    with app.state.sessionmaker() as db:
        secret = auth.issue_token(db, db.get_one(User, team.ids[email]), kind=auth.SESSION, name="Firefox")
    return {"Authorization": f"Bearer {secret}"}


def last_used(app, team, email: str, minutes: int) -> None:
    """As if their tokens were last used that many minutes ago."""
    with app.state.sessionmaker() as db:
        stamp = utcnow() - timedelta(minutes=minutes)
        db.execute(update(Token).where(Token.user_id == team.ids[email]).values(last_used_at=stamp))
        db.commit()


def on(app, team, email: str, hour: datetime, site_seconds: int = 0) -> None:
    """As if they used the site in that hour, before the test."""
    with app.state.sessionmaker() as db:
        db.add(SiteUsage(hour=hour, user_id=team.ids[email], site_seconds=site_seconds))
        db.commit()


def test_admins_see_how_many_people_used_the_site_each_day_and_for_how_long(app, client, team):
    chief = team.member("chief@x.test", admin=True)
    team.member("alice@x.test")
    bob = team.member("bob@x.test")
    alice = browser(app, team, "alice@x.test")

    # Alice's web app is open for two minutes; Bob uses the add-in, which is time on Vault but not on the web app.
    client.get("/api/me", headers=alice)
    last_used(app, team, "alice@x.test", 2)
    client.get("/api/me", headers=alice)
    client.get("/api/folders", headers=bob)
    # And two days ago, in Atlanta's afternoon, Alice had the web app open for ten minutes.
    today = utcnow().astimezone(ATLANTA).date()
    afternoon = datetime.combine(today - timedelta(days=2), time(15), tzinfo=ATLANTA).astimezone(UTC)
    on(app, team, "alice@x.test", afternoon, site_seconds=600)

    usage = client.get("/api/usage", params={"days": 7, "tz": "America/New_York"}, headers=chief).json()
    assert usage["timezone"] == "America/New_York"
    assert [day["day"] for day in usage["days"]] == [str(today - timedelta(days=n)) for n in range(6, -1, -1)]
    *before, two_days_ago, yesterday, now = usage["days"]
    assert now["people"] == 3  # Alice, Bob, and the chief, looking
    assert 115 <= now["site_seconds"] <= 125
    assert (two_days_ago["people"], two_days_ago["site_seconds"]) == (1, 600)
    assert (yesterday["people"], yesterday["site_seconds"]) == (0, 0)
    assert all(day["people"] == 0 for day in before)
    assert (usage["people"], usage["since"]) == (3, str(today - timedelta(days=2)))
    assert 115 <= usage["total_site_seconds"] <= 125  # the ten minutes were set up, not counted

    # Only admins see it.
    refused = client.get("/api/usage", headers=bob)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
    assert client.get("/api/usage", params={"days": 0}, headers=chief).status_code == 422


def test_days_are_the_time_zones_the_page_asks_for(app, client, team):
    chief = team.member("chief@x.test", admin=True)
    team.member("alice@x.test")
    # 2 AM UTC, two days ago: the evening before in Atlanta.
    late = datetime.combine(utcnow().date() - timedelta(days=2), time(2), tzinfo=UTC)
    on(app, team, "alice@x.test", late, site_seconds=60)

    def day_of_alice(tz: str) -> str:
        usage = client.get("/api/usage", params={"days": 7, "tz": tz}, headers=chief).json()
        [day] = [day["day"] for day in usage["days"] if day["site_seconds"] == 60]
        return day

    assert day_of_alice("UTC") == str(late.date())
    assert day_of_alice("America/New_York") == str(late.date() - timedelta(days=1))
    # A time zone the server doesn't know is UTC, and says so.
    unknown = client.get("/api/usage", params={"tz": "Mars/Olympus_Mons"}, headers=chief).json()
    assert (unknown["timezone"], len(unknown["days"])) == ("UTC", 30)


def test_someone_on_twice_in_an_hour_counts_once_with_both_times(app, client, team):
    chief = team.member("chief@x.test", admin=True)
    team.member("alice@x.test")
    alice = browser(app, team, "alice@x.test")
    client.get("/api/me", headers=alice)
    for _ in range(2):  # every few minutes, as an open page does
        last_used(app, team, "alice@x.test", 3)
        client.get("/api/me", headers=alice)

    usage = client.get("/api/usage", params={"days": 2}, headers=chief).json()
    assert usage["days"][-1]["people"] == 2  # Alice and the chief
    seconds = sum(day["site_seconds"] for day in usage["days"])  # both days, in case this ran across midnight
    with app.state.sessionmaker() as db:
        alices = db.query(SiteUsage).filter(SiteUsage.user_id == team.ids["alice@x.test"]).all()
    assert sum(row.site_seconds for row in alices) == seconds
    assert 350 <= seconds <= 370


def test_hours_are_kept_a_little_over_a_year(app, client, team):
    chief = team.member("chief@x.test", admin=True)
    long_ago = datetime.combine(utcnow().date() - timedelta(days=401), time(12), tzinfo=UTC)
    within = datetime.combine(utcnow().date() - timedelta(days=399), time(12), tzinfo=UTC)
    team.member("alice@x.test")
    on(app, team, "alice@x.test", long_ago, site_seconds=60)
    on(app, team, "alice@x.test", within, site_seconds=60)

    client.get("/api/me", headers=chief)  # noting a use forgets what's past keeping
    with app.state.sessionmaker() as db:
        kept = sorted(row.hour for row in db.query(SiteUsage).filter(SiteUsage.user_id == team.ids["alice@x.test"]))
    assert kept == [within]
