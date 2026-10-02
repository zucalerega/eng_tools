# Hosting and deploying

The team's Vault (and Yorg, on the same server) is live at
**https://lucazerega.tail07089c.ts.net**. This page says where it runs, how to deploy a new
version, and how to look after it. Whether you're a person or an agent, read it through
before you deploy, and keep to the [rules](#rules) at the end.

## Where it runs

- **The machine:** an Oracle Cloud "Always Free" VM (Ampere A1, 1 OCPU and 6 GB, Oracle
  Linux 9), reached over SSH as `opc@129.80.217.44`. The Oracle Cloud account is the
  repository owner's.
- **Its public address:** [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) on the
  VM (Tailscale machine `lucazerega`, key expiry off) serves
  https://lucazerega.tail07089c.ts.net and passes it to Vault on `127.0.0.1:8100`. Nothing
  else on the VM is reachable from the internet.
- **Google sign-in:** the OAuth client in Google Cloud Console has the redirect URI
  `https://lucazerega.tail07089c.ts.net/auth/callback`. If the address ever changes,
  change it there and in `CVC_PUBLIC_URL`.

On the server:

| Path | What |
|---|---|
| `/opt/vault/app/server` | The server's code (`server/` from the repository) and its `.venv`, made by uv 0.12 with Python 3.13 from `/opt/vault/python` |
| `/opt/vault/app/web/dist` | The built web app, which the server serves |
| `/srv/vault/.env` | Settings and secrets (below). Readable only by `vault` |
| `/srv/vault/data` | `vault.db` (SQLite), `blobs/` (every version of every file), `yorg/` (Yorg's uploads and arrays) |
| `/srv/vault/downloads` | `Vault-Setup.exe` and `cvc.exe`, offered on the web app's SolidWorks page |
| `/srv/vault/backups` | Database backups, nightly and before each deploy, kept 14 days |

Everything under `/srv/vault` belongs to the user `vault`, which the server runs as.

**Services** (their files are in [`deploy/`](../deploy), copies of the server's):

- `vault.service` runs `cvc-server` as `vault` in `/srv/vault`, starts at boot, and
  restarts it if it stops. The server migrates its database itself when it starts.
- `vault-backup.timer` runs `/usr/local/sbin/vault-backup` every night at 08:30 UTC: a
  consistent copy of the database, gzipped, kept 14 days. The files (`blobs/`, `yorg/`)
  have no copy off the server yet (Cloudflare R2 is planned).

**Settings** (`/srv/vault/.env`; `server/.env.example` explains each one):

```bash
CVC_ENV=production
CVC_HOST=127.0.0.1
CVC_PORT=8100
CVC_PUBLIC_URL=https://lucazerega.tail07089c.ts.net
CVC_DATABASE_URL=sqlite:////srv/vault/data/vault.db
CVC_BLOB_DIR=/srv/vault/data/blobs
CVC_YORG_DIR=/srv/vault/data/yorg
CVC_DOWNLOADS_DIR=/srv/vault/downloads
CVC_WEB_DIR=/opt/vault/app/web/dist
# And the secrets, which are only in the server's copy: CVC_SECRET_KEY,
# CVC_GOOGLE_CLIENT_ID, CVC_GOOGLE_CLIENT_SECRET, CVC_BOOTSTRAP_ADMINS.
```

## Getting access

Deploying takes SSH access to the server as `opc`. The server takes keys only, no
passwords, and no key is in this repository, so a clone alone can't deploy: each computer
that deploys has a key of its own. The first one, `vault-oracle`, is on the owner's laptop.

To deploy from another computer:

1. On it, make a key: `ssh-keygen -t ed25519 -f ~/.ssh/vault_oracle -C "vault-<computer>"`.
2. Send its public half (`~/.ssh/vault_oracle.pub`, one line) to someone who has access.
   Never send the private half.
3. They add that line to `/home/opc/.ssh/authorized_keys` on the server. Taking the line
   out again stops that computer.
4. Check it: `ssh -i ~/.ssh/vault_oracle opc@129.80.217.44 true` answers without asking for
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
VAULT_DEPLOY_DRY_RUN=1 bash deploy/deploy.sh   # build it, but don't touch the server
```

On Windows, if Git Bash can't find npm: `export PATH="/c/Program Files/nodejs:$PATH"`.

What [`deploy/deploy.sh`](../deploy/deploy.sh) does:

1. It fetches from GitHub and refuses a commit that isn't there, or that isn't on `main`
   (unless `VAULT_DEPLOY_UNMERGED=1`: only when the owner asks for a branch to be tried
   on the live site).
2. It checks that commit out in a folder of its own next to the repository
   (`../.cvc-deploy`, removed when it's done), and runs `npm ci` and `npm run build` there.
   So what ships is exactly that commit, whatever you have open, and the web app always
   matches the server.
3. It copies `server/` and `web/dist` to the server, beside the running ones.
4. On the server it backs up the database (`backups/vault-before-deploy-<time>.db.gz`),
   stops `vault.service`, swaps the new code in (keeping the `.venv`), updates the Python
   packages with `uv sync --locked`, and starts the service again. Vault is down for
   about half a minute.
5. It waits up to 30 seconds for `/healthz`. If the new version doesn't answer, it shows
   the service's last log lines, puts the old version back, and fails.

It ends with **"Deployed: Vault answers."** A deploy takes a few minutes, mostly `npm ci`.

### Before deploying

- Deploy `main` or a release tag: the live site only runs what's on `main`. Releases
  (tags like `v0.2.0`) are described in [CLAUDE.md](../CLAUDE.md), under "Releasing".
- Read any migration in the release (`server/src/cvc_server/migrations/versions`). The
  server runs it when it starts, and the backup the script takes is what you'd go back to.
- For a big release, tell the team first: check-ins stop for about half a minute.

### After deploying

- The script said "Deployed: Vault answers."
- https://lucazerega.tail07089c.ts.net opens and you can sign in.
- If the release changed the server: on a scratch folder, check a file in, out, and in again.
- If it changed Yorg: a dataset opens and plots.
- The service's log is clean (see [Looking after it](#looking-after-it)).

### Rolling back

Deploy the previous release again: `bash deploy/deploy.sh v0.1.0`. If the bad release ran a
migration, also put back the database from the backup taken just before it
([below](#putting-back-a-database-backup)).

## Looking after it

Everything here runs on the server: `ssh -i ~/.ssh/vault_oracle opc@129.80.217.44`.

| To | Run |
|---|---|
| See whether it's running | `sudo systemctl status vault.service` |
| Read its log | `sudo journalctl -u vault.service -n 100 --no-pager` |
| Restart it | `sudo systemctl restart vault.service` |
| Ask it directly | `curl -fs http://127.0.0.1:8100/healthz` |
| See the backups | `sudo ls -lt /srv/vault/backups \| head` |
| Check the public address | `sudo tailscale funnel status` (it should show `/ proxy http://127.0.0.1:8100`) |

If the site doesn't load but `/healthz` answers on the server, look at Tailscale:
`sudo tailscale status`, and `sudo tailscale funnel --bg 8100` turns Funnel back on.

**Changing a setting:** edit `/srv/vault/.env` on the server (`sudo -u vault vi
/srv/vault/.env`), then restart the service. Never print it or copy it off the server.

**New downloads** (from CI's `vault-setup` and `cvc-windows` artifacts): copy the file to
the server's `/tmp` with `scp`, then swap it in whole, so nobody downloads half a file:

```bash
sudo install -o vault -g vault -m 644 /tmp/Vault-Setup.exe /srv/vault/downloads/.Vault-Setup.exe.part
sudo mv /srv/vault/downloads/.Vault-Setup.exe.part /srv/vault/downloads/Vault-Setup.exe
```

### Putting back a database backup

Only with the owner's say-so: this replaces the live database, and whatever changed since
the backup is lost. The database being replaced is kept in `backups/`.

```bash
sudo systemctl stop vault.service
cd /srv/vault
keep=backups/replaced-$(date -u +%Y%m%d-%H%M%S) && sudo -u vault mkdir "$keep"
for f in data/vault.db data/vault.db-wal data/vault.db-shm; do
    if sudo test -e "$f"; then sudo mv "$f" "$keep/"; fi
done
sudo -u vault sh -c 'gunzip -c backups/<the backup>.db.gz > data/vault.db'
sudo systemctl start vault.service
```

## Setting up a server from scratch

If the VM is ever lost or moved:

1. A Linux VM with `sqlite3` and `curl`. Install [uv](https://docs.astral.sh/uv/) as
   `/usr/local/bin/uv`, and Python 3.13 into `/opt/vault/python`
   (`sudo env UV_PYTHON_INSTALL_DIR=/opt/vault/python uv python install 3.13`).
2. A system user `vault`; `/srv/vault` (with `data/`, `downloads/`, `backups/`) owned by it;
   `/opt/vault/app` with `server/` and `web/`.
3. `/srv/vault/.env` with the settings above, a new `CVC_SECRET_KEY`, the Google OAuth
   client, and `CVC_BOOTSTRAP_ADMINS`; `chmod 600`, owned by `vault`.
4. The files in [`deploy/`](../deploy): the units in `/etc/systemd/system/`, `vault-backup`
   in `/usr/local/sbin/` (executable). Then
   `sudo systemctl enable vault.service vault-backup.timer`.
5. The first deploy expects a `server/.venv` already in place: copy `server/` and
   `web/dist` in by hand, run the `uv sync` line from `deploy/deploy.sh` there, and start the
   service. From then on, `deploy/deploy.sh` does it.
6. Tailscale on the VM: `sudo tailscale up`, turn key expiry off for the machine in the
   Tailscale admin console, and `sudo tailscale funnel --bg 8100`. Then point Google's
   redirect URI and `CVC_PUBLIC_URL` at the new address.
7. Copy the data over (`/srv/vault/data`, and `downloads/`) with the service stopped on both
   machines.

The Docker image (`server/Dockerfile`, which CI builds, and publishes to ghcr.io for
version tags) is another way to run the same server. The live site doesn't use it.

## Rules

- **Never expose a development server** (port 8000, or anything with `CVC_DEV_AUTH=1`)
  through Funnel or any other way: its sign-in lets anyone be anyone.
- **Never print, copy off the server, or commit** `.env`, SSH keys, or tokens.
- **Deploy only `main` or a release tag,** unless the owner asks for something else.
- **Don't change the live data by hand** (CLAUDE.md, "Data safety"): try things on a copy.
- **Leave the VM's firewall, Tailscale, and the Oracle Cloud account alone** unless the
  owner asks.
- If you change something on the server that this page or `deploy/` describes, change it
  here too, in the same PR.
