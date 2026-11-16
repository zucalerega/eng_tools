# Running it for your team

YJSP's tools, Vault, Yorg, Piper, and Buildflow, are one server, which any team can run for
itself: with its own name and logo, its own school's sign-in, and its own data, which never
leaves its machine except as its own encrypted backups. This page sets one up on a Linux
machine with Docker, from a release's image, behind [Caddy](https://caddyserver.com), which
gets the site's HTTPS certificate and keeps it renewed. The files are in
[`deploy/compose/`](../deploy/compose).

YJSP's own site runs a checkout of the repository as a service instead
([docs/deploying.md](deploying.md)); everything here is the same server.

## What you need

- **A Linux machine that stays on**, such as a cloud VM, with
  [Docker](https://docs.docker.com/engine/install/) and its Compose plugin (2.24 or newer:
  `docker compose version`). The server needs about 150 MB of memory idle, and more while it
  reads big test data or runs simulations: 2 GB is enough to start, and 4 GB comfortable. Give
  it disk for every version of every CAD file the team checks in: 50 GB is a start, and Admin >
  People says how full it is.
- **A domain name for it**, whose DNS points at the machine (an `A` record, and `AAAA` for
  IPv6), with ports 80 and 443 open to it from the internet (TCP, and UDP 443 for HTTP/3).
  Caddy gets the certificate from Let's Encrypt on its own once they are.
