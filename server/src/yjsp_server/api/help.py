"""The help, as a page anyone can open (/help), and as Markdown for AI tools (/help.md, and /llms.txt, which points AI
tools to it). help.py has what's in it; signed-in members see how Vault and Yorg work inside too."""

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response
from sqlalchemy.orm import Session

from .. import __version__, help
from ..models import UserStatus
from .deps import DB, Config, session_user
from .pages import FAVICON, GOLD, PALETTE, SITE, THEME, esc

router = APIRouter(include_in_schema=False)

_ORBIT = (
    '<svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">'
    f'<path d="M4 57Q42 52 60 5Q36 45 4 57Z" fill="{GOLD}"/></svg>'
)
_STYLE = f"""{PALETTE}
  body {{ margin: 0; background: var(--bg); color: var(--text); }}
  a {{ color: var(--accent); }}
  .bar {{ position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: .75rem; height: 3.5rem;
    padding: 0 1.25rem; background: #08111f; color: #fff; border-bottom: 2px solid {GOLD}; }}
  .brand {{ display: inline-flex; align-items: center; gap: .55rem; color: #fff; text-decoration: none;
    font-family: Bahnschrift, "DIN Alternate", Rubik, "Segoe UI", sans-serif; font-size: 1.1rem; font-weight: 700;
    letter-spacing: .22em; }}
  .where {{ color: #b9c4d6; font-size: .95rem; }}
  .grow {{ flex: 1; }}
  .bar a.action, .bar button {{ display: inline-flex; align-items: center; height: 2.1rem; padding: 0 .8rem;
    border: 1px solid rgb(255 255 255 / 28%); border-radius: 6px; background: transparent; color: #fff; font: inherit;
    font-size: .9rem; font-weight: 600; text-decoration: none; white-space: nowrap; cursor: pointer; }}
  .bar a.action:hover, .bar button:hover {{ background: rgb(255 255 255 / 10%); }}
  .bar a.primary {{ background: var(--primary); border-color: var(--primary); }}
  .layout {{ display: grid; grid-template-columns: 16rem minmax(0, 1fr); gap: 2.5rem; max-width: 76rem;
    margin: 0 auto; padding: 1.5rem 1.25rem 5rem; }}
  .contents {{ position: sticky; top: 5rem; align-self: start; max-height: calc(100vh - 6rem); overflow: auto;
    font-size: .9rem; }}
  .contents ul {{ list-style: none; margin: 0; padding: 0; }}
  .contents ul ul {{ margin: 0 0 .5rem .7rem; }}
  .contents a {{ display: block; padding: .18rem .5rem; border-radius: 6px; color: var(--text);
    text-decoration: none; }}
  .contents a:hover {{ background: var(--surface); }}
  .contents li.part > a {{ margin-top: .4rem; font-weight: 600; }}
  .tag {{ margin-left: .35rem; color: var(--muted); font-size: .75rem; font-weight: 400; }}
  .contents p {{ margin: 1rem .5rem; color: var(--muted); font-size: .82rem; }}
  .contents p a {{ display: inline; padding: 0; color: var(--accent); text-decoration: underline; }}
  main {{ min-width: 0; max-width: 50rem; }}
  .intro {{ padding: 1.1rem 1.35rem; background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; }}
  .intro h1 {{ margin: 0 0 .5rem; font-family: Bahnschrift, "DIN Alternate", Rubik, "Segoe UI", sans-serif;
    font-size: 1.6rem; }}
  .intro p {{ margin: .5rem 0; }}
  .doc h1 {{ margin: 3rem 0 1rem; padding-top: 1.25rem; border-top: 1px solid var(--border);
    font-family: Bahnschrift, "DIN Alternate", Rubik, "Segoe UI", sans-serif; font-size: 1.75rem; }}
  .doc h2 {{ margin: 2.2rem 0 .7rem; font-size: 1.35rem; }}
  .doc h3 {{ margin: 1.6rem 0 .5rem; font-size: 1.1rem; }}
  h1, h2, h3, h4 {{ scroll-margin-top: 4.5rem; line-height: 1.25; }}
  .doc li {{ margin: .3rem 0; }}
  code {{ padding: .05rem .3rem; border: 1px solid var(--border); border-radius: 4px; background: var(--surface);
    font-family: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace; font-size: .86em; }}
  pre {{ padding: .75rem 1rem; overflow: auto; border: 1px solid var(--border); border-radius: 6px;
    background: var(--surface); }}
  pre code {{ padding: 0; border: 0; background: none; }}
  .table {{ overflow-x: auto; margin: 1rem 0; }}
  table {{ border-collapse: collapse; font-size: .92rem; }}
  th, td {{ padding: .4rem .6rem; border: 1px solid var(--border); text-align: left; vertical-align: top; }}
  th {{ background: var(--surface); }}
  blockquote {{ margin: 1rem 0; padding: .1rem 1rem; border-left: 3px solid {GOLD}; color: var(--muted); }}
  @media (max-width: 54rem) {{
    .layout {{ grid-template-columns: minmax(0, 1fr); gap: 1rem; }}
    .contents {{ position: static; max-height: none; }}
    .contents ul ul, .where, .bar a.markdown {{ display: none; }}
  }}
"""
# Copy for an AI: the help as Markdown, on the clipboard. A ClipboardItem can wait for it to download (Safari wants the
# click and the copy together); without one, it's copied once it's here, and failing that, opened to copy by hand.
_COPY = """<script>
document.getElementById("copy").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const text = () => fetch("/help.md", { credentials: "same-origin" }).then((r) => r.text());
  try {
    if (window.ClipboardItem && navigator.clipboard.write) {
      const blob = text().then((t) => new Blob([t], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    } else {
      await navigator.clipboard.writeText(await text());
    }
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy for an AI"), 2500);
  } catch (error) {
    window.open("/help.md", "_blank");
  }
});
</script>"""


