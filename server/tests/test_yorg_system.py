"""System models (Yorg's dev page): admins draw a feed system, and it runs with FullFlow against a test's data."""

import random

import pytest
from fullflow import FullFlowError

from yjsp_server.yorg.system.catalog import PSI
from yjsp_server.yorg.system.channels import Reading, to_si
from yjsp_server.yorg.system.network import _Builder
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
    assert wall["only_when"] == [["mode", "ullage"], ["ullage_model", "wall"]] and wall["tunable"]


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

    # A press line saved before gas valves had their name opens as a gas valve.
    older = cold_flow_model()
    older["nodes"].append(node("gn2", "source", "Bottle"))
    older["edges"].append(edge("press", "gas_line", "Press line", "gn2", "tank"))
    response = team.client.post("/api/yorg/dev/models", json={"name": "Older", "model": older}, headers=chief)
    assert response.status_code == 201, response.text
    assert response.json()["model"]["edges"][-1]["type"] == "gas_valve"

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
                m["nodes"].append(node("gn2", "source", "Bottle")),
                m["edges"].append(edge("reg", "regulator", "Regulator", "gn2", "out")),
            ),
            "Regulator holds the pressure where it flows to: connect it to a gas junction or a tank",
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


def test_a_run_that_doesnt_settle_says_where():
    """FullFlow lists the equations it couldn't meet, largest first, under names like tank:liquid:ullage_volume or
    inj.cda:anchor; the page names their parts, and not those whose equations it met."""
    checked = runnable(SystemModelIn.model_validate(cold_flow_model()))
    job = {"model": {"nodes": checked.nodes, "edges": checked.edges}, "liquid_of": checked.liquid_of, "dt": 0.01}
    built = _Builder({**job, "start": 10.0, "end": 12.0}, {}, lambda t: None)
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
                    "ullage_model": "wall",
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


def test_a_pressurized_system_starts_from_its_sensors_and_holds_its_pressure(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, pressurized_csv(), "Pressurized.csv")
    status = run(
        team, chief, {"model": pressurized_model(), "dataset_id": dataset["id"], "start": 0.0, "end": 2.0, "dt": 0.01}
    )
    assert status["state"] == "done", status
    result = status["result"]
    # It started where the tank's sensors say, not at its settings.
    started = {(one["part"], one["key"]): one for one in result["initial"]}
    assert started["tank", "pressure"]["channel"] == "PT-TANK"
    assert started["tank", "pressure"]["value"] == pytest.approx(250 * PSI + ATMOSPHERE, rel=1e-6)
    assert started["tank", "gas_temperature"]["value"] == pytest.approx(283.15, abs=0.01)
    assert at(result, "tank.pressure", 0.0) == pytest.approx(250 * PSI + ATMOSPHERE, rel=1e-3)
    # The press valve fills the tank from the manifold, which the regulator holds within its droop of its set point.
    for t in (0.2, 1.0, 1.9):
        manifold = at(result, "gj.pressure", t)
        assert 270 * PSI + ATMOSPHERE < manifold <= 300.5 * PSI + ATMOSPHERE, (t, manifold)
    assert at(result, "reg.mass_flow", 1.0) > 0 and 0 < at(result, "reg.position", 1.0) < 1
    assert at(result, "press.mass_flow", 1.0) > 0
    # Pressurized with warmer gas from the bottle before the main valve opens, the ullage warms; the wall (at 20 C)
    # trades heat with it, and moves a little for that (it's heavy).
    assert at(result, "tank.gas_temperature", 0.0) == pytest.approx(283.15, abs=0.01)
    assert at(result, "tank.gas_temperature", 0.25) > 283.15 + 0.5
    assert 1e-4 < abs(at(result, "tank.wall_temperature", 1.4) - 293.15) < 1.0
    # The venturi cavitates: its flow stays put while the chamber's pressure climbs from 40 to 70 psig.
    assert at(result, "cav.cavitating", 0.8) == 1.0 and at(result, "cav.cavitating", 1.4) == 1.0
    assert at(result, "chamber.pressure", 1.4) - at(result, "chamber.pressure", 0.8) == pytest.approx(
        30 * PSI, rel=0.02
    )
    assert at(result, "cav.mass_flow", 1.4) == pytest.approx(at(result, "cav.mass_flow", 0.8), rel=0.01)
    # The vent opens at 1.5 s: gas leaves the tank, and it loses pressure faster than the regulator makes up.
    assert at(result, "vent.mass_flow", 1.4) == pytest.approx(0.0, abs=1e-6)
    assert at(result, "vent.mass_flow", 1.9) > 0.005
    assert at(result, "tank.pressure", 1.9) < at(result, "tank.pressure", 1.45)


