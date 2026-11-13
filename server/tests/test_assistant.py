"""The assistant: Claude answering members' questions from the help, as it writes, within its budgets (in all, and each
month) and each person's daily limit. Anthropic's API is a stand-in on a port of its own (fake_claude.py), which the real SDK talks to."""

import json
import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from yjsp_server import assistant
from yjsp_server.app import create_app
from yjsp_server.assistant import Assistant
from yjsp_server.config import Settings

from .conftest import BOOTSTRAP_ADMIN
from .fake_claude import FakeClaude, Reply
from .test_auth import production_settings


@pytest.fixture
def claude() -> Iterator[FakeClaude]:
    fake = FakeClaude()
    yield fake
    fake.close()


@pytest.fixture(autouse=True)
def assistant_on(settings, claude):
    """The server's assistant, asking the stand-in, with $5 to spend and $1 a person a day."""
    settings.anthropic_api_key = "test-key"
    settings.anthropic_base_url = claude.url
    settings.assistant_budget = 5.0
    settings.assistant_daily_limit = 1.0


class Clock:
    """The assistant's clock, which a test sets: which month it is, for its monthly budget."""

    def __init__(self, now: datetime):
        self.now = now


@pytest.fixture
def clock(monkeypatch) -> Clock:
    clock = Clock(datetime(2026, 12, 30, 12, tzinfo=UTC))
    monkeypatch.setattr(assistant, "utcnow", lambda: clock.now)
    return clock


def ask(client: TestClient, who: dict[str, str], *conversation: dict[str, str]):
    """Ask Claude: the response, and the answer's pieces as they came (none if it was refused)."""
    response = client.post("/api/assistant/ask", json={"messages": list(conversation)}, headers=who)
    if response.status_code != 200:
        return response, []
    return response, [json.loads(line) for line in response.text.splitlines() if line.strip()]


QUESTION = {"role": "user", "text": "Why is Fin.SLDPRT read-only?", "page": "/vault/file/12"}


def spending(client: TestClient, admin: dict[str, str]) -> dict:
    response = client.get("/api/assistant/spending", headers=admin)
    assert response.status_code == 200, response.text
    return response.json()


