# YJSP design

YJSP is the Yellow Jacket Space Program's site for its engineering tools: two apps on one
server. **Vault** keeps the team's SolidWorks and STEP files, with check-out/check-in
locking, full version history, and per-folder permissions; it replaces Kenesto. **Yorg**
plots the team's test data. They share the server, the database, sign-in and accounts, and
the web app's frame, and nothing else. It's built for a college rocketry team, not a
company: a few dozen people, close to zero hosting cost, and simple enough for next year's
team to keep running.

This page is the site as a whole: how it's put together, sign-in and accounts, the web
app's frame, the API's conventions, the names from before YJSP, and deploying. Each app has
its own: [vault.md](vault.md) and [yorg.md](yorg.md).

## Context

- The team runs SolidWorks on their own Windows laptops, with admin rights, so each person
  can install Vault's add-in, the main way people use Vault.
- The server, the web app, and the CLI build and test on Windows, macOS, and Linux. The
  add-in only runs inside SolidWorks 2025 on Windows, where it's tested by hand.
- People sign in with Google (decided September 2026), or with their Georgia Tech accounts
  (added October 2026).

## Architecture

```
SolidWorks add-in (C#, .NET Framework 4.8) ─┐
vault CLI (C#, .NET 10, Windows + macOS)    ─┴─ Vault.Client library ─┐
                                                                       │ HTTPS, JSON
Web app (React): the frame, Vault's pages, Yorg's pages ───────────────┤
                                                                       ▼
                               YJSP server (Python, FastAPI): sign-in, accounts, the web app
                               ├── vault/: folders, files, versions, check-outs, permissions
                               ├── yorg/: datasets, views, calculated channels, scripts, models
                               ├── database: SQLite or Postgres, one for all of it
                               └── files: Vault's (YJSP_VAULT_DIR) and Yorg's (YJSP_YORG_DIR)
```

| Part | Where | Status |
|---|---|---|
| The site: sign-in, accounts, the web app's frame | `server/src/yjsp_server`, `web/src` (their top levels) | working |
| Vault on the server | `server/src/yjsp_server/vault` | working |
| Vault in the web app | `web/src/vault` | working |
| Vault's client library | `client/src/Vault.Client` (netstandard2.0 + net10.0) | working |
| Vault's CLI (`vault`) | `client/src/Vault.Cli` (.NET 10) | working |
| Vault's SolidWorks 2025 add-in | `client/src/Vault.SolidWorks` (.NET Framework 4.8) | working; first run in SolidWorks September 2026 |
| Yorg on the server | `server/src/yjsp_server/yorg` | working |
| Yorg in the web app | `web/src/yorg` | working |

**What the apps share, and what's their own.** One server process, one database, one
sign-in, and one web app, whose top bar has the app switcher (Vault, Yorg), the account
menu, and the theme. Each app has its own tables (Vault's are named without a prefix, from
before Yorg; Yorg's are `yorg_*`), its own folder of files, its own API, and its own pages:
Vault's under `/vault` (`/vault/files/...`, `/vault/file/5`, `/vault/locks`, ...) and Yorg's
under `/yorg`, with the site's own page at `/`, which goes to either. Neither app imports
the other, and the site's own code imports neither, except where it puts them together
(`app.py` and `migrations/env.py` on the server, `App.tsx` and `main.tsx` in the web app)
and where accounts change (`people.py`, below).

The one tie between them is people. Accounts are the site's (`models.py`, `auth.py`,
`people.py`), and both apps refer to them. Vault's index carries people's names and what
they may see, so a change to an account has every Vault client sync everything again
(`vault.people_changed`), and it's recorded in Vault's activity log (`vault.log`), the
site's only one.

## Storage

