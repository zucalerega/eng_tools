"""The rules of part numbers' names. Vault's client (PartNumbersTests.cs) and the web app (paths.test.ts) have the same
cases: they must agree on what's a part number."""

import pytest

from yjsp_server.vault import numbers


@pytest.mark.parametrize(
    ("name", "number", "kind", "exact"),
    [
        ("00000123-001.SLDPRT", 123, "001", True),
        ("00000123-501.sldasm", 123, "501", True),
        ("00000123-001", 123, "001", True),  # no type
        ("00000123-001 - machining.SLDDRW", 123, "001", False),
        ("00000123-001.PDF", 123, "001", True),
        ("00000004-010-6.SLDPRT", 4, "010", False),  # Ground Structures' numbers, from before
        ("00000004-501 downloads backup.SLDASM", 4, "501", False),
        ("99999999-999.STEP", 99999999, "999", True),
    ],
)
def test_names_that_are_part_numbers(name, number, kind, exact):
    assert numbers.parse(name) == numbers.Numbered(number, kind, exact)


@pytest.mark.parametrize(
    "name",
    [
        "Fin.SLDPRT",
        "0000123-001.SLDPRT",  # seven digits
        "000000123-001.SLDPRT",  # nine
        "00000123-01.SLDPRT",
        "00000123-0011.SLDPRT",
        "00000123-001a.SLDPRT",  # a kind runs on into letters: not one
        "00000123_001.SLDPRT",
        "91251A463_Socket Head Screw.SLDPRT",
        "1341617 VUVS-L20-COVER CAP.SLDPRT",
    ],
)
def test_names_that_arent(name):
    assert numbers.parse(name) is None


def test_how_numbers_are_written():
    assert numbers.text(123, "001") == "00000123-001"
    assert numbers.parse("00000123-001.SLDPRT").text == "00000123-001"


@pytest.mark.parametrize(
    ("name", "holds", "applies"),
    [
        ("00000123-001.SLDPRT", True, "part"),
        ("00000123-501.SLDASM", True, "assembly"),
        ("00000123-001.STEP", True, "part"),
        ("00000123-001.stp", True, "part"),
        ("00000123-001.STL", True, "part"),
        ("00000123-001.SLDDRW", False, "part"),
        ("00000123-001.PDF", False, "part"),
    ],
)
def test_which_files_hold_numbers(name, holds, applies):
    assert (numbers.holds(name), numbers.applies_to(name)) == (holds, applies)


def test_kinds_fit_parts_assemblies_or_any():
    assert numbers.fits("part", "Fin.SLDPRT") and numbers.fits("any", "Fin.SLDPRT")
    assert not numbers.fits("assembly", "Fin.SLDPRT")
    assert numbers.fits("assembly", "Fin Can.SLDASM") and not numbers.fits("part", "Fin Can.SLDASM")


@pytest.mark.parametrize(("code", "ok"), [("001", True), ("501", True), ("01", False), ("0001", False), ("a01", False)])
def test_kinds_are_three_digits(code, ok):
    assert numbers.is_kind(code) is ok


@pytest.mark.parametrize(
    ("name", "vendor"),
    [
        ("91251A463.SLDPRT", True),
        ("91251A463_Socket Head Screw.SLDPRT", True),
        ("5911K12 Ball Valve.SLDASM", True),
        ("90107a029.STEP", True),
        ("Fin.SLDPRT", False),
        ("00000123-001.SLDPRT", False),  # a part number is never a vendor's
        ("91251A463B.SLDPRT", False),
        ("102423 Stringer.SLDPRT", False),
    ],
)
def test_vendors_names(name, vendor):
    assert numbers.vendors(name) is vendor
