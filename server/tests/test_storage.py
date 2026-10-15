"""How full the server's disk is, and how much of it Vault's files, Yorg's, and the database take: for admins."""


def test_admins_see_how_much_of_the_disk_vault_yorg_and_the_database_take(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    before = team.client.get("/api/storage", headers=chief).json()

    # A version in Vault is its file's bytes; a dataset in Yorg is its upload and the arrays read from it.
    team.checkin(chief, {"Fin.SLDPRT": b"x" * 5000})
    csv = b"time,pressure\n" + b"".join(b"%d,%d\n" % (i, i * 2) for i in range(1000))
    response = team.client.post("/api/yorg/datasets", params={"filename": "run.csv"}, content=csv, headers=alice)
    assert response.status_code == 201, response.text

    after = team.client.get("/api/storage", headers=chief).json()
    assert after["vault"] - before["vault"] == 5000
    assert after["yorg"] - before["yorg"] > len(csv)
    assert after["database"] > 0
    assert 0 < after["free"] < after["total"]
    assert after["total"] - after["free"] >= after["vault"] + after["yorg"] + after["database"]

    # It's the server's business: members don't see it.
    refused = team.client.get("/api/storage", headers=alice)
    assert (refused.status_code, refused.json()["error"]) == (403, "admin_only")