- **A way to sign in** ([Sign-in](#sign-in)): the school's Microsoft 365 accounts, through an
  app registered in its directory, or Google accounts, through a Google Cloud project.
- **An x86-64 machine for the published image.** On ARM, such as Oracle Cloud's Ampere
  machines, [build the image](#building-the-image) on the machine.

## Setting it up

1. Get the files, from the release you'll run: the latest, on the
   [releases page](https://github.com/zucalerega/eng_tools/releases) (v0.7.0 here):

   ```bash
   git clone --branch v0.7.0 https://github.com/zucalerega/eng_tools.git yjsp
   ```

   ```bash
   cd yjsp/deploy/compose && cp .env.example .env && chmod 600 .env
   ```

2. Fill in `.env`: the release (`YJSP_VERSION`), the domain, a new secret key
   (`openssl rand -base64 48`), your site's and team's names, your school, at least one
   [way to sign in](#sign-in), and your own email in `YJSP_BOOTSTRAP_ADMINS`. Git ignores
   `.env`, and only you should be able to read it: it has the site's secrets.
3. Start it:

   ```bash
   docker compose up -d
   ```

   ```bash
   docker compose logs server
   ```

   The server refuses to start without what it needs, and says what's missing ("Can't start
   in production: set YJSP_SECRET_KEY …"): fix `.env` and run `docker compose up -d` again.
   Once `https://<your domain>/healthz` says `{"ok":true}`, the site is up.
4. Open the site and sign in with the email in `YJSP_BOOTSTRAP_ADMINS`: you're its first
   admin. The account menu, at the top right, has the rest: Admin > People (inviting people,
   and making them admins) and Admin > Whitelist.
5. Set up [backups](#backups) before the team puts anything in it.

Everything the site keeps is in Docker's `yjsp_data` volume: its database, Vault's files,
Yorg's, the team's logo, and the add-in's downloads. `docker compose down` stops the site and
keeps it; never add `-v` to that, which deletes it.

## Sign-in

People sign in with their school's accounts: the server has no passwords of its own. Set up
Microsoft, Google, or both. Who joins:

- **The school's people** (its addresses, `YJSP_SCHOOL_DOMAINS`, and their subdomains) join by
  signing in, with Microsoft, or with Google where the school's accounts are Google's
  (`YJSP_GOOGLE_MAKES_ACCOUNTS=1`). An admin can turn on the whitelist (Admin > Whitelist):
  then only the school's addresses on it can join.
- **Anyone else**, such as a mentor or an alumnus, joins by an admin's invite to the address
  they sign in to Google with (Admin > People).
- With no school domains at all, people join only by invite.

### Microsoft (a school on Microsoft 365)

In the [Microsoft Entra admin center](https://entra.microsoft.com), signed in with your school
account. Many schools don't let students register apps: then ask the school's IT to register it
with these settings, or use Google.

1. App registrations > New registration. Name it after your site. Supported account types:
   **Accounts in this organizational directory only** (single tenant). Redirect URI: **Web**,
   `https://<your domain>/auth/microsoft/callback`.
2. On its Overview: the **Application (client) ID** is `YJSP_MICROSOFT_CLIENT_ID`, and the
   **Directory (tenant) ID** is `YJSP_MICROSOFT_TENANT`.
3. Certificates & secrets > New client secret: its **Value** (shown once) is
   `YJSP_MICROSOFT_CLIENT_SECRET`. It expires (in at most two years): note when, and make a new
   one before it does, or no one can sign in.

The site asks Microsoft only for who someone is (`openid email profile`). Only accounts in your
school's directory, at one of its addresses, get in: a guest the school invited from outside
doesn't.

### Google

In the [Google Cloud console](https://console.cloud.google.com), in a project for the site:

1. Google Auth Platform > Branding: the app's name and a support email. Then Audience:
   **Internal** if your school's accounts are Google Workspace's and the project is in the
   school's organization (then only its accounts can use it); otherwise **External**, and
   publish it (In production). With only the basic scopes it asks for (`openid email profile`),
   it needs no verification.
2. Clients > Create client: a **Web application**, with the authorized redirect URI
   `https://<your domain>/auth/callback`.
3. Its client ID and secret are `YJSP_GOOGLE_CLIENT_ID` and `YJSP_GOOGLE_CLIENT_SECRET`.
4. `YJSP_GOOGLE_MAKES_ACCOUNTS=1` only where the school's accounts are Google's. Otherwise
   anyone can make a Google account with a school address, so Google signs in only people who
   are in already: invited, or joined with Microsoft.

After changing `.env`, `docker compose up -d` restarts the server with it.

## Your team's name and logo

`YJSP_SITE_NAME` is the short name in the top bar, the browser's tabs, and the sign-in pages;
`YJSP_TEAM_NAME` is the team's, on the sign-in pages, the help, and a P&ID's title block.

The logo is two PNG files: `logo-on-light.png`, with dark letters, for light pages, and
`logo-on-dark.png`, with light letters, for the dark theme. The pages fit them, scaled, into
a box 245 wide by 173 tall: a logo about that shape fills it, and any other fits inside it.
Put them in the volume:

```bash
docker compose exec server mkdir -p /data/brand
```

```bash
docker compose cp logo-on-light.png server:/data/brand/
```

```bash
docker compose cp logo-on-dark.png server:/data/brand/
```

The pages show them at once (a browser may keep showing the old one for up to a day). Until
there's a logo, the pages show the site's name instead; with only one, it's used for both
themes.

## The SolidWorks add-in and the `vault` command

Each release has, on its GitHub release, `Vault-Setup.exe` (the SolidWorks add-in's
installer), its signature `Vault-Setup.exe.sig`, and `vault.exe` (Vault's command line). Put
the installer and its signature where the site offers them to members (the web app's
SolidWorks page):

```bash
docker compose exec server mkdir -p /data/downloads
```

```bash
docker compose cp Vault-Setup.exe server:/data/downloads/
```

```bash
docker compose cp Vault-Setup.exe.sig server:/data/downloads/
```

Each member installs the add-in from there, and connects it to your site from the web app
([the add-in's guide](../client/src/Vault.SolidWorks/README.md)). Installed add-ins update
themselves from the same place when a newer installer is there, and run only installers
signed with the release key YJSP's releases are signed with: use the release's files, not a
build of your own, which would need a key of your own and an add-in built with its public
half ([docs/deploying.md](deploying.md), "Signing key").

## Backups

The data is the team's designs and test results: keep a copy off the machine. `backup.sh`
copies the database (a consistent copy, made while the site runs), Vault's files, Yorg's, and
the logo into a [restic](https://restic.net) repository, in object storage such as
[Cloudflare R2](https://developers.cloudflare.com/r2/) (free up to 10 GB) or Backblaze B2.
restic encrypts everything before it leaves the machine, and each night adds only what changed.
It keeps two weeks of nights, two months of Sundays, and two years of firsts of the month.
restic runs in its own container, with keys the server never sees.

1. Make a bucket, and an API token that can read and write it, and nothing else. (In R2: a
   bucket, then an API token with Object Read & Write for that bucket only; the repository's
   address uses the account's ID, from R2's overview page.)
2. Fill in `backup.env`, with a new password for the repository:

   ```bash
   cp backup.env.example backup.env && chmod 600 backup.env
   ```

   ```bash
   openssl rand -base64 32
   ```

   **Keep the password in a password manager too**: without it, no one can read the backups.
3. Make the repository, and make the first copy and check it:

   ```bash
   docker compose run --rm backup init
   ```

   ```bash
   ./backup.sh backup && ./backup.sh check
   ```

4. Run them on their own, as root (`sudo crontab -e`), with this folder's path: a copy each
   night, and a check each Sunday, which reads back a tenth of the repository (all of it over
   ten weeks) and restores the database and 20 of Vault's files to check them.

   ```
   30 3 * * * cd /path/to/yjsp/deploy/compose && ./backup.sh backup >>backup.log 2>&1
   30 4 * * 0 cd /path/to/yjsp/deploy/compose && ./backup.sh check >>backup.log 2>&1
   ```

Admin > People shows when the last copy and check worked, and warns when one failed (with
what went wrong; `backup.log` has the rest) or when no copy is newer than 36 hours.

For more protection, R2's bucket lock rules can keep copies from being deleted early, even
with the key: YJSP's are in [docs/deploying.md](deploying.md), "Off-site backups".

### Putting it back

On this machine, or on a new one with the files and the same `.env` and `backup.env` (it
needn't be started first):

```bash
./backup.sh restore
```

It stops the site, puts the latest copy back, keeps the database it replaces in the volume's
`backups/` folder, and starts the site. `./backup.sh snapshots` lists the copies, and
`./backup.sh restore <copy>` puts back an older one. Practice once a semester on a scratch
machine: a restore you've never done is a guess.

## Upgrading

1. Read the release's notes, on its GitHub release.
2. Back up: the server changes its database as it starts, if the release needs to, and
   there's no going back without a copy from before.

   ```bash
   ./backup.sh backup
   ```

3. Move the checkout to the release, set `YJSP_VERSION` in `.env` to its tag, and restart.
   (Keep changes of your own to `compose.yaml` in a `compose.override.yaml` beside it, which
   Compose adds to it and git ignores, so a new release's files don't clash with them.)

   ```bash
   git fetch --tags && git checkout v0.8.0
   ```

   ```bash
   docker compose pull && docker compose up -d
   ```

4. Check that `https://<your domain>/healthz` answers, that you can sign in, and that you can
   check a file in, out, and in again in a scratch folder.
5. Put the release's `Vault-Setup.exe` and its signature in the downloads folder, as above:
   the add-ins update to it.

To go back, set the earlier release in `.env` and `docker compose up -d`; if the release
changed the database, also put back the copy from before it (`./backup.sh restore <copy>`).

## More

- **Claude, in Help**, answers questions from the docs, with an Anthropic API key and a
  monthly budget; **Deals** searches eBay each day for what the team wants, with an eBay
  developer keyset. Both are off until set: the repository's
  [`server/.env.example`](../server/.env.example) has their settings, and every other.
- **Building the image**, below, runs it on ARM, or a version of your own.
- **Without Docker**, the server runs from a checkout with [uv](https://docs.astral.sh/uv/),
  as YJSP's own does: [docs/deploying.md](deploying.md), "Setting up a server from scratch".

### Building the image

On an ARM machine, or to run changes of your own, build the image on the machine, from a
checkout of the release (it takes a few minutes):

```bash
docker build -f server/Dockerfile -t yjsp-server:v0.7.0 .
```

Run that in the checkout's top folder, then set `YJSP_IMAGE=yjsp-server` in `.env`, with
`YJSP_VERSION` the tag you built, and `docker compose up -d` (not `pull`).
