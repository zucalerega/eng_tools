"""What one request may cost the server, before anything else looks at it.

FastAPI reads a request's whole JSON body into memory before it checks who's asking, so anyone, signed in or not,
could otherwise send gigabytes and take the server's memory. This refuses a body over MOST_BODY (413), whether it
says its size up front or not. Uploads, which stream to disk and check their own limit (YJSP_MAX_UPLOAD_MB), pass
through untouched.
"""

import json
import re
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

MOST_BODY = 10 << 20  # bytes: a check-in of thousands of files, or an assembly's 3D model, is well under a megabyte

# The requests whose bodies stream to disk, each with its own limit: a file's contents for Vault, and test data for
# Yorg (vault/api.py put_blob, yorg/api.py post_dataset).
_STREAMED = [("PUT", re.compile(r"/api/blobs/[0-9a-f]{64}")), ("POST", re.compile(r"/api/yorg/datasets"))]

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


class BodyLimit:
    """ASGI middleware: reads a request's body first, up to its limit, and hands it on, or refuses it."""

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]], most: int = MOST_BODY) -> None:
        self.app, self.most = app, most

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or any(
            scope["method"] == method and path.fullmatch(scope["path"]) for method, path in _STREAMED
        ):
            await self.app(scope, receive, send)
            return
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > self.most:
            await self._refuse(send)
            return
        # Without a size up front (chunked), count as it comes.
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                break  # the client left: the app finds that out for itself
            body = message.get("body", b"")
            size += len(body)
            if size > self.most:
                await self._refuse(send)
                return
            chunks.append(body)
            if not message.get("more_body", False):
                break
        pending = [{"type": "http.request", "body": b"".join(chunks), "more_body": False}]

        async def replay() -> Message:
            return pending.pop() if pending else await receive()

        await self.app(scope, replay, send)

    async def _refuse(self, send: Send) -> None:
        body = json.dumps(
            {
                "error": "too_large",
                "message": f"That request is over {self.most >> 20} MB, more than the server takes: "
                "upload files one at a time",
            }
        ).encode()
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
        await send({"type": "http.response.start", "status": 413, "headers": headers})
        await send({"type": "http.response.body", "body": body})
