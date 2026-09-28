"""Yorg: a file of test data becomes channels on one time base; datasets and views belong to the team."""

import math
import struct
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from cvc_server.app import create_app
from cvc_server.models import UserStatus
from cvc_server.yorg import ingest
from cvc_server.yorg.models import Dataset


def upload(team, who, text: str | bytes, filename: str = "run.csv", **params) -> dict:
    data = text.encode() if isinstance(text, str) else text
    response = team.client.post(
        "/api/yorg/datasets", params={"filename": filename, **params}, content=data, headers=who
    )
    assert response.status_code == 201, response.text
    return response.json()


def channel(dataset: dict, name: str) -> dict:
    return next(c for c in dataset["channels"] if c["name"] == name)


def fetch(team, who, dataset: dict, file: str) -> list[float | None]:
    """An array of the dataset's latest read (None for NaN)."""
    url = f"/api/yorg/datasets/{dataset['id']}/data/{dataset['data_version']}/{file}"
    response = team.client.get(url, headers=who)
    assert response.status_code == 200, response.text
    assert "immutable" in response.headers["cache-control"]
    values = struct.unpack(f"<{len(response.content) // 8}d", response.content)
    return [None if math.isnan(value) else value for value in values]


def samples(team, who, dataset: dict, name: str) -> list[tuple[float, float | None]]:
    found = channel(dataset, name)
    return list(zip(fetch(team, who, dataset, found["time"]), fetch(team, who, dataset, found["values"]), strict=True))


# --- reading files ------------------------------------------------------------------------------------------------


def test_a_csv_becomes_channels_on_one_time_base(team):
    chief = team.member("chief@x.test", admin=True)
    csv = "Time (s),PT-OX-01 [psi],TC-02 (degC),LC-01\n0.000,14.7,21.5,0\n0.001,15.25,21.5,12\n0.002,16.125,21.6,30\n"
    dataset = upload(team, chief, csv, filename="Hotfire 3.csv")

    assert (dataset["status"], dataset["name"], dataset["filename"]) == ("ready", "Hotfire 3", "Hotfire 3.csv")
    assert (dataset["rows"], dataset["channel_count"], dataset["size"]) == (3, 3, len(csv))
    assert (dataset["time_kind"], dataset["start_epoch"]) == ("relative", None)
    assert (dataset["t_min"], dataset["t_max"]) == (0.0, 0.002)
    assert dataset["sample_rate"] == pytest.approx(1000)
    assert [(c["name"], c["unit"], c["column"]) for c in dataset["channels"]] == [
        ("PT-OX-01", "psi", 2),
        ("TC-02", "degC", 3),
        ("LC-01", "", 4),
    ]
    pt = channel(dataset, "PT-OX-01")
    assert (pt["kind"], pt["decimals"], pt["count"], pt["min"], pt["max"]) == ("number", 3, 3, 14.7, 16.125)
    assert pt["mean"] == pytest.approx((14.7 + 15.25 + 16.125) / 3)
    assert (pt["t_min"], pt["t_max"], pt["time"]) == (0.0, 0.002, "time.f64")
    assert samples(team, chief, dataset, "PT-OX-01") == [(0.0, 14.7), (0.001, 15.25), (0.002, 16.125)]
    assert samples(team, chief, dataset, "LC-01") == [(0.0, 0.0), (0.001, 12.0), (0.002, 30.0)]
    assert dataset["read_info"]["time_column"] == "Time"
    assert dataset["read_info"]["time_format"] == "seconds"
    assert (dataset["read_info"]["delimiter"], dataset["read_info"]["header_row"]) == ("comma", 1)
    assert dataset["warnings"] == [] and dataset["events"] == []
    assert dataset["created_by"]["email"] == "chief@x.test"

    # The file as it was uploaded.
    source = team.client.get(f"/api/yorg/datasets/{dataset['id']}/source", headers=chief)
    assert source.content == csv.encode()
    assert source.headers["content-disposition"] == "attachment; filename*=utf-8''Hotfire%203.csv"


def test_notes_above_the_names_and_a_row_of_units_under_them(team):
    chief = team.member("chief@x.test", admin=True)
    csv = "Test: Hotfire 3\nOperator: Sam\n\nTime,PT-1,TC-1\ns,psi,K\n0,1,300\n0.5,2,301\n"
    dataset = upload(team, chief, csv)
    assert [(c["name"], c["unit"]) for c in dataset["channels"]] == [("PT-1", "psi"), ("TC-1", "K")]
    info = dataset["read_info"]
    assert (info["header_row"], info["units_row"], info["first_data_row"]) == (4, 5, 6)
    assert samples(team, chief, dataset, "TC-1") == [(0.0, 300.0), (0.5, 301.0)]


