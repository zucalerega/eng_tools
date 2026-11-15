"""What the team wants, as each app says it: the site's terms for it (`Want`), how one want stands for others (a
component for its CAD in Vault and its part on a P&ID), and the words searches are made of: part numbers, and stock."""

import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, replace

from sqlalchemy.orm import Session

MOST_SEARCHES = 3  # for one want
MOST_NUMBERS = 3


@dataclass(frozen=True)
class Want:
    """Something the team wants, found by searching for it."""

    key: str  # what it is, unique on the site: "buildflow:component:12", "vault:file:34", "piper:5:MOV-101"
    title: str  # what it's called: "Main oxidizer valve"
    where: str  # where it's from, in words: "Elytra, Fluids"
    href: str  # its page on the site: "/buildflow/programs/1?phase=build&component=12"
    searches: tuple[str, ...]  # what to search for, the best first
    numbers: tuple[str, ...] = ()  # part numbers a listing that's it would carry: "SS-43GS4"
    needs: str = ""  # what it has to be, in words, to judge a listing by
    weight: float = 1.0  # how much it matters now: what's being worked on, ready to buy
    covers: tuple[str, ...] = ()  # others it stands for: its CAD in Vault ("vault:file:34"), its P&ID's part


# What each app says it wants, from the database: handed over by app.py, as the site imports no app.
Wants = Callable[[Session], Sequence[Want]]


def gather(db: Session, sources: Iterable[Wants]) -> list[Want]:
    """Everything the team wants, the most wanted first: each app's, those one stands for folded into it, so a deal for
    a component's CAD is the component's."""
    found: dict[str, Want] = {}
    for source in sources:
        for want in source(db):
            found.setdefault(want.key, want)
    covered: set[str] = set()
    for key, want in list(found.items()):
        others = [found[k] for k in want.covers if k in found and k != key]
        if not others:
            continue
        found[key] = replace(
            want,
            searches=_once([*want.searches, *(s for o in others for s in o.searches)])[:MOST_SEARCHES],
            numbers=_once([*want.numbers, *(n for o in others for n in o.numbers)])[:MOST_NUMBERS],
            needs="; ".join(text for text in [want.needs, *(o.needs for o in others)] if text),
            weight=max([want.weight, *(o.weight for o in others)]),
        )
        covered.update(o.key for o in others)
    kept = [want for key, want in found.items() if key not in covered and want.searches]
    return sorted(kept, key=lambda w: (-w.weight, w.key))


def _once(items: Iterable[str]) -> tuple[str, ...]:
    seen: dict[str, str] = {}
    for item in items:
        tidy = " ".join(item.split())
        if tidy and tidy.lower() not in seen:
            seen[tidy.lower()] = tidy
    return tuple(seen.values())


# --- words to search for --------------------------------------------------------------------------------------------

# A part number as vendors write them: letters and digits together, with dashes, dots, or slashes between, at least one
# of each and five long: SS-43GS4, PX309-1KG5V, 91251A463, AN6-8D. Not a material's grade (6061-T6, 17-4, 316L), a
# size (0.125in, 1/4NPT), or a pressure (3000psi).
_NUMBER = re.compile(r"(?<![\w-])[A-Z0-9][A-Z0-9]*(?:[-./][A-Z0-9]+)*(?![\w-])")
_MATERIAL = re.compile(r"^(?:\d{4}-T\d+|17-4(?:PH)?|15-5(?:PH)?|\d{3}L?|T\d+)$")
_MEASURE = re.compile(r"^\d+(?:[./]\d+)?(?:IN|MM|CM|M|FT|PSI|PSIA|PSIG|BAR|KPA|MPA|NPT|AN|LB|LBS|KG|G|V|VDC|MA|K|C|F)$")


def part_numbers(text: str) -> tuple[str, ...]:
    """The part numbers in some words: what a vendor's part, a model, or a component's description names."""
    found = []
    for token in _NUMBER.findall(text.upper().replace("_", " ")):  # "91251A463_Socket Head Screw", as Vault names it
        squashed = token.replace("-", "").replace(".", "").replace("/", "")
        if len(squashed) < 5 or not re.search(r"\d", token) or not re.search(r"[A-Z]", token):
            continue
        if _MATERIAL.match(token) or _MEASURE.match(token) or _MEASURE.match(squashed):
            continue
        found.append(token)
    return _once(found)[:MOST_NUMBERS]


# Stock a part's made from, in a description: a metal or a plastic by its grade, its form, and its sizes.
_GRADES = [
    (re.compile(r"\b(6061|6063|7075|2024|5052|3003|6082)(?:-(T\d+))?\b", re.I), "aluminum"),
    (
        re.compile(r"\b(303|304|304L|316|316L|321|17-4(?:\s?PH)?|15-5(?:\s?PH)?|410|440C)\b(?:\s*SS)?", re.I),
        "stainless",
    ),
    (re.compile(r"\b(Inconel|Incoloy|Monel|Hastelloy)\s*(\d{3})?\b", re.I), ""),
    (re.compile(r"\b(Ti-?6Al-?4V|titanium|Grade\s*[25]\s*titanium)\b", re.I), ""),
    (re.compile(r"\b(4130|4140|1018|1045|A36)\b(?:\s*steel)?", re.I), "steel"),
    (re.compile(r"\b(G-?10|FR-?4|phenolic|PTFE|Delrin|acetal|PEEK|nylon|UHMW|carbon fiber|fiberglass)\b", re.I), ""),
    (re.compile(r"\b(brass|copper|bronze|C360|C110)\b", re.I), ""),
]
_FORMS = re.compile(
    r"\b(round bar|square bar|flat bar|hex bar|bar|rod|tube|tubing|pipe|plate|sheet|angle|channel|block|billet)\b", re.I
)
_SIZES = re.compile(
    r"(\d+(?:\.\d+)?(?:\s*/\s*\d+)?)\s*(in\b|inch(?:es)?\b|\"|mm\b)\s*(OD|ID|wall|thick|dia(?:meter)?)?", re.I
)


def stock(text: str) -> str | None:
    """What to search for the stock a part's made from, from its description ("6061-T6 aluminum, 8 in OD, 0.125 in
    wall tube": "6061-T6 aluminum tube 8 in OD 0.125 in wall"), or None if it doesn't say a material."""
    matched = next(((found, family) for pattern, family in _GRADES if (found := pattern.search(text))), None)
    if matched is None:
        return None
    grade, family = matched[0].group(0).strip(), matched[1]
    words = [grade] if not family or family.lower() in grade.lower() else [grade, family]
    form = _FORMS.search(text)
    if form:
        words.append(form.group(1).lower())
    for size, unit, of in _SIZES.findall(text)[:2]:
        words.append(" ".join([size.replace(" ", ""), "mm" if unit.lower() == "mm" else "in", of]).strip())
    return " ".join(words)
