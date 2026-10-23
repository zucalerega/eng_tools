"""The assistant: Claude answering members' questions from the help, as it writes, within its budget and each person's
daily limit. Anthropic's API is a stand-in on a port of its own (fake_claude.py), which the real SDK talks to."""

import json
import threading
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from yjsp_server.app import create_app
from yjsp_server.assistant import Assistant

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
    assert (found["budget"], found["daily_limit"], found["model"], found["effort"]) == (
        5.0,
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


def test_production_needs_a_budget_for_its_key(tmp_path):
    with pytest.raises(RuntimeError, match="set YJSP_ASSISTANT_BUDGET"):
        create_app(production_settings(tmp_path, anthropic_api_key="sk-ant-test"))
    create_app(production_settings(tmp_path, anthropic_api_key="sk-ant-test", assistant_budget=20))