def test_labview_measurement_files(team):
    chief = team.member("chief@x.test", admin=True)
    lvm = (
        "LabVIEW Measurement\t\nWriter_Version\t2\n***End_of_Header***\t\n\n"
        "Channels\t2\t\nSamples\t3\t3\n***End_of_Header***\t\t\n"
        "X_Value\tPT1\tPT2\tComment\n0.000\t1\t2\n0.001\t3\t4\n0.002\t5\t6\n"
    )
    dataset = upload(team, chief, lvm, filename="test.lvm")
    assert [c["name"] for c in dataset["channels"]] == ["PT1", "PT2"]
    assert dataset["read_info"]["time_column"] == "X_Value"
    assert samples(team, chief, dataset, "PT2") == [(0.0, 2.0), (0.001, 4.0), (0.002, 6.0)]
    assert dataset["warnings"] == ["Left out Comment: it has no values."]


@pytest.mark.parametrize(
    ("text", "delimiter"),
    [
        ("Time;Pressure (bar);Temp (°C)\n0,000;1,013;20,5\n0,010;1,250;20,6\n", "semicolon"),
        ("Time\tPressure (bar)\tTemp (°C)\n0.000\t1.013\t20.5\n0.010\t1.250\t20.6\n", "tab"),
        ("Time  Pressure(bar)  Temp(°C)\n0.000  1.013  20.5\n0.010  1.250  20.6\n", "spaces"),
    ],
)
def test_other_delimiters_and_decimal_commas(team, text, delimiter):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, text)
    assert dataset["read_info"]["delimiter"] == delimiter
    assert dataset["read_info"]["decimal_comma"] == (delimiter == "semicolon")
    assert [(c["name"], c["unit"]) for c in dataset["channels"]] == [("Pressure", "bar"), ("Temp", "°C")]
    assert samples(team, chief, dataset, "Pressure") == [(0.0, 1.013), (0.01, 1.25)]


def test_windows_encodings(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, "Time,T (\xb0C)\n0,20\n1,21\n".encode("cp1252"))
    assert channel(dataset, "T")["unit"] == "°C"
    dataset = upload(team, chief, "Time,T (\xb0C)\n0,20\n1,21\n".encode("utf-16"))
    assert channel(dataset, "T")["unit"] == "°C"
    assert samples(team, chief, dataset, "T") == [(0.0, 20.0), (1.0, 21.0)]


def test_dates_and_times_of_day(team):
    chief = team.member("chief@x.test", admin=True)
    iso = "Timestamp,PT\n2026-09-20T14:32:01.000-04:00,1\n2026-09-20T14:32:01.500-04:00,2\n2026-09-20T14:32:02.250-04:00,3\n"
    dataset = upload(team, chief, iso)
    assert dataset["time_kind"] == "absolute"
    assert dataset["start_epoch"] == datetime(2026, 9, 20, 18, 32, 1, tzinfo=UTC).timestamp()
    assert dataset["read_info"]["utc_offset"] == -4 * 3600
    assert [t for t, _ in samples(team, chief, dataset, "PT")] == [0.0, 0.5, 1.25]

    # LabVIEW's and Excel's American dates, with AM and PM.
    us = "Date/Time,PT\n09/20/2026 02:32:01.000 PM,1\n09/20/2026 02:32:01.100 PM,2\n"
    dataset = upload(team, chief, us)
    assert dataset["start_epoch"] == datetime(2026, 9, 20, 14, 32, 1, tzinfo=UTC).timestamp()
    assert [t for t, _ in samples(team, chief, dataset, "PT")] == pytest.approx([0.0, 0.1])

    # Only times of day: seconds after midnight, past midnight too.
    clock = "Time,PT\n23:59:59.5,1\n23:59:59.9,2\n00:00:00.3,3\n"
    dataset = upload(team, chief, clock)
    assert (dataset["time_kind"], dataset["start_epoch"]) == ("clock", 86399.5)
    assert [t for t, _ in samples(team, chief, dataset, "PT")] == pytest.approx([0.0, 0.4, 0.8])


def test_unix_times_and_other_units(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, "time_ms,PT\n1790000000000,1\n1790000000250,2\n")
    assert (dataset["time_kind"], dataset["start_epoch"]) == ("absolute", 1790000000.0)
    assert dataset["read_info"]["time_format"] == "unix_milliseconds"
    assert [t for t, _ in samples(team, chief, dataset, "PT")] == [0.0, 0.25]

    # Nanoseconds since 1970 are more digits than a float holds: they're counted from the first row exactly.
    dataset = upload(team, chief, "t_ns,PT\n1790000000000000001,1\n1790000000000000501,2\n")
    assert dataset["read_info"]["time_format"] == "unix_nanoseconds"
    assert [t for t, _ in samples(team, chief, dataset, "PT")] == [0.0, 5e-7]

    dataset = upload(team, chief, "Time (ms),PT\n0,1\n10,2\n20,3\n")
    assert (dataset["time_kind"], dataset["read_info"]["time_format"]) == ("relative", "milliseconds")
    assert [t for t, _ in samples(team, chief, dataset, "PT")] == pytest.approx([0.0, 0.01, 0.02])


def test_rows_out_of_order_are_put_in_order(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, "Time,A,B\n0.2,3,c\n0.0,1,a\n0.1,2,b\n")
    assert samples(team, chief, dataset, "A") == [(0.0, 1.0), (0.1, 2.0), (0.2, 3.0)]
    assert channel(dataset, "B")["labels"] == ["c", "a", "b"]  # numbered as they came
    assert samples(team, chief, dataset, "B") == [(0.0, 1.0), (0.1, 2.0), (0.2, 0.0)]
    assert dataset["warnings"] == ["The rows weren't in time order, so they were put in order."]


