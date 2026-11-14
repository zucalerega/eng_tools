"""Bug reports and feature requests: sent from Help, looked at by Claude for the owner, and approved by the owner to have
Claude Code build them (feedback.py), with Anthropic's API and Claude Code's routines played by the stand-in."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from yjsp_server import assistant

from .conftest import BOOTSTRAP_ADMIN
from .fake_claude import FakeClaude, Fire, Reply

LOOKED = "**Recommendation**: approve. Check-in should keep the file's references."
BUG = {
    "kind": "bug",
    "title": "Check-in drops a part's references",
    "body": "I checked in Nozzle.SLDASM and its parts came up missing on Ben's computer.",
    "page": "/vault/file/12",
}


@pytest.fixture
def claude() -> Iterator[FakeClaude]:
    fake = FakeClaude()
    yield fake
    fake.close()


@pytest.fixture(autouse=True)
def feedback_on(settings, claude):
    """Claude asking the stand-in, with $5 to spend; the owner (the bootstrap admin) approves, and a routine builds."""
    settings.anthropic_api_key = "test-key"
    settings.anthropic_base_url = claude.url
    settings.assistant_budget = 5.0
    settings.feedback_approver = BOOTSTRAP_ADMIN.upper()  # whatever its case
    settings.feedback_routine_url = f"{claude.url}/v1/claude_code/routines/trig_test/fire"
    settings.feedback_routine_token = "sk-ant-oat01-test"


def send(client: TestClient, who: dict[str, str], **sent):
    return client.post("/api/feedback", json={**BUG, **sent}, headers=who)


def looked(app) -> None:
    """Until Claude has looked at what's been sent."""
    app.state.feedback.wait()


def everyone(client: TestClient, admin: dict[str, str]) -> dict:
    response = client.get("/api/feedback", headers=admin)
    assert response.status_code == 200, response.text
    return response.json()


def test_claude_looks_at_a_bug_report_for_the_owner(app, client, team, claude):
    owner = team.member(BOOTSTRAP_ADMIN, admin=True)
    ana = team.member("ana@rocketry.test")
    claude.replies.append(Reply(text=LOOKED, input_tokens=200, write_1h=75_000, output_tokens=400))
    response = send(client, ana)
    assert response.status_code == 200, response.text
    sent = response.json()
    assert (sent["kind"], sent["title"], sent["status"], sent["page"]) == ("bug", BUG["title"], "new", "/vault/file/12")
    # Whoever sent it sees what they sent and what's become of it: not Claude's look, or who's who.
    assert sent["evaluation"] is None and sent["sender"] is None

    looked(app)
    [look] = claude.requests
    # The help as questions read it, from what Anthropic keeps for them; then what to do instead, and the request.
    ask = Reply()
    claude.replies.append(ask)
    client.post("/api/assistant/ask", json={"messages": [{"role": "user", "text": "Hi"}]}, headers=ana)
    question = claude.requests[1]
    assert look["system"][0] == question["system"][0]
    assert (look["model"], look["thinking"], look["output_config"]) == (
        question["model"],
        question["thinking"],
        question["output_config"],
    )
    assert look["system"][1]["text"] == assistant.LOOKING
    [message] = look["messages"]
    assert message["content"].startswith("[A bug report, sent from /vault/file/12]")
    assert BUG["title"] in message["content"] and BUG["body"] in message["content"]

    found = everyone(client, owner)
    assert found["can_approve"] is True and found["why_not_approve"] is None
    [item] = found["requests"]
    assert item["evaluation"] == LOOKED
    assert item["sender"]["email"] == "ana@rocketry.test"
    assert item["evaluation_cost"] == pytest.approx(0.3044)  # 200 read, 75,000 kept an hour, 400 written
    assert item["looking"] is False
    [mine] = client.get("/api/feedback/mine", headers=ana).json()
    assert mine["evaluation"] is None and mine["status"] == "new"

    # It counts against Claude's budgets, as no one's question: not Ana's daily limit, nor the month's questions.
    spending = client.get("/api/assistant/spending", headers=owner).json()
    assert spending["feedback_spent"] == pytest.approx(0.3044)
    assert spending["month_questions"] == 1  # Ana's "Hi"
    assert [p["questions"] for p in spending["people"]] == [1]
    assert client.get("/api/assistant", headers=ana).json()["day_used"] == pytest.approx(0.0007)


