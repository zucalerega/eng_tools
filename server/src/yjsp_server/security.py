"""What every response tells the browser about how to treat the site, and what the access log leaves out.

The headers: no other site may frame ours (so it can't be dressed up to trick a click), the browser takes a file for
what the server says it is, links don't carry our addresses to other sites, the browser sticks to HTTPS (in production,
behind Tailscale's HTTPS), and the page's plugins, base URL, and forms are kept to the site (forms may also post to a
Vault client's sign-in on the computer itself, 127.0.0.1). Which scripts may run isn't limited yet: Yorg's Python runs a
worker from a data: URL in a sandboxed frame, with Pyodide and WebAssembly from a CDN, which a script policy has to
allow for first (docs/design.md, "Server conventions").
"""

import logging
import re
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

POLICY = "; ".join(
    [
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self' http://127.0.0.1:* http://localhost:*",
    ]
)
HSTS = "max-age=31536000"  # a year

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


class SecurityHeaders:
    """ASGI middleware: adds the headers to every response that doesn't set its own."""

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]], https: bool = False) -> None:
        self.app = app
        self.headers = [
            (b"content-security-policy", POLICY.encode()),
            (b"x-frame-options", b"DENY"),
            (b"x-content-type-options", b"nosniff"),
            (b"referrer-policy", b"strict-origin-when-cross-origin"),
            (b"cross-origin-opener-policy", b"same-origin"),
            (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
        ] + ([(b"strict-transport-security", HSTS.encode())] if https else [])

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                present = {name.lower() for name, _ in message.get("headers", [])}
                message["headers"] = [*message.get("headers", []), *(h for h in self.headers if h[0] not in present)]
            await send(message)

        await self.app(scope, receive, with_headers)


# A sign-in's one-time code and state, in the query of the address Google or Microsoft sends the browser back to.
_SECRETS_IN_QUERY = re.compile(r"((?:^|[?&])(?:code|state)=)[^&\s]*")


class HideSignInCodes(logging.Filter):
    """Keeps sign-in codes out of the access log: uvicorn logs each request's path with its query."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            record.args = (*args[:2], _SECRETS_IN_QUERY.sub(r"\1…", args[2]), *args[3:])
        return True


def hide_sign_in_codes() -> None:
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, HideSignInCodes) for f in access.filters):
        access.addFilter(HideSignInCodes())
