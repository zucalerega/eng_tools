"""eBay's Browse API, as an application uses it (developer.ebay.com/api-docs/buy/browse): a search for what the team
wants (`item_summary/search`), and a listing again to keep it current (`item/{id}`), with an application's token
(the client credentials grant), kept until it lapses as eBay asks.

What's kept of a listing is the listing's: its title, price, shipping, condition, picture, and address. Nothing of its
seller (a username is personal data, by eBay's terms), so there's nothing of anyone's to delete when eBay says an
account has gone (finder.py answers its notifications).
"""

import base64
import logging
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import quote

import httpx2

from ..config import Settings

log = logging.getLogger(__name__)

EBAY = "https://api.ebay.com"
SCOPE = "https://api.ebay.com/oauth/api_scope"
MARKETPLACE = "EBAY_US"
WAIT = 20.0  # seconds, for one request
# Listings that ship to the US, to buy now or to bid on; those for parts or not working are left out after (rank.py).
FILTER = "buyingOptions:{FIXED_PRICE|BEST_OFFER|AUCTION},deliveryCountry:US"


class EbayError(Exception):
    """eBay didn't answer as it should: what went wrong, in words, for the run's record."""


class EbayLimit(EbayError):
    """eBay's limit for the day is reached: the run stops, and tomorrow's goes on."""


@dataclass(frozen=True)
class Listing:
    """A listing, as eBay says it now."""

    id: str  # eBay's itemId: "v1|1234567890|0"
    title: str
    url: str  # its page on eBay
    image: str | None
    price: int  # in cents: an auction's current bid
    currency: str
    shipping: int | None  # in cents; None when eBay works it out at checkout
    condition: str
    auction: bool
    ends_at: datetime | None  # an auction's end
    available: bool = True  # not sold out, nor ended


