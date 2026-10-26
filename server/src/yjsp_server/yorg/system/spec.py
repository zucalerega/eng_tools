"""A system model as a client sends it (Piper builds one from a P&ID): nodes and the edges between them, each with its
settings and links to channels. Its parts must fit together (check_shape), and to run it must be one that can be
simulated (runnable), or the server says in words which part is the problem.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field

from ...errors import ApiError
from .catalog import BY_TYPE, in_words, settings_of

_ID = r"^[A-Za-z0-9_-]{1,40}$"
# Where liquid and gas can go: an ullage tank holds both, an outlet takes either.
_LIQUID_ENDS = {"tank", "junction", "outlet"}
_GAS_ENDS = {"source", "gas_junction", "tank", "outlet"}


class BadModel(ApiError):
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
                f"{part.name} is a {in_words(found.label)}, which goes {'between' if found.kind == 'edge' else 'at'} nodes"
            )
    nodes = {node.id for node in model.nodes}
    for edge in model.edges:
        if edge.source not in nodes or edge.target not in nodes:
            raise BadModel(f"{edge.name} isn't connected at both ends")
        if edge.source == edge.target:
            raise BadModel(f"{edge.name} starts and ends at the same place")


@dataclass
class Runnable:
    """A checked model: every part's settings (defaults filled in), each liquid part's liquid, and each gas part's
    gas."""

    nodes: dict[str, dict[str, Any]]
    edges: dict[str, dict[str, Any]]
    liquid_of: dict[str, str] = field(default_factory=dict)  # liquid node or edge id: the id of the tank it's from
    gas_of: dict[str, str] = field(default_factory=dict)  # gas node or edge id: the gas in it (Nitrogen)
    gas_model_of: dict[str, str] = field(default_factory=dict)  # and its properties: real or ideal


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
                    f"{part.name}'s {in_words(setting.label)} can't be {value}: pick one of {', '.join(setting.choices)}"
                )
            continue
        if isinstance(value, str):
            raise BadModel(f"{part.name}'s {in_words(setting.label)} has to be a number")
        if setting.minimum is not None and value < setting.minimum:
            raise BadModel(f"{part.name}'s {in_words(setting.label)} is below {setting.minimum:g} (in SI units)")
        if setting.maximum is not None and value > setting.maximum:
            raise BadModel(f"{part.name}'s {in_words(setting.label)} is above {setting.maximum:g} (in SI units)")
    unknown_links = set(part.links) - {link.key for link in kind.links}
    if unknown_links:
        raise BadModel(f"{part.name} can't be linked to a {sorted(unknown_links)[0]} channel")
    return values


def _ullage(node: dict[str, Any]) -> bool:
    return node["type"] == "tank" and node["settings"]["mode"] == "ullage"


def runnable(model: SystemModelIn) -> Runnable:
    """Check a model can be simulated: each part set up within its limits; liquid paths between tanks, junctions,
    and outlets, and gas paths between gas supplies, gas junctions, tanks' ullages, and outlets; every liquid path
    reaching a tank (whose liquid it carries), and every gas path a gas supply or an ullage (whose gas it carries)."""
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
        if _ullage(node) and settings["liquid_volume"] >= settings["volume"]:
            raise BadModel(f"{node['name']} has no room for its ullage: its liquid fills it")
    liquid_edges: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    gas_edges: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    for edge in edges.values():
        source, target = nodes[edge["source"]], nodes[edge["target"]]
        if BY_TYPE[edge["type"]].phase == "gas":
            for end in (source, target):
                if end["type"] not in _GAS_ENDS:
                    raise BadModel(
                        f"{edge['name']} carries gas, so it can't connect to {end['name']}, a liquid junction: use a "
                        "gas junction"
                    )
                if end["type"] == "tank" and not _ullage(end):
                    raise BadModel(
                        f"{edge['name']} carries gas into or out of {end['name']}'s ullage: set {end['name']}'s "
                        "pressure to gas ullage"
                    )
            if edge["type"] == "regulator" and target["type"] not in ("gas_junction", "tank"):
                raise BadModel(
                    f"{edge['name']} holds the pressure where it flows to: connect it to a gas junction or a tank"
                )
            ends = gas_edges
        else:
            for end in (source, target):
                if end["type"] not in _LIQUID_ENDS:
                    kind = in_words(BY_TYPE[end["type"]].label)
                    raise BadModel(f"{edge['name']} carries liquid, so it can't connect to {end['name']}, a {kind}")
            ends = liquid_edges
        ends[source["id"]].append(edge["id"])
        ends[target["id"]].append(edge["id"])
    checked = Runnable(nodes, edges)
    _liquids(checked, liquid_edges)
    _gases(checked, gas_edges)
    return checked


def _circuit(checked: Runnable, start: str, ends: dict[str, list[str]]) -> tuple[set[str], list[str]]:
    """The nodes and edges connected to start through ends' edges, and the nodes among them."""
    circuit, found, pending = set(), [], [start]
    while pending:
        here = pending.pop()
        if here in circuit:
            continue
        circuit.add(here)
        found.append(here)
        for edge_id in ends[here]:
            circuit.add(edge_id)
            edge = checked.edges[edge_id]
            pending.extend(end for end in (edge["source"], edge["target"]) if end not in circuit)
    return circuit, found


