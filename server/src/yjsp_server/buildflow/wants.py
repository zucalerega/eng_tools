"""What Buildflow wants found (the site's deals/): every program's components not yet procured, those ready to buy
(through design, bought off the shelf) and lately worked on first. Procured is through the build phase's milestone for
buying (Procurement, as programs start; one named for ordering, purchasing, or buying), or, with none, through the build
phase. A bought one by its part numbers and what it is;
one the team makes by the stock its description says it's made from. Each stands for its CAD in Vault and its parts on
P&IDs, by its links, so a deal found for those is the component's, on its bill of design."""

import re
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

from sqlalchemy.orm import Session

from ..db import utcnow
from ..deals.wants import Want, part_numbers, stock
from . import programs
from .models import Component, Link, Phase
from .progress import phase_state

RECENT = timedelta(days=14)  # worked on lately: changed this recently
# The build phase's milestones for buying a component, or its stock.
_BUYING = re.compile(r"procure|purchas|order|buy", re.IGNORECASE)
# How much a component's wanted, by where it is in design: ready to buy once it's through, or needs none.
_DESIGNED = {"done": 2.0, "skipped": 2.0, "in_progress": 1.0, "blocked": 1.0, "not_started": 0.5}


def wants(db: Session) -> list[Want]:
    found = []
    now = utcnow()
    for program in programs.programs(db):
        stones = programs.milestones(db, program.id)
        design = [m for m in stones if m.phase == Phase.DESIGN]
        build = [m for m in stones if m.phase == Phase.BUILD]
        buying = [m for m in build if _BUYING.search(m.name) or _BUYING.search(m.title)] or build
        subsystems = {s.id: s.name for s in programs.subsystems(db, program.id)}
        for component in programs.components(db, program.id):
            statuses = {p.milestone_id: p.status for p in component.progress}
            if buying and phase_state(buying, statuses) in ("done", "skipped"):
                continue  # bought, or its stock is, already
            numbers = part_numbers(" ".join([component.description, *(link.title for link in component.links)]))
            searches = list(numbers)
            if component.bought and component.description.strip():
                searches.append(_what_it_is(component))
            material = None if component.bought else stock(component.description)
            if material:
                searches.append(material)
            covers = _covers(component.links)
            if not searches and not covers:
                continue
            weight = _DESIGNED[phase_state(design, statuses)] * (1.5 if component.bought else 1.0)
            if now - component.updated_at < RECENT:
                weight *= 1.5
            subsystem = subsystems.get(component.subsystem_id, "")
            made = "bought off the shelf" if component.bought else "made by the team: stock to make it from"
            found.append(
                Want(
                    key=f"buildflow:component:{component.id}",
                    title=component.name,
                    where=f"{program.name}, {subsystem}",
                    href=f"/buildflow/programs/{program.id}?phase=build&component={component.id}",
                    searches=tuple(searches),
                    numbers=numbers,
                    needs=f"{component.name}, in {program.name}'s {subsystem}, {made}. {component.description}".strip(),
                    weight=weight,
                    covers=covers,
                )
            )
    return found


def _what_it_is(component: Component) -> str:
    """A search for a bought part by what it is: its name, and the start of its description, which says its kind and
    size ("1/2 in ball valve, 3000 psi")."""
    words = component.description.replace("\n", " ").split()
    return " ".join([component.name, *words[:8]])[:120].rstrip(" ,;:.")


def _covers(links: list[Link]) -> tuple[str, ...]:
    """What else a component stands for, by its links: a file in Vault, and a part on a P&ID (a link to the diagram
    found at its tag, `?find=MOV-101`, as Piper links to one)."""
    covered = []
    for link in links:
        if not link.url.startswith("/"):
            continue
        address = urlsplit(link.url)
        parts = address.path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["vault", "file"] and parts[2].isdigit():
            covered.append(f"vault:file:{parts[2]}")
        elif len(parts) >= 3 and parts[:2] == ["piper", "diagrams"] and parts[2].isdigit():
            for tag in parse_qs(address.query).get("find", []):
                covered.append(f"piper:{parts[2]}:{tag.strip().upper()}")
    return tuple(dict.fromkeys(covered))
