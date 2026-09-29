"""A system model as the web app sends it: nodes and the edges between them, each with its settings and links to
channels. Saving takes any model whose parts fit together (a half-drawn one is fine); running checks more
(runnable), and says in words which part is the problem.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field

from ...errors import CvcError
from .catalog import BY_TYPE, settings_of

_ID = r"^[A-Za-z0-9_-]{1,40}$"
_LIQUID_NODES = {"tank", "junction", "outlet"}


class BadModel(CvcError):
    status = 422
    code = "bad_model"


class PartIn(BaseModel):
    id: str = Field(pattern=_ID)
    type: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=80)
    x: float = 0.0
    y: float = 0.0
    settings: dict[str, float | str] = Field(default_factory=dict)
    links: dict[str, str] = Field(default_factory=dict)  # a link's key: the name of the channel in it ("": none)


class EdgeIn(PartIn):
    source: str = Field(pattern=_ID)  # the node it flows from (positive flow)
    target: str = Field(pattern=_ID)  # and the node it flows to


class DisplayIn(BaseModel):
    """How the web app shows the model; a run also reads channels without units in these."""

    units: Literal["us", "si"] = "us"
    gauge: bool = True  # pressures shown (and channels read) above the atmosphere
    ambient: float = Field(default=101325.0, gt=0, lt=2e5)  # Pa: the atmosphere, for gauge pressures


class SystemModelIn(BaseModel):
    version: Literal[1] = 1
    nodes: list[PartIn] = Field(default_factory=list, max_length=200)
    edges: list[EdgeIn] = Field(default_factory=list, max_length=400)
    display: DisplayIn = Field(default_factory=DisplayIn)


def check_shape(model: SystemModelIn) -> None:
    """What any saved model needs: parts of known types with unique ids, and edges between its nodes."""
    seen: set[str] = set()
    for part in [*model.nodes, *model.edges]:
        if part.id in seen:
            raise BadModel(f"Two parts are called {part.id}")
        seen.add(part.id)
        found = BY_TYPE.get(part.type)
        if found is None:
            raise BadModel(f"{part.name} is a {part.type}, which isn't a part a model can have")
        if found.kind != ("edge" if isinstance(part, EdgeIn) else "node"):
            raise BadModel(
                f"{part.name} is a {found.label.lower()}, which goes {'between' if found.kind == 'edge' else 'at'} nodes"
            )
    nodes = {node.id for node in model.nodes}
    for edge in model.edges:
        if edge.source not in nodes or edge.target not in nodes:
            raise BadModel(f"{edge.name} isn't connected at both ends")
        if edge.source == edge.target:
            raise BadModel(f"{edge.name} starts and ends at the same place")


@dataclass
class Runnable:
    """A checked model: every part's settings (defaults filled in), and each liquid part's liquid."""

    nodes: dict[str, dict[str, Any]]
    edges: dict[str, dict[str, Any]]
    liquid_of: dict[str, str] = field(default_factory=dict)  # liquid node or edge id: the id of the tank it's from


def _settings(part: PartIn) -> dict[str, Any]:
    kind = BY_TYPE[part.type]
    unknown = set(part.settings) - {setting.key for setting in kind.settings}
    if unknown:
        raise BadModel(f"{part.name} has no setting {sorted(unknown)[0]}")
    values = settings_of(part.type, part.settings)
    for setting in kind.settings:
        value = values[setting.key]
        if setting.quantity == "choice":
            if value not in setting.choices:
                raise BadModel(
                    f"{part.name}'s {setting.label.lower()} can't be {value}: pick one of {', '.join(setting.choices)}"
                )
            continue
        if isinstance(value, str):
            raise BadModel(f"{part.name}'s {setting.label.lower()} has to be a number")
        if setting.minimum is not None and value < setting.minimum:
            raise BadModel(f"{part.name}'s {setting.label.lower()} is below {setting.minimum:g} (in SI units)")
        if setting.maximum is not None and value > setting.maximum:
            raise BadModel(f"{part.name}'s {setting.label.lower()} is above {setting.maximum:g} (in SI units)")
    unknown_links = set(part.links) - {link.key for link in kind.links}
    if unknown_links:
        raise BadModel(f"{part.name} can't be linked to a {sorted(unknown_links)[0]} channel")
    return values


def runnable(model: SystemModelIn) -> Runnable:
    """Check a model can be simulated: each part set up within its limits, liquid paths between liquid nodes and press
    lines from a gas supply into a tank's ullage, and every liquid path reaching a tank (whose liquid it carries)."""
    check_shape(model)
    if not model.nodes:
        raise BadModel("Draw the system first: tanks, lines, valves, and where they lead")
    nodes = {
        node.id: {"id": node.id, "type": node.type, "name": node.name, "settings": _settings(node), "links": node.links}
        for node in model.nodes
    }
    edges = {
        edge.id: {
            "id": edge.id,
            "type": edge.type,
            "name": edge.name,
            "source": edge.source,
            "target": edge.target,
            "settings": _settings(edge),
            "links": edge.links,
        }
        for edge in model.edges
    }
    for node in nodes.values():
        settings = node["settings"]
        if node["type"] == "tank" and settings["mode"] == "ullage" and settings["liquid_volume"] >= settings["volume"]:
            raise BadModel(f"{node['name']} has no room for its ullage: its liquid fills it")
    neighbors: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    for edge in edges.values():
        source, target = nodes[edge["source"]], nodes[edge["target"]]
        if BY_TYPE[edge["type"]].phase == "gas":
            if source["type"] != "source":
                raise BadModel(f"{edge['name']} carries pressurant, so it starts at a gas supply")
            if target["type"] != "tank" or target["settings"]["mode"] != "ullage":
                raise BadModel(
                    f"{edge['name']} carries pressurant into a tank's ullage: set {target['name']}'s pressure to ullage"
                )
            continue
        for end in (source, target):
            if end["type"] not in _LIQUID_NODES:
                raise BadModel(f"{edge['name']} carries liquid, so it can't connect to {end['name']}, a gas supply")
        neighbors[source["id"]].append(edge["id"])
        neighbors[target["id"]].append(edge["id"])
    # Each connected run of liquid parts carries one tank's liquid.
    checked = Runnable(nodes, edges)
    for node_id, node in nodes.items():
        if node["type"] == "source" or node_id in checked.liquid_of:
            continue
        circuit, tanks, pending = set(), [], [node_id]
        while pending:
            here = pending.pop()
            if here in circuit:
                continue
            circuit.add(here)
            if nodes[here]["type"] == "tank":
                tanks.append(here)
            for edge_id in neighbors[here]:
                circuit.add(edge_id)
                edge = edges[edge_id]
                pending.extend(end for end in (edge["source"], edge["target"]) if end not in circuit)
        if not tanks:
            raise BadModel(f"{node['name']} isn't connected to a tank, so nothing says what liquid is there")
        liquids = {_liquid(nodes[tank]["settings"]) for tank in tanks}
        if len(liquids) > 1:
            named = " and ".join(f"{nodes[tank]['name']} ({_liquid(nodes[tank]['settings'])})" for tank in tanks[:2])
            raise BadModel(f"{named} are connected, but a model carries one liquid in each connected set of lines")
        for part_id in circuit:
            checked.liquid_of[part_id] = tanks[0]
    return checked


def _liquid(settings: dict[str, Any]) -> str:
    return settings["fluid"] if settings["fluid"] != "Custom" else f"{settings['density']:g} kg/m³"
