"""A stand-in for Anthropic's Messages API, on a port of its own: it answers as Anthropic does, streaming, with the
replies a test gives it (or a plain one), and keeps every request it got. The assistant reaches it through
YJSP_ANTHROPIC_BASE_URL, so the real SDK talks to it over HTTP, as it would to Anthropic."""

import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


@dataclass
class Reply:
    text: str = "Check it out, then check it in from the Vault tab."
    stop_reason: str = "end_turn"
    model: str | None = None  # the one asked for
    input_tokens: int = 100
    write_5m: int = 0
    write_1h: int = 0
    read: int = 0
    output_tokens: int = 50
    iterations: list[dict[str, Any]] | None = None  # usage.iterations, as with a fallback
    status: int = 200  # another: Anthropic's error, with this message
    error: str = ""
    error_code: str | None = None  # and this error.details.error_code, as a spend limit's has
    breaks_off: bool = False  # the connection drops partway through the answer
    hold: threading.Event | None = None  # wait for this before answering
    # Partway through the answer, after this many pieces of it: Anthropic's error event (as when it's overloaded), or a
    # wait for `hold`. 0: before it starts (before message_start).
    error_after: int | None = None
    hold_after: int | None = None


@dataclass
class FakeClaude:
    replies: list[Reply] = field(default_factory=list)
    requests: list[dict[str, Any]] = field(default_factory=list)  # each request's body, and its headers in "headers"
    received: threading.Event = field(default_factory=threading.Event)  # set at each request
    holding: threading.Event = field(default_factory=threading.Event)  # set when an answer waits partway, hold_after

    def __post_init__(self) -> None:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                fake.requests.append({**body, "headers": {k.lower(): v for k, v in self.headers.items()}})
                fake.received.set()
                reply = fake.replies.pop(0) if fake.replies else Reply()
                if reply.hold is not None and reply.hold_after is None:
                    reply.hold.wait(30)
                if reply.status != 200:
                    self._error(reply)
                else:
                    self._stream(reply, reply.model or body["model"])

            def _error(self, reply: Reply) -> None:
                kind = {400: "invalid_request_error", 402: "billing_error", 429: "rate_limit_error"}
                error: dict[str, Any] = {"type": kind.get(reply.status, "api_error"), "message": reply.error}
                if reply.error_code is not None:
                    error["details"] = {"error_code": reply.error_code}
                data = json.dumps({"type": "error", "error": error}).encode()
                self.send_response(reply.status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.send_header("x-should-retry", "false")  # the SDK would otherwise try again, after a wait
                self.end_headers()
                self.wfile.write(data)

            def _stream(self, reply: Reply, model: str) -> None:
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("transfer-encoding", "chunked")
                self.end_headers()
                usage = {
                    "input_tokens": reply.input_tokens,
                    "cache_creation_input_tokens": reply.write_5m + reply.write_1h,
                    "cache_read_input_tokens": reply.read,
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": reply.write_5m,
                        "ephemeral_1h_input_tokens": reply.write_1h,
                    },
                    "output_tokens": 1,
                }
                message = {"id": "msg_test", "type": "message", "role": "assistant", "model": model, "content": []}
                if reply.error_after == 0:
                    return self._overloaded()
                self._event("message_start", {"message": {**message, "stop_reason": None, "usage": usage}})
                # Thinking first, as adaptive thinking does, with its text left out.
                block = {"type": "thinking", "thinking": "", "signature": ""}
                self._event("content_block_start", {"index": 0, "content_block": block})
                self._event("content_block_delta", {"index": 0, "delta": {"type": "signature_delta", "signature": "x"}})
                self._event("content_block_stop", {"index": 0})
                self._event("content_block_start", {"index": 1, "content_block": {"type": "text", "text": ""}})
                pieces = [reply.text[i : i + 12] for i in range(0, len(reply.text), 12)]
                for number, piece in enumerate(pieces):
                    self._event("content_block_delta", {"index": 1, "delta": {"type": "text_delta", "text": piece}})
                    if reply.breaks_off and number == len(pieces) // 2:
                        self.wfile.flush()
                        self.close_connection = True
                        return  # without the chunked body's end: as a dropped connection looks
                    if reply.error_after == number + 1:
                        return self._overloaded()
                    if reply.hold_after == number + 1 and reply.hold is not None:
                        self.wfile.flush()
                        fake.holding.set()
                        reply.hold.wait(30)
                self._event("content_block_stop", {"index": 1})
                ending: dict[str, Any] = {"output_tokens": reply.output_tokens}
                if reply.iterations is not None:
                    ending["iterations"] = reply.iterations
                self._event(
                    "message_delta",
                    {"delta": {"stop_reason": reply.stop_reason, "stop_sequence": None}, "usage": ending},
                )
                self._event("message_stop", {})
                self.wfile.write(b"0\r\n\r\n")

            def _overloaded(self) -> None:
                """Anthropic's error, on a stream that's begun: an error event, and the stream's end."""
                self._event("error", {"error": {"type": "overloaded_error", "message": "Overloaded"}})
                self.wfile.write(b"0\r\n\r\n")

            def _event(self, name: str, data: dict[str, Any]) -> None:
                chunk = f"event: {name}\ndata: {json.dumps({'type': name, **data})}\n\n".encode()
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_port}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