class Ebay:
    """eBay's API with an application's keyset (YJSP_EBAY_CLIENT_ID, YJSP_EBAY_CLIENT_SECRET)."""

    name = "ebay"

    def __init__(self, settings: Settings):
        self.base = (settings.ebay_base_url or EBAY).rstrip("/")
        self._key = base64.b64encode(f"{settings.ebay_client_id}:{settings.ebay_client_secret}".encode()).decode()
        self._context = f"contextualLocation=country%3DUS%2Czip%3D{settings.deals_zip}" if settings.deals_zip else ""
        self._token: tuple[str, float] | None = None  # and when to get another, on time.monotonic()'s clock
        self._lock = threading.Lock()

    def _bearer(self) -> str:
        with self._lock:
            if self._token is not None and time.monotonic() < self._token[1]:
                return self._token[0]
            try:
                response = httpx2.post(
                    f"{self.base}/identity/v1/oauth2/token",
                    data={"grant_type": "client_credentials", "scope": SCOPE},
                    headers={"Authorization": f"Basic {self._key}"},
                    timeout=WAIT,
                )
            except httpx2.HTTPError as error:
                raise EbayError(f"The server couldn't reach eBay ({type(error).__name__})") from None
            if response.status_code != 200:
                raise EbayError(
                    "eBay turned down the site's keyset: check YJSP_EBAY_CLIENT_ID and YJSP_EBAY_CLIENT_SECRET, and that "
                    f"the keyset is enabled for production ({_said(response)})"
                )
            body = _json(response, "the request for a token")
            token = body.get("access_token")
            if not isinstance(token, str) or not token:
                raise EbayError("eBay gave the site no token it could use (HTTP 200, without an access_token)")
            try:
                lasts = int(body.get("expires_in", 7200))
            except (TypeError, ValueError):
                lasts = 7200
            # Kept until five minutes before it lapses (two hours, as eBay gives them).
            self._token = (token, time.monotonic() + max(60, lasts - 300))
            return self._token[0]

    def _get(self, path: str, params: dict[str, Any] | None = None) -> httpx2.Response:
        for attempt in range(2):
            headers = {"Authorization": f"Bearer {self._bearer()}", "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE}
            if self._context:
                headers["X-EBAY-C-ENDUSERCTX"] = self._context
            try:
                response = httpx2.get(f"{self.base}{path}", params=params, headers=headers, timeout=WAIT)
            except httpx2.HTTPError as error:
                raise EbayError(f"The server couldn't reach eBay ({type(error).__name__})") from None
            if response.status_code == 401 and attempt == 0:
                with self._lock:
                    self._token = None  # lapsed early: another
                continue
            if response.status_code == 429:
                raise EbayLimit("eBay's limit of calls for the day is reached: the next run goes on")
            return response
        return response

    def search(self, query: str, limit: int = 25) -> list[Listing]:
        """The listings eBay finds for some words, the best match first."""
        response = self._get("/buy/browse/v1/item_summary/search", {"q": query[:350], "limit": limit, "filter": FILTER})
        if response.status_code != 200:
            raise EbayError(f"eBay's search for {query[:80]} failed ({_said(response)})")
        items = _json(response, f"the search for {query[:80]}").get("itemSummaries") or []
        found = [_listing(item) for item in items if isinstance(item, dict)] if isinstance(items, list) else []
        return [listing for listing in found if listing is not None]

    def item(self, listing: str) -> Listing | None:
        """A listing as it is now, or None if it's gone: ended, sold out, or taken down."""
        response = self._get(f"/buy/browse/v1/item/{quote(listing, safe='')}")
        if response.status_code in (404, 410):
            return None
        if response.status_code != 200:
            raise EbayError(f"eBay didn't say what became of listing {listing} ({_said(response)})")
        return _listing(_json(response, f"listing {listing}"))


def _json(response: httpx2.Response, what: str) -> dict[str, Any]:
    """What eBay answered, as JSON; an EbayError if it isn't eBay's answer (a page from something in between, cut off),
    which the run says, and goes on from."""
    try:
        body = response.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        kind = response.headers.get("content-type", "nothing said of it").split(";")[0]
        raise EbayError(f"eBay's answer to {what} wasn't one it gives (HTTP {response.status_code}, {kind})")
    return body


def _listing(item: dict[str, Any]) -> Listing | None:
    """A listing from what eBay says of an item, in a search or alone; None if it can't be shown: no price in dollars,
    no title, or no page."""
    bid = item.get("currentBidPrice") or {}
    price = bid if bid.get("value") else item.get("price") or {}
    cents = _cents(price.get("value"))
    title, url = str(item.get("title") or "").strip(), str(item.get("itemWebUrl") or "")
    if cents is None or price.get("currency") != "USD" or not title or not url.startswith("https://"):
        return None
    options = item.get("buyingOptions") or []
    auction = "AUCTION" in options and "FIXED_PRICE" not in options
    ends = _time(item.get("itemEndDate")) if auction else None
    stock = {a.get("estimatedAvailabilityStatus") for a in item.get("estimatedAvailabilities") or []}
    image = (item.get("image") or {}).get("imageUrl")
    return Listing(
        id=str(item.get("itemId") or ""),
        title=title[:300],
        url=url[:2000],
        image=image if isinstance(image, str) and image.startswith("https://") else None,
        price=cents,
        currency="USD",
        shipping=_shipping(item.get("shippingOptions") or []),
        condition=str(item.get("condition") or "")[:100],
        auction=auction,
        ends_at=ends,
        available=not (stock and stock <= {"OUT_OF_STOCK"}) and (ends is None or ends > datetime.now(UTC)),
    )


def _shipping(options: list[dict[str, Any]]) -> int | None:
    """What the cheapest way of shipping it costs, in cents, if eBay says: calculated shipping is worked out at
    checkout."""
    costs = [
        _cents((option.get("shippingCost") or {}).get("value"))
        for option in options
        if option.get("shippingCostType") == "FIXED"
    ]
    known = [cost for cost in costs if cost is not None]
    return min(known) if known else None


def _cents(value: Any) -> int | None:
    try:
        dollars = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return int((dollars * 100).to_integral_value()) if dollars.is_finite() and dollars >= 0 else None


def _time(value: Any) -> datetime | None:
    try:
        found = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return found.astimezone(UTC) if found.tzinfo else found.replace(tzinfo=UTC)


def _said(response: httpx2.Response) -> str:
    """What eBay said was wrong, from its error."""
    try:
        errors = response.json().get("errors") or []
        said = errors[0].get("longMessage") or errors[0].get("message") if errors else None
    except (ValueError, AttributeError, IndexError):
        said = None
    return f"HTTP {response.status_code}" + (f": {str(said)[:200]}" if said else "")