def test_the_owner_approves_a_request_and_claude_code_builds_it(app, client, team, claude):
    owner = team.member(BOOTSTRAP_ADMIN, admin=True)
    ana = team.member("ana@rocketry.test")
    claude.replies.append(Reply(text=LOOKED))
    request_id = send(client, ana).json()["id"]
    looked(app)

    response = client.post(f"/api/feedback/{request_id}/approve", json={"note": "Keep the old links."}, headers=owner)
    assert response.status_code == 200, response.text
    approved = response.json()
    assert approved["status"] == "approved"
    assert approved["session_url"] == "https://claude.ai/code/session_test1"
    assert approved["decided_by"]["email"] == BOOTSTRAP_ADMIN and approved["note"] == "Keep the old links."

    # The routine's own endpoint, with its token, and what it's to build: not who sent it.
    [fire] = claude.fires
    assert fire["path"] == "/v1/claude_code/routines/trig_test/fire"
    assert fire["headers"]["authorization"] == "Bearer sk-ant-oat01-test"
    assert fire["headers"]["anthropic-version"]
    text = fire["body"]["text"]
    assert text.startswith(f"YJSP request #{request_id}: a bug report from a team member, which the owner has read")
    for part in (BUG["title"], BUG["body"], "/vault/file/12", "Keep the old links.", LOOKED):
        assert part in text
    assert "ana" not in text.lower()

    # Once only: there's no taking back a session that started.
    again = client.post(f"/api/feedback/{request_id}/approve", json={}, headers=owner)
    assert (again.status_code, again.json()["error"]) == (409, "feedback_decided")
    assert again.json()["message"] == f"Request #{request_id} was approved already: Claude Code is building it"
    assert len(claude.fires) == 1

    [mine] = client.get("/api/feedback/mine", headers=ana).json()
    assert mine["status"] == "approved" and mine["session_url"] is None
    response = client.post(f"/api/feedback/{request_id}/done", json={"reply": "Fixed in 0.6.1."}, headers=owner)
    assert response.json()["status"] == "done"
    [mine] = client.get("/api/feedback/mine", headers=ana).json()
    assert (mine["status"], mine["reply"]) == ("done", "Fixed in 0.6.1.")


def test_only_the_owner_approves(app, client, team, claude, settings):
    owner = team.member(BOOTSTRAP_ADMIN, admin=True)
    lead = team.member("lead@rocketry.test", admin=True)
    ana = team.member("ana@rocketry.test")
    request_id = send(client, ana).json()["id"]
    looked(app)
    for who in (lead, ana):
        response = client.post(f"/api/feedback/{request_id}/approve", json={}, headers=who)
        assert (response.status_code, response.json()["error"]) == (403, "feedback_owner_only")
    found = everyone(client, lead)
    assert found["can_approve"] is False
    assert found["why_not_approve"].startswith("Only the site's owner can approve requests")
    response = client.get("/api/feedback", headers=ana)
    assert (response.status_code, response.json()["error"]) == (403, "admin_only")

    # Without the routine, or the owner, there's no approving.
    settings.feedback_routine_token = ""
    response = client.post(f"/api/feedback/{request_id}/approve", json={}, headers=owner)
    assert (response.status_code, response.json()["error"]) == (503, "feedback_routine_off")
    assert "YJSP_FEEDBACK_ROUTINE_TOKEN" in response.json()["message"]
    settings.feedback_approver = ""
    assert everyone(client, owner)["why_not_approve"] == (
        "No one can approve requests on this server: its YJSP_FEEDBACK_APPROVER isn't set"
    )
    assert claude.fires == []

    # Any admin can decline one, saying why.
    response = client.post(f"/api/feedback/{request_id}/decline", json={"reply": " "}, headers=lead)
    assert (response.status_code, response.json()["error"]) == (400, "bad_request")
    response = client.post(f"/api/feedback/{request_id}/decline", json={"reply": "That's how it works."}, headers=lead)
    assert response.json()["status"] == "declined"
    [mine] = client.get("/api/feedback/mine", headers=ana).json()
    assert (mine["status"], mine["reply"]) == ("declined", "That's how it works.")
    response = client.post(f"/api/feedback/{request_id}/done", json={}, headers=lead)
    assert (response.status_code, response.json()["error"]) == (409, "feedback_decided")