def _member(request: Request, db: Session) -> bool:
    """Whether the browser is a signed-in member's, who sees how Vault and Yorg work inside too."""
    user = session_user(request, db)
    return user is not None and user.status == UserStatus.ACTIVE


def _contents(found: help.Help, members: bool) -> str:
    items = []
    for doc in found.shown(members):
        sections = "".join(f'<li><a href="#{esc(s.id)}">{esc(s.title)}</a></li>' for s in doc.sections if s.level == 2)
        tag = "" if doc.part.public else '<span class="tag">members</span>'
        items.append(
            f'<li class="part"><a href="#{esc(doc.part.key)}">{esc(doc.title)}{tag}</a>'
            + (f"<ul>{sections}</ul>" if sections else "")
            + "</li>"
        )
    more = (
        ""
        if members
        else '<p>Signed in, members also see how Vault and Yorg work inside: <a href="/?next=/help">sign in</a>.</p>'
    )
    return f'<nav class="contents" aria-label="Contents"><ul>{"".join(items)}</ul>{more}</nav>'


@router.get("/help", response_class=HTMLResponse)
def help_page(request: Request, db: DB, settings: Config) -> HTMLResponse:
    """The help, for anyone: the guide, the SolidWorks add-in, and troubleshooting; and for members, the design too."""
    members = _member(request, db)
    found = help.load(settings.help_dir)
    site = esc(settings.public_url.rstrip("/"))
    if members:
        asking = (
            "<p>In the web app, <strong>Help</strong> (top right) asks Claude, which has read all of this and answers "
            "with links to it.</p>"
        )
        account = '<a class="action primary" href="/">Open YJSP</a>'
    else:
        asking = (
            "<p>Members can also ask Claude, which has read all of this, from <strong>Help</strong> in the web app.</p>"
        )
        account = '<a class="action primary" href="/?next=/help">Sign in</a>'
    body = found.html(members) if found.docs else "<p>The help isn't on this server.</p>"
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Help · {SITE}</title>
<meta name="description" content="Help for YJSP, the Yellow Jacket Space Program's engineering tools: Vault and Yorg.">
<link rel="alternate" type="text/markdown" href="/help.md" title="The help, as Markdown">
<link rel="icon" href="{esc(FAVICON)}">{THEME}<style>{_STYLE}</style></head>
<body><header class="bar"><a class="brand" href="/">{_ORBIT}{SITE}</a><span class="where">Help</span>
<span class="grow"></span><a class="action markdown" href="/help.md">Markdown</a>
<button type="button" id="copy">Copy for an AI</button>{account}</header>
<div class="layout">{_contents(found, members)}<main>
<section class="intro"><h1>Help</h1>
<p>YJSP is the Yellow Jacket Space Program's engineering tools: <strong>Vault</strong>, for the team's SolidWorks and
STEP files, and <strong>Yorg</strong>, for its test data. Find your way with the contents, or search the page (Ctrl+F)
for words from a message you saw: <a href="#troubleshooting">Troubleshooting</a> has what each error means.</p>
<p>Working it out with an AI assistant (ChatGPT, Claude, Gemini)? <strong>Copy for an AI</strong> puts all of this on
your clipboard as Markdown, to paste into a chat with it, or give it this address: <code>{site}/help.md</code>.</p>
{asking}</section>
<div class="doc">{body}</div></main></div>{_COPY}</body></html>"""
    return HTMLResponse(page, headers={"Cache-Control": "no-cache"})


@router.get("/help.md")
def help_markdown(request: Request, db: DB, settings: Config) -> Response:
    """The help as one Markdown document, for an AI tool: what the page shows whoever asks."""
    members = _member(request, db)
    found = help.load(settings.help_dir)
    site = settings.public_url.rstrip("/")
    preface = f"""# YJSP help

> For an AI assistant helping someone with YJSP (version {__version__}): this is the site's own help, from {site}/help.
> YJSP is the Yellow Jacket Space Program's engineering tools: Vault, version control for the team's SolidWorks and
> STEP files, and Yorg, for its test data. Answer from this help, and say so when it doesn't cover something: then the
> person should ask the team's admins. Each heading ends with its anchor on the page ({{#vault-api}} is
> {site}/help#vault-api), for linking to it.
"""
    text = preface + "\n" + found.markdown(members, f"{site}/help") + "\n"
    return Response(text, media_type="text/markdown; charset=utf-8", headers={"Cache-Control": "no-cache"})


@router.get("/llms.txt")
def llms_txt(settings: Config) -> Response:
    """Where an AI tool finds the help (llmstxt.org): the Markdown, and the page."""
    site = settings.public_url.rstrip("/")
    text = f"""# {SITE}

> The Yellow Jacket Space Program's engineering tools: Vault, version control for the team's SolidWorks and STEP files
> (check-out and check-in, version history, folder permissions, a SolidWorks add-in), and Yorg, for its test data (CSV
> files from hotfires and cold flows, plotted on one time axis).

## Docs

- [YJSP help]({site}/help.md): the user guide, the SolidWorks add-in, troubleshooting, and what each error means, as
  one Markdown document
- [The help page]({site}/help): the same, as a web page
"""
    return Response(text, media_type="text/plain; charset=utf-8")
