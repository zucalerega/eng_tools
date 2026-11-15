"""What Piper wants found (the site's deals/): the parts on the team's latest P&IDs that say their model (Swagelok
SS-45S8), searched for by it. A part that says only what it has to be (its size, rating, and fluid) is no search of its
own, but what it needs counts where a Buildflow component stands for it (wants.gather)."""

from datetime import timedelta
from typing import Any
from urllib.parse import quote

from sqlalchemy.orm import Session

from ..db import utcnow
from ..deals.wants import Want, part_numbers
from .diagrams import diagrams, latest_drawing
from .schemas import drawing_pages

MOST_DIAGRAMS = 30  # the latest changed
RECENT = timedelta(days=30)
# What a part says of itself that a replacement has to match, as the parts list names them (web/src/piper/library).
_SAYS = {
    "model": "model",
    "size": "size",
    "mawp": "MAWP",
    "cv": "Cv",
    "body": "body",
    "actuation": "actuation",
    "normal": "normally",
    "material": "material",
    "range": "range",
    "output": "output",
    "fluid": "fluid",
    "volume": "volume",
    "meop": "MEOP",
    "diameter": "diameter",
    "rating": "rating",
}
# What's only written or drawn on a drawing: no part to buy.
_DRAWN = {"text", "region", "connector", "legend", "titleblock", "title_block", "picture", "figure", "tee", "junction"}


def wants(db: Session) -> list[Want]:
    found: dict[str, Want] = {}
    now = utcnow()
    for diagram in diagrams(db)[:MOST_DIAGRAMS]:
        drawing = latest_drawing(db, diagram)
        fluids = {str(f.get("id")): str(f.get("label") or f.get("name") or "") for f in drawing.get("fluids") or []}
        weight = 1.0 if now - diagram.updated_at < RECENT else 0.5
        for page in drawing_pages(drawing):
            for part in page.get("parts") or []:
                want = _want(diagram.id, diagram.name, part, fluids, weight)
                if want is not None:
                    found.setdefault(want.key, want)
    return list(found.values())


def _want(diagram: int, name: str, part: Any, fluids: dict[str, str], weight: float) -> Want | None:
    if not isinstance(part, dict) or part.get("unlisted") or str(part.get("kind")) in _DRAWN:
        return None
    tag = str(part.get("tag") or "").strip()
    props = part.get("props") if isinstance(part.get("props"), dict) else {}
    said = {key: str(value).strip() for key, value in props.items() if key in _SAYS and str(value).strip()}
    if not tag or not said:
        return None
    kind = str(part.get("kind") or "part").replace("_", " ")
    holds = fluids.get(str(props.get("fluid") or ""), "")
    needs = ", ".join(f"{_SAYS[key]} {value}" for key, value in said.items() if key != "fluid")
    model = said.get("model", "")
    return Want(
        key=f"piper:{diagram}:{tag.upper()}",
        title=f"{tag}, {model or kind}",
        where=f"Piper, {name}",
        href=f"/piper/diagrams/{diagram}?find={quote(tag, safe='')}",
        searches=(model,) if model else (),
        numbers=part_numbers(model),
        needs=f"{kind} {tag} on the P&ID {name}: {needs}" + (f"; carries {holds}" if holds else ""),
        weight=weight,
    )