def test_a_liquid_follows_its_temperature_channel(team):
    chief = team.member("chief@x.test", admin=True)
    rows = ["Time (s),PT-TANK (psig),TC-FUEL (F)"]
    rows += [f"{i / 100:.2f},300.0,{40 + 70 * i / 100:.2f}" for i in range(201)]  # 40 °F to 180 °F
    dataset = upload(team, chief, "\n".join(rows) + "\n", "Warming.csv")
    model = cold_flow_model()
    model["nodes"][0]["links"]["temperature"] = "TC-FUEL"
    model["edges"][1]["links"] = {}  # the main valve stays open
    status = run(team, chief, {"model": model, "dataset_id": dataset["id"], "start": 0.0, "end": 2.0, "dt": 0.05})
    assert status["state"] == "done", status
    liquid = status["result"]["liquids"]["tank"]
    assert liquid["follows"] == "TC-FUEL"
    assert liquid["temperatures"] == pytest.approx([277.59, 355.37], abs=0.01)
    assert liquid["densities"][1] - liquid["densities"][0] > 20  # water at 180 °F is 2.7% lighter
    # The injector passes less as the water lightens: CdA sqrt(2 rho dP).
    result = status["result"]
    assert at(result, "inj.mass_flow", 1.95) < 0.995 * at(result, "inj.mass_flow", 0.5)


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


def test_a_fit_finds_the_knobs_that_made_the_data(team):
    chief = team.member("chief@x.test", admin=True)
    # What the "test" measured: the model itself, with an injector CdA of 3e-5 m² and a line friction factor of 0.03.
    blank = upload(team, chief, "Time (s),X\n0,0\n1,0\n", "Blank.csv")
    truth = run(
        team, chief, {"model": fit_model(3e-5, 0.03), "dataset_id": blank["id"], "start": 0.0, "end": 1.0, "dt": 0.05}
    )
    assert truth["state"] == "done", truth
    rows = ["Time (s),PT-MANIFOLD (psia),FM-01 (kg/s)"]
    for t, pressure, flow in zip(
        truth["result"]["times"],
        truth["result"]["series"]["j1.pressure"],
        truth["result"]["series"]["inj.mass_flow"],
        strict=True,
    ):
        rows.append(f"{t:.4f},{pressure / PSI:.6f},{flow:.8f}")
    measured = upload(team, chief, "\n".join(rows) + "\n", "Measured.csv")

    # Fit from knobs well off: the injector's CdA and the line's friction factor.
    body = {
        "model": fit_model(2e-5, 0.015),
        "dataset_id": measured["id"],
        "start": 0.0,
        "end": 1.0,
        "dt": 0.05,
        "knobs": [{"part": "inj", "key": "cda"}, {"part": "line", "key": "friction_factor"}],
    }
    response = team.client.post("/api/yorg/dev/fits", json=body, headers=chief)
    assert response.status_code == 201, response.text
    fit_id = response.json()["id"]
    team.app.state.yorg_runs.wait(fit_id, timeout=600)
    status = team.client.get(f"/api/yorg/dev/runs/{fit_id}", headers=chief).json()
    assert status["state"] == "done", status
    found = {(knob["part"], knob["key"]): knob for knob in status["result"]["fit"]["knobs"]}
    assert found["inj", "cda"]["start"] == 2e-5
    assert found["inj", "cda"]["value"] == pytest.approx(3e-5, rel=0.02)
    assert found["line", "friction_factor"]["value"] == pytest.approx(0.03, rel=0.05)
    fitted = status["result"]["fit"]
    assert fitted["cost"] < 1e-3 * fitted["cost_start"]
    assert {one["output"] for one in fitted["compared"]} == {"j1.pressure", "inj.mass_flow"}
    assert status["progress"]["tries"] == fitted["tries"] > 3
    # The fit's result is the best run: plotted like any other.
    assert at(status["result"], "inj.mass_flow", 0.5) == pytest.approx(
        at(truth["result"], "inj.mass_flow", 0.5), rel=0.01
    )