def test_a_slower_sensor_keeps_its_own_times(team):
    chief = team.member("chief@x.test", admin=True)
    lines = ["Time,Fast,Slow,Dropout"]
    for i in range(20):
        lines.append(f"{i / 10},{i},{i if i % 5 == 0 else ''},{'' if i == 7 else i}")
    dataset = upload(team, chief, "\n".join(lines) + "\n")

    slow = channel(dataset, "Slow")
    assert (slow["time"], slow["count"], slow["t_min"], slow["t_max"]) == ("c2.t.f64", 4, 0.0, 1.5)
    assert samples(team, chief, dataset, "Slow") == [(0.0, 0.0), (0.5, 5.0), (1.0, 10.0), (1.5, 15.0)]
    # One missing sample doesn't make a channel slow: it stays on the file's times, with a gap.
    dropout = channel(dataset, "Dropout")
    assert (dropout["time"], dropout["count"]) == ("time.f64", 19)
    assert samples(team, chief, dataset, "Dropout")[6:9] == [(0.6, 6.0), (0.7, None), (0.8, 8.0)]
    assert channel(dataset, "Fast")["time"] == "time.f64"


def test_text_columns_become_states_or_events(team):
    chief = team.member("chief@x.test", admin=True)
    lines = ["Time,Valve,Mode,Sequence,PT"]
    for i in range(40):
        step = {10: "IGNITION", 30: "SHUTDOWN"}.get(i, "")
        lines.append(f"{i},{'OPEN' if 10 <= i < 30 else 'CLOSED'},{['IDLE', 'FIRE', 'SAFE'][i // 15]},{step},{i * 2}")
    dataset = upload(team, chief, "\n".join(lines) + "\n")

    valve = channel(dataset, "Valve")
    assert (valve["kind"], valve["labels"]) == ("state", ["CLOSED", "OPEN"])  # on and off are 1 and 0
    assert samples(team, chief, dataset, "Valve")[9:11] == [(9.0, 0.0), (10.0, 1.0)]
    mode = channel(dataset, "Mode")
    assert (mode["kind"], mode["labels"]) == ("state", ["IDLE", "FIRE", "SAFE"])
    # A text column that's mostly empty is events, shown as markers, not a channel.
    assert "Sequence" not in [c["name"] for c in dataset["channels"]]
    assert dataset["events"] == [
        {"t": 10.0, "label": "IGNITION", "channel": "Sequence"},
        {"t": 30.0, "label": "SHUTDOWN", "channel": "Sequence"},
    ]


def test_valves_read_as_valves_however_a_log_says_so(team):
    """Off is 0 and on is 1, in words where the file has them; anything else (fault) comes after them."""
    chief = team.member("chief@x.test", admin=True)
    columns = {
        "PRVNT": ["closed", "1", "1", "fault", "open", "0", "closed", "disconnected"],
        "GRISO3": ["closed", "1", "closed", "1", "1", "closed", "1", "closed"],
        "OQD": ["0", "open", "0", "open", "open", "0", "0", "open"],
        "FSWV": ["OPEN", "fault", "OPEN", "OPEN", "fault", "OPEN", "OPEN", "OPEN"],
        "IGNITER": ["undetermined"] * 8,
    }
    lines = ["Time," + ",".join(columns)]
    lines += [",".join([str(i), *(values[i] for values in columns.values())]) for i in range(8)]
    dataset = upload(team, chief, "\n".join(lines) + "\n")

    def states(name: str) -> tuple[list[str], list[float | None]]:
        return channel(dataset, name)["labels"], [value for _, value in samples(team, chief, dataset, name)]

    assert states("PRVNT") == (["closed", "open", "fault", "disconnected"], [0, 1, 1, 2, 1, 0, 0, 3])
    assert states("GRISO3") == (["closed", "open"], [0, 1, 0, 1, 1, 0, 1, 0])  # 1 is open
    assert states("OQD") == (["closed", "open"], [0, 1, 0, 1, 1, 0, 0, 1])  # 0 is closed
    assert states("FSWV") == (["CLOSED", "OPEN", "fault"], [1, 2, 1, 1, 2, 1, 1, 1])  # never closed
    assert states("IGNITER") == (["undetermined"], [0] * 8)  # not a switch: as it came
    prvnt = channel(dataset, "PRVNT")
    assert (prvnt["min"], prvnt["max"], prvnt["mean"]) == (0, 3, 1)


