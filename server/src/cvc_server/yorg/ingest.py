"""Reading a file of test data (CSV) into arrays: one time base, and a channel for each other column.

First the start of the file says how it's laid out: its encoding and delimiter, where the column names (and
maybe a row of units) are, which column is time and in what format, and which columns hold numbers and which
text. Then the whole file streams through a block of rows at a time, each column going to a file of its own, so
a file much bigger than memory can be read. Last, each column is finished on its own: put in time order if the
rows weren't, and cut down to its own samples if it was mostly empty (a slower sensor logged in the same file).

Arrays are little-endian float64 (what the browser reads as it is): times in seconds, and values, NaN where a
row had none. A text column becomes a state (its values numbered in the order they first appear) or, if it's
mostly empty, events: a sequence's steps, say, which the plots show as markers.
"""

import csv
import io
import itertools
import math
import operator
import re
import string
import sys
from array import array
from collections import Counter
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal

SNIFF_BYTES = 512 * 1024  # how much of the file to look at to work out its layout
BLOCK_ROWS = 20_000
MAX_COLUMNS = 2000
MAX_LABELS = 1000  # a text column with more different values than this is notes, not a signal
MAX_EVENTS = 2000
EVENT_SHARE = 0.05  # a text column with values in fewer rows than this is events, not a state
SPARSE_SHARE = 0.5  # a column with values in at most this share of rows keeps its own times

TimeFormat = Literal[
    "auto",
    "seconds",
    "milliseconds",
    "microseconds",
    "nanoseconds",
    "unix_seconds",
    "unix_milliseconds",
    "unix_microseconds",
    "unix_nanoseconds",
    "datetime",
    "rows",
]
Delimiter = Literal[",", ";", "\t", "|", " "]

_PER_SECOND = {"seconds": 1.0, "milliseconds": 1e3, "microseconds": 1e6, "nanoseconds": 1e9}
_DELIMITER_NAMES = {",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe", " ": "spaces"}
_NAN = math.nan
_SECOND = timedelta(seconds=1)
_EPOCH = datetime(1970, 1, 1)


class ReadError(Exception):
    """The file can't be read as test data (or not the way it was asked to be); the message says why."""


@dataclass
class ReadOptions:
    """How to read a file. Anything left out is worked out from the file."""

    time_column: str | None = None  # the time column's name
    time_format: TimeFormat = "auto"  # "rows": there's no time column; time is the row number / sample_rate
    sample_rate: float | None = None  # rows per second, for "rows"
    header_row: int | None = None  # the names' row, from 1; 0: the file has no names
    delimiter: Delimiter | None = None

    def as_dict(self) -> dict[str, Any]:
        return {name: value for name, value in asdict(self).items() if value not in (None, "auto")}

    @classmethod
    def of(cls, values: dict[str, Any] | None) -> "ReadOptions":
        return cls(**(values or {}))


@dataclass
class ChannelData:
    position: int  # its column in the file, from 0
    name: str
    unit: str
    kind: Literal["number", "state"]
    labels: list[str]  # a state's values, by number
    decimals: int | None
    count: int  # samples with a value
    min: float | None
    max: float | None
    mean: float | None
    t_min: float | None
    t_max: float | None
    time_file: str  # "time.f64", or its own times ("c3.t.f64") if it was mostly empty
    value_file: str


@dataclass
class ReadResult:
    rows: int
    time_kind: Literal["relative", "absolute", "clock"]
    start_epoch: float | None
    t_min: float
    t_max: float
    sample_rate: float | None
    channels: list[ChannelData]
    events: list[dict[str, Any]]
    warnings: list[str]
    info: dict[str, Any]


# --- the layout -------------------------------------------------------------------------------------------------