def _liquids(checked: Runnable, ends: dict[str, list[str]]) -> None:
    """Each connected run of liquid parts carries one tank's liquid."""
    for node_id, node in checked.nodes.items():
        if node_id in checked.liquid_of or not (node["type"] in ("tank", "junction") or ends[node_id]):
            continue
        circuit, found = _circuit(checked, node_id, ends)
        tanks = [one for one in found if checked.nodes[one]["type"] == "tank"]
        if not tanks:
            raise BadModel(f"{node['name']} isn't connected to a tank, so nothing says what liquid is there")
        liquids = {_liquid(checked.nodes[tank]["settings"]) for tank in tanks}
        if len(liquids) > 1:
            named = " and ".join(
                f"{checked.nodes[tank]['name']} ({_liquid(checked.nodes[tank]['settings'])})" for tank in tanks[:2]
            )
            raise BadModel(f"{named} are connected, but a model carries one liquid in each connected set of lines")
        for part_id in circuit:
            checked.liquid_of[part_id] = tanks[0]


def _gases(checked: Runnable, ends: dict[str, list[str]]) -> None:
    """Each connected run of gas parts carries one gas: its supplies' and ullages'."""
    for node_id, node in checked.nodes.items():
        if node_id in checked.gas_of or not (node["type"] in ("source", "gas_junction") or ends[node_id]):
            continue
        circuit, found = _circuit(checked, node_id, ends)
        holders = [one for one in found if checked.nodes[one]["type"] == "source" or _ullage(checked.nodes[one])]
        if not holders:
            raise BadModel(
                f"{node['name']} isn't connected to a gas supply or a tank's ullage, so nothing says what gas is there"
            )
        by_gas: dict[tuple[str, str], str] = {}  # each gas, and its properties: the first part holding it
        for holder in holders:
            settings = checked.nodes[holder]["settings"]
            by_gas.setdefault((settings["gas"], settings["gas_model"]), holder)
        if len(by_gas) > 1:
            named = " and ".join(
                f"{_holder(checked.nodes[holder])} ({gas if model == 'real' else f'ideal {gas}'})"
                for (gas, model), holder in list(by_gas.items())[:2]
            )
            raise BadModel(
                f"{named} are connected, but a model carries one gas in each connected set of gas lines: make them "
                "the same"
            )
        gas, model = next(iter(by_gas))
        for part_id in circuit:
            checked.gas_of[part_id] = gas
            checked.gas_model_of[part_id] = model


def _holder(node: dict[str, Any]) -> str:
    return f"{node['name']}'s ullage" if node["type"] == "tank" else node["name"]


def _liquid(settings: dict[str, Any]) -> str:
    return settings["fluid"] if settings["fluid"] != "Custom" else f"{settings['density']:g} kg/m³"
