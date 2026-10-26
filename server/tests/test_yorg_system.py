"""System models (Piper's Simulation mode, for admins): a feed system's model, run with FullFlow against a test's data."""

import ast

import numpy as np
import pytest
from fullflow import FullFlowError

from yjsp_server.yorg.system.catalog import PSI
from yjsp_server.yorg.system.channels import Reading, to_si
from yjsp_server.yorg.system.library import Run
from yjsp_server.yorg.system.spec import SystemModelIn, runnable

ATMOSPHERE = 101325.0


def upload(team, who, csv: str, name: str = "Cold flow.csv") -> dict:
    response = team.client.post("/api/yorg/datasets", params={"filename": name}, content=csv.encode(), headers=who)
    assert response.status_code == 201, response.text
    return response.json()


def cold_flow_csv() -> str:
    """2 s at 100 Hz: the tank at 300 psig, the main valve open from 0.5 s to 1.5 s."""
    rows = ["Time (s),MOV-01,PT-TANK (psig)"]
    for i in range(201):
        t = i / 100
        rows.append(f"{t:.2f},{'OPEN' if 0.5 <= t < 1.5 else 'CLOSED'},300.0")
    return "\n".join(rows) + "\n"


def node(node_id: str, kind: str, name: str, settings: dict | None = None, links: dict | None = None) -> dict:
    return {"id": node_id, "type": kind, "name": name, "settings": settings or {}, "links": links or {}}


def edge(edge_id, kind, name, source, target, settings=None, links=None) -> dict:
    return {**node(edge_id, kind, name, settings, links), "source": source, "target": target}


def cold_flow_model() -> dict:
    """Tank -> feed line -> J1 -> main valve -> J2 (manifold) -> injector -> atmosphere."""
    return {
        "nodes": [
            node("tank", "tank", "Water tank", {"fluid": "Water"}, {"pressure": "PT-TANK"}),
            node("j1", "junction", "Valve inlet"),
            node("j2", "junction", "Manifold"),
            node("out", "outlet", "Atmosphere"),
        ],
        "edges": [
            edge("line", "line", "Feed line", "tank", "j1", {"length": 2.0, "diameter": 0.0127}),
            edge("mov", "valve", "Main valve", "j1", "j2", {"cda": 5e-5, "opening_time": 0.05}, {"command": "MOV-01"}),
            edge("inj", "orifice", "Injector", "j2", "out", {"cda": 3e-5}),
        ],
    }


