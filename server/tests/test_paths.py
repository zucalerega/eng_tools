import pytest

from yjsp_server.vault import paths
from yjsp_server.vault.paths import PathError


@pytest.mark.parametrize("name", ["Fin.SLDPRT", "Nose cone v2.SLDASM", "Ø-ring 38mm.STEP", ".gitignore", "Rev(A)"])
def test_valid_names(name):
    assert paths.clean_name(name) == name


@pytest.mark.parametrize(
    "name",
    [
        "",
        ".",
        "..",
        "a:b",
        "what?.step",
        'quote".x',
        "con",
        "CON.txt",
        "Lpt1.sldprt",
        "dot.",
        "space ",
        " lead",
        "~$Fin.SLDPRT",
        "tab\there",
    ],
)
def test_names_windows_rejects(name):
    with pytest.raises(PathError):
        paths.clean_name(name)


def test_split_accepts_either_slash_and_ignores_extras():
    assert paths.split("\\Structures//Fins/") == ["Structures", "Fins"]
    assert paths.split("") == []


def test_names_normalize_to_nfc():
    decomposed = "Me\u0301canique.STEP"  # macOS spells é as e + combining accent
    assert paths.clean_name(decomposed) == "M\u00e9canique.STEP"
    assert paths.key(decomposed) == paths.key("m\u00e9canique.step")


def test_case_insensitive_keys():
    assert paths.key("Fin.SLDPRT") == paths.key("fin.sldprt")


def test_path_length_limit():
    paths.split("/".join(["a" * 9] * 20))  # 199 characters
    with pytest.raises(PathError):
        paths.split("/".join(["a" * 9] * 21))


@pytest.mark.parametrize(
    ("drawing", "model", "expected"),
    [
        ("Fin.SLDDRW", "Fin.SLDPRT", True),
        ("fin.slddrw", "FIN.SLDPRT", True),
        ("Fin - machining.SLDDRW", "Fin.SLDPRT", True),
        ("Fin (sheet 2).SLDDRW", "Fin.SLDPRT", True),
        ("Fin_flat.SLDDRW", "Fin.SLDPRT", True),
        ("Fin Can.SLDDRW", "Fin Can.SLDASM", True),
        ("Fin2.SLDDRW", "Fin.SLDPRT", False),  # another part's name
        ("Finish.SLDDRW", "Fin.SLDPRT", False),
        ("Bracket.SLDDRW", "Fin.SLDPRT", False),
        ("Fin.SLDDRW", "Fin Can.SLDASM", False),
    ],
)
def test_drawings_are_named_after_what_they_show(drawing, model, expected):
    assert paths.named_after(drawing, model) is expected
