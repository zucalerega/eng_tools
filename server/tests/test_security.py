"""What every response tells the browser about how to treat the site, and what the access log leaves out
(security.py); and the API's docs, which production doesn't serve."""

import logging

from fastapi.testclient import TestClient

from yjsp_server.app import create_app
from yjsp_server.security import HideSignInCodes

from .test_auth import production_settings


def test_every_response_says_how_the_browser_may_treat_it(client, team):
    chief = team.member("chief@x.test", admin=True)
    for response in (
        client.get("/"),  # the sign-in page
        client.get("/api/folders", headers=chief),
        client.get("/api/nope", headers=chief),  # an error too
    ):
        headers = response.headers
        assert "frame-ancestors 'none'" in headers["content-security-policy"]
        assert "form-action 'self' http://127.0.0.1:*" in headers["content-security-policy"]
        assert (headers["x-frame-options"], headers["x-content-type-options"]) == ("DENY", "nosniff")
        assert headers["referrer-policy"] == "strict-origin-when-cross-origin"
        assert "strict-transport-security" not in headers  # development is plain HTTP


def test_production_insists_on_https_and_keeps_its_api_docs_to_itself(tmp_path, client):
    settings = production_settings(tmp_path, yorg_dir=tmp_path / "yorg", web_dir=tmp_path / "web")
    with TestClient(create_app(settings)) as prod:
        assert prod.get("/healthz").headers["strict-transport-security"] == "max-age=31536000"
        # The paths are the web app's then, like any other: no docs, and no map of the API.
        assert "swagger-ui" not in prod.get("/docs").text
        assert "redoc.standalone.js" not in prod.get("/redoc").text
        schema = prod.get("/openapi.json")
        assert not schema.headers["content-type"].startswith("application/json")
    # In development, they're there.
    assert "swagger-ui" in client.get("/docs").text
    assert client.get("/openapi.json").json()["openapi"]


def test_the_access_log_leaves_out_sign_in_codes():
    # As uvicorn logs a request: client, method, path with its query, HTTP version, status.
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        "",
        0,
        '%s - "%s %s HTTP/%s" %d',
        (
            "127.0.0.1:5000",
            "GET",
            "/auth/microsoft/callback?code=0.AAAA-secret&state=st4te&session_state=x",
            "1.1",
            303,
        ),
        None,
    )
    assert HideSignInCodes().filter(record)
    assert record.getMessage() == (
        '127.0.0.1:5000 - "GET /auth/microsoft/callback?code=…&state=…&session_state=x HTTP/1.1" 303'
    )
