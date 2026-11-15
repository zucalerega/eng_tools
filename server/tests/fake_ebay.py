"""A stand-in for eBay's Browse API, on a port of its own: it gives an application's token to the right keyset, answers
searches with the listings a test gives it for each query, and a listing as a test says it is now (or gone), keeping
every request it got. The deals finder reaches it through YJSP_EBAY_BASE_URL, as it would eBay."""

import base64
import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

CLIENT_ID, CLIENT_SECRET = "YJSP-test-PRD-1234", "PRD-secret"


def item(
    id: str,
    title: str,
    price: str,
    *,
    shipping: str | None = "0.00",
    condition: str = "Used",
    auction: bool = False,
    bid: str | None = None,
    ends: str | None = None,
    stock: str | None = None,
) -> dict[str, Any]:
    """A listing as eBay says it, in a search or alone."""
    found: dict[str, Any] = {
        "itemId": id,
        "title": title,
        "price": {"value": price, "currency": "USD"},
        "condition": condition,
        "itemWebUrl": f"https://www.ebay.com/itm/{id.split('|')[1] if '|' in id else id}",
        "image": {"imageUrl": f"https://i.ebayimg.com/images/{id}.jpg"},
        "buyingOptions": ["AUCTION"] if auction else ["FIXED_PRICE", "BEST_OFFER"],
        "seller": {"username": "someone", "feedbackPercentage": "99.8", "feedbackScore": 1200},
        "shippingOptions": (
            [{"shippingCostType": "FIXED", "shippingCost": {"value": shipping, "currency": "USD"}}]
            if shipping is not None
            else [{"shippingCostType": "CALCULATED"}]
        ),
    }
    if bid is not None:
        found["currentBidPrice"] = {"value": bid, "currency": "USD"}
    if ends is not None:
        found["itemEndDate"] = ends
    if stock is not None:
        found["estimatedAvailabilities"] = [{"estimatedAvailabilityStatus": stock}]
    return found


@dataclass
class FakeEbay:
    results: dict[str, list[dict[str, Any]]] = field(default_factory=dict)  # by query, as it's searched
    items: dict[str, dict[str, Any] | None] = field(default_factory=dict)  # by id: as it is now; None, gone
    searched: list[str] = field(default_factory=list)  # each query, in order
    tokens: int = 0  # tokens given
    search_status: int = 200  # another: each search fails with it
    search_page: str | None = None  # each search answered with this page instead, as something in between might
    requests: list[dict[str, Any]] = field(default_factory=list)  # each request's method, path, and headers

    def __post_init__(self) -> None:
        fake = self
        expected = "Basic " + base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def _send(self, status: int, body: Any) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _error(self, status: int, message: str) -> None:
                self._send(status, {"errors": [{"errorId": status, "message": message, "longMessage": message}]})

            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers["content-length"])).decode()
                fake.requests.append({"method": "POST", "path": self.path, "headers": dict(self.headers)})
                form = parse_qs(body)
                if self.path != "/identity/v1/oauth2/token" or self.headers.get("authorization") != expected:
                    return self._error(401, "Invalid client credentials")
                if form.get("grant_type") != ["client_credentials"] or not form.get("scope"):
                    return self._error(400, "Bad grant")
                fake.tokens += 1
                self._send(
                    200,
                    {
                        "access_token": f"token-{fake.tokens}",
                        "expires_in": 7200,
                        "token_type": "Application Access Token",
                    },
                )

            def do_GET(self) -> None:
                address = urlsplit(self.path)
                fake.requests.append({"method": "GET", "path": self.path, "headers": dict(self.headers)})
                if not (self.headers.get("authorization") or "").startswith("Bearer token-"):
                    return self._error(401, "Invalid access token")
                if self.headers.get("x-ebay-c-marketplace-id") != "EBAY_US":
                    return self._error(400, "No marketplace")
                if address.path == "/buy/browse/v1/item_summary/search":
                    query = parse_qs(address.query)["q"][0]
                    fake.searched.append(query)
                    if fake.search_status != 200:
                        return self._error(fake.search_status, "Search failed")
                    if fake.search_page is not None:
                        page = fake.search_page.encode()
                        self.send_response(200)
                        self.send_header("content-type", "text/html; charset=utf-8")
                        self.send_header("content-length", str(len(page)))
                        self.end_headers()
                        self.wfile.write(page)
                        return None
                    found = fake.results.get(query, [])
                    return self._send(200, {"total": len(found), "itemSummaries": found} if found else {"total": 0})
                if address.path.startswith("/buy/browse/v1/item/"):
                    listing = unquote(address.path.removeprefix("/buy/browse/v1/item/"))
                    now = fake.items.get(listing)
                    return self._send(200, now) if now is not None else self._error(404, "The item was not found")
                self._error(404, "No such resource")

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
