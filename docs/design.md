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
  add-in only runs inside SolidWorks (2026; 2025 while laptops move over) on Windows, where
  it's tested by hand.
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
| Vault's SolidWorks add-in | `client/src/Vault.SolidWorks` (.NET Framework 4.8) | working; first run in SolidWorks September 2026; for SolidWorks 2026 since October 2026 |
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
| The database: accounts, Vault's tables, Yorg's | `YJSP_DATABASE_URL` (`sqlite:///data/yjsp.db`) | nightly, on the server, for 14 days; and nightly off it |
| Vault's files: every version of every file, and the meshes of Caliper's 3D models, in `blobs/` | `YJSP_VAULT_DIR` (`data/vault`) | nightly, off the server |
| Yorg's files: uploads and their arrays (`datasets/`), saved scripts and models | `YJSP_YORG_DIR` (`data/yorg`) | nightly, off the server |
| Software to download (the add-in's installer, and its signature) | `YJSP_DOWNLOADS_DIR` | no need: it comes from CI |

Vault's blobs never change once written, so a backup of them only ever adds files. Yorg's
scripts and models are JSON files changed in place, and deleting one deletes its file, so a
copy of them needs to keep old versions too. The off-site backup does both: restic, run by
root each night to an R2 bucket, encrypted, keeping two weeks of nights, two months of
weeks, and two years of months, and checked by a restore each week (deploy/yjsp-offsite,
[deploying.md](deploying.md#off-site-backups)). The server only reads its report
(`YJSP_BACKUP_STATUS`, `backups.py`), for the Storage card.

Admin > People starts with how full the server's disk is, and how much of it Vault's files,
Yorg's, and the database take (`GET /api/storage`, `disk.py`): the folders above, measured
when the page opens, on the disk Vault's files are on, which on the live server holds all
three. The rest of the disk is the system, logs, and the database's backups.

## Sign-in and accounts

- **People** sign in with a Georgia Tech account, or with Google to an account already
  there. Since October 2026 only a GT sign-in makes an account (`auth._sign_in`): Google
  signs in to one it made before, or to an admin's invite, so someone without a GT account
  (a mentor, say) joins by an invite to their Google address. With the *whitelist* off
  (Admin > Whitelist in the web app, `site_settings`), anyone with a GT account joins at
  once; with it on, only a GT address on it does (`whitelist_emails`), besides people
  invited, and anyone else who signs in is turned away, by a page that says to ask an admin,
  rather than left waiting for one. Admins put a roster's addresses on the whitelist from a
  file, in which the web app finds every email wherever it is, or one at a time
  (`people.add_to_whitelist`); only GT addresses go on, and any other is left off and said
  so. Each shows its account once it has one, by its email or by the sign-in that made it
  (an alias can make an account named by the GT username), and taking one off changes no
  account. Emails listed in `YJSP_BOOTSTRAP_ADMINS` are always active admins, made by either
  sign-in, and a disabled account stays disabled however it signs in. Accounts *pending*
  from before, when a sign-in with the whitelist on made one to wait for an admin, can still
  be approved; one whose address goes on the whitelist joins at its next sign-in, and
  turning the whitelist off approves them all. While it's off, anyone with a GT account gets
  Yorg and what Vault grants *everyone*, and Admin > People says so.
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
  say, nor when anyone signed in last, but themselves (`people.last_sign_in`). Admins also see each person's time on the site (`site_seconds`): when a browser
  session is used again within five minutes of its last use, the page was open all along,
  and the gap counts (`usage.record`). So does their time in SolidWorks
  (`solidworks_seconds`): the add-in asks the server what's new every 20 seconds while
  SolidWorks runs, and while SolidWorks has the foreground and someone has used the
  computer in the last five minutes, its requests say so (`X-YJSP-Activity: solidworks`,
  `SolidWorksActivity.cs`), and the gap since its token's last use counts. SolidWorks left
  open behind other windows, or overnight, doesn't. The CLI doesn't count, nor do add-ins
  released before (0.5.2 and older), which don't say; two browsers open at once count
  twice. The list shows the two together, each on hover, and sorts by status, when people
  joined, when they were last on, or their time on the site.
- **Activity:** Admin > People starts with a tracker of the last 30 days: how many people
  used the site each day (the web app, the add-in, or the CLI) and how long the web app was
  open and people worked in SolidWorks, everyone's together, in stat tiles and a column
  chart, where each day's time is the web app's with SolidWorks' on top, in a color of its
  own (`GET /api/usage`). Each time a token's use is noted, its owner was on in that hour
  (`site_usage`, one row a person an hour, in UTC, with that hour's time on the web app and
  in SolidWorks), and the page asks for days in its own time zone, so a day is the team's
  and not UTC's (`usage.daily`; a server without time zone data gives UTC's). It counts
  from the deploy that added it (October 2026): nothing kept this before, and the chart
  says since when, and since when time in SolidWorks was (from the add-in after 0.5.2). The
  hours are kept 400 days, a little over a year (`usage.KEEP`); noting a use forgets the
  ones past it.
- **Server load:** beside it, how hard the server is working: how busy its CPUs have been
  and how full its memory, against all of each, for the last 24 hours or 7 days (`GET
  /api/load`). The server samples them itself each minute, in a thread it starts and stops
  with itself (`load.Sampler`), from `/proc` on Linux: the CPUs' time since the last sample
  that was busy, and that the hypervisor took for other machines (steal), and the memory in
  use, all but what's available. Samples are kept a week (`server_load`). A point is a minute
  over a day, and the busiest of 10 minutes over a week, so a short spike still shows; the
  line breaks where the server wasn't running. It warns when the CPU has averaged over 85%
  for a quarter hour, the memory is over 90% full, or the hypervisor took over 10% of the
  CPU's time in the last hour. Elsewhere than Linux (development on a Mac) it estimates the
  CPU from the load average and leaves memory out.
- **The SolidWorks add-in:** under them, who has Vault's add-in (`GET /api/add-in`,
  `clients.py`): who's signed in with it, on how many computers (the page doesn't name them, since a
  computer's name is often its owner's), with which version, and when
  they last used it; who downloaded its installer; and how many people have it, signed in
  and using it in the last 90 days. The add-in signs in as "SolidWorks add-in on
  <computer>" and the CLI as "vault CLI on <computer>", so a token's name tells them apart,
  and each says its version in its requests (`User-Agent: vault-client/<version>`), which
  its token keeps (`tokens.client_version`, as it notes the token's use). Each download is
  noted as it's served (`downloads`, the add-in's own updates included), from the deploy
  that began noting them. Each version is compared with the installer the server offers:
  an older one is marked (the add-in offers itself the update), and one not known yet,
  until the add-in next talks to the server, isn't.