def test_simulations_are_for_admins(team):
    chief = team.member("chief@x.test", admin=True)
    bob = team.member("bob@x.test")
    response = team.client.get("/api/yorg/models/catalog", headers=bob)
    assert (response.status_code, response.json()["error"]) == (403, "admins_only")
    body = {"model": cold_flow_model(), "dataset_id": 1, "start": 0, "end": 2}
    assert team.client.post("/api/yorg/models/runs", json=body, headers=bob).status_code == 403
    catalog = team.client.get("/api/yorg/models/catalog", headers=chief).json()
    assert {part["type"] for part in catalog["parts"]} >= {
        "tank",
        "junction",
        "gas_junction",
        "outlet",
        "source",
        "line",
        "valve",
        "orifice",
        "venturi",
        "gas_valve",
        "gas_orifice",
        "regulator",
    }
    assert "Water" in catalog["liquids"] and "Helium" in catalog["gases"]
    tank = next(part for part in catalog["parts"] if part["type"] == "tank")
    wall = next(setting for setting in tank["settings"] if setting["key"] == "heat_transfer")
    assert wall["only_when"] == [["mode", "ullage"]] and wall["tunable"]
    source = next(part for part in catalog["parts"] if part["type"] == "source")
    gas = next(setting for setting in source["settings"] if setting["key"] == "gas_model")
    assert (gas["default"], gas["choices"]) == ("real", ["real", "ideal"])


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (
            lambda m: m["nodes"].append(node("j9", "junction", "Stray tee")),
            "Stray tee isn't connected to a tank, so nothing says what liquid is there",
        ),
        (
            lambda m: (
                m["nodes"].append(node("gn2", "source", "Bottle")),
                m["edges"].append(edge("press", "gas_valve", "Press valve", "gn2", "tank")),
            ),
            "Press valve carries gas into or out of Water tank's ullage: set Water tank's pressure to gas ullage",
        ),
        (
            lambda m: (
                m["nodes"].append(node("gn2", "source", "Bottle")),
                m["edges"].append(edge("purge", "gas_valve", "Purge", "gn2", "j1")),
            ),
            "Purge carries gas, so it can't connect to Valve inlet, a liquid junction: use a gas junction",
        ),
        (
            lambda m: (
                m["nodes"].append(node("gj", "gas_junction", "Press manifold")),
                m["edges"].append(edge("drain", "line", "Drain", "j2", "gj")),
            ),
            "Drain carries liquid, so it can't connect to Press manifold, a gas junction",
        ),
        (
            lambda m: m["nodes"].append(node("gj", "gas_junction", "Press manifold")),
            "Press manifold isn't connected to a gas supply or a tank's ullage, so nothing says what gas is there",
        ),
        (
            lambda m: (
                m["nodes"][0]["settings"].update(mode="ullage", volume=0.004, liquid_volume=0.003, gas="Nitrogen"),
                m["nodes"].append(node("ghe", "source", "Helium bottle", {"gas": "Helium"})),
                m["edges"].append(edge("press", "gas_valve", "Press valve", "ghe", "tank")),
            ),
            "Water tank's ullage (Nitrogen) and Helium bottle (Helium) are connected, but a model carries one gas in "
            "each connected set of gas lines: make them the same",
        ),
        (
            lambda m: (
                m["nodes"][0]["settings"].update(mode="ullage", volume=0.004, liquid_volume=0.003, gas="Nitrogen"),
                m["nodes"].append(node("gn2", "source", "Bottle", {"gas": "Nitrogen", "gas_model": "ideal"})),
                m["edges"].append(edge("press", "gas_valve", "Press valve", "gn2", "tank")),
            ),
            "Water tank's ullage (Nitrogen) and Bottle (ideal Nitrogen) are connected, but a model carries one gas in "
            "each connected set of gas lines: make them the same",
        ),
        (
            lambda m: (
                m["nodes"].append(node("gn2", "source", "Bottle")),
                m["edges"].append(edge("reg", "regulator", "Regulator", "gn2", "out")),
            ),
            "Regulator holds the pressure where it flows to: connect it to a gas junction or a tank",
        ),
        (
            lambda m: m["edges"].append(edge("loose", "line", "Loose line", "j2", "nowhere")),
            "Loose line isn't connected at both ends",
        ),
        (lambda m: m["edges"][0]["settings"].update(length=-1), "Feed line's length is below 0.001 (in SI units)"),
        (lambda m: m["edges"][0]["links"].update(command="MOV-01"), "Feed line can't be linked to a command channel"),
    ],
)
def test_a_model_that_cant_run_says_why(team, change, message):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, cold_flow_csv())
    model = cold_flow_model()
    change(model)
    response = team.client.post(
        "/api/yorg/models/runs", json={"model": model, "dataset_id": dataset["id"], "start": 0, "end": 2}, headers=chief
    )
    assert (response.status_code, response.json()["message"]) == (422, message)


def test_channels_are_read_in_their_units_or_the_models():
    psi_gauge = Reading(pressure="psi", gauge=True)
    assert list(to_si("pressure", "psig", [100.0], psi_gauge)) == pytest.approx([100 * PSI + ATMOSPHERE])
    assert list(to_si("pressure", "psia", [100.0], psi_gauge)) == pytest.approx([100 * PSI])
    assert list(to_si("pressure", "bar", [2.0], Reading(gauge=False))) == pytest.approx([2e5])
    assert list(to_si("pressure", "", [10.0], psi_gauge)) == pytest.approx([10 * PSI + ATMOSPHERE])
    assert list(to_si("temperature", "°F", [32.0], psi_gauge)) == pytest.approx([273.15])
    assert list(to_si("temperature", "degC", [-183.0], psi_gauge)) == pytest.approx([90.15])
    assert list(to_si("temperature", "", [-297.0], Reading(temperature="F"))) == pytest.approx([90.37], abs=0.01)
    assert list(to_si("mass_flow", "lbm/s", [1.0], psi_gauge)) == pytest.approx([0.45359237])
    assert list(to_si("command", "V", [5.0], psi_gauge)) == [5.0]