@pytest.mark.parametrize(
    ("knobs", "message"),
    [
        ([{"part": "tank", "key": "fluid"}], "Water tank has no knob fluid to fit"),
        (
            [{"part": "tank", "key": "polytropic_exponent"}],
            "Water tank's ullage exponent n doesn't matter as it's set up",
        ),
        ([{"part": "inj", "key": "cda"}, {"part": "inj", "key": "cda"}], "Injector's CdA is picked twice"),
        ([{"part": "nope", "key": "cda"}], "There's no part nope to fit"),
    ],
)
def test_a_fit_says_what_it_cant_do(team, knobs, message):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, cold_flow_csv())
    body = {"model": cold_flow_model(), "dataset_id": dataset["id"], "start": 0, "end": 1, "knobs": knobs}
    response = team.client.post("/api/yorg/dev/fits", json=body, headers=chief)
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
    response = team.client.post("/api/yorg/dev/fits", json=body, headers=chief)
    assert (response.status_code, response.json()["message"]) == (
        422,
        "Link a sensor to fit the model to: a pressure transducer, a flow meter, a tank's pressure",
    )


def anchored_run(team, who, body: dict) -> dict:
    response = team.client.post("/api/yorg/dev/anchors", json=body, headers=who)
    assert response.status_code == 201, response.text
    run_id = response.json()["id"]
    team.app.state.yorg_runs.wait(run_id, timeout=300)
    status = team.client.get(f"/api/yorg/dev/runs/{run_id}", headers=who).json()
    assert status["state"] in ("done", "failed"), status
    return status


def measured_csv(result: dict, columns: dict[str, str], extra=None, noise: float = 0.0) -> str:
    """A test's data made from a run: each column (its name and unit) from an output (pressures in psia), with noise
    (a share of the column's largest value, the same every time), and any extra columns from extra(t)."""
    names = list(columns) + list(extra(0.0) if extra else {})
    scales = {name: (PSI if "psia" in name else 1.0) for name in columns}
    largest = {name: max(abs(value) for value in result["series"][output]) for name, output in columns.items()}
    jitter = random.Random(7)
    rows = ["Time (s)," + ",".join(names)]
    for index, t in enumerate(result["times"]):
        values = [
            (result["series"][output][index] + jitter.gauss(0.0, noise * largest[name])) / scales[name]
            for name, output in columns.items()
        ]
        values += list(extra(t).values()) if extra else []
        rows.append(f"{t:.4f}," + ",".join(f"{value:.8g}" for value in values))
    return "\n".join(rows) + "\n"


@pytest.mark.parametrize("solver", ["transient", "steady"])
def test_anchors_find_the_knobs_that_made_the_data_in_one_run(team, solver):
    chief = team.member("chief@x.test", admin=True)
    # What the "test" measured: the model itself, with an injector CdA of 3e-5 m² and a line friction factor of 0.03.
    blank = upload(team, chief, "Time (s),X\n0,0\n1,0\n", "Blank.csv")
    truth = run(
        team, chief, {"model": fit_model(3e-5, 0.03), "dataset_id": blank["id"], "start": 0.0, "end": 1.0, "dt": 0.01}
    )
    assert truth["state"] == "done", truth
    columns = {"PT-MANIFOLD (psia)": "j1.pressure", "FM-01 (kg/s)": "inj.mass_flow"}
    measured = upload(team, chief, measured_csv(truth["result"], columns), "Measured.csv")

    # From knobs well off, each anchored to a sensor from 0.2 s (after the line's flow has come up to speed, which a
    # steady run doesn't model).
    body = {
        "model": fit_model(2e-5, 0.015),
        "dataset_id": measured["id"],
        "start": 0.0,
        "end": 1.0,
        "dt": 0.01,
        "solver": solver,
        "anchors": [
            {"part": "inj", "key": "cda", "sensor": "inj", "link": "flow", "start": 0.2},
            {"part": "line", "key": "friction_factor", "sensor": "j1", "link": "pressure", "start": 0.2},
        ],
    }
    status = anchored_run(team, chief, body)
    assert status["state"] == "done", status
    result = status["result"]
    found = {(one["part"], one["key"]): one for one in result["anchors"]}
    assert found["inj", "cda"]["start"] == 2e-5
    assert found["inj", "cda"]["value"] == pytest.approx(3e-5, rel=1e-3)
    assert found["line", "friction_factor"]["value"] == pytest.approx(0.03, rel=1e-2)
    assert found["inj", "cda"]["low"] <= found["inj", "cda"]["value"] <= found["inj", "cda"]["high"]
    # Each knob's history: its setting until its span, then what the data asked for.
    assert at({"times": result["times"], "series": result["anchored"]}, "inj.cda", 0.1) == 2e-5
    assert at({"times": result["times"], "series": result["anchored"]}, "inj.cda", 0.6) == pytest.approx(3e-5, rel=1e-3)
    # And the model reads what was measured.
    assert at(result, "inj.mass_flow", 0.6) == pytest.approx(at(truth["result"], "inj.mass_flow", 0.6), rel=1e-4)
    assert at(result, "j1.pressure", 0.6) == pytest.approx(at(truth["result"], "j1.pressure", 0.6), rel=1e-4)


