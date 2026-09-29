"""System models (Yorg's dev page): admins draw a feed system, and it runs with FullFlow against a test's data."""

import pytest

from cvc_server.yorg.system.catalog import PSI
from cvc_server.yorg.system.channels import Reading, to_si

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


def run(team, who, body: dict) -> dict:
    response = team.client.post("/api/yorg/dev/runs", json=body, headers=who)
    assert response.status_code == 201, response.text
    run_id = response.json()["id"]
    team.app.state.yorg_runs.wait(run_id, timeout=300)
    status = team.client.get(f"/api/yorg/dev/runs/{run_id}", headers=who).json()
    assert status["state"] in ("done", "failed"), status
    return status


def at(result: dict, output: str, t: float) -> float:
    """An output's value at the result time nearest t."""
    index = min(range(len(result["times"])), key=lambda i: abs(result["times"][i] - t))
    return result["series"][output][index]


def test_the_dev_page_is_for_admins(team):
    chief = team.member("chief@x.test", admin=True)
    bob = team.member("bob@x.test")
    for path in ("/api/yorg/dev/catalog", "/api/yorg/dev/models"):
        assert team.client.get(path, headers=bob).status_code == 403
        assert team.client.get(path, headers=chief).status_code == 200
    catalog = team.client.get("/api/yorg/dev/catalog", headers=chief).json()
    assert {part["type"] for part in catalog["parts"]} >= {
        "tank",
        "junction",
        "outlet",
        "source",
        "line",
        "valve",
        "orifice",
        "gas_line",
    }
    assert "Water" in catalog["liquids"] and "Helium" in catalog["gases"]