def test_claude_answers_from_the_help_as_it_writes(client, team, claude):
    member = team.member("ana@rocketry.test")
    response, events = ask(client, member, QUESTION)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/x-ndjson"
    assert events[0] == {"type": "thinking"}
    assert "".join(e["text"] for e in events if e["type"] == "text") == Reply().text
    assert len([e for e in events if e["type"] == "text"]) > 1  # in pieces, as written
    assert events[-1]["type"] == "done" and events[-1]["stop_reason"] == "end_turn"

    [sent] = claude.requests
    assert sent["headers"]["authorization"] == "Bearer test-key"
    assert sent["model"] == "claude-sonnet-5-5"
    assert sent["max_tokens"] == 16_000
    assert sent["thinking"] == {"type": "adaptive"}
    assert sent["output_config"] == {"effort": "high"}
    # The instructions and the whole help, kept an hour; who's asking after them; the conversation kept 5 minutes.
    instructions, person = sent["system"]
    assert instructions["text"].startswith("You're the help assistant in YJSP")
    assert '<doc source="docs/troubleshooting.md" page="/help#troubleshooting">' in instructions["text"]
    assert '<doc source="docs/vault.md" page="/help#vault">' in instructions["text"]
    assert instructions["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert person == {"type": "text", "text": person["text"]} and "not an admin" in person["text"]
    assert sent["cache_control"] == {"type": "ephemeral"}
    assert sent["messages"] == [
        {"role": "user", "content": "[Asked from /vault/file/12]\n\nWhy is Fin.SLDPRT read-only?"}
    ]
    # A question Claude Sonnet 5.5 declines goes to the model Anthropic picks for it.
    assert sent["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in sent["headers"]["anthropic-beta"]


def test_a_conversation_reads_the_same_each_time(client, team, claude):
    member = team.member("ana@rocketry.test")
    ask(client, member, QUESTION)
    answer = {"role": "assistant", "text": Reply().text}
    follow_up = {"role": "user", "text": "And if someone else has it?", "page": "/vault/file/12"}
    response, _ = ask(client, member, QUESTION, answer, follow_up)
    assert response.status_code == 200
    first, second = claude.requests
    # What Anthropic keeps (prompt caching) is only read again while everything before the new question is the same.
    assert second["system"] == first["system"]
    assert second["messages"][: len(first["messages"])] == first["messages"]
    assert second["messages"][1:] == [
        {"role": "assistant", "content": Reply().text},
        {"role": "user", "content": "[Asked from /vault/file/12]\n\nAnd if someone else has it?"},
    ]
    # An admin's questions say so, after the help.
    ask(client, team.member(BOOTSTRAP_ADMIN, admin=True), QUESTION)
    assert claude.requests[-1]["system"][0] == first["system"][0]
    assert claude.requests[-1]["system"][1]["text"] == "The person asking is an admin."


def test_each_answer_is_counted_at_what_it_cost(client, team, claude):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    member = team.member("ana@rocketry.test")
    assert spending(client, admin)["spent"] == 0
    # The first question in an hour reads the help in full and keeps it; the next reads what was kept.
    claude.replies += [
        Reply(input_tokens=1000, write_1h=50_000, output_tokens=500),
        Reply(input_tokens=1200, read=50_000, output_tokens=400),
    ]
    ask(client, member, QUESTION)
    found = spending(client, admin)
    # $2 per million tokens read, $4 per million kept an hour, $10 per million written.
    assert found["spent"] == pytest.approx(0.207)
    ask(client, member, QUESTION)
    found = spending(client, admin)
    # And $0.10 per million read from what was kept.
    assert found["spent"] == pytest.approx(0.207 + 0.0114)
    assert found["today"] == pytest.approx(found["spent"])
    assert (found["budget"], found["monthly_budget"], found["daily_limit"], found["model"], found["effort"]) == (
        5.0,
        0,
        1.0,
        "claude-sonnet-5-5",
        "high",
    )
    [person] = found["people"]
    assert person["user"]["email"] == "ana@rocketry.test"
    assert person["questions"] == 2
    assert person["spent"] == pytest.approx(0.2184)
    # What was asked isn't kept, only what it cost.
    assert "read-only" not in json.dumps(found)


def test_an_answer_from_a_fallback_is_counted_at_each_models_price(client, team, claude):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    declined = {
        "type": "message",
        "input_tokens": 1000,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "output_tokens": 20,
    }
    answered = {
        "type": "fallback_message",
        "model": "claude-sonnet-5",
        "input_tokens": 1000,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 40_000,
        "output_tokens": 300,
    }
    claude.replies.append(Reply(model="claude-sonnet-5", iterations=[declined, answered]))
    response, events = ask(client, admin, QUESTION)
    assert events[-1]["type"] == "done"
    # Claude Sonnet 5.5's attempt at its prices, then Claude Sonnet 5's, whose reads cost $0.20 per million.
    assert spending(client, admin)["spent"] == pytest.approx(0.0022 + 0.013)


def test_the_budget_stops_it(client, team, claude, settings):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    member = team.member("ana@rocketry.test")
    settings.assistant_budget = 0.10
    assert client.get("/api/assistant", headers=member).json()["available"] is True
    claude.replies.append(Reply(input_tokens=1000, write_1h=50_000, output_tokens=500))  # $0.207
    ask(client, member, QUESTION)

    status = client.get("/api/assistant", headers=member).json()
    assert status["available"] is False
    assert status["reason"].startswith("Claude has spent its budget")
    assert status["budget"] is None and status["spent"] is None  # what it has cost is for admins
    response, _ = ask(client, member, QUESTION)
    assert (response.status_code, response.json()["error"]) == (503, "assistant_spent")
    assert len(claude.requests) == 1
    assert client.get("/api/assistant", headers=admin).json()["spent"] == pytest.approx(0.207)
    # Raised, it answers again.
    settings.assistant_budget = 5.0
    assert ask(client, member, QUESTION)[0].status_code == 200


def test_a_monthly_budget_stops_it_until_the_next_month(client, team, claude, settings, clock):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    member = team.member("ana@rocketry.test")
    # As for the API credits a Claude Max plan includes each month: no budget in all, as they come back each month.
    settings.assistant_budget = 0
    settings.assistant_monthly_budget = 0.10
    status = client.get("/api/assistant", headers=admin).json()
    assert (status["available"], status["monthly_budget"], status["month_spent"]) == (True, 0.10, 0)
    claude.replies.append(Reply(input_tokens=1000, write_1h=50_000, output_tokens=500))  # $0.207
    ask(client, member, QUESTION)

    status = client.get("/api/assistant", headers=member).json()
    assert status["available"] is False
    assert status["reason"] == "Claude has spent this month's budget for questions: it answers again on January 1"
    assert status["monthly_budget"] is None and status["month_spent"] is None  # what it has cost is for admins
    response, _ = ask(client, member, QUESTION)
    assert (response.status_code, response.json()["error"]) == (503, "assistant_month_spent")
    assert len(claude.requests) == 1
    found = spending(client, admin)
    assert (found["available"], found["budget"], found["monthly_budget"]) == (False, 0, 0.10)
    assert found["month_spent"] == pytest.approx(0.207) and found["spent"] == pytest.approx(0.207)

    # December, in UTC, to its last second.
    clock.now = datetime(2026, 12, 31, 23, 59, 59, tzinfo=UTC)
    response, _ = ask(client, member, QUESTION)
    assert (response.status_code, response.json()["error"]) == (503, "assistant_month_spent")
    # The next month, it answers again, and counts that month's answers from nothing.
    clock.now = datetime(2027, 1, 1, tzinfo=UTC)
    assert client.get("/api/assistant", headers=member).json()["available"] is True
    response, events = ask(client, member, QUESTION)
    assert events[-1]["type"] == "done"
    found = spending(client, admin)
    assert (found["available"], found["reason"]) == (True, None)
    assert found["month_spent"] == pytest.approx(0.0007)  # the stand-in's usual answer
    assert found["spent"] == pytest.approx(0.2077)
    status = client.get("/api/assistant", headers=admin).json()
    assert (status["month_spent"], status["spent"]) == (pytest.approx(0.0007), pytest.approx(0.2077))


def test_a_budget_in_all_still_holds_with_a_monthly_one(client, team, claude, settings, clock):
    member = team.member("ana@rocketry.test")
    settings.assistant_budget = 0.30
    settings.assistant_monthly_budget = 0.25
    claude.replies += [Reply(input_tokens=1000, write_1h=50_000, output_tokens=500) for _ in range(2)]  # $0.207 each
    assert ask(client, member, QUESTION)[0].status_code == 200
    clock.now = datetime(2027, 1, 10, tzinfo=UTC)
    assert ask(client, member, QUESTION)[0].status_code == 200

    # Under January's budget, but over the one in all, which doesn't come back with the month.
    response, _ = ask(client, member, QUESTION)
    assert (response.status_code, response.json()["error"]) == (503, "assistant_spent")
    clock.now = datetime(2027, 2, 1, tzinfo=UTC)
    response, _ = ask(client, member, QUESTION)
    assert (response.status_code, response.json()["error"]) == (503, "assistant_spent")
    assert len(claude.requests) == 2


KEEP = Reply(input_tokens=10, write_1h=75_000, output_tokens=0, stop_reason="max_tokens")  # the help kept: $0.30002
KEPT = Reply(input_tokens=10, read=75_000, output_tokens=0, stop_reason="max_tokens")  # read from what's kept: $0.00752


def test_the_help_is_kept_ready_between_questions(app, client, team, claude, settings, clock):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    member = team.member("ana@rocketry.test")
    assistant = app.state.assistant
    assert assistant.keep_warm() is False  # only when the settings say
    assert claude.requests == []
    settings.assistant_keep_warm = True
    start = clock.now
    claude.replies.append(KEEP)
    assert assistant.keep_warm() is True
    ask(client, member, QUESTION)
    kept, question = claude.requests
    # The help as questions read it, with the same thinking, as Anthropic keeps it for those; and nothing written.
    assert kept["system"] == question["system"][:1]
    assert (kept["model"], kept["thinking"], kept["output_config"]) == (
        question["model"],
        question["thinking"],
        question["output_config"],
    )
    assert kept["max_tokens"] == 0 and not kept.get("stream")

    # Anthropic keeps it an hour from the last read: the question was one, so it's read again 50 minutes after that.
    clock.now = start + timedelta(minutes=49)
    assert assistant.keep_warm() is False
    claude.replies.append(KEPT)
    clock.now = start + timedelta(minutes=50)
    assert assistant.keep_warm() is True
    clock.now = start + timedelta(minutes=90)
    ask(client, member, QUESTION)
    clock.now = start + timedelta(minutes=139)
    assert assistant.keep_warm() is False
    claude.replies.append(KEPT)
    clock.now = start + timedelta(minutes=140)
    assert assistant.keep_warm() is True
    assert len(claude.requests) == 5

    # It counts against the budgets, as no one's question.
    found = spending(client, admin)
    assert found["keep_warm"] is True
    assert found["keep_warm_spent"] == pytest.approx(0.30002 + 2 * 0.00752)
    assert found["month_spent"] == pytest.approx(found["keep_warm_spent"] + 2 * 0.0007)
    [person] = found["people"]
    assert (person["user"]["email"], person["questions"]) == ("ana@rocketry.test", 2)
    assert client.get("/api/assistant", headers=member).json()["day_used"] == pytest.approx(0.0014)


def test_the_help_is_kept_again_at_once_when_it_changes(app, team, claude, settings, clock, tmp_path):
    settings.assistant_keep_warm = True
    settings.help_dir = tmp_path / "help"
    settings.help_dir.mkdir()
    (settings.help_dir / "README.md").write_text("# YJSP\n\nCheck files out before you change them.\n")
    claude.replies += [KEEP, KEEP]
    assert app.state.assistant.keep_warm() is True
    assert app.state.assistant.keep_warm() is False
    # As after a deploy that changed the docs: what was kept is no use to the next question.
    (settings.help_dir / "README.md").write_text("# YJSP\n\nCheck files out, then in again, when you're done.\n")
    assert app.state.assistant.keep_warm() is True
    assert "then in again" in claude.requests[-1]["system"][0]["text"]


def test_the_help_isnt_kept_when_no_one_can_ask(app, client, team, claude, settings, clock):
    settings.assistant_keep_warm = True
    settings.assistant_budget = 0
    settings.assistant_monthly_budget = 0.10
    claude.replies.append(Reply(input_tokens=1000, write_1h=50_000, output_tokens=500))  # $0.207
    ask(client, team.member("ana@rocketry.test"), QUESTION)
    clock.now += timedelta(hours=2)
    assert app.state.assistant.keep_warm() is False  # the month's budget is spent: nothing more to spend on it
    assert len(claude.requests) == 1


def test_when_anthropic_wont_keep_the_help_it_tries_again_soon(app, team, claude, settings, clock):
    settings.assistant_keep_warm = True
    claude.replies.append(Reply(status=529, error="Overloaded"))
    assert app.state.assistant.keep_warm() is False
    clock.now += timedelta(minutes=4)
    assert app.state.assistant.keep_warm() is False
    assert len(claude.requests) == 1  # not every minute
    claude.replies.append(KEEP)
    clock.now += timedelta(minutes=1)
    assert app.state.assistant.keep_warm() is True


def test_the_server_keeps_the_help_loaded_unless_its_settings_say_not():
    assert Settings(_env_file=None).assistant_keep_warm is True


def keep_for(client: TestClient, who: dict[str, str], hours: int | None):
    return client.put("/api/assistant/settings", json={"keep_hours": hours}, headers=who)


def test_admins_can_have_the_help_kept_only_for_hours_after_a_question(app, client, team, claude, settings, clock):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    member = team.member("ana@rocketry.test")
    assistant = app.state.assistant
    settings.assistant_keep_warm = True
    assert spending(client, admin)["keep_hours"] is None  # around the clock, as it starts
    response = keep_for(client, admin, 3)
    assert (response.status_code, response.json()) == (200, {"keep_hours": 3}), response.text
    assert spending(client, admin)["keep_hours"] == 3

    # No one has asked: there's nothing to keep loaded.
    assert assistant.keep_warm() is False
    start = clock.now
    claude.replies.append(Reply(write_1h=75_000))
    ask(client, member, QUESTION)
    # Read again 50 minutes after each read, until what's loaded lasts to 3 hours after the question.
    for minutes in (50, 100, 150):
        clock.now = start + timedelta(minutes=minutes - 1)
        assert assistant.keep_warm() is False
        clock.now = start + timedelta(minutes=minutes)
        claude.replies.append(KEPT)
        assert assistant.keep_warm() is True
    clock.now = start + timedelta(minutes=200)  # loaded until 3 hours 30 minutes: enough
    assert assistant.keep_warm() is False
    clock.now = start + timedelta(hours=8)
    assert assistant.keep_warm() is False
    assert len(claude.requests) == 4

    # The next question, hours later, reads it in full again, and keeps it loaded for 3 hours after it.
    claude.replies += [Reply(write_1h=75_000), KEPT]
    ask(client, member, QUESTION)
    clock.now += timedelta(minutes=50)
    assert assistant.keep_warm() is True
    claude.replies.append(Reply(read=75_000))
    ask(client, member, QUESTION)
    found = spending(client, admin)
    assert (found["month_questions"], found["month_questions_loaded"]) == (3, 1)

    # 1 hour is just the hour Anthropic keeps it after each read: nothing in between.
    assert keep_for(client, admin, 1).status_code == 200
    clock.now += timedelta(hours=3)
    claude.replies.append(Reply(write_1h=75_000))
    ask(client, member, QUESTION)
    clock.now += timedelta(minutes=50)
    assert assistant.keep_warm() is False
    assert len(claude.requests) == 8

    # And back to around the clock, with no one asking.
    assert keep_for(client, admin, None).status_code == 200
    claude.replies.append(KEPT)
    assert assistant.keep_warm() is True
    clock.now += timedelta(days=2)
    claude.replies.append(KEEP)
    assert assistant.keep_warm() is True


def test_only_admins_choose_how_long_the_help_is_kept(client, team):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    member = team.member("ana@rocketry.test")
    response = keep_for(client, member, 2)
    assert (response.status_code, response.json()["error"]) == (403, "admin_only")
    for hours in (0, 25):
        response = keep_for(client, admin, hours)
        assert (response.status_code, response.json()["error"]) == (400, "bad_request")
        assert (
            response.json()["message"] == "Claude keeps the help loaded for 1 to 24 hours after a question, or always"
        )
    assert spending(client, admin)["keep_hours"] is None


def test_each_person_has_a_daily_limit(client, team, claude, settings):
    ana = team.member("ana@rocketry.test")
    ben = team.member("ben@rocketry.test")
    settings.assistant_daily_limit = 0.10
    claude.replies.append(Reply(input_tokens=1000, write_1h=50_000, output_tokens=500))  # $0.207
    response, events = ask(client, ana, QUESTION)
    assert events[-1]["day_used"] == 1.0

    response, _ = ask(client, ana, QUESTION)
    assert (response.status_code, response.json()["error"]) == (429, "assistant_daily_limit")
    status = client.get("/api/assistant", headers=ana).json()
    assert (status["available"], status["day_used"]) == (False, 1.0)
    # Someone else's questions are theirs to ask.
    assert ask(client, ben, QUESTION)[0].status_code == 200
    assert client.get("/api/assistant", headers=ben).json()["day_used"] < 1


def test_admins_see_whether_people_can_ask_whatever_they_asked_themselves(client, team, claude, settings):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    settings.assistant_daily_limit = 0.10
    claude.replies.append(Reply(input_tokens=1000, write_1h=50_000, output_tokens=500))  # $0.207
    ask(client, admin, QUESTION)
    assert client.get("/api/assistant", headers=admin).json()["available"] is False  # their own day's share is used
    found = spending(client, admin)
    assert (found["available"], found["reason"]) == (True, None)
    settings.assistant_budget = 0.10
    found = spending(client, admin)
    assert found["available"] is False and found["reason"].startswith("Claude has spent its budget")


def test_one_question_at_a_time(client, team, claude):
    member = team.member("ana@rocketry.test")
    hold = threading.Event()
    claude.replies.append(Reply(hold=hold))
    first: list = []
    asking = threading.Thread(target=lambda: first.append(ask(client, member, QUESTION)))
    asking.start()
    assert claude.received.wait(10)
    response, _ = ask(client, member, QUESTION)
    assert (response.status_code, response.json()["error"]) == (409, "assistant_busy")
    hold.set()
    asking.join(10)
    assert first[0][0].status_code == 200
    # Answered, it takes the next one.
    assert ask(client, member, QUESTION)[0].status_code == 200


def test_a_question_claude_declines_says_so(client, team, claude):
    claude.replies.append(Reply(text="", stop_reason="refusal"))
    response, events = ask(client, team.member("ana@rocketry.test"), QUESTION)
    assert events[-1]["stop_reason"] == "refusal"


@pytest.mark.parametrize(
    ("status", "said", "code", "ours"),
    [
        (400, "Your credit balance is too low to access the Anthropic API.", "assistant_no_credits", 503),
        (401, "invalid x-api-key", "assistant_failed", 502),
        (429, "Number of request tokens has exceeded your rate limit.", "assistant_failed", 502),
        (529, "Overloaded", "assistant_failed", 502),
    ],
)
def test_when_anthropic_wont_take_a_question(client, team, claude, status, said, code, ours):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    claude.replies.append(Reply(status=status, error=said))
    response, _ = ask(client, admin, QUESTION)
    assert (response.status_code, response.json()["error"]) == (ours, code)
    assert spending(client, admin)["spent"] == 0  # a question it didn't take costs nothing


@pytest.mark.parametrize(
    ("status", "said", "error_code"),
    [
        # A spend limit set on the key's workspace (docs/deploying.md, "Claude"), or on the whole organization.
        (
            400,
            "You have reached your specified workspace API usage limits. You will regain access on 2027-01-01.",
            None,
        ),
        (
            400,
            "You have reached your specified API usage limits. You will regain access on 2027-01-01 at 00:00 UTC.",
            None,
        ),
        # The monthly cap of the organization's tier: a 429, as for a rate limit, but no wait helps.
        (
            429,
            "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set "
            "based on your organization's API tier. You will regain access on 2027-01-01 at 00:00 UTC.",
            "enforced_spend_limit_reached",
        ),
    ],
)
def test_anthropics_spend_limits_say_when_claude_is_back(client, team, claude, clock, status, said, error_code):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    claude.replies.append(Reply(status=status, error=said, error_code=error_code))
    response, _ = ask(client, admin, QUESTION)
    assert response.status_code == 503
    assert response.json() == {
        "error": "assistant_spend_limit",
        "message": "Claude has reached its monthly spending limit at Anthropic: it answers again on January 1, or "
        "sooner if an admin asks whoever runs the server to raise it",
    }
    assert spending(client, admin)["spent"] == 0


def test_an_answer_that_breaks_off_is_counted_as_if_it_had_finished(client, team, claude):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    claude.replies.append(Reply(breaks_off=True))
    response, events = ask(client, admin, QUESTION)
    assert response.status_code == 200
    assert [e["type"] for e in events if e["type"] != "text"][-1] == "error"
    assert events[-1]["error"] == "assistant_failed"
    # It read the question, and may have written all it could: 100 tokens at $2 a million, 16,000 at $10.
    assert spending(client, admin)["spent"] == pytest.approx(0.1602)


def test_an_answer_anthropic_breaks_off_counts_what_it_wrote(client, team, claude):
    admin = team.member(BOOTSTRAP_ADMIN, admin=True)
    claude.replies.append(Reply(error_after=2))  # two pieces of the answer, then Anthropic is overloaded
    response, events = ask(client, admin, QUESTION)
    assert events[-1] == {
        "type": "error",
        "error": "assistant_failed",
        "message": "Claude is overloaded or down just now: try again in a few minutes",
    }
    # What it read (100 tokens at $2 a million), and the words it wrote: not all it could have written.
    assert 0.0002 < spending(client, admin)["spent"] < 0.001
    # Turned away before it started, it cost nothing.
    before = spending(client, admin)["spent"]
    claude.replies.append(Reply(error_after=0))
    response, events = ask(client, admin, QUESTION)
    assert events[-1]["message"] == "Claude is overloaded or down just now: try again in a few minutes"
    assert spending(client, admin)["spent"] == before


def test_a_question_that_fails_to_start_frees_whoever_asked(client, team, claude, monkeypatch):
    member = team.member("ana@rocketry.test")
    request = Assistant._request

    def unreadable(self, *args):
        monkeypatch.setattr(Assistant, "_request", request)  # just this once
        raise RuntimeError("the help couldn't be read")

    monkeypatch.setattr(Assistant, "_request", unreadable)
    with pytest.raises(RuntimeError):
        ask(client, member, QUESTION)
    # Not "still answering" a question that never started.
    assert ask(client, member, QUESTION)[0].status_code == 200


def test_an_answer_keeps_no_database_connection_while_it_comes(client, team, claude):
    member = team.member("ana@rocketry.test")
    hold = threading.Event()
    claude.replies.append(Reply(hold=hold, hold_after=1))
    asking = threading.Thread(target=lambda: ask(client, member, QUESTION))
    asking.start()
    try:
        assert claude.holding.wait(10)
        # A dozen answers at once would otherwise take every connection the server has.
        assert client.app.state.sessionmaker.kw["bind"].pool.checkedout() == 0
    finally:
        hold.set()
        asking.join(10)


def test_a_long_answer_goes_back_with_the_next_question(client, team, claude):
    member = team.member("ana@rocketry.test")
    answer = {"role": "assistant", "text": "word " * 12_000}  # 60,000 characters: about as long as one gets
    follow_up = {"role": "user", "text": "And the rest?", "page": "/vault"}
    response, events = ask(client, member, QUESTION, answer, follow_up)
    assert response.status_code == 200, response.text
    assert claude.requests[-1]["messages"][1]["content"] == answer["text"]


@pytest.mark.parametrize(
    "conversation",
    [
        [QUESTION, QUESTION],  # two questions in a row
        [QUESTION, {"role": "assistant", "text": "An answer."}],  # nothing to answer
        [{"role": "assistant", "text": "An answer."}, QUESTION],
        [{"role": "user", "text": "   "}],
        [{"role": "user", "text": "Why? " * 4001}],  # a question over 20,000 characters
    ],
)
def test_a_conversation_is_questions_and_answers_in_turn(client, team, claude, conversation):
    response, _ = ask(client, team.member("ana@rocketry.test"), *conversation)
    assert (response.status_code, response.json()["error"]) == (400, "bad_conversation")
    assert claude.requests == []


def test_only_admins_see_what_it_costs(client, team):
    response = client.get("/api/assistant/spending", headers=team.member("ana@rocketry.test"))
    assert (response.status_code, response.json()["error"]) == (403, "admin_only")


def test_without_a_key_or_a_budget_there_is_no_assistant(settings, claude):
    settings.anthropic_api_key = ""
    with TestClient(create_app(settings)) as client:
        client.get("/auth/dev-login", params={"email": BOOTSTRAP_ADMIN}, follow_redirects=False)
        headers = {"X-YJSP-Request": "1"}
        status = client.get("/api/assistant").json()
        assert status["available"] is False and status["reason"].startswith("Claude isn't set up on this server")
        response = client.post("/api/assistant/ask", json={"messages": [QUESTION]}, headers=headers)
        assert (response.status_code, response.json()["error"]) == (503, "assistant_off")
    assert claude.requests == []


def test_without_a_budget_of_either_kind_there_is_no_assistant(client, team, settings):
    settings.assistant_budget = 0
    settings.assistant_monthly_budget = 0
    status = client.get("/api/assistant", headers=team.member("ana@rocketry.test")).json()
    assert status["available"] is False and status["reason"].startswith("Claude isn't set up on this server")


def test_production_needs_a_budget_for_its_key(tmp_path):
    with pytest.raises(RuntimeError, match=r"set YJSP_ASSISTANT_MONTHLY_BUDGET .* or YJSP_ASSISTANT_BUDGET"):
        create_app(production_settings(tmp_path, anthropic_api_key="sk-ant-test"))
    create_app(production_settings(tmp_path, anthropic_api_key="sk-ant-test", assistant_budget=20))
    create_app(production_settings(tmp_path, anthropic_api_key="sk-ant-test", assistant_monthly_budget=95))