def test_an_anchor_is_on_while_its_knob_counts_and_holds_after(team):
    chief = team.member("chief@x.test", admin=True)
    command = lambda t: {"MOV-01": int(0.5 <= t < 1.5)}  # noqa: E731
    rows = "\n".join(f"{i / 100:.2f},{command(i / 100)['MOV-01']}" for i in range(201))
    commands = upload(team, chief, "Time (s),MOV-01\n" + rows + "\n", "Commands.csv")
    model = cold_flow_model()
    model["nodes"][0]["links"] = {}  # the tank at its 300 psig
    model["nodes"][2]["links"] = {"pressure": "PT-MANIFOLD"}
    model["edges"][2]["links"] = {"flow": "FM-01"}
    truth = run(team, chief, {"model": model, "dataset_id": commands["id"], "start": 0.0, "end": 2.0, "dt": 0.01})
    assert truth["state"] == "done", truth
    columns = {"PT-MANIFOLD (psia)": "j2.pressure", "FM-01 (kg/s)": "inj.mass_flow"}
    measured = upload(team, chief, measured_csv(truth["result"], columns, command, noise=0.002), "Measured.csv")
    model["edges"][1]["settings"]["cda"] = 3e-5  # the main valve's, from 5e-5
    model["edges"][2]["settings"]["cda"] = 2e-5  # the injector's, from 3e-5
    body = {"model": model, "dataset_id": measured["id"], "start": 0.0, "end": 2.0, "dt": 0.01}
    anchors = [
        {"part": "mov", "key": "cda", "sensor": "j2", "link": "pressure"},
        {"part": "inj", "key": "cda", "sensor": "inj", "link": "flow"},
    ]

    # While the valve is shut, nothing flows whatever the CdAs, so no CdA matches the flow meter's noise: FullFlow
    # holds them there, and what they're found to be comes from where it could anchor them.
    whole = anchored_run(team, chief, {**body, "anchors": anchors})
    assert whole["state"] == "done", whole
    found = {(one["part"], one["key"]): one for one in whole["result"]["anchors"]}
    assert found["mov", "cda"]["value"] == pytest.approx(5e-5, rel=0.02)
    assert found["inj", "cda"]["value"] == pytest.approx(3e-5, rel=0.02)
    held = [note for note in whole["result"]["notes"] if note.startswith("FullFlow anchored")]
    assert len(held) == 2
    assert held[1].startswith("FullFlow anchored Injector's CdA to Injector's flow meter for 5")

    # Anchored while it's open, they're anchored throughout, and then hold. In a transient run, from when it opens,
    # where the model's flow starts at nothing as the test's did: from later, the CdAs set off would have the model's
    # flow jump to the test's, which the feed line's inertia doesn't allow. In a steady run (no inertia), from any time.
    for solver, start in (("transient", 0.5), ("steady", 0.7)):
        while_open = [{**anchor, "start": start, "end": 1.4} for anchor in anchors]
        status = anchored_run(team, chief, {**body, "solver": solver, "anchors": while_open})
        assert status["state"] == "done", status
        assert status["result"]["notes"] == [], solver
        found = {(one["part"], one["key"]): one for one in status["result"]["anchors"]}
        assert found["mov", "cda"]["value"] == pytest.approx(5e-5, rel=0.02), solver
        assert found["inj", "cda"]["value"] == pytest.approx(3e-5, rel=0.02), solver
        # The noise moves them from step to step.
        assert found["inj", "cda"]["low"] < found["inj", "cda"]["value"] < found["inj", "cda"]["high"]
        history = {"times": status["result"]["times"], "series": status["result"]["anchored"]}
        assert at(history, "inj.cda", 0.3) == 2e-5
        assert at(history, "inj.cda", 1.9) == pytest.approx(at(history, "inj.cda", 1.4))