_COMMA_NUMBER = re.compile(r"^[-+]?\d+,\d+(?:[eE][-+]?\d+)?$")
_DOT_NUMBER = re.compile(r"^[-+]?\d*\.\d+(?:[eE][-+]?\d+)?$")
# A date or a time of day: 2026-09-20, 09/20/2026 14:32, 14:32:01.5.
_DATE_LIKE = re.compile(r"^\d{1,4}[-/.:]\d{1,2}(?:[-/.:T ]+\d{1,4})*")
_NAME_UNIT = re.compile(r"^(?P<name>.*?)\s*[(\[{](?P<unit>[^()\[\]{}]{1,24})[)\]}]\s*$")
# A value written with its unit after it, as some loggers write every cell: 23.958 V, -151.273 psi, 12.5%, 300 °C.
_UNIT_VALUE = re.compile(r"^([-+]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][-+]?\d+)?)\s*([A-Za-z%°ºµμ][^\s]{0,15})$")
_UNIT_TAIL = string.ascii_letters + " %°ºµμ"  # what's after a number when its unit's written with it
_TIME_NAME = re.compile(
    r"^(?:t|time|times|timestamp|time[ _]?stamp|date[ _/]?time|elapsed(?:[ _]?time)?|epoch|unix(?:[ _]?time)?"
    r"|x_value|clock|utc|ts|gps[ _]?time|rel(?:ative)?[ _]?time|sample[ _]?time|daq[ _]?time|seconds|secs?|millis|micros)"
    r"(?:[ _-]?(?P<unit>s|sec|secs|seconds|ms|msec|millis|milliseconds|us|µs|μs|usec|micros|microseconds"
    r"|ns|nsec|nanos|nanoseconds))?$",
    re.IGNORECASE,
)
_TIME_WORD = re.compile(r"(?<![a-z])time(?:stamp)?(?![a-z])", re.IGNORECASE)  # "Test Time", "time_since_boot"
_TIME_UNITS = {
    **dict.fromkeys(["s", "sec", "secs", "second", "seconds"], "seconds"),
    **dict.fromkeys(["ms", "msec", "millis", "millisecond", "milliseconds"], "milliseconds"),
    **dict.fromkeys(["us", "µs", "μs", "usec", "micros", "microsecond", "microseconds"], "microseconds"),
    **dict.fromkeys(["ns", "nsec", "nanos", "nanosecond", "nanoseconds"], "nanoseconds"),
}
# What a row of units says, to tell it from a row of short names.
_UNITS = {
    *_TIME_UNITS,
    *["psi", "psia", "psig", "psid", "bar", "mbar", "pa", "kpa", "mpa", "atm", "torr", "inhg", "inh2o"],
    *["v", "mv", "kv", "a", "ma", "ua", "w", "kw", "mw", "j", "kj", "ohm", "ohms", "hz", "khz", "rpm"],
    *["k", "c", "f", "degc", "degf", "deg_c", "deg_f", "°c", "°f", "ºc", "ºf", "deg", "degrees", "rad"],
    *["n", "kn", "lbf", "lb", "lbs", "lbm", "kg", "g", "mg", "klbf", "ozf", "nm", "ftlb", "inlb"],
    *["m", "mm", "cm", "km", "in", "ft", "mil", "m/s", "ft/s", "m/s2", "m/s^2", "g's", "gs", "mph", "kph"],
    *["%", "pct", "percent", "count", "counts", "bool", "state", "raw", "adc", "bits"],
    *["l/s", "l/min", "lpm", "gpm", "scfm", "slpm", "sccm", "kg/s", "g/s", "lb/s", "lbm/s", "cc", "ml", "l", "gal"],
}
# Units a name can end with, as its last word (Upstream Pressure PSI, PT1_psi, Output %): not one letter (Pump A is a
# pump), nor words that are as often just part of a name (a valve's state, a count, flow in).
_NAME_UNITS = {unit for unit in _UNITS if len(unit) > 1 or not unit.isalpha()} - {
    *["state", "bool", "raw", "adc", "bits", "count", "counts", "in", "us", "pa", "deg", "degrees", "rad", "mil"],
}
# Values that mean on and off: a column of only these is a state with them in this order.
_BOOLEANS = {
    "true": 1,
    "false": 0,
    "on": 1,
    "off": 0,
    "open": 1,
    "opened": 1,
    "closed": 0,
    "close": 0,
    "yes": 1,
    "no": 0,
    "high": 1,
    "low": 0,
    "armed": 1,
    "disarmed": 0,
    "enabled": 1,
    "disabled": 0,
}


@dataclass
class _Layout:
    encoding: str
    delimiter: str
    decimal_comma: bool
    header: int | None  # the names' row (0-based), if any
    units: int | None  # the units' row, if any
    data: int  # the first row of data
    width: int
    names: list[str]
    units_of: list[str]
    named: list[bool]  # whether the file named the column
    kinds: list[str]  # per column: "number", "bool", or "text"
    decimals: list[int | None]
    samples: list[list[str]]  # the first rows of data, as wide as the file


def _encoding(head: bytes) -> str:
    if head.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if head.startswith((b"\xff\xfe", b"\xfe\xff")):
        return "utf-16"
    try:
        head.decode("utf-8")
    except UnicodeDecodeError as error:
        if error.start < len(head) - 4:  # not just a character cut off at the end of the sample
            return "cp1252"  # what Windows programs (LabVIEW, Excel) write: "°C", "µs"
    return "utf-8"


def _number(text: str, decimal_comma: bool) -> float:
    """The number in a cell, or NaN."""
    try:
        return float(text.replace(",", ".") if decimal_comma else text)
    except ValueError:
        return _NAN


def _is_number(text: str, decimal_comma: bool = False) -> bool:
    try:
        float(text.replace(",", ".") if decimal_comma else text)
    except ValueError:
        return False
    return True


def _unit_value(text: str, decimal_comma: bool) -> tuple[str, str] | None:
    """A value written with its unit (23.958 V, 12.5%): its number, as written, and its unit. None if it isn't one."""
    match = _UNIT_VALUE.match(text.strip())
    if match is None or match[2] in ("e", "E") or not _is_number(match[1], decimal_comma):
        return None
    return match[1], match[2]


def _value_like(cell: str, decimal_comma: bool) -> bool:
    text = cell.strip()
    return bool(text) and (
        _is_number(text, decimal_comma)
        or _DATE_LIKE.match(text) is not None
        or _unit_value(text, decimal_comma) is not None
    )