def test_values_written_with_their_units(team):
    """Some loggers write each value with its unit (23.958 V): they're its numbers, and it's the channel's unit."""
    chief = team.member("chief@x.test", admin=True)
    lines = ["timestamp,PRPT2,OTLC1,PUF_I,OBV_V,Sequence"]
    for i in range(40):
        current = "-0.000" if i == 0 else f"{i / 100:.3f}"
        step = {10: "1 ARM", 30: "2 FIRE"}.get(i, "")
        lines.append(f"{1712514960 + i / 50},{1233.368 + i:.3f} psi,{83.367 + i:.3f}lbf,{current} A,23.860 V,{step}")
    dataset = upload(team, chief, "\n".join(lines) + "\n")

    assert [(c["name"], c["kind"], c["unit"]) for c in dataset["channels"]] == [
        ("PRPT2", "number", "psi"),
        ("OTLC1", "number", "lbf"),
        ("PUF_I", "number", "A"),
        ("OBV_V", "number", "V"),
    ]
    pt = channel(dataset, "PRPT2")
    assert (pt["count"], pt["decimals"], pt["min"], pt["max"]) == (40, 3, 1233.368, 1272.368)
    assert samples(team, chief, dataset, "OTLC1")[:2] == [(0.0, 83.367), (pytest.approx(0.02), 84.367)]
    assert [value for _, value in samples(team, chief, dataset, "PUF_I")][:3] == [0.0, 0.01, 0.02]
    # A sequence's steps are still its steps, though "1 ARM" starts with a number.
    assert [event["label"] for event in dataset["events"]] == ["1 ARM", "2 FIRE"]
    assert dataset["warnings"] == []


def test_units_written_as_a_names_last_word(team):
    """Upstream Pressure PSI, or PT1_psi: the unit, and the name as it's written. Not Pump A, or Valve State."""
    chief = team.member("chief@x.test", admin=True)
    names = "Timestamp ms,Upstream Pressure PSI,Motor Applied Output %,Motor RPM,PT1_psi,Pump A,Valve State,PT2 [bar]"
    dataset = upload(team, chief, f"{names}\n0,426.47,0,0,14.7,1,0,1.01\n10,427.1,5,100,14.8,2,1,1.02\n")
    assert [(c["name"], c["unit"]) for c in dataset["channels"]] == [
        ("Upstream Pressure PSI", "PSI"),
        ("Motor Applied Output %", "%"),
        ("Motor RPM", "RPM"),
        ("PT1_psi", "psi"),
        ("Pump A", ""),
        ("Valve State", ""),
        ("PT2", "bar"),  # in brackets: the name without it, as before
    ]
    assert dataset["read_info"]["time_format"] == "milliseconds"


def test_a_text_column_can_start_empty(team):
    """Which columns are text is worked out from the first rows; a sequence's first step can come long after."""
    chief = team.member("chief@x.test", admin=True)
    lines = ["Time,PT,Sequence"]
    for i in range(3000):
        lines.append(f"{i / 100},{i},{'IGNITION' if i == 2500 else ''}")
    dataset = upload(team, chief, "\n".join(lines) + "\n")
    assert dataset["events"] == [{"t": 25.0, "label": "IGNITION", "channel": "Sequence"}]
    assert dataset["warnings"] == []


def test_free_text_is_left_out(team, monkeypatch):
    monkeypatch.setattr(ingest, "MAX_LABELS", 3)
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, "Time,Note,PT\n0,a,1\n1,b,2\n2,c,3\n3,d,4\n")
    assert [c["name"] for c in dataset["channels"]] == ["PT"]
    assert dataset["warnings"] == ["Left out Note: it's text with more than 3 different values, not a signal."]


def test_cells_that_arent_numbers_and_rows_without_a_time(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, "Time,PT\n0,1\n1,ERR\nabc,5\n\n3,3\n,\n")
    assert samples(team, chief, dataset, "PT") == [(0.0, 1.0), (1.0, None), (3.0, 3.0)]
    assert dataset["warnings"] == [
        "Left out 1 row whose time couldn't be read (row 4: 'abc').",
        "PT: 1 cell wasn't a number (row 3: 'ERR'), so it was left empty.",
    ]


def test_names_that_repeat_and_columns_without_names(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, "Time,PT,PT,\n0,1,2,3\n1,1,2,3\n")
    assert [c["name"] for c in dataset["channels"]] == ["PT", "PT (2)", "Column 4"]


def test_without_a_time_column_time_is_the_row_until_you_choose_one(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, "A,B\n5,1\n3,2\n")
    assert dataset["read_info"]["time_format"] == "rows"
    assert samples(team, chief, dataset, "A") == [(0.0, 5.0), (1.0, 3.0)]
    assert dataset["warnings"] == [
        "No column looks like time, so time is the row number. To use a column, choose it in Read settings."
    ]
    first_version = dataset["data_version"]

    response = team.client.post(f"/api/yorg/datasets/{dataset['id']}/read", json={"time_column": "B"}, headers=chief)
    assert response.status_code == 200, response.text
    dataset = response.json()
    assert [c["name"] for c in dataset["channels"]] == ["A"]
    assert samples(team, chief, dataset, "A") == [(1.0, 5.0), (2.0, 3.0)]
    assert dataset["read_options"] == {"time_column": "B"}
    # The last read's arrays are gone, and asking for them says to load the dataset again.
    stale = team.client.get(f"/api/yorg/datasets/{dataset['id']}/data/{first_version}/time.f64", headers=chief)
    assert (stale.status_code, stale.json()["error"]) == (404, "stale")

    # A way of reading it that doesn't work leaves the last read as it was.
    response = team.client.post(f"/api/yorg/datasets/{dataset['id']}/read", json={"time_column": "C"}, headers=chief)
    assert (response.status_code, response.json()["error"]) == (422, "unreadable")
    assert response.json()["message"] == "There's no column called C. The columns are A, B."
    again = team.client.get(f"/api/yorg/datasets/{dataset['id']}", headers=chief).json()
    assert (again["data_version"], again["read_options"]) == (dataset["data_version"], {"time_column": "B"})

    # Row numbers at a sample rate.
    response = team.client.post(
        f"/api/yorg/datasets/{dataset['id']}/read", json={"time_format": "rows", "sample_rate": 100}, headers=chief
    )
    assert samples(team, chief, response.json(), "B") == [(0.0, 1.0), (0.01, 2.0)]