def test_models_are_saved_changed_and_deleted(team):
    chief = team.member("chief@x.test", admin=True)
    created = team.client.post(
        "/api/yorg/dev/models", json={"name": "Cold flow", "model": cold_flow_model()}, headers=chief
    )
    assert created.status_code == 201, created.text
    saved = created.json()
    assert (saved["name"], saved["created_by"]) == ("Cold flow", "Chief")
    assert [m["name"] for m in team.client.get("/api/yorg/dev/models", headers=chief).json()] == ["Cold flow"]

    changed = cold_flow_model()
    changed["edges"][2]["settings"]["cda"] = 4e-5
    response = team.client.put(
        f"/api/yorg/dev/models/{saved['id']}", json={"name": "Cold flow 2", "model": changed}, headers=chief
    )
    assert response.status_code == 200, response.text
    again = team.client.get(f"/api/yorg/dev/models/{saved['id']}", headers=chief).json()
    assert (again["name"], again["model"]["edges"][2]["settings"]["cda"]) == ("Cold flow 2", 4e-5)

    # A half-drawn model saves; one whose edge ends nowhere doesn't.
    loose = {"nodes": [node("j", "junction", "Loose end")], "edges": [edge("l", "line", "Line", "j", "nowhere")]}
    response = team.client.post("/api/yorg/dev/models", json={"name": "Broken", "model": loose}, headers=chief)
    assert (response.status_code, response.json()["message"]) == (422, "Line isn't connected at both ends")

    assert team.client.delete(f"/api/yorg/dev/models/{saved['id']}", headers=chief).status_code == 204
    assert team.client.get(f"/api/yorg/dev/models/{saved['id']}", headers=chief).status_code == 404


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (
            lambda m: m["nodes"].append(node("j9", "junction", "Stray tee")),
            "Stray tee isn't connected to a tank, so nothing says what liquid is there",
        ),
        (
            lambda m: (
                m["nodes"].append(node("gn2", "source", "Regulator")),
                m["edges"].append(edge("press", "gas_line", "Press line", "gn2", "tank")),
            ),
            "Press line carries pressurant into a tank's ullage: set Water tank's pressure to ullage",
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
        "/api/yorg/dev/runs", json={"model": model, "dataset_id": dataset["id"], "start": 0, "end": 2}, headers=chief
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


def test_a_cold_flow_follows_its_valve_and_tank(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, cold_flow_csv())
    status = run(
        team, chief, {"model": cold_flow_model(), "dataset_id": dataset["id"], "start": 0.0, "end": 2.0, "dt": 0.01}
    )
    assert status["state"] == "done", status
    result = status["result"]
    assert result["times"][0] == pytest.approx(0.0) and result["times"][-1] == pytest.approx(2.0)
    assert result["liquids"]["tank"]["density"] == pytest.approx(998, abs=3)
    # Closed: the tank's pressure up to the valve, the atmosphere after it, and nothing flows.
    assert at(result, "j1.pressure", 0.4) == pytest.approx(300 * PSI + ATMOSPHERE, rel=1e-3)
    assert at(result, "j2.pressure", 0.4) == pytest.approx(ATMOSPHERE, rel=1e-3)
    assert abs(at(result, "inj.mass_flow", 0.4)) < 1e-3
    # Open: flow through all three, each part taking its share of the drop, and the same flow in each.
    flow = at(result, "inj.mass_flow", 1.3)
    assert 1.0 < flow < 2.0
    assert at(result, "line.mass_flow", 1.3) == pytest.approx(flow, rel=1e-3)
    assert at(result, "mov.position", 1.3) == pytest.approx(1.0)
    manifold = at(result, "j2.pressure", 1.3)
    assert ATMOSPHERE < manifold < at(result, "j1.pressure", 1.3) < 300 * PSI + ATMOSPHERE
    # The injector's flow is what its CdA passes at the manifold's pressure.
    assert flow == pytest.approx(3e-5 * (2 * 998 * (manifold - ATMOSPHERE)) ** 0.5, rel=0.01)
    # Closed again.
    assert abs(at(result, "inj.mass_flow", 1.95)) < 1e-2
    assert at(result, "mov.position", 1.95) == pytest.approx(0.0)


def test_an_ullage_tank_blows_down_and_its_knobs_turn(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, cold_flow_csv())
    model = cold_flow_model()
    model["nodes"][0] = node(
        "tank",
        "tank",
        "Water tank",
        {"fluid": "Water", "mode": "ullage", "pressure": 300 * PSI, "volume": 0.004, "liquid_volume": 0.003},
    )
    model["nodes"].append(node("gn2", "source", "Regulator", {"gas": "Nitrogen", "pressure": 300 * PSI}))
    model["edges"].append(edge("press", "gas_line", "Press line", "gn2", "tank", {"cda": 2e-6}))

    def tank_at_end(**tank) -> tuple[float, dict]:
        model["nodes"][0]["settings"].update(tank)
        status = run(team, chief, {"model": model, "dataset_id": dataset["id"], "start": 0.0, "end": 1.5, "dt": 0.02})
        assert status["state"] == "done", status
        return at(status["result"], "tank.pressure", 1.45), status["result"]

    isothermal, result = tank_at_end(polytropic_exponent=1.0, collapse_factor=1.0)
    # Draining lowers it, from 300 psia; the press line adds back less than leaves.
    assert at(result, "tank.pressure", 0.45) == pytest.approx(300 * PSI, rel=0.01)
    assert isothermal < 0.95 * 300 * PSI
    assert at(result, "tank.liquid_volume", 1.45) < 0.003
    assert at(result, "press.mass_flow", 1.45) > 0
    # Less heat reaching the gas (a higher n) and more pressurant lost (a higher collapse factor) both leave less.
    adiabatic, _ = tank_at_end(polytropic_exponent=1.4, collapse_factor=1.0)
    collapsing, _ = tank_at_end(polytropic_exponent=1.0, collapse_factor=3.0)
    assert adiabatic < isothermal and collapsing < isothermal


def test_a_run_that_fails_says_why(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, cold_flow_csv())
    model = cold_flow_model()
    model["nodes"][0]["settings"]["temperature"] = 200.0  # frozen water
    status = run(team, chief, {"model": model, "dataset_id": dataset["id"], "start": 0.0, "end": 1.0})
    assert status["state"] == "failed"
    assert status["message"].startswith("Water tank: ThermoProp can't give Water's properties at 200.0 K")
