"""Part numbers: NNNNNNNN-KKK, such as 00000123-001 (docs/vault.md, "Part numbers").

The server hands out the 8 digits in order, and the 3-digit kind says what kind of thing it is, from the list admins
keep (PartKind). A part's or an assembly's number is its name, and never changes; its drawings, and PDFs and exports
of it, are named after it ("00000123-001 - machining.SLDDRW"). Vendors' parts keep their vendors' names.

These rules are pure: vault.py holds the vault to them, with what it knows of which numbers were handed out and which
files have them. Vault's client (PartNumbers.cs) and the web app (paths.ts) have the same rules, and their tests the
same cases as tests/test_numbers.py.
"""

import re
from dataclasses import dataclass
from typing import Literal

from . import paths

DIGITS = 8
LARGEST = 10**DIGITS - 1

# A number, its kind, and then the end of the name or a symbol or a space before more: "00000123-001",
# "00000123-001 - machining", "00000004-010-6"; not "00000123-0011". Digits are 0-9 alone (not \d, which takes any
# script's), as the clients have them.
_NUMBERED = re.compile(r"^([0-9]{8})-([0-9]{3})(?![0-9A-Za-z])")
_KIND = re.compile(r"^[0-9]{3}$")
# McMaster-Carr's part numbers, which their files are named by: 91251A463, 5911K12, "91251A463_Socket Head Screw".
_MCMASTER = re.compile(r"^[0-9]{4,5}[A-Za-z][0-9]{1,4}(?![0-9A-Za-z])")

# The files that take numbers of their own: SolidWorks parts and assemblies, and STEP and STL files we make. A STEP or
# STL file whose number a part or an assembly has is an export of it, named after it.
HOLDERS = (".sldprt", ".sldasm", ".step", ".stp", ".stl")
EXPORTS = (".step", ".stp", ".stl")
_ASSEMBLIES = (".sldasm",)


@dataclass(frozen=True)
class Numbered:
    """A name that starts with a part number."""

    number: int
    kind: str
    exact: bool  # the name is the number, with nothing after it but its type

    @property
    def text(self) -> str:
        return text(self.number, self.kind)


def text(number: int, kind: str) -> str:
    """00000123-001: how a part number is written."""
    return f"{digits(number)}-{kind}"


def digits(number: int) -> str:
    """00000123: how a number is written, without its kind."""
    return f"{number:0{DIGITS}d}"


def parse(name: str) -> Numbered | None:
    """The part number a file's name starts with (its type left off), or None for a name that doesn't."""
    stem = paths.stem(name)
    found = _NUMBERED.match(stem)
    if found is None:
        return None
    return Numbered(int(found.group(1)), found.group(2), exact=len(stem) == found.end())


def is_kind(code: str) -> bool:
    """Whether a kind's code is three digits: 001."""
    return _KIND.match(code) is not None


def holds(name: str) -> bool:
    """Whether a file of this type takes a number of its own (HOLDERS), as against being named after one."""
    return paths.extension(name) in HOLDERS


def applies_to(name: str) -> Literal["part", "assembly"]:
    """What kind of thing a file holding a number is, for which kinds it can have: an assembly, or a part."""
    return "assembly" if paths.extension(name) in _ASSEMBLIES else "part"


def fits(applies: str, name: str) -> bool:
    """Whether a kind for parts, assemblies, or any (PartKind.applies) can be the kind of this file's number."""
    return applies == "any" or applies == applies_to(name)


def exports(name: str) -> bool:
    """Whether a file can be a part's or an assembly's export (STEP, STL), named after the number it has."""
    return paths.extension(name) in EXPORTS


def vendors(name: str) -> bool:
    """Whether a file is named as a vendor names its parts (McMaster-Carr's numbers): such a file keeps its name."""
    return _MCMASTER.match(paths.stem(name)) is not None