| What | Setting (default) | Backed up |
|---|---|---|
| The database: accounts, Vault's tables, Yorg's | `YJSP_DATABASE_URL` (`sqlite:///data/yjsp.db`) | nightly, on the server, for 14 days |
| Vault's files: every version of every file, and the meshes of Caliper's 3D models, in `blobs/` | `YJSP_VAULT_DIR` (`data/vault`) | not yet |
| Yorg's files: uploads and their arrays (`datasets/`), saved scripts and models | `YJSP_YORG_DIR` (`data/yorg`) | not yet |
| Software to download (the add-in's installer) | `YJSP_DOWNLOADS_DIR` | no need: it comes from CI |

Vault's blobs never change once written, so a backup of them only ever adds files. Yorg's
scripts and models are JSON files changed in place, and deleting one deletes its file, so a
copy of them needs to keep old versions too.

## Sign-in and accounts

- **People** sign in with a Georgia Tech account or with Google, and anyone who does joins
  at once (decided September 2026, for now), unless an admin has turned on the *whitelist*
  (Admin > People in the web app, `site_settings`). With it on, a first sign-in creates a
  *pending* account that an admin approves, unless an admin invited that email beforehand.
  Emails listed in `YJSP_BOOTSTRAP_ADMINS` are always active admins, and a disabled account
  stays disabled however it signs in. Turning the whitelist off approves everyone waiting,
  since they could sign in again to join; turning it on changes no one who already has an
  account. While it's off, anyone with a GT or Google account gets Yorg and what Vault
  grants *everyone*.
- **Georgia Tech accounts** are Microsoft 365 accounts, in GT's tenant in Microsoft Entra,
  which sends their sign-ins on to GT's own login page, Duo and all. The server signs in
  through an app registered in Entra, at GT's tenant's endpoints, and lets in only GT's
  people (`auth.sign_in_microsoft`): the ID token must be signed by Microsoft and issued for
  GT's tenant, and for someone with a GT address (`gatech.edu`), which guests GT invited from
  outside don't have. The app is registered outside GT, for many tenants but limited to
  GT's, so the team keeps it without needing GT's IT. An account is tied to the person's
  Microsoft object ID (`microsoft_oid`), as to a Google account (`google_sub`), and found
  the first time by their GT addresses: their username's (`gburdell3@gatech.edu`), which a
  new account is named by, or an alias. So people are invited by their GT address. An
  account made with Google under another address isn't found: its owner keeps signing in
  with Google until admins can change an account's email.
- **Who's on:** a token notes when it was last used, at most once a minute (not a write per
  request), so Admin > People shows when each person was last on (their last sign-in, or
  the last use of a session or a client: the web app, the add-in, the CLI) and who's on
  now (within two minutes: an open page asks who you are every minute, `session.ts`). Only
  admins see it (`people.last_active`); the list others get for granting access doesn't
  say.
- **Names:** an account's name is the one GT or Google gives at its first sign-in, and
  anyone can change their own (the account menu, `people.rename_self`); signing in again
  keeps it.
- **The browser** keeps an HttpOnly session cookie. Requests that change something
  must also send an `X-YJSP-Request` header, which cross-site pages can't add
  (CSRF protection). A page opened before signing in is where signing in comes back to,
  with its query (a link to Yorg's plots holds them there), and only paths on the site
  (`_safe_next`). The round trip to Microsoft or Google keeps that in the session cookie,
  which browsers cap at 4 KB, so one longer than 2,000 characters comes back to its page
  without its query. The sign-in pages are the site's: the YJSP name, with both apps'
  marks, and Georgia Tech's sign-in first.
- **The CLI and add-in** sign in through the browser, like `gh auth login`:
  1. The client listens on `127.0.0.1:<port>` and opens `/auth/client` with a PKCE
     challenge.
  2. You confirm in the browser ("Sign in to Vault").
  3. The server redirects to `http://127.0.0.1:<port>/callback` with a one-time
     code.
  4. The client exchanges the code and its PKCE verifier for a token. Tokens can be
     revoked (`GET/DELETE /api/tokens`), and the server stores only their hashes.
- **Local development:** `YJSP_DEV_AUTH=1` enables `/auth/dev-login` and
  `/auth/dev-token`, which sign in as any email. The server refuses to start in
  production with this on, or without a way to sign in (Georgia Tech's, Google's, or
  both) configured.

## The web app

`web/` is one page (TypeScript, React, Vite) that the server serves at `/` and at any path
the API doesn't own (`api/web.py`), to people who are signed in and approved; everyone
else signs in on the server's home page first. It uses the browser session cookie, and
sends `X-YJSP-Request` on every request (`api.ts`).

- **The frame** (`App.tsx`): the top bar, with the app switcher, each app's own pages in
  it, and the account menu (your name, the theme, Admin and Vault's admin mode for those
  who have them, and signing out). Each app's pages come from its own folder: Vault's
  (`web/src/vault`, `VaultPage`, under `/vault`) and Yorg's (`web/src/yorg`, `YorgPage`,
  under `/yorg`). The site's own page (`Home`, at `/`, where signing in lands) has both
  apps on it.
- **Who you are** (`session.ts`) is the site's, for both apps: loaded when the page opens
  and asked again every minute while it's visible. Vault's index (`vault/store.ts`, the
  sync feed) loads when a page of Vault first shows and keeps current only while one
  does; Yorg's pages and the site's own never ask for it.
