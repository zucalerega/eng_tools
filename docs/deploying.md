# Hosting and deploying

The team's site, YJSP (Vault and Yorg, on one server), is live at
**https://lucazerega.tail07089c.ts.net**. This page says where it runs, how to deploy a new
version, and how to look after it. Whether you're a person or an agent, read it through
before you deploy, and keep to the [rules](#rules) at the end.

## Where it runs

- **The machine:** an Oracle Cloud "Always Free" VM (Ampere A1, 1 OCPU and 6 GB, Oracle
  Linux 9), reached over SSH as `opc@lucazerega.tail07089c.ts.net`, through Tailscale: its SSH isn't
  open to the internet ([Getting access](#getting-access)). The Oracle Cloud account is the
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
| `/srv/yjsp/downloads` | `Vault-Setup.exe` and `vault.exe`, offered on Vault's SolidWorks page, and `Vault-Setup.exe.sig`, the installer's signature |
| `/srv/yjsp/backups` | Database backups, nightly and before each deploy, kept 14 days; `offsite/yjsp.db`, the database as the off-site backup last copied it; `offsite.json`, how the off-site backup went (written by root) |
| `/etc/yjsp/offsite.env`, `/etc/yjsp/offsite.password` | The off-site backup's settings and keys ([Off-site backups](#off-site-backups)). Readable only by root |

Everything under `/srv/yjsp` belongs to the user `yjsp`, which the server runs as.

**Services** (their files are in [`deploy/`](../deploy), copies of the server's):

- `yjsp.service` runs `yjsp-server` as `yjsp` in `/srv/yjsp`, starts at boot, and
  restarts it if it stops. The server migrates its database itself when it starts. It and
  its model runs may use 5 GB of the machine's 6 (`MemoryMax`): past that, systemd restarts
  it, rather than the kernel stopping whatever it picks, SSH and Tailscale included.
- `yjsp-backup.timer` runs `/usr/local/sbin/yjsp-backup` every night at 08:30 UTC: a
  consistent copy of the database, gzipped, kept 14 days, for putting it back quickly.
- `yjsp-offsite.timer` runs `/usr/local/sbin/yjsp-offsite backup` as root every night at
  09:00 UTC: the database, Vault's files, and Yorg's, copied off the server, encrypted, to
  Cloudflare R2. `yjsp-offsite-verify.timer` checks it by a restore every Sunday at 10:00
  UTC ([Off-site backups](#off-site-backups)).

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

Deploying takes SSH access to the server as `opc`, through Tailscale: the computer must be
on the owner's tailnet (Tailscale, signed in to the owner's account, or with the machine
`lucazerega` shared to it from the Tailscale admin console), since the server's SSH isn't
open to the internet. The server takes keys only, no passwords, and no key is in this
repository, so a clone alone can't deploy: each computer that deploys has a key of its own. The first one is on the owner's laptop. A key made
before YJSP is `~/.ssh/vault_oracle`: rename it and its `.pub` to `yjsp_oracle`, or point
`YJSP_DEPLOY_KEY` at it.

To deploy from another computer:

1. On it, make a key: `ssh-keygen -t ed25519 -f ~/.ssh/yjsp_oracle -C "yjsp-<computer>"`.
2. Send its public half (`~/.ssh/yjsp_oracle.pub`, one line) to someone who has access.
   Never send the private half.
3. They add that line to `/home/opc/.ssh/authorized_keys` on the server. Taking the line
   out again stops that computer.
4. Check it: `ssh -i ~/.ssh/yjsp_oracle opc@lucazerega.tail07089c.ts.net true` answers without
   asking for a password. Then deploy as below.

### Closing SSH to the internet

Once, by the owner. Until it's done, SSH answers anyone on the internet at the VM's public
address (keys only, but a door all the same):

1. From a computer on the tailnet, check that SSH works through Tailscale:
   `ssh -i ~/.ssh/yjsp_oracle opc@lucazerega.tail07089c.ts.net true`. (The VM's own firewall lets
   SSH in on Tailscale's interface; Funnel, the website, comes in through Tailscale too, not
   through an open port.)
2. In Oracle Cloud: Networking > Virtual cloud networks > the VM's network > Security Lists
   (and Network Security Groups, if the VM has one): delete the ingress rule for TCP port 22
   from `0.0.0.0/0`.
3. Check it from a computer off the tailnet (or with Tailscale off): `ssh opc@<the public
   address>` times out, and step 1 still works.
4. If Tailscale on the VM is ever down, Oracle Cloud's console connection (Compute >
   Instances > the VM > Console connection, or Cloud Shell) still reaches it.

Optionally, Tailscale SSH (`sudo tailscale set --ssh` on the VM) lets the tailnet's access
rules decide who gets in, on top of the keys.

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

Everything here runs on the server: `ssh -i ~/.ssh/yjsp_oracle opc@lucazerega.tail07089c.ts.net`.

| To | Run |
|---|---|
| See whether it's running | `sudo systemctl status yjsp.service` |
| Read its log | `sudo journalctl -u yjsp.service -n 100 --no-pager` |
| Restart it | `sudo systemctl restart yjsp.service` |
| Ask it directly | `curl -fs http://127.0.0.1:8100/healthz` |
| See the backups | `sudo ls -lt /srv/yjsp/backups \| head` |
| See the off-site backup | Admin > People's Storage card, or `systemctl list-timers 'yjsp-offsite*'` and `sudo journalctl -u yjsp-offsite -n 50` |
| Check the public address | `sudo tailscale funnel status` (it should show `/ proxy http://127.0.0.1:8100`) |

**Is it overloaded?** Admin > People's *Server load* shows how busy the CPU has been and how
full the memory, minute by minute, for the last day or week (from `/proc`, sampled by the
server itself). Near 100% for long, the site slows down: it says so when the CPU has
averaged over 85% for a quarter hour or the memory is over 90% full. On the machine itself,
`top` shows what's busy now.

If the site doesn't load but `/healthz` answers on the server, look at Tailscale:
`sudo tailscale status`, and `sudo tailscale funnel --bg 8100` turns Funnel back on.

**Changing a setting:** edit `/srv/yjsp/.env` on the server (`sudo -u yjsp vi
/srv/yjsp/.env`), then restart the service. Never print it or copy it off the server.

**New downloads** come with each release: CI puts `Vault-Setup.exe`, its signature
`Vault-Setup.exe.sig`, and `vault.exe` on the tag's GitHub release, a draft until the owner
publishes it (only people who can push to the repository see a draft). In your clone of this
repository, download them, check the signature (it says `Verified OK`), and copy them to the
server's `/tmp`:

```bash
d=/tmp/yjsp-v0.5.4
gh release download v0.5.4 --dir $d --pattern 'Vault-Setup.exe*' --pattern vault.exe
openssl dgst -sha256 -verify client/src/Vault.Client/installer-signing.pub.pem -signature $d/Vault-Setup.exe.sig $d/Vault-Setup.exe
scp -i ~/.ssh/yjsp_oracle $d/* opc@lucazerega.tail07089c.ts.net:/tmp/
```

On the server, swap each in whole, so nobody downloads half a file. `Vault-Setup.exe` and its
signature go together: put both in under hidden names first, then swap them in one right
after the other, the signature first:

```bash
cd /srv/yjsp/downloads
sudo install -o yjsp -g yjsp -m 644 /tmp/Vault-Setup.exe .Vault-Setup.exe.part
sudo install -o yjsp -g yjsp -m 644 /tmp/Vault-Setup.exe.sig .Vault-Setup.exe.sig.part
sudo mv .Vault-Setup.exe.sig.part Vault-Setup.exe.sig && sudo mv .Vault-Setup.exe.part Vault-Setup.exe
```

`vault.exe` goes in the same way, on its own. A build of `main` goes in the same way too, from
its CI run's `vault-setup` artifact (`gh run download <run id> --name vault-setup`), which is
kept 3 days.

A newer `Vault-Setup.exe` there is also how laptops get an add-in update: within a few
hours, the Vault tab in SolidWorks offers **Update** (the server reads the version from the
program). The add-in installs it only when `Vault-Setup.exe.sig` says it's signed with the
team's key ([below](#signing-key)), which CI does only for `main` and release tags: so put in
only a build CI made from one of those, as for a deploy, with its signature. Without it, or
with another build's, laptops refuse the update and say why. Add-ins up to 0.5.2 don't
check signatures: the protection starts on each laptop once it has an add-in newer than that.

**Making everyone update:** laptops take Update when their people get round to it. When the
team needs a release's fixes, an admin can set the oldest version that can change the vault
(Admin > People, under the SolidWorks add-in): older add-ins and `vault` commands can then
still open and get files, but anything that changes the vault says to update first. Put in
the release's `vault.exe` along with the installer first, since it holds for the CLI too,
and give people a few days to take the update; the tracker above it shows who hasn't. The
site refuses a version newer than the `Vault-Setup.exe` it offers, and Allow any version
takes it off.

### Signing key

CI signs `Vault-Setup.exe` on pushes to `main` and release tags, never for pull requests
([`.github/sign-installer.sh`](../.github/sign-installer.sh)), with RSA 3072 (PKCS#1 v1.5
over its SHA-256: `openssl dgst -sha256 -sign`), using the private key in the GitHub Actions
secret `INSTALLER_SIGNING_KEY` (the PEM file's text). The add-in
carries the public half (`AddInUpdate` in `Vault.Client`, the same as
[`installer-signing.pub.pem`](../client/src/Vault.Client/installer-signing.pub.pem) beside
it, which CI checks each signature with), and its Update runs only installers signed with
it. So neither the server nor its downloads folder can put a program on the team's laptops:
that takes the private key. Without the secret, CI's builds of `main` aren't signed (it
warns), and add-ins won't update to them, and a release tag's run fails before it uploads
anything.

The private key is in that secret and in the owner's password manager, and nowhere else:
never in the repository, on the server, or left on a computer's disk. To change it, because
it leaked or it's lost, or on the owner's say-so:

1. On the owner's computer, in a private folder: `openssl genrsa -out new.pem 3072`, and
   its public half, `openssl rsa -in new.pem -pubout -out installer-signing.pub.pem`. Put
   `new.pem`'s text in the password manager.
2. In a pull request, put the new `installer-signing.pub.pem` beside `AddInUpdate`, and its
   modulus (`openssl rsa -pubin -in installer-signing.pub.pem -noout -modulus`) in
   `AddInUpdate`'s `SigningKeyModulus`; the client tests check they're the same key. Merge
   and release it with the old key still in the secret: laptops check it with the key their
   add-in carries now, the old one. (CI warns that it's signed with a key this add-in
   doesn't carry: here, that's right.)
3. Once that release is in the downloads folder, put `new.pem`'s text in
   `INSTALLER_SIGNING_KEY`, and delete `new.pem`. Every build from then on is signed with
   the new key, which add-ins from step 2 on take.

If the old key leaked, whoever has it and the server's downloads folder can get a program
past the add-ins that carry it, until laptops have the release from step 2: have the team
run that `Vault-Setup.exe` by hand, from the web app's SolidWorks page, rather than wait
for Update. If it's lost, add-ins that carry it can't update to anything signed with the new
one: put the new key in the secret first (step 3), then release step 2, and run its
`Vault-Setup.exe` by hand on each laptop.

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

### Off-site backups

A copy on the server is no copy if the server goes: a disk failure, a mistake, or someone
who takes it over. So every night `deploy/yjsp-offsite` copies everything that matters off
it, into a [restic](https://restic.net) repository in a Cloudflare R2 bucket:

- **What:** a consistent copy of the database (made as `yjsp`, in `backups/offsite/`),
  Vault's files (`data/vault/`, without its temporary uploads), and Yorg's (`data/yorg/`,
  without temporary files, runs, and caches).
- **How:** restic encrypts everything on the server, with a password only the server and
  the owner have, so Cloudflare can't read the team's designs. Each night adds only what
  changed (Vault's blobs never change), and keeps the night's state: two weeks of nights,
  two months of Sundays, and two years of first-of-months, so an old version of a Yorg script
  or model can come back too. Unused data goes on Sundays.
- **Out of the site's reach:** it runs as root, with its keys in `/etc/yjsp/offsite.env`
  and `/etc/yjsp/offsite.password` (root only), so whoever took over the site (the `yjsp`
  user) could neither read them nor use them to erase the copies. The bucket's lock rules
  (below) keep even the key's holder from deleting the last 10 days of copies.
- **Checked:** every Sunday it reads back a tenth of the repository (all of it over ten
  weeks), restores the database and checks it with SQLite, and restores 20 of Vault's files
  at random, each of which must hash to its own name. Each run writes how it went to
  `backups/offsite.json`; Admin > People's Storage card shows it, and warns when a night
  failed, no copy is newer than 36 hours, or a check failed.

**Setting it up**, once, only when the owner asks (it needs their Cloudflare account):

1. In Cloudflare, R2: create a bucket `yjsp-backups` (location: automatic). Under its
   Settings, add these **bucket lock rules**, so that copies can't be deleted early even with
   the key:
   - prefix `keys/`, indefinitely, and prefix `config`, indefinitely (restic's encryption keys
     and settings: without them nothing can be read);
   - prefix `data/`, 10 days, and prefix `snapshots/`, 10 days.

   restic deletes data only once no kept copy needs it, which is at least two weeks after it
   was written, so these rules never get in its way. Then make an **R2 API token**: Object
   Read & Write, for this bucket only. Note its access key ID and secret, and the account's
   ID (R2's overview page).
2. Copy the files from [`deploy/`](../deploy) to the server (from a checkout of `main`,
   with the key from [Getting access](#getting-access)):
   `scp -i ~/.ssh/yjsp_oracle deploy/yjsp-offsite* deploy/offsite.env.example opc@<the server>:/tmp/`.
   Then on the server, in `/tmp`, install restic (from EPEL) and them:

   ```bash
   cd /tmp
   sudo dnf install -y oracle-epel-release-el9 && sudo dnf install -y restic
   sudo install -m 755 yjsp-offsite /usr/local/sbin/
   sudo install -m 644 yjsp-offsite.service yjsp-offsite.timer yjsp-offsite-verify.service yjsp-offsite-verify.timer /etc/systemd/system/
   sudo install -d -m 700 /etc/yjsp
   sudo install -m 600 offsite.env.example /etc/yjsp/offsite.env
   sudo vi /etc/yjsp/offsite.env  # the account ID, and the token's key ID and secret
   sudo sh -c 'umask 077 && openssl rand -base64 32 > /etc/yjsp/offsite.password'
   ```

3. **Put the password in the owner's password manager now** (`sudo cat
   /etc/yjsp/offsite.password`, once): if the server is lost, it's the only way to read the
   backups. Never put it anywhere else.
4. Make the repository, start the timers, and run both once:

   ```bash
   sudo sh -c 'set -a && . /etc/yjsp/offsite.env && restic init'
   sudo systemctl daemon-reload
   sudo systemctl enable --now yjsp-offsite.timer yjsp-offsite-verify.timer
   sudo systemctl start yjsp-offsite.service && sudo journalctl -u yjsp-offsite -n 20
   sudo systemctl start yjsp-offsite-verify.service && sudo journalctl -u yjsp-offsite-verify -n 20
   ```

   The first night uploads everything, so it takes a while; later ones take minutes.
   Admin > People should then say "Copied off the server … and checked by a restore …".

**Putting it all back** from off-site, when the server's data is lost (on a new server,
set up as in [Setting up a server from scratch](#setting-up-a-server-from-scratch), with
`offsite.env` and the password from the password manager):

```bash
sudo systemctl stop yjsp.service
sudo sh -c 'set -a && . /etc/yjsp/offsite.env && restic snapshots'   # pick one; latest is the last night
sudo sh -c 'set -a && . /etc/yjsp/offsite.env && restic restore latest --target /srv/restore'
cd /srv/yjsp
sudo mv /srv/restore/srv/yjsp/data/vault /srv/restore/srv/yjsp/data/yorg data/
sudo mv /srv/restore/srv/yjsp/backups/offsite/yjsp.db data/yjsp.db
sudo chown -R yjsp:yjsp data && sudo systemctl start yjsp.service
```

If restic says its index is missing or damaged (the lock rules protect the data, keys,
and snapshots, not the index), `restic repair index` rebuilds it from the data. Practice
this on a scratch VM once a semester: a restore you've never done is a guess.

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
   `sudo systemctl enable yjsp.service yjsp-backup.timer`. And the off-site backup, as in
   [Off-site backups](#off-site-backups), with the existing `offsite.env` and password if
   it's a move: then put the data back from it before the first start.
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
