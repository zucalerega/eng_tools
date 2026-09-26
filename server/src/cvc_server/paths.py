"""Vault paths: '/'-separated, case-insensitive, and valid on Windows.

Workspaces are Windows folders, so every vault path must be a legal Windows
path, and two names that differ only in case are the same file.
"""

import unicodedata

from .errors import CvcError

# C:\CVC\ plus 200 characters stays under Windows' 260-character limit, which SolidWorks doesn't lift.
MAX_PATH = 200
MAX_NAME = 255
_INVALID = frozenset('<>:"/\\|?*')
_RESERVED = frozenset(
    ["CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))]
)


class PathError(CvcError):
    code = "bad_path"


def clean_name(name: str) -> str:
    """Validate one file or folder name; returns it NFC-normalized."""
    name = unicodedata.normalize("NFC", name)
    if name in ("", ".", ".."):
        raise PathError(f"{name!r} is not a valid name")
    if len(name) > MAX_NAME:
        raise PathError(f"{name[:40]}... is longer than {MAX_NAME} characters")
    bad = sorted({c for c in name if c in _INVALID or ord(c) < 32})
    if bad:
        raise PathError(f"{name!r} contains characters Windows doesn't allow: {' '.join(map(repr, bad))}")
    if name != name.strip() or name.endswith("."):
        raise PathError(f"{name!r} starts or ends with a space, or ends with a dot")
    if name.split(".")[0].upper() in _RESERVED:
        raise PathError(f"{name!r} is a reserved name on Windows")
    if name.startswith("~$"):
        raise PathError(f"{name!r} is a SolidWorks/Office temporary file")
    return name


def split(path: str) -> list[str]:
    """Validated names along a vault path ('/' or '\\' separated); [] is the root."""
    names = [clean_name(part) for part in path.replace("\\", "/").split("/") if part]
    if len("/".join(names)) > MAX_PATH:
        raise PathError(f"{path[:60]}... is longer than {MAX_PATH} characters")
    return names


def key(name: str) -> str:
    """Comparison key for names and paths: case-insensitive, as on Windows."""
    return unicodedata.normalize("NFC", name).lower()


def join(*names: str) -> str:
    return "/".join(n for n in names if n)
