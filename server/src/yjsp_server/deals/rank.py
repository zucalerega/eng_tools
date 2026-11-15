"""How well a listing fits what the team wants, and how good its price is: words alone, before Claude looks (or instead,
when it can't). A listing with the part number wanted is it; else, a share of the words that say what it is; and a
price under what the search found typically is a deal."""

import re
import statistics
from dataclasses import dataclass

from .ebay import Listing
from .wants import Want

# Listings that aren't the thing: parts of it, broken, or a picture.
_JUNK = re.compile(
    r"\b(for parts|not working|broken|as[ -]is|for repair|parts only|empty box|box only|manual only|untested)\b", re.I
)
# Words that say nothing of what a thing is.
_STOP = {
    "a", "an", "and", "the", "for", "with", "of", "in", "on", "to", "or", "new", "used", "nos", "lot", "pcs", "pc",
    "qty", "free", "shipping", "ship", "fast", "oem", "genuine", "original", "brand", "item", "items", "set", "kit",
    "x", "-", "&", "w", "w/", "pack", "each", "inch", "mm",
}  # fmt: skip
_WORD = re.compile(r"[a-z0-9]+(?:[-./][a-z0-9]+)*")

# How sure a match by words is before it's shown without Claude's say: half of what it's called and searched for.
SURE = 0.5
# Listings that come up for a want, at most, for Claude to look at: the best by words.
MOST_CANDIDATES = 6


def words(text: str) -> set[str]:
    return {word for word in _WORD.findall(text.lower()) if word not in _STOP}


def squash(text: str) -> str:
    """Letters and digits alone, in capitals, to find a part number however it's written: SS-43GS4 is SS43GS4."""
    return re.sub(r"[^A-Z0-9]", "", text.upper())


@dataclass(frozen=True)
class Candidate:
    want: Want
    listing: Listing
    search: str
    fit: float  # 0 to 1: how well its words fit
    reason: str  # why, in words
    typical: int | None = None  # what those the search found that fit typically cost, shipped, in cents


def fit(want: Want, listing: Listing) -> tuple[float, str]:
    """How well a listing fits what's wanted, 0 to 1, and why, in words."""
    if _JUNK.search(listing.title) or "parts" in listing.condition.lower():
        return 0.0, "For parts, or not working"
    title = squash(listing.title)
    for number in want.numbers:
        if len(squash(number)) >= 5 and squash(number) in title:
            return 1.0, f"Its part number, {number}"
    wanted = words(" ".join([want.title, *want.searches]))
    found = wanted & words(listing.title)
    if not wanted:
        return 0.0, ""
    share = len(found) / min(len(wanted), 8)
    # Said as the listing writes them: 6061-T6, not 6061-t6.
    spelled: dict[str, str] = {}
    for word in re.findall(r"[A-Za-z0-9]+(?:[-./][A-Za-z0-9]+)*", listing.title):
        spelled.setdefault(word.lower(), word)
    shown = ", ".join(spelled.get(word, word) for word in sorted(found, key=len, reverse=True)[:4])
    return min(0.95, share), (f"It says {shown}" if found else "")


def total(listing: Listing) -> int:
    """What it costs, shipped, in cents: its price, and its shipping where eBay says it."""
    return listing.price + (listing.shipping or 0)


def candidates(want: Want, search: str, listings: list[Listing]) -> list[Candidate]:
    """The listings a search found that fit a want at all, each with how well, and its price against the typical one:
    the median of those that fit, with at least three to go by."""
    fitting = []
    for listing in listings:
        how, why = fit(want, listing)
        if how > 0 and listing.available:
            fitting.append(Candidate(want, listing, search, how, why))
    prices = [total(c.listing) for c in fitting if c.fit >= SURE]
    typical = round(statistics.median(prices)) if len(prices) >= 3 else None
    return [Candidate(c.want, c.listing, c.search, c.fit, c.reason, typical) for c in fitting]


def savings(paid: int, typical: int | None) -> float | None:
    """How far under the typical price something is, as a share of it (0.34: a third under), or None, if there's no
    typical price to go by."""
    if not typical:
        return None
    return round(max(-1.0, min(0.9, 1 - paid / typical)), 4)


def score(fit_of: float, paid: int, typical: int | None) -> float:
    """How good a deal it is, 0 to 1: how well it fits, mostly, and how far under the typical price."""
    return round(0.75 * fit_of + 0.25 * max(0.0, savings(paid, typical) or 0.0), 4)


def best(found: list[Candidate], most: int = MOST_CANDIDATES) -> list[Candidate]:
    """A want's best candidates, each listing once: the best fitting, then the cheapest."""
    kept: dict[str, Candidate] = {}
    for candidate in sorted(found, key=lambda c: (-c.fit, total(c.listing))):
        kept.setdefault(candidate.listing.id, candidate)
    return list(kept.values())[:most]
