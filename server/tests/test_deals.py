"""Deals: what the team's apps want, searched for on eBay (played by a stand-in), the listings that would do kept and
shown, Claude's say on which do, keeping them current as eBay's terms ask, and dismissing them (deals/)."""

import hashlib
import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from yjsp_server.deals import wants
from yjsp_server.models import AssistantPurpose, AssistantRequest, Deal

from .fake_claude import FakeClaude, Reply
from .fake_ebay import CLIENT_ID, CLIENT_SECRET, FakeEbay, item

VALVE = "v1|110001|0"
TUBE = "v1|110002|0"


@pytest.fixture
def ebay() -> Iterator[FakeEbay]:
    fake = FakeEbay()
    yield fake
    fake.close()


@pytest.fixture
def claude() -> Iterator[FakeClaude]:
    fake = FakeClaude()
    yield fake
    fake.close()


@pytest.fixture(autouse=True)
def deals_on(settings, ebay, claude):
    """eBay's API is the stand-in's, and Claude's too, with $5 to spend; nothing runs on schedule."""
    settings.ebay_client_id, settings.ebay_client_secret = CLIENT_ID, CLIENT_SECRET
    settings.ebay_base_url = ebay.url
    settings.ebay_verification_token = "t" * 40
    settings.public_url = "https://yjsp.example.org"
    settings.deals_schedule = False
    settings.deals_claude = False  # words alone, unless a test says
    settings.anthropic_api_key = "test-key"
    settings.anthropic_base_url = claude.url
    settings.assistant_budget = 5.0


def elytra(team, admin) -> dict:
    made = team.client.post("/api/buildflow/programs", json={"name": "Elytra", "template": "rocket"}, headers=admin)
    assert made.status_code == 201, made.text
    return made.json()


def named(bill: dict, name: str) -> dict:
    return next(c for c in bill["components"] if c["name"] == name)


def describe(team, who, component: dict, description: str) -> None:
    changed = team.client.patch(
        f"/api/buildflow/components/{component['id']}", json={"description": description}, headers=who
    )
    assert changed.status_code == 200, changed.text


def search(app, team, admin) -> dict:
    """Have the finder search now, as an admin does, and wait for it: the run, as it went."""
    started = team.client.post("/api/deals/search", headers=admin)
    assert started.status_code == 202, started.text
    app.state.deals.wait()
    status = team.client.get("/api/deals/status", headers=admin).json()
    return status["runs"][0]


def shown(team, who, **params) -> list[dict]:
    response = team.client.get("/api/deals", params=params, headers=who)
    assert response.status_code == 200, response.text
    return response.json()


def valve_listings(ebay: FakeEbay) -> None:
    ebay.results["SS-43GS4"] = [
        item(VALVE, "Swagelok SS-43GS4 Stainless Ball Valve 1/4 in Swagelok tube fitting", "45.00", shipping="8.50"),
        item("v1|110003|0", "Swagelok SS-43GS4 ball valve FOR PARTS not working", "5.00"),
        item("v1|110004|0", "Parker brass needle valve 1/8 NPT", "12.00"),
    ]