def test_a_run_that_doesnt_settle_says_where():
    """FullFlow lists the equations it couldn't meet, largest first, under names like tank:liquid:ullage_volume or
    inj.cda:anchor; the page names their parts, and not those whose equations it met."""
    checked = runnable(SystemModelIn.model_validate(cold_flow_model()))
    names = {part["id"]: part["name"] for part in [*checked.nodes.values(), *checked.edges.values()]}
    built = Run({}, start=10.0, end=12.0, dt=0.01, names=names)
    error = FullFlowError(
        "Transient timestep failed or converged to unacceptable residuals.\n"
        "time = 0.51\n"
        "Largest residuals:\n"
        "  - line:mass_flow.integration: -1.571477e-05\n"
        "  - inj.cda:anchor.balance[0]: 2.000000e-06\n"
        "  - line.balance[0]: 1.500000e-06\n"
        "  - j1.balance[0]: 0.000000e+00\n"
    )
    assert built.explain(error) == (
        "The simulation didn't settle at 10.510 s, around Feed line and Injector. Try a shorter time step, or check "
        "the settings there (a CdA of 0, a line with no length)."
    )


def pressurized_csv() -> str:
    """2 s at 100 Hz: the main valve open from 0.3 s, the vent from 1.5 s, the ullage starting at 250 psig and 50 °F,
    and the chamber's pressure rising from 0 to 100 psig."""
    rows = ["Time (s),MOV-01,VENT-01,PT-TANK (psig),TC-ULLAGE (F),PT-CHAMBER (psig)"]
    for i in range(201):
        t = i / 100
        rows.append(f"{t:.2f},{int(t >= 0.3)},{int(t >= 1.5)},{250.0 - 5 * t:.2f},{50.0 - t:.2f},{50.0 * t:.2f}")
    return "\n".join(rows) + "\n"


def pressurized_model() -> dict:
    """Bottle -> regulator -> press manifold -> press valve -> water tank (a wall-heated ullage) -> main valve ->
    venturi inlet -> cavitating venturi -> chamber; and a vent from the tank to a vent stack."""
    setpoint = 300 * PSI + ATMOSPHERE
    return {
        "nodes": [
            node("gn2", "source", "Bottle", {"gas": "Nitrogen", "pressure": 2000 * PSI}),
            node("gj", "gas_junction", "Press manifold", {"volume": 0.0002, "pressure": setpoint}),
            node(
                "tank",
                "tank",
                "Water tank",
                {
                    "fluid": "Water",
                    "mode": "ullage",
                    "volume": 0.02,
                    "liquid_volume": 0.015,
                    "wall_mass": 3.0,
                    "heat_transfer": 20.0,
                },
                {"pressure": "PT-TANK", "gas_temperature": "TC-ULLAGE"},
            ),
            node("j1", "junction", "Venturi inlet"),
            node("chamber", "outlet", "Chamber", {}, {"pressure": "PT-CHAMBER"}),
            node("stack", "outlet", "Vent stack"),
        ],
        "edges": [
            edge("reg", "regulator", "Regulator", "gn2", "gj", {"setpoint": setpoint, "droop": 30 * PSI, "cda": 4e-6}),
            edge("press", "gas_valve", "Press valve", "gj", "tank", {"cda": 2e-5}),
            edge("mov", "valve", "Main valve", "tank", "j1", {"cda": 8e-5}, {"command": "MOV-01"}),
            edge("cav", "venturi", "Venturi", "j1", "chamber", {"cda": 2e-5, "recovery": 0.85}),
            edge("vent", "gas_valve", "Vent", "tank", "stack", {"cda": 5e-6, "check": "no"}, {"command": "VENT-01"}),
        ],
    }


