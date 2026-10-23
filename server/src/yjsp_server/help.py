"""The help: the user guide, the SolidWorks add-in's, troubleshooting, and how Vault and Yorg work, all from the
repository's own docs (Settings.help_dir). It's one page anyone can open (/help, api/help.py), Markdown for AI tools
(/help.md), and what the assistant reads (assistant.py).

The guide, the add-in's, and troubleshooting are public, for someone who can't sign in yet, or an AI tool pointed at
the site. How the site works inside (the design docs) is for signed-in members only, as the repository is private.
Sections for developers (running a server, the checks before a release) are left out: they're in the repository.
"""

import posixpath
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from markdown_it import MarkdownIt
from markdown_it.token import Token


@dataclass(frozen=True)
class Part:
    key: str  # its anchor on the page, and the start of its sections' anchors (vault-api)
    path: str  # the file, in the repository
    public: bool  # anyone sees it; otherwise only signed-in members
    skip: tuple[str, ...] = ()  # its sections (## headings) for developers, left out


# What's in the help, in the page's order: the one list, for the page, the Markdown, and the assistant alike.
PARTS = (
    Part("guide", "README.md", True, skip=("Layout", "Run the server locally", "Tests", "The live site")),
    Part(
        "solidworks",
        "client/src/Vault.SolidWorks/README.md",
        True,
        skip=("Testing against a development server", "Manual checks before a release"),
    ),
    Part("troubleshooting", "docs/troubleshooting.md", True),
    Part("design", "docs/design.md", False),
    Part("vault", "docs/vault.md", False),
    Part("yorg", "docs/yorg.md", False),
)

# CommonMark with tables, and never HTML from the docs: <name> in a sentence stays text.
_MARKDOWN = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])
_FENCE = re.compile(r"^\s*(```|~~~)")
_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_LINK = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")
_CODE = re.compile(r"(`+[^`]*`+)")
_WEB = re.compile(r"^(https?:|mailto:)", re.IGNORECASE)


@dataclass(frozen=True)
class Section:
    """A heading in the contents: a part's title (level 1), or one of its sections (level 2)."""

    id: str
    title: str
    level: int


@dataclass
class Doc:
    part: Part
    source: str  # its Markdown, without the sections for developers
    title: str
    sections: list[Section]
    headings: dict[int, str]  # each heading's anchor, by its line in source
    anchors: set[str]


@dataclass
class Help:
    docs: list[Doc]  # the parts this server has, in order
    # Made once for each set of files (load): the page's HTML, for members and for anyone, and what the assistant reads.
    _html: dict[bool, str] = field(default_factory=dict)
    _for_assistant: str | None = None

    def shown(self, members: bool) -> list[Doc]:
        """What someone sees: everything if they're a signed-in member, the public parts otherwise."""
        return [doc for doc in self.docs if members or doc.part.public]

    def html(self, members: bool) -> str:
        """The parts, as HTML for the page: every heading with its anchor, and links between the parts to theirs."""
        if members not in self._html:
            shown = self.shown(members)
            self._html[members] = "\n".join(_render(doc, shown) for doc in shown)
        return self._html[members]

    def markdown(self, members: bool, page: str) -> str:
        """The parts as one Markdown document, for AI tools: each heading ends with its anchor ({#vault-api}), and a
        link between the parts goes to the page, at `page` (the help page's address) plus the anchor."""
        shown = self.shown(members)
        return "\n\n".join(_markdown(doc, shown, lambda anchor: f"{page}#{anchor}") for doc in shown)

    def for_assistant(self) -> str:
        """Everything in the help, as the assistant reads it: each part in a <doc> saying where it's from, its
        headings with their anchors on the page, and links between the parts to the page (/help#vault-api)."""
        if self._for_assistant is None:
            self._for_assistant = "\n\n".join(
                f'<doc source="{doc.part.path}" page="/help#{doc.part.key}">\n'
                f"{_markdown(doc, self.docs, lambda anchor: f'/help#{anchor}')}\n</doc>"
                for doc in self.docs
            )
        return self._for_assistant


def load(folder: Path) -> Help:
    """The help as its files are now: read again only when one of them has changed (or appeared, or gone)."""
    return _load(folder, tuple(_stamp(folder / part.path) for part in PARTS))


