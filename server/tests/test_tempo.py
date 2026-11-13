"""Tempo: saved sequence tests, reusable environments, exact source preservation, and authorization."""

from yjsp_server.models import UserStatus

TESTS_API = "/api/tempo/tests"
ENVS_API = "/api/tempo/environments"

SAMPLE_ENV = {
    "valves": [{"name": "press_valve", "initial": "CLOSED"}],
    "sensors": [
        {
            "name": "tank_pt",
            "unit": "psi",
            "mode": "time",
            "initial": 0,
            "samples": [{"at": 0, "value": 0}, {"at": 2, "value": 320}],
        }
    ],
}

EXACT_SOURCE = (
    "# exact source with tabs and trailing newline\n"
    "press_valve.open()\n"
    "if True:\n"
    "\twait_for(500 * ms)\n"
    "press_valve.close()\n"
)


def test_tempo_requires_auth(team):
    assert team.client.get(TESTS_API).status_code == 401
    assert team.client.get(ENVS_API).status_code == 401


def test_tempo_csrf_for_cookie_writes(client):
    client.get("/auth/dev-login", params={"email": "admin@example.com"}, follow_redirects=False)
    try:
        res = client.post(TESTS_API, json={"name": "No CSRF", "source": "pass\n", "environment": SAMPLE_ENV})
        assert res.status_code == 403
        assert res.json()["error"] == "csrf"

        ok = client.post(
            TESTS_API,
            json={"name": "With CSRF", "source": "pass\n", "environment": SAMPLE_ENV},
            headers={"X-YJSP-Request": "1"},
        )
        assert ok.status_code == 201
    finally:
        client.cookies.clear()


def test_tempo_test_crud_and_exact_source(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")

    created = team.client.post(
        TESTS_API,
        json={"name": "  Vespula PrePress  ", "source": EXACT_SOURCE, "environment": SAMPLE_ENV},
        headers=alice,
    )
    assert created.status_code == 201, created.text
    test = created.json()
    assert test["name"] == "Vespula PrePress"
    assert test["source"] == EXACT_SOURCE
    assert test["environment"] == SAMPLE_ENV
    assert test["version"] == 1
    assert test["can_change"] is True

    # Listed in metadata without full source
    listed = team.client.get(TESTS_API, headers=bob)
    assert listed.status_code == 200
    items = listed.json()
    assert len(items) == 1
    assert items[0]["id"] == test["id"]
    assert items[0]["can_change"] is False
    assert "source" not in items[0]

    # Bob can load the exact source
    loaded = team.client.get(f"{TESTS_API}/{test['id']}", headers=bob)
    assert loaded.status_code == 200
    assert loaded.json()["source"] == EXACT_SOURCE
    assert loaded.json()["can_change"] is False

    # Bob cannot update or delete Alice's test
    assert (
        team.client.put(
            f"{TESTS_API}/{test['id']}",
            json={"name": "Hijack", "source": "abort()", "environment": SAMPLE_ENV},
            headers=bob,
        ).status_code
        == 403
    )
    assert team.client.delete(f"{TESTS_API}/{test['id']}", headers=bob).status_code == 403

    # Alice updates with optimistic concurrency check
    updated_source = EXACT_SOURCE + "# appended\n"
    updated = team.client.put(
        f"{TESTS_API}/{test['id']}",
        json={
            "name": "Vespula PrePress v2",
            "source": updated_source,
            "environment": SAMPLE_ENV,
            "expected_version": 1,
        },
        headers=alice,
    )
    assert updated.status_code == 200
    assert updated.json()["version"] == 2
    assert updated.json()["source"] == updated_source

    # Stale expected_version returns 409 changed
    stale = team.client.put(
        f"{TESTS_API}/{test['id']}",
        json={"name": "Stale", "source": "pass", "environment": SAMPLE_ENV, "expected_version": 1},
        headers=alice,
    )
    assert stale.status_code == 409
    assert stale.json()["error"] == "changed"

    # Admin can delete Alice's test
    admin = team.member("chief@x.test", admin=True)
    assert team.client.delete(f"{TESTS_API}/{test['id']}", headers=admin).status_code == 204
    assert team.client.get(f"{TESTS_API}/{test['id']}", headers=alice).status_code == 404


def test_tempo_environments_crud_and_validation(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")

    bad = team.client.post(
        ENVS_API,
        json={"name": "Bad env", "environment": {"valves": "nope", "sensors": []}},
        headers=alice,
    )
    assert bad.status_code == 422

    created = team.client.post(
        ENVS_API,
        json={"name": "Vespula Stand", "description": "Baseline valves", "environment": SAMPLE_ENV},
        headers=alice,
    )
    assert created.status_code == 201
    env_item = created.json()
    assert env_item["version"] == 1
    assert env_item["can_change"] is True

    # Search works
    assert len(team.client.get(f"{ENVS_API}?q=vespula", headers=bob).json()) == 1
    assert len(team.client.get(f"{ENVS_API}?q=nonexistent", headers=bob).json()) == 0

    # Bob cannot edit, Alice can
    assert (
        team.client.put(
            f"{ENVS_API}/{env_item['id']}",
            json={"name": "Bob edit", "description": "", "environment": SAMPLE_ENV},
            headers=bob,
        ).status_code
        == 403
    )
    edited = team.client.put(
        f"{ENVS_API}/{env_item['id']}",
        json={"name": "Vespula Stand R2", "description": "Updated", "environment": SAMPLE_ENV, "expected_version": 1},
        headers=alice,
    )
    assert edited.status_code == 200
    assert edited.json()["version"] == 2

    # Pending user cannot access
    pending = team.member("pending@x.test", status=UserStatus.PENDING)
    assert team.client.get(TESTS_API, headers=pending).status_code == 403
