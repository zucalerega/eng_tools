"""Vault paths: '/'-separated, case-insensitive, and valid on Windows.

Workspaces are Windows folders, so every vault path must be a legal Windows
path, and two names that differ only in case are the same file.
"""

import unicodedata

from .errors import ApiError

# C:\VLT\ plus 200 characters stays under Windows' 260-character limit, which SolidWorks doesn't lift.
MAX_PATH = 200
MAX_NAME = 255
_INVALID = frozenset('<>:"/\\|?*')
_RESERVED = frozenset(
    ["CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))]
)


class PathError(ApiError):
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


def extension(name: str) -> str:
    """'.sldprt' for 'Fin.SLDPRT': lowercase, with the dot; '' if there's none."""
    dot = name.rfind(".")
    return key(name[dot:]) if dot > 0 else ""


def is_drawing(name: str) -> bool:
    return extension(name) == ".slddrw"


def is_model(name: str) -> bool:
    """A part or an assembly: what a drawing shows."""
    return extension(name) in (".sldprt", ".sldasm")


def named_after(drawing: str, model: str) -> bool:
    """Whether a drawing is named after a model: Fin.SLDDRW, or 'Fin - machining.SLDDRW', for Fin.SLDPRT.

    The drawing's name is the model's, or starts with it and goes on after a space or a symbol, so
    'Fin2' or 'Finish' aren't drawings of Fin.
    """
    stem = key(drawing[: len(drawing) - len(extension(drawing))])
    base = key(model[: len(model) - len(extension(model))])
    return stem == base or (stem.startswith(base) and not stem[len(base)].isalnum())


def join(*names: str) -> str:
    return "/".join(n for n in names if n)