def test_an_anchor_finds_a_tanks_collapse_factor_through_its_pressure(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, pressurized_csv(), "Pressurized.csv")
    model = pressurized_model()
    tank = model["nodes"][2]["settings"]
    tank["collapse_factor"] = 1.5
    body = {"model": model, "dataset_id": dataset["id"], "start": 0.0, "end": 1.4, "dt": 0.01}
    truth = run(team, chief, body)
    assert truth["state"] == "done", truth

    def others(t: float) -> dict:
        return {
            "MOV-01": int(t >= 0.3),
            "VENT-01": int(t >= 1.5),
            "TC-ULLAGE (F)": 50.0 - t,
            "PT-CHAMBER (psig)": 50.0 * t,
        }

    csv = measured_csv(truth["result"], {"PT-TANK (psia)": "tank.pressure"}, others)
    measured = upload(team, chief, csv, "Measured.csv")
    tank["collapse_factor"] = 1.0
    # The collapse factor moves the tank's pressure only through how fast pressurant fills it: anchored to the
    # pressure, it's the pressure's slope that decides it, across the main valve opening at 0.3 s (where FullFlow
    # takes a sliver of a step) and with the regulator starting shut, at its set pressure.
    anchor = {"part": "tank", "key": "collapse_factor", "sensor": "tank", "link": "pressure"}
    status = anchored_run(team, chief, {**body, "dataset_id": measured["id"], "anchors": [anchor]})
    assert status["state"] == "done", status
    found = status["result"]["anchors"][0]
    assert found["value"] == pytest.approx(1.5, rel=1e-3)
    assert 1.45 < found["low"] <= found["high"] < 1.55
    assert status["result"]["notes"] == []


def test_an_anchor_past_its_limits_says_so(team):
    chief = team.member("chief@x.test", admin=True)
    # Made with fittings' K of 2000 in the line, which a friction factor (at most 1) can't make up for.
    blank = upload(team, chief, "Time (s),X\n0,0\n1,0\n", "Blank.csv")
    lossy = fit_model(3e-5, 0.03)
    lossy["edges"][0]["settings"]["loss_coefficient"] = 2000.0
    truth = run(team, chief, {"model": lossy, "dataset_id": blank["id"], "start": 0.0, "end": 1.0, "dt": 0.01})
    assert truth["state"] == "done", truth
    columns = {"PT-MANIFOLD (psia)": "j1.pressure", "FM-01 (kg/s)": "inj.mass_flow"}
    measured = upload(team, chief, measured_csv(truth["result"], columns), "Lossy.csv")
    anchor = {"part": "line", "key": "friction_factor", "sensor": "j1", "link": "pressure"}
    body = {"model": fit_model(3e-5, 0.03), "dataset_id": measured["id"], "start": 0.0, "end": 1.0, "dt": 0.01}
    status = anchored_run(team, chief, {**body, "anchors": [anchor]})
    assert status["state"] == "done", status
    # What it took: f + K D / L, with K D / L = 2000 * 0.0095 / 3.
    assert status["result"]["anchors"][0]["value"] == pytest.approx(0.03 + 2000 * 0.0095 / 3, rel=1e-3)
    assert status["result"]["notes"] == [
        "Feed line's friction factor f went past its limits to match Manifold's pressure transducer: no value it can "
        "really have does. If that channel is noisy, a longer time step averages more of it (a knob that acts through "
        "what a tank holds asks for its slope); if not, something else in the model is off."
    ]


def test_a_steady_run_holds_its_tanks_pressure(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, pressurized_csv(), "Pressurized.csv")
    body = {"model": pressurized_model(), "dataset_id": dataset["id"], "start": 0.0, "end": 2.0, "dt": 0.05}
    status = run(team, chief, {**body, "solver": "steady"})
    assert status["state"] == "done", status
    result = status["result"]
    # The tank follows its pressure channel instead of draining, and pressurant flows in, which settles at once.
    for t in (0.0, 1.0, 1.9):
        assert at(result, "tank.pressure", t) == pytest.approx((250 - 5 * t) * PSI + ATMOSPHERE, rel=1e-3)
    assert at(result, "cav.mass_flow", 1.0) > 0
    assert at(result, "reg.mass_flow", 1.0) == pytest.approx(at(result, "press.mass_flow", 1.0), rel=1e-3)
    assert "tank.liquid_volume" not in result["series"]


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
    ],
)
def test_an_anchor_says_what_it_cant_do(team, change, message):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, cold_flow_csv())
    body = {"model": fit_model(3e-5, 0.03), "dataset_id": dataset["id"], "start": 0, "end": 1, "dt": 0.01, **change}
    response = team.client.post("/api/yorg/dev/anchors", json=body, headers=chief)
    assert (response.status_code, response.json()["message"]) == (422, message)


def test_an_anchor_to_what_the_model_follows_says_so(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, pressurized_csv(), "Pressurized.csv")
    body = {"model": pressurized_model(), "dataset_id": dataset["id"], "start": 0, "end": 1}

    def refused(anchor: dict, solver: str = "transient") -> str:
        response = team.client.post(
            "/api/yorg/dev/anchors", json={**body, "solver": solver, "anchors": [anchor]}, headers=chief
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