def fit_model(injector_cda: float, friction: float) -> dict:
    """Tank at 300 psig -> feed line -> manifold (a pressure transducer) -> injector -> atmosphere."""
    return {
        "nodes": [
            node("tank", "tank", "Water tank", {"fluid": "Water", "pressure": 300 * PSI + ATMOSPHERE}),
            node("j1", "junction", "Manifold", {}, {"pressure": "PT-MANIFOLD"}),
            node("out", "outlet", "Atmosphere"),
        ],
        "edges": [
            edge(
                "line",
                "line",
                "Feed line",
                "tank",
                "j1",
                {"length": 3.0, "diameter": 0.0095, "friction_factor": friction},
            ),
            edge("inj", "orifice", "Injector", "j1", "out", {"cda": injector_cda}, {"flow": "FM-01"}),
        ],
    }


@pytest.mark.parametrize(
    ("knobs", "message"),
    [
        ([{"part": "tank", "key": "fluid"}], "Water tank has no knob fluid to fit"),
        ([{"part": "tank", "key": "heat_transfer"}], "Water tank's wall hA doesn't matter as it's set up"),
        ([{"part": "inj", "key": "cda"}, {"part": "inj", "key": "cda"}], "Injector's CdA is picked twice"),
        ([{"part": "nope", "key": "cda"}], "There's no part nope to fit"),
    ],
)
def test_a_fit_says_what_it_cant_do(team, knobs, message):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, cold_flow_csv())
    body = {"model": cold_flow_model(), "dataset_id": dataset["id"], "start": 0, "end": 1, "knobs": knobs}
    response = team.client.post("/api/yorg/models/fits", json=body, headers=chief)
    assert (response.status_code, response.json()["message"]) == (422, message)


def test_a_fit_needs_something_to_compare_with(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, cold_flow_csv())
    body = {
        "model": cold_flow_model(),  # its tank follows PT-TANK, and nothing is compared
        "dataset_id": dataset["id"],
        "start": 0,
        "end": 1,
        "knobs": [{"part": "inj", "key": "cda"}],
    }
    response = team.client.post("/api/yorg/models/fits", json=body, headers=chief)
    assert (response.status_code, response.json()["message"]) == (
        422,
        "Link a sensor to fit the model to: a pressure transducer, a flow meter, a tank's pressure",
    )


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (
            {"anchors": [{"part": "tank", "key": "fluid", "sensor": "j1", "link": "pressure"}]},
            "Water tank has no knob fluid to anchor",
        ),
        (
            {"anchors": [{"part": "inj", "key": "cda", "sensor": "nope", "link": "pressure"}]},
            "There's no nope pressure to anchor Injector's CdA to",
        ),
        (
            {"anchors": [{"part": "inj", "key": "cda", "sensor": "line", "link": "flow"}]},
            "Link Feed line's flow meter to a channel to anchor Injector's CdA to it",
        ),
        (
            {
                "anchors": [
                    {"part": "inj", "key": "cda", "sensor": "j1", "link": "pressure"},
                    {"part": "line", "key": "friction_factor", "sensor": "j1", "link": "pressure"},
                ]
            },
            "Manifold's pressure transducer anchors two knobs: give each knob a sensor of its own",
        ),
        (
            {"anchors": [{"part": "inj", "key": "cda", "sensor": "inj", "link": "flow", "end": 1.5}]},
            "Injector's CdA is anchored outside the run's window",
        ),
        (
            {"anchors": [{"part": "inj", "key": "cda", "sensor": "inj", "link": "flow", "start": 0.5, "end": 0.505}]},
            "Injector's CdA is anchored for less than a time step",
        ),
        (
            {
                "anchors": [{"part": "inj", "key": "cda", "sensor": "inj", "link": "flow"}],
                "knobs": [{"part": "inj", "key": "cda"}],
            },
            "Injector's CdA is anchored and fitted: pick one",
        ),
        (
            {
                "anchors": [
                    {"part": "inj", "key": "cda", "sensor": "inj", "link": "flow"},
                    {"part": "line", "key": "friction_factor", "sensor": "j1", "link": "pressure"},
                ],
                "knobs": [{"part": "line", "key": "loss_coefficient"}],
            },
            "Every sensor anchors a knob, so there's none left to fit the others to: anchor fewer, or link another "
            "sensor",
        ),
    ],
)
def test_an_anchor_says_what_it_cant_do(team, change, message):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, cold_flow_csv())
    body = {"model": fit_model(3e-5, 0.03), "dataset_id": dataset["id"], "start": 0, "end": 1, "dt": 0.01, **change}
    response = team.client.post("/api/yorg/models/anchors", json=body, headers=chief)
    assert (response.status_code, response.json()["message"]) == (422, message)