class _Shape:
    """What a row of data looks like: about as many numbers (or dates) as the rows at the end of the sample.

    Data can hold text (states, a sequence's steps), so it's the count of numbers that tells it from names,
    units, and notes, which have far fewer.
    """

    def __init__(self, rows: list[list[str]], decimal_comma: bool):
        self.decimal_comma = decimal_comma
        counts = sorted(self.values(row) for row in [row for row in rows if _filled(row)][-50:])
        self.typical = counts[len(counts) // 2] if counts else 0

    def values(self, row: list[str]) -> int:
        return sum(_value_like(cell, self.decimal_comma) for cell in row)

    def is_data(self, row: list[str]) -> bool:
        values = self.values(row)
        return values > 0 and values * 2 >= self.typical

    def names_like(self, row: list[str], width: int) -> bool:
        """Text across most of the data's columns: names (or units), not a note above the data."""
        filled = _filled(row)
        return (
            not self.is_data(row)
            and len(row) * 2 >= width
            and filled >= min(2, width)
            and filled * 2 >= min(len(row), width)
        )


def _comma_decimals(lines: list[str], delimiter: str) -> bool:
    fields = [cell.strip() for line in lines[-50:] for cell in line.split(delimiter)]
    commas = sum(_COMMA_NUMBER.match(cell) is not None for cell in fields)
    return commas > 0 and commas >= sum(_DOT_NUMBER.match(cell) is not None for cell in fields)


def _delimiter(lines: list[str]) -> tuple[str, bool]:
    """The delimiter, and whether numbers have a decimal comma ("0,5"), from the lines at the end (the data)."""
    body = [line for line in lines if line.strip()][-200:]
    scores = {}
    for delimiter in (",", "\t", ";", "|"):
        count, lines_with_it = Counter(line.count(delimiter) for line in body).most_common(1)[0]
        if count:
            scores[delimiter] = (lines_with_it / len(body), count)
    if not scores:
        width, lines_with_it = Counter(len(line.split()) for line in body).most_common(1)[0]
        return (" " if width > 1 and lines_with_it >= 0.9 * len(body) else ","), False
    best = max(scores, key=lambda delimiter: scores[delimiter])
    if best == ",":
        # "0,5;1,25" has more commas than semicolons, but the fields between the semicolons are numbers.
        for other in ("\t", ";", "|"):
            if other in scores and scores[other][0] >= 0.9 and _comma_decimals(body, other):
                return other, True
        return ",", False
    return best, _comma_decimals(body, best)


def _rows(text: io.TextIOBase, delimiter: str) -> Iterator[list[str]]:
    if delimiter == " ":
        return (line.split() for line in text)
    return csv.reader(text, delimiter=delimiter)


def _looks_like_units(row: list[str]) -> bool:
    filled = [cell.strip().strip("()[]{}").strip().lower() for cell in row if cell.strip()]
    return bool(filled) and sum(cell in _UNITS for cell in filled) * 2 >= len(filled)


def _data_start(rows: list[list[str]], start: int, shape: _Shape) -> int:
    """The first row of the data: the rows of numbers (all as wide as each other) that end the file's start.

    Walking up from the last of them, other rows (notes, a message the logger wrote) are passed over; text
    across the data's columns (the names, or units) ends it.
    """
    is_data = [bool(row) and shape.is_data(row) for row in rows]
    widths = Counter(len(rows[i]) for i in range(start, len(rows)) if is_data[i])
    if not widths:
        raise ReadError("Couldn't find rows of numbers in this file. Is it a CSV file of test data?")
    width = widths.most_common(1)[0][0]
    first = max(i for i in range(start, len(rows)) if is_data[i] and len(rows[i]) == width)
    for i in range(first - 1, start - 1, -1):
        if is_data[i]:
            first = i
        elif shape.names_like(rows[i], width):
            break
    return first


def _filled(row: list[str]) -> int:
    return sum(1 for cell in row if cell.strip())


def _split_unit(name: str) -> tuple[str, str]:
    match = _NAME_UNIT.match(name)
    if match and match["name"].strip():
        return match["name"].strip(), match["unit"].strip()
    return name, ""


def _name_unit(name: str) -> str:
    """A unit a name ends with, as a word (Upstream Pressure PSI, PT1_psi), as it's written; else ""."""
    words = re.split(r"[\s_]+", name.strip())
    return words[-1] if len(words) > 1 and words[-1].lower() in _NAME_UNITS else ""


def _decimals(text: str, decimal_comma: bool) -> int | None:
    text = text.strip()
    if "e" in text or "E" in text:
        return None
    point = text.rfind("," if decimal_comma else ".")
    return 0 if point < 0 else len(text) - point - 1


def _layout(source: Path, options: ReadOptions) -> _Layout:
    with source.open("rb") as file:
        head = file.read(SNIFF_BYTES)
        whole = not file.read(1)
    if not head.strip():
        raise ReadError("The file is empty")
    encoding = _encoding(head)
    text = head.decode(encoding, errors="replace")
    if not whole:
        text = text[: text.rfind("\n") + 1]  # the last line was cut off
    lines = text.splitlines()
    if options.delimiter:
        delimiter, decimal_comma = (
            options.delimiter,
            options.delimiter != "," and _comma_decimals(lines, options.delimiter),
        )
    else:
        delimiter, decimal_comma = _delimiter(lines)
    rows = list(_rows(io.StringIO(text, newline=""), delimiter))
    shape = _Shape(rows, decimal_comma)

    header = units = None
    # LabVIEW measurement files (.lvm) end each block of settings with this; the names come after the last one.
    markers = [i for i, row in enumerate(rows) if row and row[0].strip() == "***End_of_Header***"]
    if options.header_row:  # the names are where you said
        header = options.header_row - 1
        if header >= len(rows):
            raise ReadError(f"There's no row {options.header_row} in the first {SNIFF_BYTES // 1024} KB of the file")
        data = _data_start(rows, header + 1, shape)
        between = [i for i in range(header + 1, data) if _filled(rows[i])]
        if between and _looks_like_units(rows[between[-1]]):
            units = between[-1]
    else:
        data = _data_start(rows, markers[-1] + 1 if markers else 0, shape)
        if options.header_row is None:  # the names: the text just above the data, maybe with units under them
            width = len(rows[data])
            above = [i for i in range(data) if _filled(rows[i])][-2:]
            if above and shape.names_like(rows[above[-1]], width):
                header = above[-1]
                names_above = len(above) == 2 and shape.names_like(rows[above[0]], width)
                if names_above and _looks_like_units(rows[header]):
                    header, units = above[0], header

    samples = [row for row in rows[data:] if row][:2000]
    width = max(
        Counter(len(row) for row in samples).most_common(1)[0][0], len(rows[header]) if header is not None else 0
    )
    if width > MAX_COLUMNS:
        raise ReadError(f"This file has {width} columns; Yorg reads up to {MAX_COLUMNS}. Split it into smaller files.")
    samples = [(row + [""] * (width - len(row)))[:width] for row in samples]

    names, units_of, named, word_units = [], [], [], []
    header_cells = rows[header] if header is not None else []
    unit_cells = rows[units] if units is not None else []
    seen: Counter[str] = Counter()
    for j in range(width):
        raw = " ".join(header_cells[j].split()) if j < len(header_cells) else ""
        name, unit = _split_unit(raw)
        if j < len(unit_cells) and unit_cells[j].strip():
            unit = unit_cells[j].strip().strip("()[]{}").strip()
        named.append(bool(name))
        word_units.append(_name_unit(name))
        name = name or f"Column {j + 1}"
        seen[name] += 1
        names.append(name if seen[name] == 1 else f"{name} ({seen[name]})")
        units_of.append(unit[:64])

    kinds, decimals, value_units = [], [], []
    for j in range(width):
        cells = [row[j].strip() for row in samples if row[j].strip()]
        # Numbers, and values written with their unit (23.958 V): numbers too, in that unit, when they share one that's
        # a unit (or that's on every row of a busy column), unlike a sequence's "1 ARM", "2 FIRE".
        numbers, written_units = [], Counter[str]()
        for cell in cells:
            if _is_number(cell, decimal_comma):
                numbers.append(cell)
            elif (written := _unit_value(cell, decimal_comma)) is not None:
                numbers.append(written[0])
                written_units[written[1]] += 1
        unit = next(iter(written_units)) if len(written_units) == 1 else ""
        if written_units and not (unit.lower() in _UNITS or written_units[unit] >= 20):
            numbers = [cell for cell in cells if _is_number(cell, decimal_comma)]
            unit = ""
        if not written_units and len(numbers) < len(cells) and all(_switch_value(cell) is not None for cell in cells):
            # A switch however it's written (closed, 1, open, 0): a state, whichever the first rows say more.
            kinds.append("bool")
            decimals.append(None)
        elif len(numbers) * 2 >= len(cells):
            kinds.append("number")
            places = [_decimals(cell, decimal_comma) for cell in numbers]
            decimals.append(None if None in places else min(max(places, default=0), 12))
        else:
            kinds.append("bool" if all(cell.lower() in _BOOLEANS for cell in cells) else "text")
            decimals.append(None)
            unit = ""
        value_units.append(unit)
    # Where the names (and a row of units) don't say, the unit written with the values, or the name's last word.
    units_of = [
        (said or with_values or word)[:64]
        for said, with_values, word in zip(units_of, value_units, word_units, strict=True)
    ]
    return _Layout(
        encoding, delimiter, decimal_comma, header, units, data, width, names, units_of, named, kinds, decimals, samples
    )


# --- time ---------------------------------------------------------------------------------------------------------


class _Times:
    """Reads a time column into seconds (NaN where a row's time can't be read)."""

    kind: Literal["relative", "absolute", "clock"] = "relative"
    start_epoch: float | None = None
    utc_offset: float | None = None

    def __init__(self, format: str):
        self.format = format

    def read(self, cells: tuple[str, ...], first_row: int) -> array:
        raise NotImplementedError


class _Numbers(_Times):
    def __init__(self, format: str, decimal_comma: bool):
        super().__init__(format)
        self.decimal_comma = decimal_comma
        unix = format.startswith("unix_")
        self.per_second = _PER_SECOND[format.removeprefix("unix_")]
        self.kind = "absolute" if unix else "relative"
        self.base: float | int | None = None if unix else 0.0

    def read(self, cells: tuple[str, ...], first_row: int) -> array:
        if self.format == "unix_nanoseconds":
            return self._nanoseconds(cells)
        values = _numbers(cells, self.decimal_comma)[0]
        if self.base is None:  # Unix time: seconds from the first row's time, which is the dataset's start
            first = next((value for value in values if math.isfinite(value)), None)
            if first is None:
                return values
            self.base = first
            self.start_epoch = first / self.per_second
        if self.base == 0.0 and self.per_second == 1.0:
            return values
        base, per_second = self.base, self.per_second
        return array("d", ((value - base) / per_second for value in values))

    def _nanoseconds(self, cells: tuple[str, ...]) -> array:
        # Whole nanoseconds since 1970 are too big for a float to hold exactly: subtract the start as integers first.
        out = array("d")
        for cell in cells:
            try:
                value = int(cell)
            except ValueError:
                try:
                    value = int(float(cell))
                except (ValueError, OverflowError):  # not a number, or NaN or infinity
                    out.append(_NAN)
                    continue
            if self.base is None:
                self.base = value
                self.start_epoch = value / 1e9
            out.append((value - self.base) / 1e9)
        return out


class _Rows(_Times):
    def __init__(self, rate: float | None):
        super().__init__("rows")
        self.rate = rate or 1.0
        self.done = 0

    def read(self, cells: tuple[str, ...], first_row: int) -> array:
        start, rate = self.done, self.rate
        self.done += len(cells)
        return array("d", (i / rate for i in range(start, start + len(cells))))


_DATE_FORMATS = [
    "%m/%d/%Y %H:%M:%S.%f",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M",
    "%m/%d/%Y %I:%M:%S.%f %p",
    "%m/%d/%Y %I:%M:%S %p",
    "%Y/%m/%d %H:%M:%S.%f",
    "%Y/%m/%d %H:%M:%S",
    "%d/%m/%Y %H:%M:%S.%f",
    "%d/%m/%Y %H:%M:%S",
    "%d.%m.%Y %H:%M:%S.%f",
    "%d.%m.%Y %H:%M:%S",
]
_TIME_OF_DAY_FORMATS = ["%H:%M:%S.%f", "%H:%M:%S", "%I:%M:%S.%f %p", "%I:%M:%S %p"]
_LONG_FRACTION = re.compile(r"(\.\d{6})\d+")  # more digits than a datetime holds (nanoseconds)


def _parser(format: str | None) -> Callable[[str], datetime]:
    if format is None:
        return datetime.fromisoformat

    def parse(text: str) -> datetime:
        return datetime.strptime(text, format)

    return parse


def _date_parser(cells: list[str]) -> tuple[str | None, bool] | None:
    """How these cells are dates: (a strptime format, or None for ISO 8601; whether they're only times of day)."""
    for format, time_of_day in (
        [(None, False)] + [(f, False) for f in _DATE_FORMATS] + [(f, True) for f in _TIME_OF_DAY_FORMATS]
    ):
        parse, read = _parser(format), 0
        for cell in cells:
            try:
                parse(_LONG_FRACTION.sub(r"\1", cell.strip()))
                read += 1
            except ValueError:
                pass
        if cells and read >= 0.95 * len(cells):
            return format, time_of_day
    return None


class _Dates(_Times):
    def __init__(self, format: str | None, time_of_day: bool):
        super().__init__("datetime")
        self.parse = _parser(format)
        self.time_of_day = time_of_day
        self.kind = "clock" if time_of_day else "absolute"
        self.base: datetime | None = None
        self.day = 0.0  # times of day: a day for each time the clock went past midnight
        self.last = -math.inf

    def _seconds(self, cell: str) -> float:
        try:
            when = self.parse(cell.strip())
        except ValueError:
            try:
                when = self.parse(_LONG_FRACTION.sub(r"\1", cell.strip()))
            except ValueError:
                return _NAN
        if self.base is None:
            self.base = when
            offset = when.utcoffset()
            self.utc_offset = offset.total_seconds() if offset is not None else None
            if self.time_of_day:
                self.start_epoch = (when - when.replace(hour=0, minute=0, second=0, microsecond=0)) / _SECOND
            else:
                self.start_epoch = (when.replace(tzinfo=None) - (offset or timedelta(0)) - _EPOCH) / _SECOND
        try:
            seconds = (when - self.base) / _SECOND
        except TypeError:  # a time with a time zone among times without, or the other way around
            return _NAN
        if self.time_of_day:
            if seconds + self.day < self.last - 43200:  # back by more than 12 hours: past midnight
                self.day += 86400.0
            seconds += self.day
            self.last = seconds
        return seconds

    def read(self, cells: tuple[str, ...], first_row: int) -> array:
        return array("d", map(self._seconds, cells))


def _time_column(layout: _Layout, options: ReadOptions) -> int | None:
    if options.time_format == "rows":
        return None
    if options.time_column is not None:
        wanted = options.time_column.strip()
        for match in (lambda name: name == wanted, lambda name: name.lower() == wanted.lower()):
            for j, name in enumerate(layout.names):
                if match(name):
                    return j
        choices = ", ".join(layout.names[:12]) + (", …" if len(layout.names) > 12 else "")
        raise ReadError(f"There's no column called {wanted}. The columns are {choices}.")
    for looks_like_time in (_TIME_NAME.match, _TIME_WORD.search):
        for j, name in enumerate(layout.names):
            if layout.named[j] and looks_like_time(name):
                return j
    return 0 if _first_column_is_time(layout) else None


def _named_like_time(name: str) -> bool:
    return bool(_TIME_NAME.match(name) or _TIME_WORD.search(name))


def _first_column_is_time(layout: _Layout) -> bool:
    """Nothing is named like time, but the first column goes up row by row, or is dates: that's time."""
    cells = [row[0].strip() for row in layout.samples if row[0].strip()]
    if len(cells) < 2 or layout.width < 2:
        return False
    if layout.kinds[0] == "number":
        values = [_number(cell, layout.decimal_comma) for cell in cells]
        return all(a < b for a, b in itertools.pairwise(values))
    return _date_parser(cells[:200]) is not None


def _auto_format(layout: _Layout, column: int) -> str:
    """The time column's format, from its name and unit, and the size or shape of its values."""
    cells = [row[column].strip() for row in layout.samples if row[column].strip()]
    if not cells:
        raise ReadError(f"The time column, {layout.names[column]}, is empty")
    if layout.kinds[column] == "number":
        name = _TIME_NAME.match(layout.names[column])
        hint = _TIME_UNITS.get(layout.units_of[column].lower()) or (
            _TIME_UNITS.get((name["unit"] or "").lower()) if name else None
        )
        if name and hint is None:  # "Seconds", "millis": the name is the unit
            hint = _TIME_UNITS.get(layout.names[column].lower())
        values = [abs(_number(cell, layout.decimal_comma)) for cell in cells]
        biggest = max((value for value in values if math.isfinite(value)), default=0.0)
        # Big enough to be a date since 2000 (and before 2100), counted from 1970: Unix time.
        for unix, per_second in (("unix_seconds", 1), ("unix_milliseconds", 1e3), ("unix_microseconds", 1e6)):
            if 9.46e8 * per_second <= biggest < 4.1e9 * per_second:
                return unix
        if 9.46e17 <= biggest < 4.1e18:
            return "unix_nanoseconds"
        return hint or "seconds"
    if _date_parser(cells[:200]) is not None:
        return "datetime"
    raise ReadError(
        f"Couldn't read the times in {layout.names[column]} (like {cells[0]!r}). "
        "Choose the time column and its format in Read settings."
    )


def _times(layout: _Layout, column: int | None, options: ReadOptions) -> _Times:
    if column is None:
        return _Rows(options.sample_rate)
    format = options.time_format if options.time_format != "auto" else _auto_format(layout, column)
    if format == "datetime":
        cells = [row[column].strip() for row in layout.samples if row[column].strip()]
        parser = _date_parser(cells[:200])
        if parser is None:
            example = f" (like {cells[0]!r})" if cells else ""
            raise ReadError(f"Couldn't read the dates in {layout.names[column]}{example}")
        return _Dates(*parser)
    return _Numbers(format, layout.decimal_comma)


# --- values -------------------------------------------------------------------------------------------------------


def _numbers(cells: tuple[str, ...], decimal_comma: bool) -> tuple[array, int, str | None]:
    """The cells as numbers: NaN for empty ones and for anything else (counted, with the first as an example).

    A value written with its unit (23.958 V) is its number; on and off words are 1 and 0.
    """
    try:
        if decimal_comma:
            return array("d", map(float, (cell.replace(",", ".") for cell in cells))), 0, None
        return array("d", map(float, cells)), 0, None
    except ValueError:
        pass
    try:  # every value with its unit: quicker to take the units off them all at once
        without = (cell.rstrip(_UNIT_TAIL) for cell in cells)
        if decimal_comma:
            return array("d", map(float, (cell.replace(",", ".") for cell in without))), 0, None
        return array("d", map(float, without)), 0, None
    except ValueError:
        pass
    out, bad, example = array("d"), 0, None
    for cell in cells:
        try:
            out.append(float(cell.replace(",", ".") if decimal_comma else cell))
        except ValueError:
            text = cell.strip()
            if not text:
                out.append(_NAN)
                continue
            value = _BOOLEANS.get(text.lower())
            written = None if value is not None else _unit_value(text, decimal_comma)
            if value is not None:
                out.append(float(value))
            elif written is not None:
                out.append(_number(written[0], decimal_comma))
            else:
                bad += 1
                example = example or text
                out.append(_NAN)
    return out, bad, example


# Each on and off word's opposite, to name the one a file never uses (a valve that was only ever closed).
_OPPOSITES = {
    "open": "closed",
    "opened": "closed",
    "closed": "open",
    "close": "open",
    "on": "off",
    "off": "on",
    "true": "false",
    "false": "true",
    "yes": "no",
    "no": "yes",
    "high": "low",
    "low": "high",
    "armed": "disarmed",
    "disarmed": "armed",
    "enabled": "disabled",
    "disabled": "enabled",
    "1": "0",
    "0": "1",
}


def _switch_value(name: str) -> int | None:
    """What a state's name says a switch is: 0 for off (closed, 0, false...), 1 for on (open, 1, true...), else None."""
    text = name.strip().lower()
    if text in _BOOLEANS:
        return _BOOLEANS[text]
    try:
        number = float(text)
    except ValueError:
        return None
    return int(number) if number in (0, 1) else None


def _opposite(name: str) -> str:
    """The other state's name (open for closed), written the same way (CLOSED: OPEN)."""
    other = _OPPOSITES.get(name.strip().lower(), "")
    return other.upper() if name.isupper() else other.capitalize() if name[:1].isupper() else other


class _States:
    """A text column's values, numbered in the order they first appear.

    A switch's (a valve's, a command's: any of its values says on or off, however it's written) are numbered again
    once the whole column is read (final): off is 0 (closed, 0, false...), on is 1 (open, 1, true...), and anything
    else (fault, disconnected) comes after them, in the order it appeared. Logs that say closed, 1, fault, and open
    then read as a valve should.
    """

    def __init__(self) -> None:
        self.numbers: dict[str, float] = {}
        self.labels: list[str] = []

    def number(self, cell: str) -> float:
        text = cell.strip()
        if not text:
            return _NAN
        found = self.numbers.get(text)
        if found is None:
            found = self.numbers[text] = float(len(self.labels))
            self.labels.append(text)
        return found

    def read(self, cells: tuple[str, ...]) -> array:
        return array("d", map(self.number, cells))

    @property
    def switch(self) -> bool:
        return any(_switch_value(label) is not None for label in self.labels)

    def final(self) -> tuple[list[str], list[float] | None]:
        """The states' names by number, and each first number's final one (None: numbered as they appeared)."""
        if not self.switch:
            return self.labels, None
        meaning = [_switch_value(label) for label in self.labels]
        rest = [label for label, value in zip(self.labels, meaning, strict=True) if value is None]

        def word(value: int) -> str | None:
            """The file's word for it, if it has one (closed), rather than a digit (0)."""
            return next(
                (
                    label
                    for label, v in zip(self.labels, meaning, strict=True)
                    if v == value and label.strip().lower() in _BOOLEANS
                ),
                None,
            )

        def name(value: int) -> str:
            # Its own word; else the other's word turned around (a log of closed and 1: closed and open); else a digit.
            own, other = word(value), word(1 - value)
            if own or other:
                return own or _opposite(other or "")
            return str(value)

        labels = [name(0), name(1), *rest]
        renumber = [
            float(value) if value is not None else 2.0 + rest.index(label)
            for label, value in zip(self.labels, meaning, strict=True)
        ]
        return labels, renumber


class _Summary:
    """How many values a column has, and their range and total, block by block."""

    __slots__ = ("count", "total", "low", "high", "bad", "example", "example_row")

    def __init__(self) -> None:
        self.count, self.total, self.low, self.high = 0, 0.0, math.inf, -math.inf
        self.bad, self.example, self.example_row = 0, None, 0

    def add(self, values: array) -> None:
        total = sum(values)
        finite: array | list[float] = values
        if not math.isfinite(total):
            finite = list(filter(math.isfinite, values))
            total = sum(finite)
        if finite:
            self.low = min(self.low, min(finite))
            self.high = max(self.high, max(finite))
            self.count += len(finite)
            self.total += total


def _write(values: array, path: Path) -> None:
    if sys.byteorder != "little":
        values = array("d", values)
        values.byteswap()
    with path.open("wb") as file:
        values.tofile(file)


def _load(path: Path, count: int) -> array:
    values = array("d")
    with path.open("rb") as file:
        values.fromfile(file, count)
    if sys.byteorder != "little":
        values.byteswap()
    return values


def _median_step(times: array) -> float | None:
    end = min(len(times), 100_001)
    steps = sorted(itertools.starmap(operator.sub, zip(itertools.islice(times, 1, end), times, strict=False)))
    positive = [step for step in steps if step > 0]
    return positive[len(positive) // 2] if positive else None


# --- reading ------------------------------------------------------------------------------------------------------


def _rows_count(count: int) -> str:
    return "1 row" if count == 1 else f"{count:,} rows"


def read_csv(source: Path, out: Path, options: ReadOptions | None = None) -> ReadResult:
    """Read a CSV file of test data into arrays in out (an empty folder). Raises ReadError if it can't."""
    options = options or ReadOptions()
    layout = _layout(source, options)
    time_column = _time_column(layout, options)
    times = _times(layout, time_column, options)
    columns = [j for j in range(layout.width) if j != time_column]
    warnings: list[str] = []
    if time_column is None and options.time_format != "rows":
        warnings.append(
            "No column looks like time, so time is the row number. To use a column, choose it in Read settings."
        )
    elif time_column is not None and options.time_column is None and not _named_like_time(layout.names[time_column]):
        warnings.append(
            f"No column is named like time, so the first one, {layout.names[time_column]}, is. "
            "If that's wrong, choose the time column in Read settings."
        )

    summaries = {j: _Summary() for j in columns}
    states = {j: _States() for j in columns if layout.kinds[j] != "number"}
    notes: set[int] = set()  # text columns with too many different values to plot
    rows = unreadable_times = long_rows = 0
    unreadable_example: tuple[int, str] | None = None
    in_order, last_time = True, -math.inf
    raw_time = out / "time.raw"
    raw = {j: out / f"c{j}.raw" for j in columns}
    handles = {j: raw[j].open("wb") for j in columns}
    time_handle = raw_time.open("wb")
    try:
        with source.open("rb") as binary:
            text = io.TextIOWrapper(binary, encoding=layout.encoding, errors="replace", newline="")
            reader = _rows(text, layout.delimiter)
            for _ in range(layout.data):
                next(reader, None)
            row_number = layout.data  # of the block's first row, from 0
            while block := list(itertools.islice(reader, BLOCK_ROWS)):
                first_row, row_number = row_number, row_number + len(block)
                if time_column is None:  # time is the row number: a blank line isn't a row
                    block = [row for row in block if row]
                    if not block:
                        continue
                width = layout.width
                if any(len(row) != width for row in block):
                    fixed = []
                    for row in block:
                        if len(row) > width and any(cell.strip() for cell in row[width:]):
                            long_rows += 1
                        fixed.append((row + [""] * (width - len(row)))[:width] if len(row) != width else row)
                    block = fixed
                cells = list(zip(*block, strict=True))
                block_times = times.read(cells[time_column] if time_column is not None else block, first_row)
                kept: list[int] | None = None  # the rows left, by their place in the block, if any were left out
                if not math.isfinite(sum(block_times)):  # rows without a readable time: leave them out
                    keep = [i for i, value in enumerate(block_times) if math.isfinite(value)]
                    for i, value in enumerate(block_times):
                        if not math.isfinite(value) and any(cell.strip() for cell in block[i]):
                            unreadable_times += 1
                            if unreadable_example is None:
                                unreadable_example = (
                                    first_row + i + 1,
                                    cells[time_column][i] if time_column is not None else "",
                                )
                    if not keep:
                        continue
                    kept = keep
                    block = [block[i] for i in keep]
                    block_times = array("d", (block_times[i] for i in keep))
                    cells = list(zip(*block, strict=True))
                if in_order and (
                    block_times[0] < last_time
                    or any(map(operator.gt, block_times, itertools.islice(block_times, 1, None)))
                ):
                    in_order = False
                last_time = block_times[-1]
                block_times.tofile(time_handle)
                rows += len(block_times)
                for j in columns:
                    if j in notes:
                        continue
                    if j in states:
                        values = states[j].read(cells[j])
                        if len(states[j].labels) > MAX_LABELS:
                            notes.add(j)
                            continue
                    else:
                        values, bad, example = _numbers(cells[j], layout.decimal_comma)
                        summary = summaries[j]
                        if bad and summary.count == 0 and not any(map(math.isfinite, values)):
                            # Empty until here, then text: a text column after all (a sequence's steps, which
                            # start after the start of the file).
                            states[j] = _States()
                            values, bad = states[j].read(cells[j]), 0
                        if bad:
                            if summary.bad == 0:
                                at = next(i for i, cell in enumerate(cells[j]) if cell.strip() == example)
                                summary.example = example
                                summary.example_row = first_row + (kept[at] if kept else at) + 1
                            summary.bad += bad
                    summaries[j].add(values)
                    values.tofile(handles[j])
    except (csv.Error, UnicodeError) as error:
        raise ReadError(
            f"Couldn't read the file as {_DELIMITER_NAMES[layout.delimiter]}-separated text: {error}"
        ) from None
    finally:
        time_handle.close()
        for handle in handles.values():
            handle.close()

    if rows == 0:
        raise ReadError("None of the rows had a time that could be read. Choose the time column in Read settings.")
    if unreadable_times:
        row, cell = unreadable_example or (0, "")
        warnings.append(f"Left out {_rows_count(unreadable_times)} whose time couldn't be read (row {row}: {cell!r}).")
    if long_rows:
        warnings.append(
            f"{_rows_count(long_rows)} had more cells than there are columns; the extra cells were left out."
        )

    time_values = _load(raw_time, rows)
    raw_time.unlink()
    order: list[int] | None = None
    if not in_order:
        order = sorted(range(rows), key=time_values.__getitem__)
        time_values = array("d", map(time_values.__getitem__, order))
        warnings.append("The rows weren't in time order, so they were put in order.")
    _write(time_values, out / "time.f64")

    channels: list[ChannelData] = []
    events: list[dict[str, Any]] = []
    for j in columns:
        name, summary = layout.names[j], summaries[j]
        if j in notes:
            warnings.append(f"Left out {name}: it's text with more than {MAX_LABELS} different values, not a signal.")
            raw[j].unlink()
            continue
        if summary.count == 0:
            if layout.named[j]:
                warnings.append(f"Left out {name}: it has no values.")
            raw[j].unlink()
            continue
        if summary.bad:
            what = "cell wasn't a number" if summary.bad == 1 else "cells weren't numbers"
            left = "it was" if summary.bad == 1 else "they were"
            warnings.append(
                f"{name}: {summary.bad:,} {what} (row {summary.example_row}: {summary.example!r}),"
                f" so {left} left empty."
            )
        values = _load(raw[j], rows)
        raw[j].unlink()
        if order is not None:
            values = array("d", map(values.__getitem__, order))
        state = states.get(j)
        if state is not None and not state.switch and summary.count <= min(rows * EVENT_SHARE, MAX_EVENTS):
            events.extend(
                {"t": time_values[i], "label": state.labels[int(value)], "channel": name}
                for i, value in enumerate(values)
                if value == value  # not NaN
            )
            continue
        labels = state.labels if state is not None else []
        if state is not None:
            labels, renumber = state.final()
            if renumber is not None:
                values = array("d", (renumber[int(value)] if value == value else value for value in values))
                known = [value for value in values if value == value]
                summary.low, summary.high, summary.total = min(known), max(known), sum(known)
        if summary.count <= rows * SPARSE_SHARE:  # mostly empty: keep only its own samples, with their times
            has_value = list(map(math.isfinite, values))
            own_times = array("d", itertools.compress(time_values, has_value))
            values = array("d", itertools.compress(values, has_value))
            time_file = f"c{j}.t.f64"
            _write(own_times, out / time_file)
            t_min, t_max = own_times[0], own_times[-1]
        else:
            time_file = "time.f64"
            first = next(i for i, value in enumerate(values) if math.isfinite(value))
            last = next(i for i in range(rows - 1, -1, -1) if math.isfinite(values[i]))
            t_min, t_max = time_values[first], time_values[last]
        value_file = f"c{j}.f64"
        _write(values, out / value_file)
        channels.append(
            ChannelData(
                position=j,
                name=name,
                unit=layout.units_of[j],
                kind="number" if state is None else "state",
                labels=[label or str(i) for i, label in enumerate(labels)],
                decimals=layout.decimals[j],
                count=summary.count,
                min=summary.low,
                max=summary.high,
                mean=summary.total / summary.count,
                t_min=t_min,
                t_max=t_max,
                time_file=time_file,
                value_file=value_file,
            )
        )
    events.sort(key=operator.itemgetter("t"))

    step = _median_step(time_values)
    format = times.format if time_column is not None else "rows"
    info = {
        "encoding": layout.encoding,
        "delimiter": _DELIMITER_NAMES[layout.delimiter],
        "decimal_comma": layout.decimal_comma,
        "header_row": layout.header + 1 if layout.header is not None else 0,
        "units_row": layout.units + 1 if layout.units is not None else None,
        "first_data_row": layout.data + 1,
        "time_column": layout.names[time_column] if time_column is not None else None,
        "time_format": format,
        "utc_offset": times.utc_offset,
    }
    return ReadResult(
        rows=rows,
        time_kind=times.kind,
        start_epoch=times.start_epoch,
        t_min=time_values[0],
        t_max=time_values[-1],
        sample_rate=1 / step if step else None,
        channels=channels,
        events=events[:MAX_EVENTS],
        warnings=warnings,
        info=info,
    )
