"""The demo, at /demo (docs/design.md, "The demo"): the site passes every request under /demo to the demo's own server
(YJSP_DEMO_URL), with /demo taken off its path, and passes the answer back.

The demo has made-up data, no sign-in, and a process, a user, and files of its own; this never passes on who's asking.
A browser's cookies and Authorization header stay here, so the demo never sees a member's session, and nothing the
demo answers sets a cookie on the site. At most MOST_AT_ONCE requests go to it at a time, so it can't keep the site
busy: the rest wait their turn, for a while, and are then told it's busy.
"""

import asyncio
from urllib.parse import quote

import httpx2
from fastapi import APIRouter, Request
from starlette.background import BackgroundTask
from starlette.responses import Response, StreamingResponse

from ..errors import ApiError, NotFound

PREFIX = "/demo"
MOST_AT_ONCE = 16
TURN_WAIT = 10.0  # seconds a request waits for its turn before it's told the demo's busy
# What's passed on of a request: what it wants, and in what form. Nothing that says who's asking.
_PASSED = {
    "accept",
    "accept-encoding",
    "accept-language",
    "cache-control",
    "content-length",
    "content-type",
    "if-match",
    "if-modified-since",
    "if-none-match",
    "if-range",
    "range",
    "user-agent",
}
# What isn't passed back of an answer: what was only between the two servers, and cookies.
_KEPT_BACK = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-connection",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]

router = APIRouter(include_in_schema=False)


class DemoBusy(ApiError):
    status = 503
    code = "demo_busy"


class DemoDown(ApiError):
    status = 502
    code = "demo_down"


class Passer:
    """The demo's server, as the site reaches it: none without YJSP_DEMO_URL. Its connections are made on first use,
    in the server's own event loop, and closed as the server stops (app.py)."""

    def __init__(self, url: str, transport: httpx2.AsyncBaseTransport | None = None) -> None:
        self.url = url.rstrip("/")
        self.transport = transport  # the tests' stand-in for the demo's server
        self._turns = asyncio.Semaphore(MOST_AT_ONCE)
        self._client: httpx2.AsyncClient | None = None

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def send(self, request: Request) -> Response:
        """Pass a request under /demo to the demo, and its answer back as it comes."""
        if not self.url:
            raise NotFound("There's no demo on this server")
        try:
            await asyncio.wait_for(self._turns.acquire(), TURN_WAIT)
        except TimeoutError:
            raise DemoBusy("The demo's busy: try again in a minute") from None
        try:
            answer = await self._send(request)
        except httpx2.HTTPError:
            self._turns.release()
            raise DemoDown("The demo isn't answering right now: try again in a few minutes") from None
        except BaseException:
            self._turns.release()
            raise

        async def done() -> None:
            await answer.aclose()
            self._turns.release()

        passed = StreamingResponse(answer.aiter_raw(), status_code=answer.status_code, background=BackgroundTask(done))
        passed.raw_headers = [
            (name.lower(), value)
            for name, value in answer.headers.raw
            if name.decode("latin-1").lower() not in _KEPT_BACK
        ]
        return passed

    async def _send(self, request: Request) -> httpx2.Response:
        if self._client is None:
            timeout = httpx2.Timeout(60.0, connect=5.0)
            self._client = httpx2.AsyncClient(base_url=self.url, transport=self.transport, timeout=timeout)
        headers = {name: value for name, value in request.headers.items() if name in _PASSED}
        headers["x-forwarded-proto"] = request.url.scheme
        headers["x-forwarded-prefix"] = PREFIX
        if request.client is not None:
            headers["x-forwarded-for"] = request.client.host
        body = request.stream() if request.method not in ("GET", "HEAD", "OPTIONS") else None
        outgoing = self._client.build_request(request.method, _path(request), headers=headers, content=body)
        return await self._client.send(outgoing, stream=True)


def _path(request: Request) -> str:
    """The request's path under /demo, and its query, as the browser sent them (still %-encoded): the demo's own."""
    raw = request.scope.get("raw_path") or b""
    if raw == PREFIX.encode() or raw.startswith(PREFIX.encode() + b"/"):
        rest = raw[len(PREFIX) :].decode("latin-1")
    else:  # sent %-encoded where it needn't be: the path as read
        rest = quote(request.url.path[len(PREFIX) :])
    query = request.scope.get("query_string", b"").decode("latin-1")
    return (rest or "/") + (f"?{query}" if query else "")


@router.api_route(PREFIX, methods=_METHODS)
@router.api_route(PREFIX + "/{path:path}", methods=_METHODS)
async def pass_to_demo(request: Request) -> Response:
    """Everything under /demo: the demo's (YJSP_DEMO_URL), whoever's asking. Without a demo, nothing's there."""
    return await request.app.state.demo.send(request)