def test_the_first_column_is_time_when_nothing_is_named_like_it(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, "Zeit,Druck\n0.0,1\n0.5,2\n1.0,3\n")
    assert dataset["read_info"]["time_column"] == "Zeit"
    assert [c["name"] for c in dataset["channels"]] == ["Druck"]
    assert dataset["warnings"] == [
        "No column is named like time, so the first one, Zeit, is. If that's wrong, choose the time column in "
        "Read settings."
    ]


def test_a_file_that_cant_be_read_is_kept_to_read_another_way(team):
    chief = team.member("chief@x.test", admin=True)
    dataset = upload(team, chief, "hello\nworld\n", filename="notes.txt")
    assert dataset["status"] == "failed"
    assert dataset["error"] == "Couldn't find rows of numbers in this file. Is it a CSV file of test data?"
    assert (dataset["channels"], dataset["data_version"]) == ([], None)

    dataset = upload(team, chief, "Time,PT\nsoon,1\nlater,2\n")
    assert dataset["status"] == "failed"
    assert dataset["error"].startswith("Couldn't read the times in Time (like 'soon')")
    response = team.client.post(f"/api/yorg/datasets/{dataset['id']}/read", json={"time_format": "rows"}, headers=chief)
    assert response.json()["status"] == "ready"
    assert response.json()["error"] is None


def test_empty_uploads_are_refused(team):
    chief = team.member("chief@x.test", admin=True)
    response = team.client.post("/api/yorg/datasets", params={"filename": "x.csv"}, content=b"", headers=chief)
    assert (response.status_code, response.json()["error"]) == (400, "empty")


def test_a_wide_file(team):
    chief = team.member("chief@x.test", admin=True)
    header = "Time," + ",".join(f"CH{j}" for j in range(300))
    rows = [f"{i}," + ",".join(str(i * j) for j in range(300)) for i in range(50)]
    dataset = upload(team, chief, "\n".join([header, *rows]) + "\n")
    assert dataset["channel_count"] == 300
    assert samples(team, chief, dataset, "CH299")[2] == (2.0, 598.0)


# --- datasets and views belong to the team -------------------------------------------------------------------------