@pytest.mark.parametrize(
    "status, error, said",
    [
        (401, "invalid token", "Claude Code turned down the routine's token"),
        (404, "not found", "Claude Code has no routine at YJSP_FEEDBACK_ROUTINE_URL"),
        (429, "too many", "Claude Code has started as many routines as it will this hour"),
        (400, "routine is paused", "Claude Code didn't start building it (routine is paused)"),
        (503, "overloaded", "Claude Code is overloaded or down just now"),
    ],
)
def test_when_claude_code_wont_start_it_the_request_waits(app, client, team, claude, status, error, said):
    owner = team.member(BOOTSTRAP_ADMIN, admin=True)
    request_id = send(client, team.member("ana@rocketry.test")).json()["id"]
    looked(app)
    claude.fire_replies.append(Fire(status, error))
    response = client.post(f"/api/feedback/{request_id}/approve", json={"note": "Soon"}, headers=owner)
    assert (response.status_code, response.json()["error"]) == (502, "feedback_routine_failed")
    assert response.json()["message"].startswith(said)
    [item] = everyone(client, owner)["requests"]
    assert (item["status"], item["decided_by"], item["note"], item["session_url"]) == ("new", None, None, None)
    # And it can be approved again.
    assert client.post(f"/api/feedback/{request_id}/approve", json={}, headers=owner).json()["status"] == "approved"
    assert len(claude.fires) == 2


def test_when_claude_cant_look_an_admin_can_have_it_look_again(app, client, team, claude, settings):
    owner = team.member(BOOTSTRAP_ADMIN, admin=True)
    settings.assistant_budget = 0
    request_id = send(client, team.member("ana@rocketry.test")).json()["id"]
    looked(app)
    [item] = everyone(client, owner)["requests"]
    assert item["evaluation"] is None
    assert item["evaluation_problem"] == "Claude isn't set up on this server: an admin can ask whoever runs it"
    assert claude.requests == []

    settings.assistant_budget = 5.0
    claude.replies.append(Reply(text=LOOKED))
    response = client.post(f"/api/feedback/{request_id}/look", headers=owner)
    assert response.status_code == 200, response.text
    looked(app)
    [item] = everyone(client, owner)["requests"]
    assert (item["evaluation"], item["evaluation_problem"]) == (LOOKED, None)

    # Anthropic's own error, and a look Claude declines, say so too.
    claude.replies.append(Reply(status=529, error="Overloaded"))
    client.post(f"/api/feedback/{request_id}/look", headers=owner)
    looked(app)
    [item] = everyone(client, owner)["requests"]
    assert item["evaluation"] == LOOKED  # the last look it had
    assert item["evaluation_problem"] == "Claude is overloaded or down just now: try again in a few minutes"
    claude.replies.append(Reply(text="", stop_reason="refusal"))
    client.post(f"/api/feedback/{request_id}/look", headers=owner)
    looked(app)
    assert everyone(client, owner)["requests"][0]["evaluation_problem"] == (
        "Claude wouldn't look at this one: read it yourself"
    )


def test_what_can_be_sent(app, client, team):
    ana = team.member("ana@rocketry.test")
    for sent, message in [
        ({"kind": "wish"}, "A request is a bug report (bug) or a feature request (feature)"),
        ({"title": "  "}, "A request's title holds 1 to 200 characters"),
        ({"title": "x" * 201}, "A request's title holds 1 to 200 characters"),
        ({"body": ""}, "Say what happened, or what you'd like, in 1 to 10,000 characters"),
        ({"body": "x" * 10_001}, "Say what happened, or what you'd like, in 1 to 10,000 characters"),
    ]:
        response = send(client, ana, **sent)
        assert (response.status_code, response.json()) == (400, {"error": "bad_request", "message": message})
    feature = send(client, ana, kind="feature", page=None).json()
    assert (feature["kind"], feature["page"]) == ("feature", None)
    for _ in range(9):
        assert send(client, ana).status_code == 200
    response = send(client, ana)
    assert (response.status_code, response.json()["error"]) == (429, "feedback_daily_limit")
    looked(app)
    assert len(client.get("/api/feedback/mine", headers=ana).json()) == 10
    assert client.post("/api/feedback/999/decline", json={"reply": "No"}, headers=ana).json()["error"] == "admin_only"