- **The oldest client that can make changes:** an add-in updates only when its person
  clicks Update and says yes to Windows, so a release's fixes reach laptops slowly: two days
  after 0.5.4 was offered (October 2026), most laptops still ran 0.5.2, and hit the
  missing-parts bugs 0.5.4 fixed. So under the tracker, admins can set the oldest version
  of the add-in and the CLI that can change the vault (`min_client_version` in
  `site_settings`, `PATCH /api/settings`). Then the vault refuses every change from an older
  one (426 `client_too_old`, `clients.refuse_old`): check-outs (Keep mine and Take over among
  them), check-ins and their uploads, undos, and the rest, each with a message that says how
  to update: the add-in's to click Update or run `Vault-Setup.exe` from the SolidWorks page
  (only the latter for those from before Update, 0.4.0 and older), and the CLI's to get the
  new `vault.exe`. The add-in and the CLI have always shown a server's message as it is, so
  the oldest on the team's laptops say it too. Reads stay open, so an old client still
  browses, gets files, shows what Caliper has, and updates itself; and nothing that doesn't
  say it's a Vault client of a version (`User-Agent: vault-client/<version>`, or CVC's
  `cvc-client/` from before 0.4.0) is refused, browsers included. The oldest can be no
  newer than the installer the server offers, which every add-in can update to, and each
  change to it goes in the activity log. This is the one exception to the server's working
  with older clients as it always has (CLAUDE.md, "API compatibility"): it's off as a server
  starts, and an admin turns it on for a release whose fixes the team needs, once its
  downloads are on the server and people have had a few days to take the update.
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
     revoked (`GET/DELETE /api/tokens`), and the server stores only their hashes. A
     client's token lapses after 90 days unused (`auth.CLIENT_IDLE`), so a laptop in a
     drawer, or one gone missing, isn't signed in forever; the CLI and the add-in then say
     the sign-in expired and ask for a new one.
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
- **Headers** (`security.py`): every response forbids other sites to frame ours (CSP
  `frame-ancestors 'none'`, `X-Frame-Options`), the browser to second-guess a file's type
  (`nosniff`), links to carry our addresses away (`Referrer-Policy`), plugins and another
  base URL (`object-src`, `base-uri`), and forms to post anywhere but the site or a Vault
  client's sign-in on the computer itself (`form-action`, `http://127.0.0.1:*`). One sets its
  own: a drawing's PDF, which Vault's Caliper shows in a frame in the browser's PDF viewer,
  may be framed by the site's own pages (`frame-ancestors 'self'`, `SAMEORIGIN`), and so
  doesn't forbid plugins (docs/vault.md, "Caliper"). Production
  adds HSTS, and doesn't serve the API's docs (`/docs`, `/redoc`, `/openapi.json`). Which
  scripts may run isn't limited yet: Yorg's Python sandbox runs an inline script in a
  sandboxed frame, a worker from a `data:` URL, and Pyodide and WebAssembly from jsDelivr,
  which a script policy must allow by hash or be reworked for first. The access log leaves
  out sign-in codes (`HideSignInCodes`).