def test_an_anchor_to_what_the_model_follows_says_so(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, pressurized_csv(), "Pressurized.csv")
    body = {"model": pressurized_model(), "dataset_id": dataset["id"], "start": 0, "end": 1}

    def refused(anchor: dict, solver: str = "transient") -> str:
        response = team.client.post(
            "/api/yorg/models/anchors", json={**body, "solver": solver, "anchors": [anchor]}, headers=chief
        )
        assert response.status_code == 422, response.text
        return response.json()["message"]

    assert (
        refused({"part": "cav", "key": "cda", "sensor": "chamber", "link": "pressure"})
        == "The model follows Chamber's pressure, so it can't anchor Venturi's throat CdA: pick a sensor"
    )
    # Steady, the tank holds what was measured, so neither its knobs nor its sensors can anchor.
    assert (
        refused({"part": "tank", "key": "collapse_factor", "sensor": "tank", "link": "pressure"}, "steady")
        == "Water tank's collapse factor doesn't matter in a steady run, where tanks hold their pressure"
    )
    assert (
        refused({"part": "press", "key": "cda", "sensor": "tank", "link": "pressure"}, "steady")
        == "In a steady run Water tank holds what was measured, so Water tank's pressure can't anchor Press valve's CdA when open"
    )
    # So does a gas junction a transducer reads, since a bottle draining has no steady state: its pressure and
    # temperature both.
    body["model"]["nodes"][1]["links"] = {"pressure": "PT-PRESS", "temperature": "TC-PRESS"}
    assert (
        refused({"part": "reg", "key": "cda", "sensor": "gj", "link": "temperature"}, "steady")
        == "In a steady run Press manifold holds what was measured, so Press manifold's temperature can't anchor "
        "Regulator's CdA fully open"
    )
    # Tubing has no wall to anchor; a vessel's wall doesn't matter in a steady run, where it holds what was measured.
    assert (
        refused({"part": "gj", "key": "heat_transfer", "sensor": "gj", "link": "temperature"})
        == "Press manifold's wall hA doesn't matter as it's set up"
    )
    body["model"]["nodes"][1]["settings"]["wall"] = "vessel"
    assert (
        refused({"part": "gj", "key": "heat_transfer", "sensor": "tank", "link": "pressure"}, "steady")
        == "Press manifold's wall hA doesn't matter in a steady run, where Press manifold holds what its transducer "
        "measured"
    )
    assert (
        refused({"part": "reg", "key": "cda", "sensor": "gj", "link": "pressure"}, "steady")
        == "In a steady run Press manifold holds what was measured, so Press manifold's pressure transducer can't "
        "anchor Regulator's CdA fully open"
    )


# --- a model's script -------------------------------------------------------------------------------------------


def script_of(team, who, body: dict) -> str:
    response = team.client.post("/api/yorg/models/script", json=body, headers=who)
    assert response.status_code == 200, response.text
    return response.json()["script"]


def data_of(team, who, body: dict) -> dict:
    """A run's data as its process gets it (the arrays in its folder's inputs), by part.link: its runner does nothing
    here."""
    runs = team.app.state.yorg_runs
    runs.runner = ["-c", "pass"]
    response = team.client.post("/api/yorg/models/runs", json=body, headers=who)
    assert response.status_code == 201, response.text
    inputs = runs.root / response.json()["id"] / "inputs"
    return {
        path.name.removesuffix(".t.f64"): tuple(
            np.fromfile(inputs / f"{path.name.removesuffix('.t.f64')}.{side}.f64", dtype="<f8") for side in ("t", "v")
        )
        for path in inputs.glob("*.t.f64")
    }