def _stamp(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_mtime_ns, stat.st_size


@lru_cache(maxsize=4)
def _load(folder: Path, stamps: tuple[tuple[int, int] | None, ...]) -> Help:
    docs = []
    for part, stamp in zip(PARTS, stamps, strict=True):
        if stamp is not None:
            text = (folder / part.path).read_bytes().decode("utf-8", errors="replace").replace("\r\n", "\n")
            docs.append(_read(part, _without(text, part.skip)))
    return Help(docs)


def _without(text: str, skip: Iterable[str]) -> str:
    """The text without the ## sections named: each from its heading to the next heading of its level or above."""
    skip = set(skip)
    kept: list[str] = []
    dropping = fenced = False
    for line in text.split("\n"):
        heading = None if fenced else _HEADING.match(line)
        if _FENCE.match(line):
            fenced = not fenced
        if heading and len(heading[1]) <= 2:
            dropping = len(heading[1]) == 2 and heading[2] in skip
        if not dropping:
            kept.append(line)
    return "\n".join(kept).strip("\n") + "\n"


def slug(text: str) -> str:
    """A heading's anchor as GitHub makes it, so a link from one doc to another works on GitHub and here alike."""
    return re.sub(r"[^\w\- ]", "", text.lower()).replace(" ", "-")


def _plain(inline: Token) -> str:
    """A heading's words, without their Markdown: `vault` and **Update** are vault and Update."""
    return "".join(child.content for child in inline.children or [] if child.type in ("text", "code_inline"))


def _read(part: Part, source: str) -> Doc:
    """A part's headings and their anchors: its title is the part's own (vault); the rest are within it (vault-api),
    numbered as GitHub numbers repeats (vault-api-1)."""
    tokens = _MARKDOWN.parse(source)
    title, sections, headings, used = "", [], {}, {}
    for index, token in enumerate(tokens):
        if token.type != "heading_open" or token.map is None:
            continue
        words = _plain(tokens[index + 1])
        level = int(token.tag[1])
        if level == 1 and not title:
            title, anchor = words, part.key
        else:
            base = f"{part.key}-{slug(words)}"
            count = used.get(base, 0)
            used[base] = count + 1
            anchor = base if count == 0 else f"{base}-{count}"
        headings[token.map[0]] = anchor
        if level <= 2:
            sections.append(Section(anchor, words, level))
    return Doc(part, source, title or part.key, sections, headings, set(headings.values()))


def _target(doc: Doc, href: str, shown: list[Doc]) -> tuple[str, str] | None:
    """Where a link in a doc goes: ("anchor", "vault-api") for a place in the help that's shown, ("url", href) for the
    web, mail, or a page of the site, and None for a file the help doesn't show (it stays as text)."""
    if _WEB.match(href) or href.startswith("/"):
        return "url", href
    path, _, fragment = href.partition("#")
    if not path:
        found: Doc | None = doc
    else:
        wanted = posixpath.normpath(posixpath.join(posixpath.dirname(doc.part.path), path))
        found = next((d for d in shown if d.part.path == wanted), None)
    if found is None:
        return None
    anchor = f"{found.part.key}-{fragment}" if fragment else found.part.key
    return "anchor", anchor if anchor in found.anchors else found.part.key


def _render(doc: Doc, shown: list[Doc]) -> str:
    tokens = _MARKDOWN.parse(doc.source)
    for token in tokens:
        if token.type == "heading_open" and token.map is not None and token.map[0] in doc.headings:
            token.attrSet("id", doc.headings[token.map[0]])
        for at, child in enumerate(token.children or []):
            if child.type != "link_open":
                continue
            target = _target(doc, str(child.attrGet("href") or ""), shown)
            if target is None:
                # A file that isn't in the help: its words stay, without the link.
                close = next(i for i in range(at, len(token.children or [])) if token.children[i].type == "link_close")
                token.children[at] = Token("text", "", 0)
                token.children[close] = Token("text", "", 0)
            else:
                kind, where = target
                child.attrSet("href", f"#{where}" if kind == "anchor" else where)
    html = _MARKDOWN.renderer.render(tokens, _MARKDOWN.options, {})
    # A wide table scrolls on its own, rather than the whole page.
    return html.replace("<table>", '<div class="table"><table>').replace("</table>", "</table></div>")


def _markdown(doc: Doc, shown: list[Doc], link: Callable[[str], str]) -> str:
    lines = doc.source.rstrip("\n").split("\n")
    fenced = False
    for number, line in enumerate(lines):
        if _FENCE.match(line):
            fenced = not fenced
            continue
        if fenced:
            continue
        if number in doc.headings:
            line = f"{line} {{#{doc.headings[number]}}}"
        # Code spans keep what's in them as it is: only the text between them has links.
        pieces = _CODE.split(line)
        for at in range(0, len(pieces), 2):
            pieces[at] = _LINK.sub(lambda match: _relink(doc, match, shown, link), pieces[at])
        lines[number] = "".join(pieces)
    return "\n".join(lines)


def _relink(doc: Doc, match: re.Match[str], shown: list[Doc], link: Callable[[str], str]) -> str:
    words, href = match[1], match[2]
    target = _target(doc, href, shown)
    if target is None:
        return words
    kind, where = target
    return f"[{words}]({link(where) if kind == 'anchor' else where})"