- **What one request may cost**, on a server of 1 CPU and 6 GB that anyone can reach:
  - A body is at most 10 MB, refused (413 `too_large`) before anything reads it
    (`limits.BodyLimit`, outside all but the headers): FastAPI reads a JSON body whole
    before it checks who's asking. Uploads (`PUT /api/blobs/{sha256}`,
    `POST /api/yorg/datasets`) stream to disk instead, up to `YJSP_MAX_UPLOAD_MB`.
  - An upload must leave the disk 2 GB free (`disk.make_room`, 507 `disk_full`): the
    database, its backups, and the system need room to write.
  - A Caliper mesh unpacks to at most 256 MB to be checked, two at a time; the server reads
    at most two SolidWorks files at once for their 3D views or drawings' pictures of their
    sheets (409 `busy` after a minute's wait), and remembers a file it couldn't read, by its
    SHA-256, rather than read it again; and the pictures it read, up to 16 MB of them.
  - The service may use 5 GB (`deploy/yjsp.service`, `MemoryMax`).

## API

Every endpoint needs sign-in except `/auth/*` and `/healthz`. Interactive docs are at
`/docs`. The site's own endpoints are below; each app's are in its page: [Vault's](vault.md#api)
(`/api/folders`, `/api/files`, ...) and [Yorg's](yorg.md#api) (`/api/yorg/...`).

| Endpoint | Purpose |
|---|---|
| `GET /api/me`, `PATCH /api/me` | who you are, and whether you're approved; change your own name |
| `GET/POST /api/users`, `PATCH /api/users/{id}` | accounts: invite, approve, disable (admins); to admins, when each was last on (`last_active_at`, `active_now`) and their time on the site (`site_seconds`) and in SolidWorks (`solidworks_seconds`) |
| `GET/PATCH /api/settings` | the whitelist `{whitelist}`: on, only GT addresses on it and invited people make accounts; turning it off approves anyone left waiting; and the oldest add-in and CLI that can change the vault `{min_client_version}`, like `"0.5.4"`, no newer than the installer offered (`not_offered`, or `no_installer` if there's none), or `null` for any (admins) |
| `GET/POST /api/whitelist`, `DELETE /api/whitelist/{id}` | the whitelist's GT addresses, each with its `account` once it has one; adding `{emails}` says which it `added`, which were on it `already`, and which it left off as `not_georgia_tech` (admins) |
| `GET /api/tokens`, `DELETE /api/tokens/{id}` | your signed-in browsers and clients |
| `GET /api/downloads`, `GET /api/downloads/{name}` | software to download (the add-in's installer), from `YJSP_DOWNLOADS_DIR`, each with its SHA-256, and a program's version, read from the program: the add-in's Update compares it with its own. A file's signature beside it (`Vault-Setup.exe.sig`) is served, for the add-in to check the installer with, but not listed |
| `GET /api/usage?days=30&tz=America/New_York` | how many people used the site each day, today last, and how long the web app was open and people worked in SolidWorks, with the time zone the days are in, who was on in all, since when each is counted, and everyone's time on the web app and in SolidWorks in all (admins) |
| `GET /api/add-in` | who has the SolidWorks add-in: each person's computers (as the add-in named them), its version on each, when they last used it, and when they downloaded the installer; how many have it, used it this week, and downloaded it; the installer's version, which add-ins are older, and how many who have it are on it (admins) |
| `GET /api/load?hours=24` | how busy the server's CPUs were and how full its memory, a point a minute (each 10 minutes over a day), each its stretch's busiest, up to a week (admins) |
| `GET /api/storage` | how full the server's disk is (`total`, `free`), and how much of it Vault's files, Yorg's, and the database take, in bytes (admins) |

## Names from before YJSP

Until 0.4.0 the site and its code were called CVC (CAD version control), which was only
ever Vault, and the repository `cad_version_control`. Some of those names live on team
laptops, in browsers, and on the live server, so they change with a way over, and some old
ones are still accepted for a while:

| Before | Now | The old one |
|---|---|---|
| `CVC_*` settings; `CVC_BLOB_DIR` | `YJSP_*`; `YJSP_VAULT_DIR`, the folder `blobs/` is in | refused: the server won't start while one is set (`config.refuse_old_settings`), rather than start on its defaults |
| `/srv/vault`, `/opt/vault`, the `vault` user, `vault.service`, `vault.db` on the live server | `/srv/yjsp`, `/opt/yjsp`, `yjsp`, `yjsp.service`, `yjsp.db` | moved once, by `deploy/migrate-to-yjsp.sh` ([deploying.md](deploying.md#moving-to-yjsp)); the script goes in the release after |
| The `cvc_session` cookie, the `X-CVC-Request` header | `yjsp_session`, `X-YJSP-Request` | still accepted, so browsers stay signed in and open tabs can save; drop them in 0.6.0, once sessions from before have run out (30 days from 0.4.0's deploy: November 3, 2026) |
| Tokens starting `cvc_` | `yjsp_` | work until they expire or are signed out |
| Vault's pages at the site's own paths, until October 2026: `/files/...`, `/file/5`, `/locks`, `/admin` | under `/vault`: `/vault/files/...`, `/vault/file/5`, ... | followed, as bookmarks and shared links have them: the web app goes on to the same page under `/vault`, with its query (`movedToVault` in `web/src/vault/paths.ts`). `/` is the site's own page now |
| `X-CVC-Version`, `X-CVC-SHA256`, `X-CVC-Size` on downloads | `X-Vault-*` | gone: no client read them |
| The `cvc-client/<version>` User-Agent | `vault-client/<version>` | still read as a client's version, so the add-in tracker shows it and the oldest client that can make changes holds for it |
| The `cvc` command, `cvc.exe` | `vault`, `vault.exe` | `cvc.exe` keeps working against the server; replace it |

The SolidWorks add-in, its setup, and the client library they share with the CLI keep none
of their old names from 0.5.0: they know only `vault://` links, `.vault` workspace folders,
and the `Vault` folders in `%APPDATA%` and `%LOCALAPPDATA%`, and the web app makes only
`vault://` links. A laptop that never ran 0.4.0 installs `Vault-Setup.exe` again and signs
in again, and whatever its old workspace had checked out is sorted out by hand.

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
4. Put a release's `Vault-Setup.exe` with its signature, `Vault-Setup.exe.sig` (and
   `vault.exe`, if you like), from its GitHub release, in a folder and point
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
   and the live server moved to its YJSP layout. Then the old names stop being accepted, as
   "Names from before YJSP" says: Vault's clients dropped theirs in 0.5.0, and the server
   drops the old cookie and header in 0.6.0.

## Open questions

- Sign-up: open to anyone who can sign in for now (September 2026). The school's accounts
  are Microsoft's, not Google's, and can sign in since October 2026. Still open: turning
  the whitelist on; whether Google sign-in stays, for people without GT accounts (advisors,
  alumni); and letting admins change an account's email, so people who joined with Google
  can move to their GT accounts and keep their check-outs and history.