def test_an_anchored_runs_script_anchors_its_knobs(team):
    chief = team.member("chief@x.test", admin=True)
    body = {
        "model": fit_model(3e-5, 0.03),
        "start": 0.0,
        "end": 1.0,
        "anchors": [{"part": "inj", "key": "cda", "sensor": "inj", "link": "flow", "start": 0.5}],
    }
    text = script_of(team, chief, body)
    assert (
        "run.anchor(\n    injector_cda,\n    injector.mass_flow,\n    key='inj.flow',\n    start=0.5,\n    end=1.0,"
    ) in text
    # Its anchors are checked as an anchored run's are, and a knob that's not in the model as it runs says so.
    twice = {**body, "anchors": body["anchors"] * 2}
    response = team.client.post("/api/yorg/models/script", json=twice, headers=chief)
    assert (response.status_code, response.json()["message"]) == (422, "Injector's CdA is picked twice")
    model = pressurized_model()
    model["nodes"][1]["links"] = {"pressure": "PT-MANIFOLD"}
    unlinked = {  # the press valve has no command channel, so nothing moves it at its opening time
        "model": model,
        "start": 0.0,
        "end": 1.0,
        "anchors": [{"part": "press", "key": "opening_time", "sensor": "gj", "link": "pressure"}],
    }
    response = team.client.post("/api/yorg/models/script", json=unlinked, headers=chief)
    assert (response.status_code, response.json()["message"]) == (
        422,
        "Press valve's opening time doesn't change anything in this model, so it can't be anchored",
    )


def test_a_scripts_names_and_channels_are_only_ever_data(team):
    """What a model's parts are called, and the channels they're linked to, go into its script as strings and
    comments, never as code."""
    chief = team.member("chief@x.test", admin=True)
    sneaky = 'x"""\nimport os; os.system("echo pwned") # \u2028\\'
    model = cold_flow_model()
    model["nodes"][0]["name"] = sneaky
    model["edges"][2]["name"] = "class"  # a word of Python's: its variable is named around it
    linked = cold_flow_model()
    linked["nodes"][0]["links"] = {"pressure": "PT'\n__import__('os')#"}
    for each in (model, linked):
        text = script_of(team, chief, {"model": each, "start": 0.0, "end": 1.0})
        tree = ast.parse(text)
        imports = [ast.unparse(one) for one in ast.walk(tree) if isinstance(one, ast.Import | ast.ImportFrom)]
        assert imports == [
            "import math",
            "from fullflow import *",
            "from thermoprop import Fluid, IdealGas, Propellant",
            "from yorg_models import *",
        ]
        assert not {one.id for one in ast.walk(tree) if isinstance(one, ast.Name)} & {"os", "__import__", "pwned"}
    assert f"'tank': {sneaky!r}," in script_of(team, chief, {"model": model, "start": 0.0, "end": 1.0})


def test_a_runs_data_is_every_linked_channel_in_si_units(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, pressurized_csv(), "Pressurized.csv")
    model = pressurized_model()
    model["nodes"][3]["links"] = {"pressure": "PT-CHAMBER"}  # a sensor: compared with the model, never followed
    data = data_of(team, chief, {"model": model, "dataset_id": dataset["id"], "start": 0.5, "end": 1.0})
    assert sorted(data) == [
        "chamber.pressure",
        "j1.pressure",
        "mov.command",
        "tank.gas_temperature",
        "tank.pressure",
        "vent.command",
    ]
    times, values = data["tank.pressure"]
    assert times[0] == pytest.approx(0.49) and times[-1] == pytest.approx(1.01)  # a sample each side of the window
    assert values[0] == pytest.approx((250.0 - 5 * 0.49) * PSI + ATMOSPHERE)
    assert data["tank.gas_temperature"][1][0] == pytest.approx((50.0 - 0.49 - 32.0) * 5 / 9 + 273.15)
    assert list(data["mov.command"][1][:2]) == [1.0, 1.0]