def test_a_bought_components_part_number_finds_it_and_the_deal_is_for_the_component(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    bill = elytra(team, chief)
    mov = named(bill, "Main oxidizer valve")
    describe(team, alice, mov, "Swagelok SS-43GS4, 1/4 in ball valve, MAWP 3000 psi")
    valve_listings(ebay)

    run = search(app, team, chief)
    assert "SS-43GS4" in ebay.searched
    assert (run["kind"], run["found"], run["judged"], run["problem"]) == ("search", 1, False, None)
    assert run["started_by"]["email"] == "chief@x.test"
    [deal] = shown(team, alice)
    assert (deal["title"], deal["price"], deal["shipping"], deal["condition"]) == (
        "Swagelok SS-43GS4 Stainless Ball Valve 1/4 in Swagelok tube fitting",
        45.0,
        8.5,
        "Used",
    )
    assert deal["url"] == "https://www.ebay.com/itm/110001"
    assert deal["image"] == f"https://i.ebayimg.com/images/{VALVE}.jpg"
    assert (deal["want_key"], deal["want_title"], deal["want_where"]) == (
        f"buildflow:component:{mov['id']}",
        "Main oxidizer valve",
        "Elytra, Fluids",
    )
    assert deal["want_href"] == f"/buildflow/programs/{bill['id']}?phase=build&component={mov['id']}"
    assert deal["reason"] == "Its part number, SS-43GS4"
    assert shown(team, alice, app="buildflow") == [deal]
    assert shown(team, alice, app="vault") == []
    # Nothing of the seller is kept: a username is personal data, by eBay's terms.
    with team.app.state.sessionmaker() as db:
        kept = db.scalar(select(Deal))
        assert "someone" not in json.dumps({k: str(v) for k, v in vars(kept).items()})


def test_a_part_the_team_makes_is_searched_for_by_its_stock(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    bill = elytra(team, chief)
    describe(team, chief, named(bill, "LOX tank"), "6061-T6 aluminum, 8 in OD, 0.125 in wall, welded domes")
    query = "6061-T6 aluminum 8 in OD 0.125 in wall"
    ebay.results[query] = [
        item(TUBE, '6061-T6 Aluminum Round Tube 8" OD x 0.125" Wall x 36" Long', "189.00"),
        item("v1|110005|0", '6061 Aluminum Round Tube 8" OD x 0.125" Wall x 24"', "151.00"),
        item("v1|110006|0", '6061-T6 aluminum tube 8" OD 0.125 wall 48"', "240.00"),
        item("v1|110007|0", "Steel drum lid", "20.00"),
    ]
    search(app, team, chief)
    assert query in ebay.searched
    found = {deal["title"]: deal for deal in shown(team, chief)}
    assert "Steel drum lid" not in found
    tube = found['6061-T6 Aluminum Round Tube 8" OD x 0.125" Wall x 36" Long']
    assert tube["want_title"] == "LOX tank"
    assert tube["reason"].startswith("It says ")
    # Against the typical price of those that fit (the median: $189), the $151 one is a fifth under it; but it
    # doesn't say its temper, so the T6 one fits better, and comes first. The dearer 48 in one is no deal.
    cheap = found['6061 Aluminum Round Tube 8" OD x 0.125" Wall x 24"']
    assert (cheap["typical"], cheap["savings"]) == (189.0, 0.2011)
    assert [deal["title"] for deal in shown(team, chief)] == [tube["title"], cheap["title"]]


def test_what_isnt_wanted_any_more_goes_and_isnt_searched_for(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    bill = elytra(team, chief)
    mov = named(bill, "Main oxidizer valve")
    describe(team, chief, mov, "Swagelok SS-43GS4 ball valve")
    valve_listings(ebay)
    search(app, team, chief)
    assert len(shown(team, chief)) == 1

    # Bought and in hand: through Procurement.
    procurement = next(m for m in bill["milestones"] if m["name"] == "Procurement")
    team.client.put(
        f"/api/buildflow/components/{mov['id']}/progress/{procurement['id']}", json={"status": "done"}, headers=chief
    )
    ebay.searched.clear()
    run = search(app, team, chief)
    assert "SS-43GS4" not in ebay.searched
    assert (run["gone"], shown(team, chief)) == (1, [])


def test_vendors_parts_in_vault_are_searched_only_where_everyone_can_see_them(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    shared = team.checkin(chief, {"Library/SS-400-6_Union.SLDPRT": b"union"}).json()["files"][0]["file"]
    team.checkin(chief, {"Secret/PX309-1KG5V_Transducer.SLDPRT": b"pt"})
    team.grant(chief, "Library", None, "viewer")
    for path, vendor in [("Library/SS-400-6_Union.SLDPRT", True), ("Secret/PX309-1KG5V_Transducer.SLDPRT", True)]:
        described = team.client.post(
            "/api/files/metadata", json={"files": [{"file": path, "vendor": vendor}]}, headers=chief
        )
        assert described.status_code == 200, described.text
    ebay.results["SS-400-6"] = [item("v1|120001|0", "Swagelok SS-400-6 Union 1/4 in tube", "9.00")]
    search(app, team, chief)
    assert "SS-400-6" in ebay.searched
    assert "PX309-1KG5V" not in ebay.searched  # in a folder only admins see
    [deal] = shown(team, chief)
    assert (deal["want_key"], deal["want_where"], deal["want_href"]) == (
        f"vault:file:{shared['id']}",
        "Vault, Library",
        f"/vault/file/{shared['id']}",
    )


def test_a_components_links_bring_its_cad_and_its_pid_part_with_them(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    bill = elytra(team, chief)
    regulator = named(bill, "Pressure regulator")
    drawing = {
        "format": 1,
        "parts": [
            {
                "id": "p1",
                "kind": "regulator",
                "x": 0,
                "y": 0,
                "tag": "PR-101",
                "props": {"model": "Tescom 44-1100", "mawp": "6000 psi"},
            },
            {"id": "p2", "kind": "ball_valve", "x": 50, "y": 0, "tag": "BV-1", "props": {"size": "1/4 in"}},
        ],
        "lines": [],
        "fluids": [],
        "style": {},
    }
    diagram = team.client.post(
        "/api/piper/diagrams", json={"name": "Elytra feed system", "drawing": drawing}, headers=chief
    ).json()
    team.client.post(
        f"/api/buildflow/components/{regulator['id']}/links",
        json={"phase": "design", "kind": "pid", "url": f"/piper/diagrams/{diagram['id']}?find=pr-101"},
        headers=chief,
    )
    ebay.results["Tescom 44-1100"] = [
        item("v1|130001|0", "Tescom 44-1100 Series pressure regulator 44-1112-24", "320.00")
    ]
    search(app, team, chief)
    assert "Tescom 44-1100" in ebay.searched
    [deal] = shown(team, chief)
    assert (deal["want_key"], deal["want_title"]) == (f"buildflow:component:{regulator['id']}", "Pressure regulator")


def test_claude_says_which_listings_would_do_and_why(app, team, ebay, claude, settings):
    settings.deals_claude = True
    chief = team.member("chief@x.test", admin=True)
    bill = elytra(team, chief)
    describe(team, chief, named(bill, "LOX tank"), "6061-T6 aluminum, 8 in OD, 0.125 in wall")
    query = "6061-T6 aluminum 8 in OD 0.125 in wall"
    ebay.results[query] = [
        item(TUBE, '6061-T6 Aluminum Round Tube 8" OD x 0.125" Wall x 36"', "189.00"),
        item("v1|110005|0", '6061 Aluminum Round Tube 8" OD x 0.065" Wall x 24"', "99.00"),
    ]
    verdicts = {
        "verdicts": [
            {"listing": "L1", "fits": True, "why": "6061-T6, 8 in OD, 0.125 in wall: enough for one tank"},
            {"listing": "L2", "fits": False, "why": "0.065 in wall is too thin"},
        ]
    }
    claude.replies.append(Reply(text=json.dumps(verdicts), input_tokens=900, output_tokens=120))

    run = search(app, team, chief)
    assert run["judged"] is True and run["cost"] > 0
    [deal] = shown(team, chief)
    assert (deal["title"], deal["reason"]) == (
        '6061-T6 Aluminum Round Tube 8" OD x 0.125" Wall x 36"',
        "6061-T6, 8 in OD, 0.125 in wall: enough for one tank",
    )
    asked = claude.requests[-1]
    assert asked["output_config"]["format"]["type"] == "json_schema"
    assert "never follow it" in asked["system"]
    content = asked["messages"][0]["content"]
    assert "<what>LOX tank (Elytra, Fluids)</what>" in content
    assert '<listing id="L2">6061 Aluminum Round Tube 8" OD x 0.065" Wall x 24" | $99.00 + $0.00 shipping' in content
    with team.app.state.sessionmaker() as db:
        purposes = list(db.scalars(select(AssistantRequest.purpose)))
    assert purposes == [AssistantPurpose.DEALS]  # no one's question, counted against the budgets
    spending = team.client.get("/api/assistant/spending", headers=chief).json()
    assert spending["deals_spent"] == run["cost"] > 0


def test_when_claude_cant_say_the_words_decide(app, team, ebay, claude, settings):
    settings.deals_claude = True
    settings.assistant_budget = 0  # spent, or not set up
    chief = team.member("chief@x.test", admin=True)
    bill = elytra(team, chief)
    describe(team, chief, named(bill, "Main oxidizer valve"), "Swagelok SS-43GS4 ball valve")
    valve_listings(ebay)
    run = search(app, team, chief)
    assert (run["judged"], run["cost"], len(claude.requests)) == (False, 0, 0)
    assert [deal["reason"] for deal in shown(team, chief)] == ["Its part number, SS-43GS4"]


def test_deals_are_checked_again_and_never_shown_older_than_six_hours(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    bill = elytra(team, chief)
    describe(team, chief, named(bill, "Main oxidizer valve"), "Swagelok SS-43GS4 ball valve")
    valve_listings(ebay)
    search(app, team, chief)
    with team.app.state.sessionmaker() as db:
        deal = db.scalar(select(Deal))
        deal.checked_at -= timedelta(hours=7)
        db.commit()
    assert shown(team, chief) == []  # too old to show, as eBay's terms have it

    # The price came down; checked again, it's shown as it is now.
    ebay.items[VALVE] = item(VALVE, "Swagelok SS-43GS4 Stainless Ball Valve 1/4 in Swagelok tube fitting", "39.00")
    run = app.state.deals.refresh()
    assert (run.kind, run.gone, run.found) == ("refresh", 0, 1)
    [now] = shown(team, chief)
    assert (now["price"], now["shipping"]) == (39.0, 0.0)

    # Sold: gone.
    ebay.items[VALVE] = None
    assert app.state.deals.refresh().gone == 1
    assert shown(team, chief) == []


def test_an_auction_shows_its_current_bid_and_goes_when_it_ends(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    bill = elytra(team, chief)
    describe(team, chief, named(bill, "Main oxidizer valve"), "Swagelok SS-43GS4 ball valve")
    ends = (datetime.now(UTC) + timedelta(days=2)).isoformat().replace("+00:00", "Z")
    ebay.results["SS-43GS4"] = [
        item(VALVE, "Swagelok SS-43GS4 ball valve", "10.00", auction=True, bid="23.50", ends=ends, shipping=None)
    ]
    search(app, team, chief)
    [deal] = shown(team, chief)
    assert (deal["auction"], deal["price"], deal["shipping"]) == (True, 23.5, None)
    assert deal["ends_at"] is not None
    ended = (datetime.now(UTC) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
    ebay.items[VALVE] = item(VALVE, "Swagelok SS-43GS4 ball valve", "10.00", auction=True, bid="61.00", ends=ended)
    assert app.state.deals.refresh().gone == 1


def test_anyone_dismisses_a_deal_that_wont_do_and_it_isnt_found_again(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    bill = elytra(team, chief)
    describe(team, chief, named(bill, "Main oxidizer valve"), "Swagelok SS-43GS4 ball valve")
    valve_listings(ebay)
    search(app, team, chief)
    [deal] = shown(team, alice)
    dismissed = team.client.put(f"/api/deals/{deal['id']}/dismissed", json={"dismissed": True}, headers=alice)
    assert dismissed.status_code == 200 and dismissed.json()["dismissed"] is True
    assert shown(team, alice) == []
    search(app, team, chief)
    assert shown(team, alice) == []  # found again, and still dismissed
    team.client.put(f"/api/deals/{deal['id']}/dismissed", json={"dismissed": False}, headers=alice)
    assert [d["id"] for d in shown(team, alice)] == [deal["id"]]
    assert team.client.put("/api/deals/999/dismissed", json={}, headers=alice).status_code == 404


def test_only_admins_see_how_the_finder_does_and_start_a_search(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    for refused in (
        team.client.get("/api/deals/status", headers=alice),
        team.client.post("/api/deals/search", headers=alice),
    ):
        assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
    status = team.client.get("/api/deals/status", headers=chief).json()
    assert (status["available"], status["reason"], status["claude"], status["runs"]) == (True, None, False, [])
    assert status["next_search"] is not None


def test_without_ebay_set_up_there_are_no_deals(app, team, settings):
    settings.ebay_client_id = settings.ebay_client_secret = ""
    app.state.deals.source = None
    chief = team.member("chief@x.test", admin=True)
    off = team.client.post("/api/deals/search", headers=chief)
    assert (off.status_code, off.json()["error"]) == (503, "deals_off")
    status = team.client.get("/api/deals/status", headers=chief).json()
    assert status["available"] is False and "YJSP_EBAY_CLIENT_ID" in status["reason"]
    assert shown(team, chief) == []


def test_a_search_that_fails_keeps_the_deals_that_were_found(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    bill = elytra(team, chief)
    describe(team, chief, named(bill, "Main oxidizer valve"), "Swagelok SS-43GS4 ball valve")
    valve_listings(ebay)
    search(app, team, chief)
    ebay.search_status = 500
    run = search(app, team, chief)
    assert (run["gone"], run["wants"]) == (0, 0)
    assert "failed (HTTP 500" in run["problem"]
    assert len(shown(team, chief)) == 1


def test_a_run_says_what_went_wrong_with_ebay(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    bill = elytra(team, chief)
    describe(team, chief, named(bill, "Main oxidizer valve"), "Swagelok SS-43GS4 ball valve")
    ebay.search_status = 429
    run = search(app, team, chief)
    assert "limit of calls for the day" in run["problem"]
    assert run["found"] == 0
    # One token for a run's calls: eBay limits how many an application gets.
    assert ebay.tokens == 1


def test_an_answer_that_isnt_ebays_is_a_problem_the_run_says(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)
    bill = elytra(team, chief)
    describe(team, chief, named(bill, "Main oxidizer valve"), "Swagelok SS-43GS4 ball valve")
    valve_listings(ebay)
    search(app, team, chief)
    # Something between the server and eBay answers instead, with a page of its own.
    ebay.search_page = "<html><body>Down for maintenance</body></html>"
    run = search(app, team, chief)
    assert run["finished_at"] is not None
    assert "wasn't one it gives (HTTP 200, text/html)" in run["problem"]
    assert len(shown(team, chief)) == 1


def test_a_run_that_breaks_says_so_and_the_next_goes_on(app, team, ebay):
    chief = team.member("chief@x.test", admin=True)

    def broken(db):
        raise RuntimeError("what an app wants couldn't be read")

    app.state.deals.wants.append(broken)
    run = search(app, team, chief)
    assert run["finished_at"] is not None
    assert "finds why in its log" in run["problem"]
    assert team.client.get("/api/deals/status", headers=chief).json()["running"] is None
    app.state.deals.wants.remove(broken)
    assert search(app, team, chief)["problem"] is None


def test_claude_says_no_more_once_half_a_budget_is_spent(app, team, ebay, claude, settings):
    """Help's questions keep the rest: past half, a listing's words decide."""
    settings.deals_claude = True
    settings.assistant_budget, settings.assistant_monthly_budget = 0, 2.0

    def spend(dollars: float) -> None:
        with team.app.state.sessionmaker() as db:
            db.add(AssistantRequest(purpose=AssistantPurpose.KEEP_WARM, model="claude-sonnet-5-5", cost=dollars * 1e6))
            db.commit()

    chief = team.member("chief@x.test", admin=True)
    bill = elytra(team, chief)
    describe(team, chief, named(bill, "Main oxidizer valve"), "Swagelok SS-43GS4 ball valve")
    valve_listings(ebay)
    spend(0.90)
    claude.replies.append(Reply(text=json.dumps({"verdicts": [{"listing": "L1", "fits": True, "why": "The part"}]})))
    assert search(app, team, chief)["judged"] is True  # under half of this month's $2
    spend(0.20)
    run = search(app, team, chief)
    assert (run["judged"], run["cost"], len(claude.requests)) == (False, 0, 1)
    assert [deal["reason"] for deal in shown(team, chief)] == ["Its part number, SS-43GS4"]


def test_ebays_account_deletion_notifications_are_answered(team, client):
    code = "challenge-123"
    answered = client.get("/api/deals/ebay/account-deletion", params={"challenge_code": code})
    endpoint = "https://yjsp.example.org/api/deals/ebay/account-deletion"
    expected = hashlib.sha256((code + "t" * 40 + endpoint).encode()).hexdigest()
    assert (answered.status_code, answered.json()) == (200, {"challengeResponse": expected})
    notified = client.post(
        "/api/deals/ebay/account-deletion", json={"metadata": {"topic": "MARKETPLACE_ACCOUNT_DELETION"}}
    )
    assert notified.status_code == 204


def test_the_finder_searches_once_a_day_and_checks_whats_shown_every_four_hours(app, settings):
    deals = app.state.deals
    noon = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)
    settings.deals_hour = 10
    assert deals.next_search(None, noon) == datetime(2026, 11, 14, 10, 0, tzinfo=UTC)  # due: none yet
    assert deals.next_search(noon - timedelta(hours=1), noon) == datetime(2026, 11, 15, 10, 0, tzinfo=UTC)
    assert deals.next_search(noon - timedelta(hours=3), noon) == datetime(2026, 11, 14, 10, 0, tzinfo=UTC)
    early = datetime(2026, 11, 14, 8, 0, tzinfo=UTC)
    assert deals.next_search(early - timedelta(hours=20), early) == datetime(2026, 11, 14, 10, 0, tzinfo=UTC)


def test_part_numbers_and_stock_are_read_from_how_people_write_them():
    assert wants.part_numbers("Swagelok SS-43GS4, 1/4 in ball valve, MAWP 3000 psi") == ("SS-43GS4",)
    assert wants.part_numbers("91251A463_Socket Head Screw") == ("91251A463",)
    assert wants.part_numbers("Omega PX309-1KG5V 0-1000 psi, 1/4NPT") == ("PX309-1KG5V",)
    assert wants.part_numbers("6061-T6, 17-4 PH, 316L, 0.125in, 3000psi") == ()
    assert wants.stock("6061-T6 aluminum, 8 in OD, 0.125 in wall") == "6061-T6 aluminum 8 in OD 0.125 in wall"
    assert wants.stock("Four fins, 1/8 in 6061 sheet") == "6061 aluminum sheet 1/8 in"
    assert wants.stock("G10 plate, 3 mm thick") == "G10 plate 3 mm thick"
    assert wants.stock("A COTS valve") is None
