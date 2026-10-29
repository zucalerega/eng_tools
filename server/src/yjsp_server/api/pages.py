"""The server's own pages, outside the web app: the sign-in pages (signin.py) and the help (help.py). Their look is the
site's: its colors, light or dark as the computer is (or as chosen in the web app's account menu), its icon, and the
team's logo (web.py serves it), as the web app shows them."""

import html
from urllib.parse import quote

SITE = "YJSP"
NAME = "Engineering Tools"  # what the site's called beside the team's logo
GOLD = "#e0a500"
# The logo's letters, navy or white, as a background's colors call for: a `--logo` the pages show with `.logo`.
LOGO_CSS = """
  .logo { display: inline-block; flex: none; aspect-ratio: 245 / 173; background: var(--logo) center / contain
    no-repeat; }
  .lockup { display: flex; align-items: center; gap: 1rem; }
  .lockup .logo { height: 3.25rem; }
  .lockup .rule { align-self: stretch; width: 1px; margin: .35rem 0; background: var(--bar-line); }
  .lockup .words { font-family: Bahnschrift, "DIN Alternate", Rubik, "Segoe UI", sans-serif; font-size: 1.1rem;
    font-weight: 700; letter-spacing: .24em; line-height: 1.25; text-transform: uppercase; }
  .lockup .words span { display: block; }
"""
# The site's own icon: the gold orbit both marks take from the team's logo, on the top bar's navy.
FAVICON = "data:image/svg+xml," + quote(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b1b33"/>'
    f'<path d="M4 57Q42 52 60 5Q36 45 4 57Z" fill="{GOLD}"/></svg>'
)
# Light, or dark like the computer (or as chosen in the web app's account menu, which keeps it in localStorage).
THEME = (
    "<script>try{var t=localStorage.getItem('yjsp.theme');"
    "if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>"
)
_DARK = """color-scheme: dark; --bg: #070b12; --surface: #0e1522; --text: #e5ebf4; --muted: #95a1b5;
    --border: #1d2940; --accent: #7aa7ee; --primary: #2a5fb0; --primary-hover: #3469bd; --door: #fff;
    --field: #111a29; --shadow: 0 18px 48px rgb(0 0 0 / 55%); --bar: #03060c; --bar-text: #fff;
    --bar-quiet: rgb(255 255 255 / 80%); --bar-line: rgb(255 255 255 / 28%); --bar-hover: rgb(255 255 255 / 10%);
    --logo: url("/brand/logo-on-dark.png");"""
# The colors, for both themes, and the type, which every page starts its style with. The top bar is the page's: white
# in the light theme, near-black in the dark, its line gold either way, as the web app's is.
PALETTE = f"""
  :root {{ color-scheme: light; --bg: #eef1f6; --surface: #fff; --text: #0f1b2d; --muted: #5b677a;
    --border: #dfe4ec; --accent: #1d4d94; --primary: #1c4b8f; --primary-hover: #163d75; --door: #0b1b33;
    --field: #fff; --shadow: 0 18px 48px rgb(15 27 45 / 12%); --bar: #fff; --bar-text: #0b1b33;
    --bar-quiet: rgb(11 27 51 / 72%); --bar-line: rgb(11 27 51 / 22%); --bar-hover: rgb(11 27 51 / 6%);
    --logo: url("/brand/logo-on-light.png");
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.5; }}
  @media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ {_DARK} }} }}
  :root[data-theme="dark"] {{ {_DARK} }}
  * {{ box-sizing: border-box; }}
{LOGO_CSS}"""


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)