def test_everyone_sees_datasets_and_only_their_owner_or_an_admin_changes_them(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    first = upload(team, alice, "Time,PT\n0,1\n1,2\n", filename="cold flow.csv")
    second = upload(team, bob, "Time,PT\n0,1\n1,2\n", filename="hotfire.csv")

    listed = team.client.get("/api/yorg/datasets", headers=alice).json()
    assert [(d["name"], d["can_change"]) for d in listed] == [("hotfire", False), ("cold flow", True)]
    assert team.client.get(f"/api/yorg/datasets/{second['id']}", headers=alice).json()["channel_count"] == 1

    url = f"/api/yorg/datasets/{first['id']}"
    refused = team.client.patch(url, json={"name": "mine now"}, headers=bob)
    assert (refused.status_code, refused.json()["error"]) == (403, "not_yours")
    assert team.client.post(url + "/read", json={}, headers=bob).status_code == 403
    assert team.client.delete(url, headers=bob).status_code == 403
    renamed = team.client.patch(url, json={"name": "Cold flow 1", "description": "LOX side"}, headers=alice).json()
    assert (renamed["name"], renamed["description"]) == ("Cold flow 1", "LOX side")
    assert team.client.patch(url, json={"name": "Cold flow #1"}, headers=chief).json()["name"] == "Cold flow #1"


def test_deleted_datasets_come_back(team):
    alice = team.member("alice@x.test")
    dataset = upload(team, alice, "Time,PT\n0,1\n1,2\n")
    url = f"/api/yorg/datasets/{dataset['id']}"
    deleted = team.client.delete(url, headers=alice).json()
    assert deleted["deleted_by"]["email"] == "alice@x.test"
    assert team.client.get("/api/yorg/datasets", headers=alice).json() == []
    assert [d["id"] for d in team.client.get("/api/yorg/datasets?deleted=true", headers=alice).json()] == [
        dataset["id"]
    ]
    data = team.client.get(f"{url}/data/{dataset['data_version']}/time.f64", headers=alice)
    assert data.status_code == 404
    assert team.client.post(url + "/read", json={}, headers=alice).status_code == 409

    restored = team.client.post(url + "/restore", headers=alice).json()
    assert (restored["deleted_at"], restored["deleted_by"]) == (None, None)
    assert fetch(team, alice, dataset, "time.f64") == [0.0, 1.0]


def test_views_are_saved_for_everyone_and_changed_by_their_owner(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    dataset = upload(team, alice, "Time,PT\n0,1\n1,2\n")
    body = {"name": "Tank pressures", "datasets": [dataset["id"]], "config": {"panels": [{"series": ["PT"]}]}}
    created = team.client.post("/api/yorg/views", json=body, headers=alice)
    assert created.status_code == 201, created.text
    view = created.json()
    assert (view["name"], view["datasets"], view["config"]) == ("Tank pressures", [dataset["id"]], body["config"])
    assert view["created_by"]["email"] == "alice@x.test"

    listed = team.client.get("/api/yorg/views", headers=bob).json()
    assert [(v["name"], v["can_change"]) for v in listed] == [("Tank pressures", False)]
    url = f"/api/yorg/views/{view['id']}"
    assert team.client.put(url, json={**body, "name": "Mine"}, headers=bob).status_code == 403
    assert team.client.delete(url, headers=bob).status_code == 403

    changed = team.client.put(url, json={**body, "name": "Tanks", "config": {"panels": []}}, headers=alice).json()
    assert (changed["name"], changed["config"], changed["updated_by"]["email"]) == (
        "Tanks",
        {"panels": []},
        "alice@x.test",
    )
    too_big = team.client.put(url, json={**body, "config": {"x": "y" * 600_000}}, headers=alice)
    assert too_big.status_code == 413
    assert team.client.delete(url, headers=alice).status_code == 204
    assert team.client.get(url, headers=alice).status_code == 404


def test_folders_keep_datasets_in_order(team):
    chief = team.member("chief@x.test", admin=True)
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")

    def add(who, name, parent=None):
        return team.client.post("/api/yorg/folders", json={"name": name, "parent_id": parent}, headers=who)

    hotfires = add(alice, "Hotfires").json()
    april = add(alice, "April", hotfires["id"]).json()
    taken = add(bob, "hotfires")
    assert (taken.status_code, taken.json()["error"]) == (409, "name_taken")
    assert add(bob, "April").status_code == 201  # the same name, in another folder
    listed = team.client.get("/api/yorg/folders", headers=bob).json()
    assert [(f["name"], f["parent_id"], f["can_change"]) for f in listed] == [
        ("April", hotfires["id"], False),
        ("April", None, True),
        ("Hotfires", None, False),
    ]

    # Uploading into a folder, and moving datasets: your own, or any if you're an admin, all or none.
    mine = upload(team, alice, "Time,PT\n0,1\n1,2\n", folder=april["id"])
    assert mine["folder_id"] == april["id"]
    theirs = upload(team, bob, "Time,PT\n0,1\n1,2\n")
    assert theirs["folder_id"] is None

    def move(who, ids, folder):
        return team.client.post("/api/yorg/datasets/move", json={"datasets": ids, "folder_id": folder}, headers=who)

    assert [d["folder_id"] for d in move(alice, [mine["id"]], hotfires["id"]).json()] == [hotfires["id"]]
    assert move(alice, [mine["id"], theirs["id"]], None).status_code == 403
    assert team.client.get(f"/api/yorg/datasets/{mine['id']}", headers=alice).json()["folder_id"] == hotfires["id"]
    assert [d["folder_id"] for d in move(chief, [mine["id"], theirs["id"]], april["id"]).json()] == [april["id"]] * 2

    # Renaming and moving folders: by whoever made them, not into themselves, and not onto a name that's taken.
    url = f"/api/yorg/folders/{hotfires['id']}"
    assert team.client.patch(url, json={"name": "Hot fires"}, headers=bob).status_code == 403
    assert team.client.patch(url, json={"name": "Hot fires"}, headers=alice).json()["name"] == "Hot fires"
    inside = team.client.patch(url, json={"parent_id": april["id"]}, headers=alice)
    assert (inside.status_code, inside.json()["error"]) == (409, "cycle")
    clash = team.client.patch(f"/api/yorg/folders/{april['id']}", json={"parent_id": None}, headers=alice)
    assert (clash.status_code, clash.json()["error"]) == (409, "name_taken")

    # Only empty folders go; deleted datasets in one move up to its folder, to be restored there.
    april_url = f"/api/yorg/folders/{april['id']}"
    full = team.client.delete(april_url, headers=alice)
    assert (full.status_code, full.json()["error"]) == (409, "not_empty")
    move(chief, [theirs["id"]], None)
    team.client.delete(f"/api/yorg/datasets/{mine['id']}", headers=alice)
    assert team.client.delete(april_url, headers=alice).status_code == 204
    assert team.client.get(f"/api/yorg/datasets/{mine['id']}", headers=alice).json()["folder_id"] == hotfires["id"]
    assert team.client.delete(url, headers=alice).status_code == 204  # now empty: the deleted dataset goes to the top
    assert team.client.get(f"/api/yorg/datasets/{mine['id']}", headers=alice).json()["folder_id"] is None


def two_tests() -> str:
    """Six seconds of a file with two tests in it: the valve opens from 1 s to 2 s, and from 3.5 s to 4.5 s."""
    lines = ["Time,Valve,PT,Slow,Sequence,Late"]
    for i in range(60):
        valve = "OPEN" if 10 <= i < 20 or 35 <= i < 45 else "CLOSED"
        step = {10: "IGNITION", 20: "SHUTDOWN"}.get(i, "")
        lines.append(f"{i / 10},{valve},{i},{i if i % 10 == 0 else ''},{step},{i if i >= 50 else ''}")
    return "\n".join(lines) + "\n"


def test_a_file_of_several_tests_splits_into_datasets(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    source = upload(team, alice, two_tests(), filename="cold flows.csv")
    folder = team.client.post("/api/yorg/folders", json={"name": "Cold flows"}, headers=bob).json()
    pieces = [
        {"name": "Cold flow 1", "start": 0.8, "end": 2.3, "zero": 1.0},  # T0 where the valve opens
        {"name": "Cold flow 2", "start": 3.3, "end": 4.8, "zero": 3.5},
    ]
    url = f"/api/yorg/datasets/{source['id']}/split"
    made = team.client.post(url, json={"pieces": pieces, "folder_id": folder["id"]}, headers=bob)
    assert made.status_code == 201, made.text
    # Anyone can split a dataset: the pieces are theirs, like an upload, and the dataset split doesn't change.
    assert [(d["name"], d["folder_id"], d["created_by"]["email"]) for d in made.json()] == [
        ("Cold flow 1", folder["id"], "bob@x.test"),
        ("Cold flow 2", folder["id"], "bob@x.test"),
    ]
    first = team.client.get(f"/api/yorg/datasets/{made.json()[0]['id']}", headers=bob).json()
    assert (first["rows"], first["filename"], first["time_kind"], first["start_epoch"]) == (
        16,
        "cold flows.csv",
        "relative",
        None,
    )
    assert (first["t_min"], first["t_max"]) == pytest.approx((-0.2, 1.3))
    assert first["read_info"]["split_from"] == {
        "dataset": source["id"],
        "name": "cold flows",
        "start": 0.8,
        "end": 2.3,
        "zero": 1.0,
    }
    assert first["size"] == (16 * 3 + 2 * 2) * 8  # its arrays: times, Valve, PT, and Slow's times and values

    # Its samples, from its zero: states keep their names, a slower sensor its own times, and events come along.
    pt = channel(first, "PT")
    assert (pt["count"], pt["min"], pt["max"], pt["mean"]) == (16, 8.0, 23.0, 15.5)
    assert (pt["t_min"], pt["t_max"]) == pytest.approx((-0.2, 1.3))
    assert samples(team, bob, first, "PT")[:3] == [(pytest.approx(-0.2), 8.0), (pytest.approx(-0.1), 9.0), (0.0, 10.0)]
    valve = channel(first, "Valve")
    assert (valve["kind"], valve["labels"]) == ("state", ["CLOSED", "OPEN"])
    assert [value for _, value in samples(team, bob, first, "Valve")] == [0.0] * 2 + [1.0] * 10 + [0.0] * 4
    assert samples(team, bob, first, "Slow") == [(0.0, 10.0), (pytest.approx(1.0), 20.0)]
    assert channel(first, "Slow")["time"] == "c3.t.f64"
    assert first["events"] == [
        {"t": 0.0, "label": "IGNITION", "channel": "Sequence"},
        {"t": pytest.approx(1.0), "label": "SHUTDOWN", "channel": "Sequence"},
    ]
    # A channel without a sample in the span is left out, and said so.
    assert [c["name"] for c in first["channels"]] == ["Valve", "PT", "Slow"]
    assert first["warnings"] == ["Left out Late: it has no samples in this span."]
    second = team.client.get(f"/api/yorg/datasets/{made.json()[1]['id']}", headers=bob).json()
    assert (second["events"], samples(team, bob, second, "Slow")) == ([], [(pytest.approx(0.5), 40.0)])
    assert team.client.get(f"/api/yorg/datasets/{source['id']}", headers=bob).json()["rows"] == 60

    # A piece has no file of its own to read again: its dataset's is read again, and split again.
    again = team.client.post(f"/api/yorg/datasets/{first['id']}/read", json={}, headers=bob)
    assert (again.status_code, again.json()["error"]) == (409, "split")
    assert team.client.get(f"/api/yorg/datasets/{first['id']}/source", headers=bob).status_code == 404
    assert team.client.get(f"/api/yorg/datasets/{source['id']}/source", headers=bob).status_code == 200

    # All or none: a span without samples makes nothing. And spans that end before they start aren't spans.
    before = len(team.client.get("/api/yorg/datasets", headers=bob).json())
    empty = team.client.post(url, json={"pieces": [pieces[0], {"name": "Nothing", "start": 7, "end": 8}]}, headers=bob)
    assert (empty.status_code, empty.json()["error"]) == (422, "empty_piece")
    assert "Nothing" in empty.json()["message"]
    backwards = team.client.post(url, json={"pieces": [{"name": "Back", "start": 2, "end": 1}]}, headers=bob)
    assert backwards.status_code == 422
    assert team.client.post(url, json={"pieces": []}, headers=bob).status_code == 422
    assert team.client.post(url, json={"pieces": pieces, "folder_id": 999}, headers=bob).status_code == 404
    assert len(team.client.get("/api/yorg/datasets", headers=bob).json()) == before

    # A deleted dataset isn't split until it's restored.
    team.client.delete(f"/api/yorg/datasets/{source['id']}", headers=alice)
    assert team.client.post(url, json={"pieces": pieces}, headers=bob).status_code == 409


def test_a_dated_piece_keeps_its_times_of_day(team):
    alice = team.member("alice@x.test")
    rows = [f"2026-09-20T14:32:{i // 2:02d}.{5 * (i % 2)}00-04:00,{i}" for i in range(10)]
    source = upload(team, alice, "Timestamp,PT\n" + "\n".join(rows) + "\n")
    url = f"/api/yorg/datasets/{source['id']}/split"

    def split(piece: dict) -> dict:
        [made] = team.client.post(url, json={"pieces": [piece]}, headers=alice).json()
        return team.client.get(f"/api/yorg/datasets/{made['id']}", headers=alice).json()

    piece = split({"name": "Test", "start": 1, "end": 3, "zero": 2})
    assert (piece["time_kind"], piece["start_epoch"]) == ("absolute", source["start_epoch"] + 2)
    assert samples(team, alice, piece, "PT") == [(-1.0, 2.0), (-0.5, 3.0), (0.0, 4.0), (0.5, 5.0), (1.0, 6.0)]
    # Without a zero, times are as they were.
    same = split({"name": "As is", "start": 1, "end": 1.5})
    assert (same["start_epoch"], same["t_min"], same["t_max"]) == (source["start_epoch"], 1.0, 1.5)


def test_calculated_channels_are_the_teams_and_changed_by_their_owner(team):
    alice = team.member("alice@x.test")
    bob = team.member("bob@x.test")
    chief = team.member("chief@x.test", admin=True)
    body = {"name": "Thrust", "expression": "[LC-1] + [LC-2]", "unit": "lbf", "description": "Both load cells"}
    created = team.client.post("/api/yorg/formulas", json=body, headers=alice)
    assert created.status_code == 201, created.text
    thrust = created.json()
    assert (thrust["name"], thrust["expression"], thrust["unit"]) == ("Thrust", "[LC-1] + [LC-2]", "lbf")
    team.client.post("/api/yorg/formulas", json={"name": "O/F", "expression": "[FM-OX] / [FM-FU]"}, headers=bob)

    listed = team.client.get("/api/yorg/formulas", headers=bob).json()
    assert [(f["name"], f["can_change"]) for f in listed] == [("O/F", True), ("Thrust", False)]
    # Names are for everyone, whatever their case.
    taken = team.client.post("/api/yorg/formulas", json={**body, "name": "THRUST"}, headers=bob)
    assert (taken.status_code, taken.json()["error"]) == (409, "name_taken")
    assert taken.json()["message"] == "There's already a calculated channel called Thrust"

    url = f"/api/yorg/formulas/{thrust['id']}"
    assert team.client.put(url, json={**body, "expression": "[LC-1]"}, headers=bob).status_code == 403
    assert team.client.delete(url, headers=bob).status_code == 403
    changed = team.client.put(url, json={**body, "expression": "[LC-1] + [LC-2] + [LC-3]"}, headers=alice).json()
    assert changed["expression"] == "[LC-1] + [LC-2] + [LC-3]"
    renamed = team.client.put(url, json={**body, "name": "Total thrust"}, headers=chief).json()
    assert (renamed["name"], renamed["updated_by"]["email"]) == ("Total thrust", "chief@x.test")
    empty = team.client.post("/api/yorg/formulas", json={"name": "Nothing", "expression": "  "}, headers=alice)
    assert empty.status_code == 422
    assert team.client.delete(url, headers=alice).status_code == 204
    assert [f["name"] for f in team.client.get("/api/yorg/formulas", headers=alice).json()] == ["O/F"]


def test_yorg_is_for_approved_members(team):
    waiting = team.member("new@x.test", status=UserStatus.PENDING)
    assert team.client.get("/api/yorg/datasets", headers=waiting).status_code == 403
    response = team.client.post(
        "/api/yorg/datasets", params={"filename": "x.csv"}, content=b"t,a\n0,1\n", headers=waiting
    )
    assert response.status_code == 403


def test_a_read_the_server_didnt_finish_can_be_read_again(settings, team):
    alice = team.member("alice@x.test")
    dataset = upload(team, alice, "Time,PT\n0,1\n1,2\n")
    with team.app.state.sessionmaker() as db:
        db.get(Dataset, dataset["id"]).status = "reading"  # as if the server stopped in the middle
        db.commit()

    with TestClient(create_app(settings)) as restarted:
        found = restarted.get(f"/api/yorg/datasets/{dataset['id']}", headers=alice).json()
    assert (found["status"], found["error"]) == (
        "failed",
        "The server stopped while it was reading this file. Read it again.",
    )
