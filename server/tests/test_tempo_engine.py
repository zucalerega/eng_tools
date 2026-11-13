"""Integration tests for Tempo's vendored Sequence Tester / Luna engine."""

import json
import sys
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parents[2] / "web" / "src" / "tempo" / "engine"


def _load_engine():
    if str(ENGINE_DIR) not in sys.path:
        sys.path.insert(0, str(ENGINE_DIR))
    import engine  # type: ignore[import-not-found]

    return engine


def test_vespula_prepress_runs_unchanged():
    engine = _load_engine()
    source = (
        "# tank pre press sequence\n"
        "import time\n"
        "print('Pre Press Sequence has begun')\n"
        "ftpt_target = 416*psi\n"
        "otpt_target = 357*psi\n"
        "upRan = 2*psi\n"
        "lowRan = 3*psi\n"
        "press_time = 2\n"
        "wait_timing = 5\n"
        "FSWV.close()\n"
        "OSWV.close()\n"
        "wait_for(wait_timing*ms)\n"
        "FBB.close()\n"
        "FBBopen = False\n"
        "OBB.close()\n"
        "OBBopen = False\n"
        "start_time = time.time()\n"
        "while time.time() < start_time + press_time:\n"
        "\tcurrFTPT = FTPT.read()\n"
        "\tcurrOTPT = OTPT.read()\n"
        "\tif FBBopen and currFTPT > ftpt_target + upRan:\n"
        "\t\tFBB.close()\n"
        "\t\tFBBopen = False\n"
        "\telif (not FBBopen) and currFTPT < ftpt_target - lowRan:\n"
        "\t\tFBB.open()\n"
        "\t\tFBBopen = True\n"
        "\tif OBBopen and currOTPT > otpt_target + upRan:\n"
        "\t\tOBB.close()\n"
        "\t\tOBBopen = False\n"
        "\telif (not OBBopen) and currOTPT < otpt_target - lowRan:\n"
        "\t\tOBB.open()\n"
        "\t\tOBBopen = True\n"
        "\twait_for(wait_timing*ms)\n"
        "OBB.close()\n"
        "FBB.close()\n"
        "print('Pre Press Sequence has ended')\n"
    )
    mapping = json.dumps(
        {
            "valves": ["FSWV", "OSWV", "FBB", "OBB"],
            "sensors": [
                {
                    "name": "FTPT",
                    "unit": "psi",
                    "mode": "valve",
                    "initial": 400,
                    "valves": ["FBB"],
                    "rates": {"0": -2, "1": 30},
                    "min": 0,
                    "max": 500,
                },
                {
                    "name": "OTPT",
                    "unit": "psi",
                    "mode": "valve",
                    "initial": 330,
                    "valves": ["OBB"],
                    "rates": {"0": -2, "1": 30},
                    "min": 0,
                    "max": 500,
                },
            ],
        }
    )
    res = engine.run_sequence(source, mapping, True, {"speed": 5, "max_duration": 30})
    assert res["checks"]["syntax"] == "pass"
    assert res["checks"]["api"] in ("pass", "partial")
    assert res["checks"]["runtime"] == "pass"
    assert "Pre Press Sequence has ended" in res["stdout"]


def test_invalid_luna_api_and_portability_rejected():
    engine = _load_engine()
    mapping = json.dumps(
        {
            "valves": [{"name": "press_valve", "initial": "CLOSED"}],
            "sensors": [{"name": "tank_pt", "unit": "psi", "samples": [{"at": 0, "value": 100}]}],
        }
    )
    # Invalid method on sensor
    bad_sensor = engine.run_sequence("tank_pt.open()\n", mapping, True)
    assert bad_sensor["checks"]["api"] == "fail"

    # Unbounded wait_until without finite timeout
    unbounded = engine.run_sequence("wait_until(lambda: tank_pt.read() >= 300*psi)\n", mapping, True)
    assert unbounded["checks"]["api"] == "fail"


def test_sensor_comparisons_and_units():
    engine = _load_engine()
    mapping = json.dumps(
        {
            "valves": [{"name": "press_valve", "initial": "CLOSED"}],
            "sensors": [{"name": "tank_pt", "unit": "psi", "samples": [{"at": 0, "value": 300}]}],
        }
    )
    source = (
        "assert tank_pt.read() >= 300 * psi\n"
        "assert 300 * psi <= tank_pt.read()\n"
        "assert 1000 * ms == 1 * s\n"
        "assert 1000 * mV == 1 * V\n"
    )
    res = engine.run_sequence(source, mapping, True)
    assert res["checks"]["runtime"] == "pass"


def test_abort_stage_and_safing_timeline():
    engine = _load_engine()
    mapping = json.dumps(
        {
            "valves": [{"name": "press_valve", "initial": "CLOSED"}, {"name": "vent_valve", "initial": "CLOSED"}],
            "sensors": [
                {
                    "name": "tank_pt",
                    "unit": "psi",
                    "mode": "valve",
                    "initial": 0,
                    "valves": ["press_valve", "vent_valve"],
                    "rates": {"00": 0, "01": -60, "10": 100, "11": 40},
                    "min": 0,
                    "max": 500,
                }
            ],
        }
    )
    source = (
        'create_abort_stage("PRESSURIZATION", "tank_pt.read() > 250*psi", '
        "{press_valve: (CLOSED, 500), vent_valve: (OPEN, 1000)})\n"
        'set_abort_stage("PRESSURIZATION")\n'
        "press_valve.open()\n"
        "wait_for(5*s)\n"
    )
    res = engine.run_sequence(source, mapping, True, {"speed": 5, "max_duration": 30})
    assert res["checks"]["runtime"] == "pass"
    assert res["simulation"]["aborted"] is True
    assert any(ev["kind"] == "abort" for ev in res["events"])
    assert res["valves"]["press_valve"] == "CLOSED"
    assert res["valves"]["vent_valve"] == "OPEN"


def test_dynamic_code_marked_warning_not_pass():
    engine = _load_engine()
    mapping = json.dumps({"valves": ["press_valve"], "sensors": []})
    source = "def helper():\n    return press_valve\nhelper().open()\n"
    res = engine.run_sequence(source, mapping, False)
    assert res["checks"]["api"] != "pass"
    assert res["checks"]["api"] in ("partial", "warn", "fail")