- **Light and dark:** light, dark, or the computer's setting, chosen in the account menu
  and remembered per browser (`theme.ts`, `yjsp.theme`, as `data-theme` on the page). The
  sign-in pages follow the same choice.
- **Menus** (all of the app's, through `usePopover`) are fixed to the window where their
  button is, and moved or flipped to stay whole on screen, so neither a window edge nor
  a scrolling area cuts them off.
- **Branding:** in the Yellow Jacket Space Program's colors: near-black, white, and dark
  blue, with its gold. Each app has its mark, after the team's logo: Vault's a vault door
  crossed by a gold orbit (`VaultMark`), Yorg's a signal rising to its gold peak
  (`YorgMark`). The tab's title and icon are the app's. The site's own icon, on the
  sign-in pages, is the gold orbit alone.

## Server conventions

- **Errors** are `ApiError`s (`errors.py`), sent as
  `{"error": "checked_out", "message": "...", "details": {...}}`. The `error` code is part
  of the API: clients branch on it.
- **One database, one chain of migrations** (`migrations/`) for the site's tables and both
  apps'. The server runs them at startup (`db.migrate`).
- **Timestamps** are timezone-aware UTC (`db.UTCDateTime`).
- **Settings** are `YJSP_*` environment variables, or a `.env` file (`config.py`;
  `server/.env.example` lists them). Production refuses development shortcuts and weak
  settings (`Settings.check`).

## API

Every endpoint needs sign-in except `/auth/*` and `/healthz`. Interactive docs are at
`/docs`. The site's own endpoints are below; each app's are in its page: [Vault's](vault.md#api)
(`/api/folders`, `/api/files`, ...) and [Yorg's](yorg.md#api) (`/api/yorg/...`).

| Endpoint | Purpose |
|---|---|
| `GET /api/me`, `PATCH /api/me` | who you are, and whether you're approved; change your own name |
| `GET/POST /api/users`, `PATCH /api/users/{id}` | accounts: invite, approve, disable (admins); to admins, when each was last on (`last_active_at`, `active_now`) |
| `GET/PATCH /api/settings` | the whitelist `{whitelist}`: on, new people need an invite or approval; turning it off approves everyone waiting (admins) |
| `GET /api/tokens`, `DELETE /api/tokens/{id}` | your signed-in browsers and clients |
| `GET /api/downloads`, `GET /api/downloads/{name}` | software to download (the add-in's installer), from `YJSP_DOWNLOADS_DIR` |

## Names from before YJSP

Until 0.4.0 the site and its code were called CVC (CAD version control), which was only
ever Vault, and the repository `cad_version_control`. Some of those names live on team
laptops, in browsers, and on the live server, so they change with a way over, and some old
ones are still accepted for a while:

| Before | Now | The old one |
|---|---|---|
| `CVC_*` settings; `CVC_BLOB_DIR` | `YJSP_*`; `YJSP_VAULT_DIR`, the folder `blobs/` is in | refused: the server won't start while one is set (`config.refuse_old_settings`), rather than start on its defaults |
| `/srv/vault`, `/opt/vault`, the `vault` user, `vault.service`, `vault.db` on the live server | `/srv/yjsp`, `/opt/yjsp`, `yjsp`, `yjsp.service`, `yjsp.db` | moved once, by `deploy/migrate-to-yjsp.sh` ([deploying.md](deploying.md#moving-to-yjsp)); the script goes in the release after |
| The `cvc_session` cookie, the `X-CVC-Request` header | `yjsp_session`, `X-YJSP-Request` | still accepted, so browsers stay signed in and open tabs can save; drop them in 0.5.0, once sessions from before have run out (30 days) |
| Tokens starting `cvc_` | `yjsp_` | work until they expire or are signed out |
| Vault's pages at the site's own paths, until October 2026: `/files/...`, `/file/5`, `/locks`, `/admin` | under `/vault`: `/vault/files/...`, `/vault/file/5`, ... | followed, as bookmarks and shared links have them: the web app goes on to the same page under `/vault`, with its query (`movedToVault` in `web/src/vault/paths.ts`). `/` is the site's own page now |
| `X-CVC-Version`, `X-CVC-SHA256`, `X-CVC-Size` on downloads | `X-Vault-*` | gone: no client read them |
| The `cvc` command, `cvc.exe` | `vault`, `vault.exe` | `cvc.exe` keeps working against the server; replace it |
| `cvc://` links, `cvc-open.exe` | `vault://`, `vault-open.exe` | Vault for SolidWorks 0.4.0 follows both, and its setup registers both. The web app makes `cvc://` links until every laptop has 0.4.0 (`LINK_SCHEME` in `web/src/vault/components.tsx`): switch it in 0.5.0, and stop registering `cvc://` in the release after |
| A workspace's `.cvc` folder; sign-ins and the add-in's settings in `%APPDATA%\CVC` (`~/.config/cvc`); its log in `%LOCALAPPDATA%\CVC` | `.vault`; `%APPDATA%\Vault` (`~/.config/vault`); `%LOCALAPPDATA%\Vault` | the 0.4.0 CLI and add-in rename `.cvc` to `.vault` the first time they open a workspace (its backups go with it), and take sign-ins and settings from the old folder when the new one has none |
| `Cvc.SolidWorks.dll`, `Cvc.Client.dll` in `C:\Program Files\Vault for SolidWorks` | `Vault.SolidWorks.dll`, `Vault.Client.dll` | Setup 0.4.0 unregisters the old add-in and deletes its files first. The add-in's COM GUID stays the same, so SolidWorks sees one add-in throughout |

## Deploying

The live site runs on an Oracle Cloud "Always Free" VM, reached through Tailscale
Funnel, with the server running from a uv environment as a systemd service.
[deploying.md](deploying.md) has how it's hosted, how to deploy (`deploy/deploy.sh`), its
backups, and how to set up a new server; the release and rollback rules are in
CLAUDE.md, under "Deployment".

The server also ships as a Docker image (`server/Dockerfile`). It runs as a non-root
user, has a health check, and keeps its database and files on a `/data` volume.
CI builds and smoke-tests the image on every change, and publishes it to
`ghcr.io/<owner>/yjsp-server:<tag>` for version tags. Setup, wherever it runs:

1. Set up sign-in, either or both. Each only asks for `openid email profile`.
   - Georgia Tech accounts: in Microsoft Entra (the admin center, on a directory the team
     keeps, not GT's), register an app for *Multiple Entra ID tenants*, with *Allow only
     certain tenants* set to `gatech.edu`, and the *Web* redirect URI
     `https://<your site's address>/auth/microsoft/callback`. Make it a client secret
     (Certificates & secrets). A secret lasts two years at most: note when it runs out.
     If GT's IT requires approving apps, their approval is needed once, before anyone
     can sign in.
   - Google: in Google Cloud Console, create an OAuth client of type *Web application* with
     the redirect URI `https://<your site's address>/auth/callback`. Google doesn't need to
     verify the app.
2. Set `YJSP_ENV=production`, `YJSP_PUBLIC_URL`, `YJSP_SECRET_KEY`,
   `YJSP_MICROSOFT_CLIENT_ID`/`_SECRET` (the app's *Application (client) ID* and its
   secret), `YJSP_GOOGLE_CLIENT_ID`/`_SECRET`, and `YJSP_BOOTSTRAP_ADMINS` (see
   `server/.env.example`). Sign-up starts open: anyone who can sign in can join until an
   admin turns on the whitelist (Admin > People).
3. Keep `YJSP_DATABASE_URL` (SQLite by default), `YJSP_VAULT_DIR`, and `YJSP_YORG_DIR`
   on a persistent disk, and back them up (see "Storage"). An S3/R2 store for Vault's
   blobs (Cloudflare R2: 10 GB free, no download fees) is planned.
4. Put CI's `Vault-Setup.exe` (and `vault.exe`, if you like) in a folder and point
   `YJSP_DOWNLOADS_DIR` at it: members get them from Vault's SolidWorks page.

Where to host it was decided in September 2026: the Oracle Cloud VM above, which costs
nothing. The image would run on Render, a VPS, or a machine on campus too.

## Roadmap

The site's own; each app has its roadmap in its page.

1. **Deploy**: Docker image and CI (done). Hosted on an Oracle Cloud VM since September
   2026, with a deploy script and nightly database backups ([deploying.md](deploying.md)).
   Still to do: Vault's blobs and Yorg's files backed up off the host (Yorg's scripts and
   models with their old versions), and an R2 store for the blobs.
2. **YJSP** (0.4.0): the site renamed from CVC, Vault and Yorg side by side in the code,
   and the live server moved to its YJSP layout. Then (0.5.0) the old names stop being
   accepted, as "Names from before YJSP" says.

## Open questions

- Sign-up: open to anyone who can sign in for now (September 2026). The school's accounts
  are Microsoft's, not Google's, and can sign in since October 2026. Still open: turning
  the whitelist on; whether Google sign-in stays, for people without GT accounts (advisors,
  alumni); and letting admins change an account's email, so people who joined with Google
  can move to their GT accounts and keep their check-outs and history.
