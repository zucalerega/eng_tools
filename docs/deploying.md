# Hosting and deploying

The team's site, YJSP (Vault and Yorg, on one server), is live at
**https://lucazerega.tail07089c.ts.net**. This page says where it runs, how to deploy a new
version, and how to look after it. Whether you're a person or an agent, read it through
before you deploy, and keep to the [rules](#rules) at the end.

## Where it runs

- **The machine:** an Oracle Cloud "Always Free" VM (Ampere A1, 1 OCPU and 6 GB, Oracle
  Linux 9), reached over SSH as `opc@129.80.217.44`. The Oracle Cloud account is the
  repository owner's.
- **Its public address:** [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) on the
  VM (Tailscale machine `lucazerega`, key expiry off) serves
  https://lucazerega.tail07089c.ts.net and passes it to the server on `127.0.0.1:8100`. Nothing
  else on the VM is reachable from the internet.
- **Georgia Tech sign-in:** the app registered in Microsoft Entra (for many tenants,
  limited to GT's) has the Web redirect URI
  `https://lucazerega.tail07089c.ts.net/auth/microsoft/callback`, and
  `http://localhost:8000/auth/microsoft/callback` for trying it on a laptop. Its client
  secret lasts two years at most: make a new one in Entra before it runs out, and put it
  in `.env`.
- **Google sign-in:** the OAuth client in Google Cloud Console has the redirect URI
  `https://lucazerega.tail07089c.ts.net/auth/callback`.

If the address ever changes, change both redirect URIs and `YJSP_PUBLIC_URL`.

On the server:

| Path | What |
|---|---|
| `/opt/yjsp/app/server` | The server's code (`server/` from the repository) and its `.venv`, made by uv 0.12 with Python 3.13 from `/opt/yjsp/python` |
| `/opt/yjsp/app/web/dist` | The built web app, which the server serves |
| `/srv/yjsp/.env` | Settings and secrets (below). Readable only by `yjsp` |
| `/srv/yjsp/data` | `yjsp.db` (SQLite: accounts, Vault's tables, Yorg's), `vault/blobs/` (every version of every file in Vault), `yorg/` (Yorg's uploads and arrays, scripts, and models) |
| `/srv/yjsp/downloads` | `Vault-Setup.exe` and `vault.exe`, offered on Vault's SolidWorks page |
| `/srv/yjsp/backups` | Database backups, nightly and before each deploy, kept 14 days |

Everything under `/srv/yjsp` belongs to the user `yjsp`, which the server runs as.

**Services** (their files are in [`deploy/`](../deploy), copies of the server's):

- `yjsp.service` runs `yjsp-server` as `yjsp` in `/srv/yjsp`, starts at boot, and
  restarts it if it stops. The server migrates its database itself when it starts.
- `yjsp-backup.timer` runs `/usr/local/sbin/yjsp-backup` every night at 08:30 UTC: a
  consistent copy of the database, gzipped, kept 14 days. The files (`vault/`, `yorg/`)
  have no copy off the server yet (Cloudflare R2 is planned).

**Settings** (`/srv/yjsp/.env`; `server/.env.example` explains each one):

```bash
YJSP_ENV=production
YJSP_HOST=127.0.0.1
YJSP_PORT=8100
YJSP_PUBLIC_URL=https://lucazerega.tail07089c.ts.net
YJSP_DATABASE_URL=sqlite:////srv/yjsp/data/yjsp.db
YJSP_VAULT_DIR=/srv/yjsp/data/vault
YJSP_YORG_DIR=/srv/yjsp/data/yorg
YJSP_DOWNLOADS_DIR=/srv/yjsp/downloads
YJSP_WEB_DIR=/opt/yjsp/app/web/dist
# And the secrets, which are only in the server's copy: YJSP_SECRET_KEY,
# YJSP_GOOGLE_CLIENT_ID, YJSP_GOOGLE_CLIENT_SECRET, YJSP_BOOTSTRAP_ADMINS, and
# YJSP_MICROSOFT_CLIENT_ID, YJSP_MICROSOFT_CLIENT_SECRET (Georgia Tech sign-in; without
# them the site offers Google's alone, which makes no new accounts: only invites join).
```

## Getting access

Deploying takes SSH access to the server as `opc`. The server takes keys only, no
passwords, and no key is in this repository, so a clone alone can't deploy: each computer
that deploys has a key of its own. The first one is on the owner's laptop. A key made
before YJSP is `~/.ssh/vault_oracle`: rename it and its `.pub` to `yjsp_oracle`, or point
`YJSP_DEPLOY_KEY` at it.

To deploy from another computer:

1. On it, make a key: `ssh-keygen -t ed25519 -f ~/.ssh/yjsp_oracle -C "yjsp-<computer>"`.
2. Send its public half (`~/.ssh/yjsp_oracle.pub`, one line) to someone who has access.
   Never send the private half.
3. They add that line to `/home/opc/.ssh/authorized_keys` on the server. Taking the line
   out again stops that computer.
4. Check it: `ssh -i ~/.ssh/yjsp_oracle opc@129.80.217.44 true` answers without asking for
   a password. Then deploy as below.

Agents use the key already set up on the computer they run on, so an agent can deploy only
from a computer that has one. Agents never make, copy, move, or print private keys: on a
computer without one, an agent says it can't deploy and leaves it to someone who can.

## Deploying

You need bash (Git Bash on Windows), git, [Node.js](https://nodejs.org/) 24 with npm, and
SSH access. From this repository (a clone whose `origin` is GitHub):

```bash
bash deploy/deploy.sh             # main, as it is on GitHub now
bash deploy/deploy.sh v0.2.0      # a release tag
YJSP_DEPLOY_DRY_RUN=1 bash deploy/deploy.sh    # build it, but don't touch the server
```

On Windows, if Git Bash can't find npm: `export PATH="/c/Program Files/nodejs:$PATH"`.

What [`deploy/deploy.sh`](../deploy/deploy.sh) does:

1. It fetches from GitHub and refuses a commit that isn't there, or that isn't on `main`
   (unless `YJSP_DEPLOY_UNMERGED=1`: only when the owner asks for a branch to be tried
   on the live site).
2. It checks that commit out in a folder of its own next to the repository
   (`../.yjsp-deploy`, removed when it's done), and runs `npm ci` and `npm run build` there.
   So what ships is exactly that commit, whatever you have open, and the web app always
   matches the server.
3. It copies `server/` and `web/dist` to the server, beside the running ones.
4. On the server it backs up the database (`backups/yjsp-before-deploy-<time>.db.gz`),
   stops `yjsp.service`, swaps the new code in (keeping the `.venv`), updates the Python
   packages with `uv sync --locked`, and starts the service again. The site is down for
   about half a minute.
5. It waits up to 30 seconds for `/healthz`. If the new version doesn't answer, it shows
   the service's last log lines, puts the old version back, and fails.

It ends with **"Deployed: YJSP answers."** A deploy takes a few minutes, mostly `npm ci`.

### Before deploying

- Deploy `main` or a release tag: the live site only runs what's on `main`. Releases
  (tags like `v0.2.0`) are described in [CLAUDE.md](../CLAUDE.md), under "Releasing".
- Read any migration in the release (`server/src/yjsp_server/migrations/versions`). The
  server runs it when it starts, and the backup the script takes is what you'd go back to.
- For a big release, tell the team first: check-ins stop for about half a minute.

### After deploying

- The script said "Deployed: YJSP answers."
- https://lucazerega.tail07089c.ts.net opens and you can sign in.
- If the release changed Vault: on a scratch folder, check a file in, out, and in again.
- If it changed Yorg: a dataset opens and plots.
- The service's log is clean (see [Looking after it](#looking-after-it)).

### Rolling back

Deploy the previous release again: `bash deploy/deploy.sh v0.4.0`. If the bad release ran a
migration, also put back the database from the backup taken just before it
([below](#putting-back-a-database-backup)). A release from before YJSP (0.3.0 and
earlier) runs only in the old layout: going back to one after the move takes
`bash deploy/migrate-to-yjsp.sh --back` ([Moving to YJSP](#moving-to-yjsp)).

## Looking after it

Everything here runs on the server: `ssh -i ~/.ssh/yjsp_oracle opc@129.80.217.44`.

| To | Run |
|---|---|
| See whether it's running | `sudo systemctl status yjsp.service` |
| Read its log | `sudo journalctl -u yjsp.service -n 100 --no-pager` |
| Restart it | `sudo systemctl restart yjsp.service` |
| Ask it directly | `curl -fs http://127.0.0.1:8100/healthz` |
| See the backups | `sudo ls -lt /srv/yjsp/backups \| head` |
| Check the public address | `sudo tailscale funnel status` (it should show `/ proxy http://127.0.0.1:8100`) |

If the site doesn't load but `/healthz` answers on the server, look at Tailscale:
`sudo tailscale status`, and `sudo tailscale funnel --bg 8100` turns Funnel back on.

**Changing a setting:** edit `/srv/yjsp/.env` on the server (`sudo -u yjsp vi
/srv/yjsp/.env`), then restart the service. Never print it or copy it off the server.

**New downloads** (from CI's `vault-setup` and `vault-windows` artifacts): copy the file to
the server's `/tmp` with `scp`, then swap it in whole, so nobody downloads half a file:

```bash
sudo install -o yjsp -g yjsp -m 644 /tmp/Vault-Setup.exe /srv/yjsp/downloads/.Vault-Setup.exe.part
sudo mv /srv/yjsp/downloads/.Vault-Setup.exe.part /srv/yjsp/downloads/Vault-Setup.exe
```

A newer `Vault-Setup.exe` there is also how laptops get an add-in update: within a few
hours, the Vault tab in SolidWorks offers **Update** (the server reads the version from the
program). So put in only a build CI made from `main` or a release tag, as for a deploy.

### Putting back a database backup

Only with the owner's say-so: this replaces the live database, and whatever changed since
the backup is lost. The database being replaced is kept in `backups/`.

```bash
sudo systemctl stop yjsp.service
cd /srv/yjsp
keep=backups/replaced-$(date -u +%Y%m%d-%H%M%S) && sudo -u yjsp mkdir "$keep"
for f in data/yjsp.db data/yjsp.db-wal data/yjsp.db-shm; do
    if sudo test -e "$f"; then sudo mv "$f" "$keep/"; fi
done
sudo -u yjsp sh -c 'gunzip -c backups/<the backup>.db.gz > data/yjsp.db'
sudo systemctl start yjsp.service
```

## Moving to YJSP

Until 0.4.0 the server was laid out as it was when the site was CVC: `/srv/vault`,
`/opt/vault`, the `vault` user, `vault.service`, `vault.db`, and `CVC_*` settings. The first
YJSP release (0.4.0) moves it, once, with
[`deploy/migrate-to-yjsp.sh`](../deploy/migrate-to-yjsp.sh) in place of `deploy.sh`, which
refuses a server that hasn't moved. Only when the owner asks for it, as for any deploy:

1. Tell the team: the site is down for about half a minute. Not at 08:30 UTC, when the
   nightly backup runs.
2. On your computer, rename the SSH key if it's from before (see [Getting
   access](#getting-access)).
3. `YJSP_DEPLOY_DRY_RUN=1 bash deploy/migrate-to-yjsp.sh` builds the release and checks that
   the server is as this page described it before 0.4.0, without changing anything.
4. `bash deploy/migrate-to-yjsp.sh v0.4.0`. While the site keeps running, it installs the
   release in `/opt/yjsp`, with a Python of its own. Then it stops the site, backs the
   database up (`backups/vault-before-migration-<time>.db.gz`), renames the `vault` user
   `yjsp`, moves `/srv/vault` to `/srv/yjsp` (`vault.db` is `yjsp.db`, `blobs/` is
   `vault/blobs/`, and the backups are named `yjsp-*`), renames the settings in `.env`
   (`CVC_X` is `YJSP_X`, `CVC_BLOB_DIR` is `YJSP_VAULT_DIR`, and the paths with them), swaps
   `vault.service` and the backup timer for YJSP's, and starts it. If it doesn't answer
   within 30 seconds, or a step fails, everything goes back as it was and the old version
   runs again. It ends with **"Moved: YJSP answers."**
5. Check the site as after any deploy ([After deploying](#after-deploying)), and put
   0.4.0's downloads in `/srv/yjsp/downloads` ([New downloads](#looking-after-it)):
   `Vault-Setup.exe`, and `vault.exe` in place of `cvc.exe`.
6. To undo it later, `bash deploy/migrate-to-yjsp.sh --back` puts the old layout back and
   runs the old version, from `/opt/vault` and `/srv/yjsp/backups/before-yjsp` (the old
   settings and services). Once the site has run well for a week, delete both:
   `sudo rm -rf /opt/vault /srv/yjsp/backups/before-yjsp`. The release after deletes the
   script.

## Setting up a server from scratch

If the VM is ever lost or moved:

1. A Linux VM with `sqlite3` and `curl`. Install [uv](https://docs.astral.sh/uv/) as
   `/usr/local/bin/uv`, and Python 3.13 into `/opt/yjsp/python`
   (`sudo env UV_PYTHON_INSTALL_DIR=/opt/yjsp/python uv python install 3.13`).
2. A system user `yjsp`; `/srv/yjsp` (with `data/`, `downloads/`, `backups/`) owned by it;
   `/opt/yjsp/app` with `server/` and `web/`.
3. `/srv/yjsp/.env` with the settings above, a new `YJSP_SECRET_KEY`, the Georgia Tech
   (Microsoft) and Google sign-ins, and `YJSP_BOOTSTRAP_ADMINS`; `chmod 600`, owned by
   `yjsp`.
4. The files in [`deploy/`](../deploy): the units in `/etc/systemd/system/`, `yjsp-backup`
   in `/usr/local/sbin/` (executable). Then
   `sudo systemctl enable yjsp.service yjsp-backup.timer`.
5. The first deploy expects a `server/.venv` already in place: copy `server/` and
   `web/dist` in by hand, run the `uv sync` line from `deploy/deploy.sh` there, and start the
   service. From then on, `deploy/deploy.sh` does it.
6. Tailscale on the VM: `sudo tailscale up`, turn key expiry off for the machine in the
   Tailscale admin console, and `sudo tailscale funnel --bg 8100`. Then point the
   sign-ins' redirect URIs (Microsoft's and Google's) and `YJSP_PUBLIC_URL` at the new
   address.
7. Copy the data over (`/srv/yjsp/data`, and `downloads/`) with the service stopped on both
   machines.

The Docker image (`server/Dockerfile`, which CI builds, and publishes to ghcr.io for
version tags) is another way to run the same server. The live site doesn't use it.

## Rules

- **Never expose a development server** (port 8000, or anything with `YJSP_DEV_AUTH=1`)
  through Funnel or any other way: its sign-in lets anyone be anyone.
- **Never print, copy off the server, or commit** `.env`, SSH keys, or tokens.
- **Deploy only `main` or a release tag,** unless the owner asks for something else.
- **Don't change the live data by hand** (CLAUDE.md, "Data safety"): try things on a copy.
- **Leave the VM's firewall, Tailscale, and the Oracle Cloud account alone** unless the
  owner asks.
- If you change something on the server that this page or `deploy/` describes, change it
  here too, in the same PR.
